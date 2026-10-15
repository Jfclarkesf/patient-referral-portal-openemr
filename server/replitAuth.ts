// Replit Auth integration using OpenID Connect
import * as client from "openid-client";
import { Strategy, type VerifyFunction } from "openid-client/passport";
import passport from "passport";
import session from "express-session";
import type { Express, Request, RequestHandler } from "express";
import type { User } from "@shared/schema";
import memoize from "memoizee";
import connectPg from "connect-pg-simple";
import { storage } from "./storage";
import bcrypt from "bcryptjs";

const getOidcConfig = memoize(
  async () => {
    return await client.discovery(
      new URL(process.env.ISSUER_URL ?? "https://replit.com/oidc"),
      process.env.REPL_ID!
    );
  },
  { maxAge: 3600 * 1000 }
);

export function getSession() {
  if (!process.env.SESSION_SECRET) {
    throw new Error("SESSION_SECRET environment variable is required for authentication.");
  }

  const sessionTtl = 7 * 24 * 60 * 60 * 1000; // 1 week
  const pgStore = connectPg(session);
  const sessionStore = new pgStore({
    conString: process.env.DATABASE_URL,
    createTableIfMissing: true,  // Auto-create sessions table if missing
    ttl: sessionTtl,
    tableName: "sessions",
  });
  
  const isProduction = process.env.NODE_ENV === "production";
  const trustProxy = process.env.TRUST_PROXY === "true";
  const isStandalone = process.env.STANDALONE_MODE === 'true' || !process.env.REPL_ID || process.env.REPL_ID === 'standalone-deployment';
  
  // Cookie configuration:
  // - Standalone mode behind proxy: Use "auto" for secure to let Express detect based on X-Forwarded-Proto
  //   If the proxy doesn't forward X-Forwarded-Proto, use false to ensure cookie is always sent
  // - Replit mode with proxy: Use "none" for OAuth redirects (requires secure: true)
  // - Default: Use "lax" for same-site requests
  const sameSiteValue = (!isStandalone && trustProxy) ? "none" : "lax";
  
  // CRITICAL FIX for Synology/mobile Safari:
  // When behind a reverse proxy that may not forward X-Forwarded-Proto header,
  // Express thinks the connection is HTTP and refuses to send secure cookies.
  // For standalone deployments behind a proxy, we set secure: false to ensure
  // cookies are always sent. The connection is still secure at the proxy level (HTTPS).
  // In Replit mode or when not behind a proxy, we keep secure: true for production.
  const secureValue = isStandalone ? false : (trustProxy || isProduction);
  
  console.log(`[Session] Mode: ${isStandalone ? 'standalone' : 'replit'}, trustProxy: ${trustProxy}, secure: ${secureValue}, sameSite: ${sameSiteValue}`);
  
  return session({
    secret: process.env.SESSION_SECRET,
    store: sessionStore,
    resave: false,
    saveUninitialized: true, // CRITICAL: Must be true to ensure cookie is sent on first request
    proxy: trustProxy, // Trust the reverse proxy for secure cookie detection
    cookie: {
      httpOnly: true,
      secure: secureValue,
      maxAge: sessionTtl,
      sameSite: sameSiteValue,
    },
  });
}

function updateUserSession(
  user: any,
  tokens: client.TokenEndpointResponse & client.TokenEndpointResponseHelpers
) {
  user.claims = tokens.claims();
  user.access_token = tokens.access_token;
  user.refresh_token = tokens.refresh_token;
  user.expires_at = user.claims?.exp;
}

async function upsertUser(claims: any) {
  await storage.upsertUser({
    id: claims["sub"],
    email: claims["email"],
    firstName: claims["first_name"],
    lastName: claims["last_name"],
    profileImageUrl: claims["profile_image_url"],
  });
}

// Without an admin, the browser setup wizard (/setup) creates the first one.
// DEFAULT_ADMIN_PASSWORD still pre-creates "admin" for unattended installs.
async function ensureDefaultAdmin() {
  try {
    if (await storage.hasAdminUser()) {
      console.log('✅ Admin user already exists');
      return;
    }
    const defaultPassword = process.env.DEFAULT_ADMIN_PASSWORD;
    if (!defaultPassword) {
      console.log('ℹ️  No admin account yet. Open the app in a browser to run first-time setup.');
      return;
    }
    await storage.createUserWithPassword({
      username: "admin",
      email: "admin@localhost",
      password: defaultPassword,
      firstName: "Admin",
      lastName: "User",
      isAdmin: true,
    });
    console.log('✅ Default admin user created (username: admin, password from DEFAULT_ADMIN_PASSWORD)');
    console.log('⚠️  Please change the admin password after first login!');
  } catch (error) {
    console.error('Error ensuring default admin:', error);
  }
}

// Sign a user in on this request (fresh session id, saved before responding)
export function startUserSession(req: Request, user: User): Promise<void> {
  const email = user.email || `${user.username}@local`;
  const sessionUser = {
    id: user.id,
    email,
    firstName: user.firstName || user.username,
    lastName: user.lastName || "",
    profileImageUrl: user.profileImageUrl || "",
    claims: {
      sub: user.id,
      email,
      first_name: user.firstName || user.username,
      last_name: user.lastName || "",
      exp: Math.floor(Date.now() / 1000) + 86400
    }
  };

  return new Promise((resolve, reject) => {
    // Regenerate session to prevent session fixation attacks and force new cookie
    req.session.regenerate((regenErr) => {
      if (regenErr) return reject(regenErr);
      req.login(sessionUser, (err) => {
        if (err) return reject(err);
        // Explicitly save session before responding to ensure it persists
        req.session.save((saveErr) => (saveErr ? reject(saveErr) : resolve()));
      });
    });
  });
}

// Helper function to check if running in standalone mode
export function isStandaloneMode(): boolean {
  return process.env.STANDALONE_MODE === 'true' || !process.env.REPL_ID || process.env.REPL_ID === 'standalone-deployment';
}

export async function setupAuth(app: Express) {
  app.set("trust proxy", 1);
  app.use(getSession());
  app.use(passport.initialize());
  app.use(passport.session());

  // Check if running in standalone mode (outside Replit)
  const isStandalone = isStandaloneMode();
  
  // Add endpoint to return auth mode
  app.get("/api/auth/mode", (_req, res) => {
    res.json({ 
      mode: isStandalone ? "standalone" : "replit",
      message: isStandalone ? "Username/password authentication" : "Replit OAuth authentication"
    });
  });
  
  if (isStandalone) {
    console.log('⚠️  Running in STANDALONE mode - Replit auth disabled');
    console.log('⚠️  Using username/password authentication for standalone deployment');
    
    // Setup simple passport serialization for standalone mode
    passport.serializeUser((user: Express.User, cb) => cb(null, user));
    passport.deserializeUser((user: Express.User, cb) => cb(null, user));
    
    // Ensure default admin exists on startup
    await ensureDefaultAdmin();
    
    // POST login with username/password
    app.post("/api/login", async (req, res) => {
      try {
        const { username, password } = req.body;
        
        if (!username || !password) {
          return res.status(400).json({ message: "Username and password are required" });
        }
        
        const user = await storage.verifyUserPassword(username, password);
        if (!user) {
          // Correct password on an account staff haven't approved yet: say so
          const pending = await storage.getUserByUsername(username);
          if (
            pending && !pending.isActive && pending.passwordHash &&
            (await bcrypt.compare(password, pending.passwordHash))
          ) {
            return res.status(403).json({
              message: "Your account is waiting for approval from our staff. Call the office if it's been more than one business day.",
            });
          }
          return res.status(401).json({ message: "Invalid username or password" });
        }
        
        try {
          await startUserSession(req, user);
        } catch (sessionErr) {
          console.error('Login session error:', sessionErr);
          return res.status(500).json({ message: "Login failed" });
        }
        console.log(`✅ User ${username} logged in successfully`);
        res.json({ success: true, message: "Login successful" });
      } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ message: "Login failed" });
      }
    });
    
    // GET login redirects to login page
    app.get("/api/login", (req, res) => {
      res.redirect("/login");
    });
    
    app.get("/api/callback", (req, res) => {
      res.redirect("/");
    });
    
    app.post("/api/logout", (req, res) => {
      req.logout((err) => {
        if (err) {
          return res.status(500).json({ message: "Logout failed" });
        }
        req.session.destroy((destroyErr) => {
          if (destroyErr) {
            return res.status(500).json({ message: "Failed to destroy session" });
          }
          res.clearCookie("connect.sid");
          res.status(200).json({ message: "Logged out successfully" });
        });
      });
    });
    
    app.get("/api/logout", (req, res) => {
      req.logout(() => {
        res.redirect("/login");
      });
    });
    
    return; // Skip Replit OIDC setup
  }

  const config = await getOidcConfig();

  const verify: VerifyFunction = async (
    tokens: client.TokenEndpointResponse & client.TokenEndpointResponseHelpers,
    verified: passport.AuthenticateCallback
  ) => {
    const user = {};
    updateUserSession(user, tokens);
    await upsertUser(tokens.claims());
    verified(null, user);
  };

  // Keep track of registered strategies
  const registeredStrategies = new Set<string>();

  // Helper function to ensure strategy exists for a domain
  const ensureStrategy = (domain: string, protocol: string) => {
    const strategyName = `replitauth:${domain}`;
    if (!registeredStrategies.has(strategyName)) {
      const strategy = new Strategy(
        {
          name: strategyName,
          config,
          scope: "openid email profile offline_access",
          callbackURL: `${protocol}://${domain}/api/callback`,
        },
        verify,
      );
      passport.use(strategy);
      registeredStrategies.add(strategyName);
    }
  };

  passport.serializeUser((user: Express.User, cb) => cb(null, user));
  passport.deserializeUser((user: Express.User, cb) => cb(null, user));

  app.get("/api/login", (req, res, next) => {
    ensureStrategy(req.hostname, req.protocol);
    passport.authenticate(`replitauth:${req.hostname}`, {
      prompt: "login consent",
      scope: ["openid", "email", "profile", "offline_access"],
    })(req, res, next);
  });

  app.get("/api/callback", (req, res, next) => {
    ensureStrategy(req.hostname, req.protocol);
    passport.authenticate(`replitauth:${req.hostname}`, {
      successReturnToOrRedirect: "/",
      failureRedirect: "/api/login",
    })(req, res, next);
  });

  // JSON logout endpoint for SPA (destroys session without redirect)
  app.post("/api/logout", (req, res) => {
    req.logout((err) => {
      if (err) {
        return res.status(500).json({ message: "Logout failed" });
      }
      
      // Destroy the session completely
      req.session.destroy((destroyErr) => {
        if (destroyErr) {
          return res.status(500).json({ message: "Failed to destroy session" });
        }
        
        // Clear the session cookie
        res.clearCookie("connect.sid");
        res.status(200).json({ message: "Logged out successfully" });
      });
    });
  });

  // Browser logout endpoint (redirects to OIDC sign-out)
  app.get("/api/logout", (req, res) => {
    req.logout(() => {
      res.redirect(
        client.buildEndSessionUrl(config, {
          client_id: process.env.REPL_ID!,
          post_logout_redirect_uri: `${req.protocol}://${req.hostname}`,
        }).href
      );
    });
  });
}

export const isAuthenticated: RequestHandler = async (req, res, next) => {
  const user = req.user as any;

  // Check if running in standalone mode
  const isStandalone = process.env.STANDALONE_MODE === 'true' || !process.env.REPL_ID || process.env.REPL_ID === 'standalone-deployment';
  
  if (isStandalone) {
    // In standalone mode, just check if user is authenticated (no token expiration check)
    if (!req.isAuthenticated() || !user) {
      return res.status(401).json({ message: "Unauthorized" });
    }
    return next();
  }

  // Original Replit auth logic
  if (!req.isAuthenticated() || !user || !user.expires_at) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  const now = Math.floor(Date.now() / 1000);
  if (now <= user.expires_at) {
    return next();
  }

  const refreshToken = user.refresh_token;
  if (!refreshToken) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  try {
    const config = await getOidcConfig();
    const tokenResponse = await client.refreshTokenGrant(config, refreshToken);
    updateUserSession(user, tokenResponse);
    return next();
  } catch (error) {
    console.error('Token refresh failed - clearing session:', (error as Error).message);
    
    req.logout((logoutErr) => {
      if (logoutErr) {
        console.error('Error during logout:', logoutErr);
      }
      
      req.session.destroy((destroyErr) => {
        if (destroyErr) {
          console.error('Error destroying session:', destroyErr);
        }
        res.status(401).json({ message: "Session expired. Please log in again." });
      });
    });
    return;
  }
};
