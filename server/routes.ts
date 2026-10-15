import type { Express, Response } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { insertReferralSchema, insertPatientSchema, insertEncounterSchema, updateSystemSettingsSchema, registerDoctorSchema, setupAdminSchema, setupOpenEMRSchema, isValidNpi, DOCUMENT_MAX_BYTES, DOCUMENT_MAX_FILES, DOCUMENT_TYPES, type User, type Encounter } from "@shared/schema";
import { lookupNpi } from "./nppes";
import { findOrCreatePractitioner } from "./openemr/practitioner";
import { mockObjectStorage } from "./mockObjectStorage";
import { setupAuth, isAuthenticated, isStandaloneMode, startUserSession } from "./replitAuth";
import express from "express";
import { testConnection, getOpenEMRConfig, exchangeAuthorizationCode, checkAvailableAPIs, loadOpenEMRClient, registerOpenEMRClient, OpenEMRRegistrationError, getOAuthRedirectUri, OPENEMR_SCOPES } from "./openemr/client";
import { pushEncounterToOpenEMR, pushReferralToOpenEMR, updateReferralStatusInOpenEMR, pullEncountersFromOpenEMR, reconcileEncountersWithOpenEMR } from "./openemr/referral";
import { searchPatients, createPatient, getPatient } from "./openemr/patient";
import { syncEncounterDocuments } from "./openemr/document";
import { randomBytes } from "crypto";
import { isAdmin } from "./middleware/adminAuth";
import { emailService } from "./email";
import { searchICD10Codes } from "./icd10-codes";
import { z } from "zod";

// Minimal per-IP limiter for the public registration endpoints
const publicHits = new Map<string, number[]>();
function isRateLimited(ip: string, limit = 20, windowMs = 15 * 60 * 1000): boolean {
  const now = Date.now();
  const recent = (publicHits.get(ip) || []).filter((t) => now - t < windowMs);
  recent.push(now);
  publicHits.set(ip, recent);
  return recent.length > limit;
}

// Create (or find) the provider in OpenEMR's Address Book and store the link.
// Never throws: a failure is recorded on the account so staff can retry.
async function syncProviderToOpenEMR(user: User): Promise<boolean> {
  if (!user.npi || user.isAdmin) return false;
  try {
    const link = await findOrCreatePractitioner({
      npi: user.npi,
      firstName: user.firstName || "",
      lastName: user.lastName || "",
      credential: user.credential,
      specialty: user.specialty,
      practiceName: user.practiceName,
      street: user.street,
      city: user.city,
      state: user.state,
      zip: user.zip,
      phone: user.phone,
      fax: user.fax,
      email: user.email,
    });
    await storage.updateUserOpenEMRProvider(user.id, {
      providerId: link.id,
      providerUuid: link.uuid,
      status: "synced",
      error: null,
    });
    console.log(`[Register] OpenEMR provider ${link.created ? "created" : "found"} for NPI ${user.npi}: id ${link.id}`);
    return true;
  } catch (error: any) {
    const message = error?.userMessage || error?.message || String(error);
    console.error(`[Register] OpenEMR provider sync failed for NPI ${user.npi}:`, error?.message || error);
    await storage.updateUserOpenEMRProvider(user.id, {
      providerId: null,
      providerUuid: null,
      status: "failed",
      error: message,
    });
    return false;
  }
}

async function sendNpiLookup(rawNpi: string, res: Response) {
  const npi = rawNpi.trim();
  if (!isValidNpi(npi)) {
    return res.status(400).json({ message: "That isn't a valid NPI number." });
  }

  try {
    const result = await lookupNpi(npi);
    if (!result) {
      return res.status(404).json({ message: "No provider with that NPI in the national registry." });
    }
    if (result.type !== "individual") {
      return res.status(422).json({ message: "That's an organization NPI. Use the individual provider's NPI." });
    }
    if (!result.active) {
      return res.status(422).json({ message: "That NPI is deactivated in the national registry." });
    }
    res.json(result);
  } catch (error) {
    console.error("[NPI] Lookup failed:", error);
    res.status(503).json({ message: "The NPI registry isn't responding. Enter the details by hand." });
  }
}

// Never send a stored SSN back to the browser; show the last 4 at most
function redactEncounter<T extends { subscriberSsn?: string | null }>(e: T): T {
  if (!e?.subscriberSsn) return e;
  return { ...e, subscriberSsn: `***-**-${e.subscriberSsn.slice(-4)}` };
}

// Can this user see this referral (and its documents)?
async function canAccessEncounter(userId: string | undefined, encounter: Encounter): Promise<boolean> {
  if (!userId) return false;
  if (encounter.userId === userId) return true;
  return !!(await storage.getUser(userId))?.isAdmin;
}

// Header-safe file name for downloads
function contentDisposition(fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]|["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

export async function registerRoutes(app: Express): Promise<Server> {
  // Setup authentication
  await setupAuth(app);
  await loadOpenEMRClient();

  // ---------- First-run setup wizard ----------

  // What the wizard still has to do. OpenEMR details only go to admins.
  app.get('/api/setup/status', async (req: any, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const needsAdmin = isStandaloneMode() && !(await storage.hasAdminUser());
      const userId = req.isAuthenticated?.() ? req.user?.claims?.sub : null;
      const viewer = userId ? await storage.getUser(userId) : undefined;
      if (!viewer?.isAdmin) {
        return res.json({ needsAdmin });
      }

      const saved = await storage.getOpenEMRClient();
      const config = getOpenEMRConfig();
      res.json({
        needsAdmin,
        suggestedAppUrl: `${req.protocol}://${req.get('host')}`,
        openemr: {
          configured: !!config,
          source: saved ? 'wizard' : config ? 'environment' : null,
          baseUrl: config?.baseUrl ?? null,
          appUrl: saved?.appUrl ?? null,
          clientName: saved?.clientName ?? null,
          clientId: config?.clientId ?? null,
          redirectUri: config ? getOAuthRedirectUri() : null,
          connected: !!config && !!(await storage.getOpenEMRRefreshToken()),
        },
      });
    } catch (error) {
      console.error("[Setup] Status check failed:", error);
      res.status(500).json({ message: "Couldn't check setup status" });
    }
  });

  // Step 1: create the first admin and sign them in. Closed once any admin exists.
  app.post('/api/setup/admin', async (req, res) => {
    if (isRateLimited(req.ip || "unknown")) {
      return res.status(429).json({ message: "Too many attempts. Try again in a few minutes." });
    }
    if (!isStandaloneMode()) {
      return res.status(404).json({ message: "Setup isn't used in this deployment." });
    }

    const parsed = setupAdminSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        message: "Some fields need attention.",
        errors: parsed.error.flatten().fieldErrors,
      });
    }
    const input = parsed.data;

    try {
      if (await storage.hasAdminUser()) {
        return res.status(409).json({ message: "Setup is already done. Sign in instead." });
      }
      if ((await storage.getUserByUsername(input.username)) || (await storage.getUserByEmail(input.email))) {
        return res.status(409).json({ message: "That username or email is already taken." });
      }

      const user = await storage.createUserWithPassword({
        username: input.username,
        email: input.email,
        password: input.password,
        firstName: input.firstName,
        lastName: input.lastName,
        isAdmin: true,
      });
      // New referrals notify the admin until they pick another address
      if (!(await storage.getSystemSettings())?.notificationEmail) {
        await storage.updateSystemSettings(input.email);
      }
      await startUserSession(req, user);

      console.log(`[Setup] Admin account created: ${input.username}`);
      res.status(201).json({ message: "Admin account created." });
    } catch (error) {
      console.error("[Setup] Admin creation failed:", error);
      res.status(500).json({ message: "Couldn't create the admin account. Try again." });
    }
  });

  // Step 2: register this app in OpenEMR and keep the client id and secret
  app.post('/api/setup/openemr', isAuthenticated, isAdmin, async (req, res) => {
    const parsed = setupOpenEMRSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        message: "Some fields need attention.",
        errors: parsed.error.flatten().fieldErrors,
      });
    }

    try {
      const result = await registerOpenEMRClient(parsed.data);
      res.status(201).json({
        clientId: result.clientId,
        redirectUri: result.redirectUri,
        clientsPageUrl: `${parsed.data.openemrUrl}/interface/smart/admin-client.php`,
      });
    } catch (error) {
      if (error instanceof OpenEMRRegistrationError) {
        return res.status(502).json({ message: error.message });
      }
      console.error("[Setup] OpenEMR registration failed:", error);
      res.status(500).json({ message: "Registration failed. Check the server log for details." });
    }
  });

  // ---------- Referring provider self-registration (public) ----------

  // Look up an NPI in the national registry to pre-fill the form
  app.get('/api/register/npi/:npi', async (req, res) => {
    if (isRateLimited(req.ip || "unknown")) {
      return res.status(429).json({ message: "Too many attempts. Try again in a few minutes." });
    }
    await sendNpiLookup(String(req.params.npi || ""), res);
  });

  // Same lookup for the referral form's Referring Provider NPI (signed-in users)
  app.get('/api/npi/:npi', isAuthenticated, async (req, res) => {
    await sendNpiLookup(String(req.params.npi || ""), res);
  });

  // Create a referring provider account (inactive until staff approve it)
  app.post('/api/register', async (req, res) => {
    if (isRateLimited(req.ip || "unknown")) {
      return res.status(429).json({ message: "Too many attempts. Try again in a few minutes." });
    }

    const parsed = registerDoctorSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        message: "Some fields need attention.",
        errors: parsed.error.flatten().fieldErrors,
      });
    }
    const input = parsed.data;

    try {
      if (await storage.getUserByNpi(input.npi)) {
        return res.status(409).json({ message: "An account with this NPI already exists. Sign in instead." });
      }
      if ((await storage.getUserByEmail(input.email)) || (await storage.getUserByUsername(input.email))) {
        return res.status(409).json({ message: "An account with this email already exists. Sign in instead." });
      }

      // Confirm the NPI belongs to this person. If the registry is down, allow it;
      // staff still approve every account.
      try {
        const registry = await lookupNpi(input.npi);
        if (!registry) {
          return res.status(422).json({ message: "That NPI isn't in the national registry." });
        }
        if (registry.type !== "individual") {
          return res.status(422).json({ message: "That's an organization NPI. Use your individual NPI." });
        }
        if (registry.lastName.toLowerCase() !== input.lastName.toLowerCase()) {
          return res.status(422).json({
            message: `The last name doesn't match the NPI registry (${registry.lastName}).`,
          });
        }
      } catch (error) {
        console.warn("[Register] NPI registry unreachable, continuing without verification:", error);
      }

      const user = await storage.createDoctorUser(input);
      const synced = await syncProviderToOpenEMR(user);

      res.status(201).json({
        message: "Account created. You can sign in once our staff approve it.",
        openemrSynced: synced,
      });
    } catch (error) {
      console.error("[Register] Registration failed:", error);
      res.status(500).json({ message: "Registration failed. Try again, or call the office." });
    }
  });

  // Retry the OpenEMR Address Book sync for a provider account (admin)
  app.post('/api/users/:id/openemr-sync', isAuthenticated, isAdmin, async (req, res) => {
    const user = await storage.getUser(req.params.id);
    if (!user) return res.status(404).json({ message: "User not found" });
    if (user.isAdmin || !user.npi) {
      return res.status(400).json({ message: "Only referring provider accounts sync to OpenEMR." });
    }
    const synced = await syncProviderToOpenEMR(user);
    const updated = await storage.getUser(user.id);
    res.status(synced ? 200 : 502).json({
      synced,
      openemrProviderId: updated?.openemrProviderId ?? null,
      error: updated?.openemrSyncError ?? null,
    });
  });

  // Auth routes (do not use isAuthenticated middleware - handle unauthenticated gracefully)
  // Prevent caching of auth state - critical for mobile Safari
  app.get('/api/auth/user', async (req: any, res) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    
    try {
      // If not authenticated or session expired, return 200 with null user
      if (!req.isAuthenticated() || !req.user || !req.user.claims || !req.user.claims.sub) {
        return res.status(200).json({ user: null });
      }
      
      const userId = req.user.claims.sub;
      const user = await storage.getUser(userId);
      
      if (!user) {
        // User doesn't exist in DB yet - this shouldn't happen but handle gracefully
        return res.status(200).json({ user: null });
      }
      
      res.status(200).json({ user });
    } catch (error) {
      console.error("Error fetching user:", error);
      res.status(500).json({ message: "Failed to fetch user" });
    }
  });

  // OAuth Authorization Code Flow - Initiate OAuth (Admin only)
  app.get('/api/oauth/authorize', isAuthenticated, isAdmin, async (req: any, res) => {
    try {
      const config = getOpenEMRConfig();
      if (!config) {
        return res.redirect('/oauth/callback?error=not_configured');
      }

      // Generate random state for CSRF protection
      const state = randomBytes(32).toString('hex');
      
      // Store state in session with 10-minute expiration
      req.session.oauthState = {
        state,
        expiresAt: Date.now() + 10 * 60 * 1000,
      };

      // Explicitly save session before redirect to ensure state is persisted
      await new Promise<void>((resolve, reject) => {
        req.session.save((err: any) => {
          if (err) {
            console.error('[OAuth] Failed to save session:', err);
            reject(err);
          } else {
            console.log('[OAuth] Session saved successfully with state:', state.substring(0, 10) + '...');
            resolve();
          }
        });
      });

      // Must match the redirect URI the client was registered with
      const redirectUri = getOAuthRedirectUri();
      
      // Build authorization URL
      const authUrl = new URL(`${config.baseUrl}/oauth2/default/authorize`);
      authUrl.searchParams.set('response_type', 'code');
      authUrl.searchParams.set('client_id', config.clientId);
      authUrl.searchParams.set('redirect_uri', redirectUri);
      authUrl.searchParams.set('scope', OPENEMR_SCOPES);
      authUrl.searchParams.set('state', state);

      console.log('[OAuth] Starting authorization flow');
      console.log('[OAuth] Base URL:', config.baseUrl);
      console.log('[OAuth] Client ID:', config.clientId);
      console.log('[OAuth] Redirect URI:', redirectUri);
      console.log('[OAuth] Full authorization URL:', authUrl.toString());

      // Redirect user to OpenEMR consent screen
      res.redirect(authUrl.toString());
    } catch (error) {
      console.error("Error initiating OAuth:", error);
      res.redirect('/oauth/callback?error=server_error');
    }
  });

  // OAuth Authorization Code Flow - Handle callback
  app.get('/api/oauth/callback', async (req: any, res) => {
    try {
      const { code, state, error } = req.query;

      // Debug session and cookie state
      console.log('[OAuth Callback] Session ID:', req.sessionID);
      console.log('[OAuth Callback] Session oauthState:', req.session.oauthState ? 'present' : 'missing');
      console.log('[OAuth Callback] Received state:', state ? state.substring(0, 10) + '...' : 'none');
      console.log('[OAuth Callback] Cookie header:', req.headers.cookie || 'NO COOKIES SENT');
      console.log('[OAuth Callback] X-Forwarded-Proto:', req.headers['x-forwarded-proto'] || 'not set');
      console.log('[OAuth Callback] X-Forwarded-Host:', req.headers['x-forwarded-host'] || 'not set');
      console.log('[OAuth Callback] Secure connection:', req.secure);
      if (req.session.oauthState) {
        console.log('[OAuth Callback] Stored state:', req.session.oauthState.state.substring(0, 10) + '...');
      }

      // Check for OAuth error from OpenEMR
      if (error) {
        console.error("OAuth error from OpenEMR:", error);
        return res.redirect(`/oauth/callback?error=${encodeURIComponent(error)}`);
      }

      // Validate state for CSRF protection
      if (!req.session.oauthState || !state || req.session.oauthState.state !== state) {
        console.error("Invalid OAuth state - session may have been lost during redirect");
        console.error("Session keys:", Object.keys(req.session));
        return res.redirect('/oauth/callback?error=invalid_state');
      }

      // Check state expiration
      if (req.session.oauthState.expiresAt < Date.now()) {
        console.error("OAuth state expired");
        delete req.session.oauthState;
        return res.redirect('/oauth/callback?error=state_expired');
      }

      // Clear state after validation
      delete req.session.oauthState;

      // Validate code presence
      if (!code || typeof code !== 'string') {
        console.error("Missing authorization code");
        return res.redirect('/oauth/callback?error=missing_code');
      }

      // Build redirect URI (must match the one used in authorize)
      const redirectUri = getOAuthRedirectUri();

      // Exchange authorization code for access token
      const tokenResponse = await exchangeAuthorizationCode(code, redirectUri);

      // Token is cached in OpenEMR client, redirect to success page
      res.redirect('/oauth/callback?success=true');
    } catch (error) {
      console.error("Error handling OAuth callback:", error);
      res.redirect('/oauth/callback?error=token_exchange_failed');
    }
  });

  // Protected: Document upload endpoint (auth checked before body parsing)
  app.put("/objects/uploads/:objectId", [isAuthenticated, express.raw({ type: '*/*', limit: '10mb' })], async (req: express.Request, res: express.Response) => {
    try {
      const objectPath = `/objects/uploads/${req.params.objectId}`;
      const data = req.body as Buffer;
      await mockObjectStorage.storeDocument(objectPath, data);
      res.status(200).send();
    } catch (error) {
      console.error("Error storing document:", error);
      res.status(500).json({ error: "Failed to store document" });
    }
  });

  // Protected: Get all referrals (admin) or user's referrals
  app.get("/api/referrals", isAuthenticated, async (req: any, res) => {
    try {
      const user = req.user?.claims?.sub;
      if (!user) {
        return res.status(401).json({ error: "Unauthorized" });
      }
      
      const userData = await storage.getUser(user);
      let referrals;
      
      if (userData?.isAdmin) {
        // Admin sees all referrals
        referrals = await storage.getAllReferrals();
      } else {
        // Regular users see only their own referrals
        referrals = await storage.getReferralsByUserId(user);
      }
      
      res.json(referrals);
    } catch (error) {
      console.error("Error fetching referrals:", error);
      res.status(500).json({ error: "Failed to fetch referrals" });
    }
  });

  // Protected: Get specific referral by reference number (with ownership check)
  app.get("/api/referrals/:referenceNumber", isAuthenticated, async (req: any, res) => {
    try {
      const referral = await storage.getReferralByReferenceNumber(req.params.referenceNumber);
      if (!referral) {
        return res.status(404).json({ error: "Referral not found" });
      }
      
      // Authorization check: user must own the referral or be an admin
      const userId = req.user?.claims?.sub;
      if (!userId) {
        return res.status(401).json({ error: "Unauthorized" });
      }
      
      const userData = await storage.getUser(userId);
      const isOwner = referral.userId === userId;
      const isUserAdmin = userData?.isAdmin || false;
      
      if (!isOwner && !isUserAdmin) {
        return res.status(403).json({ error: "Forbidden: You don't have access to this referral" });
      }
      
      res.json(referral);
    } catch (error) {
      console.error("Error fetching referral:", error);
      res.status(500).json({ error: "Failed to fetch referral" });
    }
  });

  // Protected: Create new referral
  app.post("/api/referrals", isAuthenticated, async (req: any, res) => {
    try {
      const validatedData = insertReferralSchema.parse(req.body);
      const userId = req.user?.claims?.sub;
      if (!userId) {
        return res.status(401).json({ error: "Unauthorized" });
      }
      const referral = await storage.createReferral(validatedData, userId);
      
      // Automatic sync to OpenEMR (don't block referral creation if sync fails)
      const config = getOpenEMRConfig();
      if (config) {
        // Run sync asynchronously without blocking response
        (async () => {
          let syncError: string | null = null;
          let originalError: any = null;
          
          try {
            console.log(`[Auto-Sync] Syncing referral ${referral.referenceNumber} to OpenEMR`);
            const syncResult = await pushReferralToOpenEMR(referral);
            
            // Handle success case - save IDs and mark as synced
            if (syncResult.success) {
              await storage.updateReferralOpenEMRIds(
                referral.id,
                syncResult.patientFhirId,
                syncResult.patientPid,
                syncResult.encounterId || null
              );
              
              if (syncResult.documentIds && syncResult.documentIds.length > 0) {
                await storage.updateReferralDocumentIds(referral.id, syncResult.documentIds);
              }
              
              await storage.updateReferralSyncStatus(referral.id, 'synced', null);
              console.log(`[Auto-Sync] ✓ Referral ${referral.referenceNumber} synced successfully - Patient ID: ${syncResult.patientFhirId}, Encounter ID: ${syncResult.encounterId || 'N/A'}`);
            }
            // Handle partial case - save patient IDs but mark as partial
            else if (syncResult.partial) {
              await storage.updateReferralOpenEMRIds(
                referral.id,
                syncResult.patientFhirId,
                syncResult.patientPid,
                null // No encounter ID on partial sync
              );
              
              if (syncResult.documentIds && syncResult.documentIds.length > 0) {
                await storage.updateReferralDocumentIds(referral.id, syncResult.documentIds);
              }
              
              syncError = syncResult.error || 'Encounter creation failed';
              await storage.updateReferralSyncStatus(referral.id, 'partial', syncError);
              console.log(`[Auto-Sync] ⚠ Referral ${referral.referenceNumber} partially synced - Patient created but encounter failed: ${syncError}`);
            }
            // Handle complete failure - clear IDs and mark as failed
            else {
              syncError = syncResult.error || 'Sync failed';
              await storage.clearReferralOpenEMRIds(referral.id);
              await storage.updateReferralSyncStatus(referral.id, 'failed', syncError);
              console.error(`[Auto-Sync] ✗ Referral ${referral.referenceNumber} sync failed: ${syncError}`);
            }
          } catch (error: any) {
            originalError = error;
            syncError = error.userMessage || error.message || 'Unknown sync error';
            console.error(`[Auto-Sync] ✗ Failed to sync referral ${referral.referenceNumber}:`, syncError, originalError);
            
            try {
              // Clear any stale IDs and mark as failed
              await storage.clearReferralOpenEMRIds(referral.id);
              await storage.updateReferralSyncStatus(referral.id, 'failed', syncError);
            } catch (storageError) {
              console.error(`[Auto-Sync] ✗ Critical: Failed to update failure status for ${referral.referenceNumber}:`, storageError);
            }
          }
        })();
      }
      
      res.status(201).json({ referenceNumber: referral.referenceNumber });
    } catch (error) {
      console.error("Error creating referral:", error);
      if (error instanceof Error && error.name === "ZodError") {
        return res.status(400).json({ error: "Invalid referral data" });
      }
      res.status(500).json({ error: "Failed to create referral" });
    }
  });

  // Protected: Generate upload URL for documents
  app.post("/api/objects/upload", isAuthenticated, async (_req, res) => {
    try {
      const uploadURL = await mockObjectStorage.getObjectEntityUploadURL();
      res.json({ uploadURL });
    } catch (error) {
      console.error("Error generating upload URL:", error);
      res.status(500).json({ error: "Failed to generate upload URL" });
    }
  });

  // Protected: Register uploaded document
  app.post("/api/documents/register", isAuthenticated, async (req, res) => {
    try {
      if (!req.body.documentURL) {
        return res.status(400).json({ error: "documentURL is required" });
      }

      const normalizedPath = mockObjectStorage.normalizeObjectEntityPath(
        req.body.documentURL
      );

      await mockObjectStorage.trySetObjectEntityAclPolicy(
        req.body.documentURL,
        {
          owner: "system",
          visibility: "public",
        }
      );

      res.status(200).json({
        documentPath: normalizedPath,
      });
    } catch (error) {
      console.error("Error registering document:", error);
      res.status(500).json({ error: "Failed to register document" });
    }
  });

  app.get("/objects/:objectPath(*)", async (req, res) => {
    try {
      await mockObjectStorage.downloadObject(req.path, res);
    } catch (error) {
      console.error("Error accessing object:", error);
      return res.sendStatus(500);
    }
  });

  // ---------- Referral documents ----------

  // Upload one file (raw body). It stays unattached until the referral is submitted.
  app.post("/api/documents", [isAuthenticated, express.raw({ type: "*/*", limit: DOCUMENT_MAX_BYTES })], async (req: any, res: Response) => {
    try {
      const userId = req.user?.claims?.sub;
      const contentType = String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
      const rawName = String(req.headers["x-file-name"] || "");
      let fileName = "";
      try { fileName = decodeURIComponent(rawName).trim(); } catch { /* bad encoding */ }
      fileName = fileName.replace(/[\\/]/g, "_").slice(0, 200);
      const data = req.body;

      if (!fileName) return res.status(400).json({ message: "The file needs a name." });
      if (!DOCUMENT_TYPES[contentType]) {
        return res.status(415).json({ message: `"${fileName}" isn't a supported file type. Use PDF, an image, Word or text.` });
      }
      if (!Buffer.isBuffer(data) || data.length === 0) {
        return res.status(400).json({ message: `"${fileName}" is empty.` });
      }

      const doc = await storage.createDocument({
        userId,
        fileName,
        contentType,
        size: data.length,
        content: data.toString("base64"),
      });

      // Clean up files from forms that were never submitted
      storage.deleteStaleUnattachedDocuments(new Date(Date.now() - 24 * 60 * 60 * 1000))
        .catch((error) => console.error("[Documents] Cleanup failed:", error));

      res.status(201).json(doc);
    } catch (error) {
      console.error("[Documents] Upload failed:", error);
      res.status(500).json({ message: "Upload failed. Try again." });
    }
  });

  // Remove a file from the form before submitting it
  app.delete("/api/documents/:id", isAuthenticated, async (req: any, res) => {
    const removed = await storage.deleteUnattachedDocument(req.params.id, req.user?.claims?.sub);
    if (!removed) return res.status(404).json({ message: "File not found, or it's already part of a referral." });
    res.status(204).send();
  });

  // Download a file
  app.get("/api/documents/:id/file", isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user?.claims?.sub;
      const doc = await storage.getDocument(req.params.id);
      if (!doc) return res.status(404).json({ message: "File not found" });

      const encounter = doc.encounterId ? await storage.getEncounterById(doc.encounterId) : undefined;
      const allowed = doc.userId === userId || (encounter ? await canAccessEncounter(userId, encounter) : false);
      if (!allowed) return res.status(403).json({ message: "Forbidden" });

      res.set({
        "Content-Type": doc.contentType,
        "Content-Disposition": contentDisposition(doc.fileName),
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
      });
      res.send(Buffer.from(doc.content, "base64"));
    } catch (error) {
      console.error("[Documents] Download failed:", error);
      res.status(500).json({ message: "Download failed" });
    }
  });

  // Files on a referral, with their OpenEMR status
  app.get("/api/encounters/:referenceNumber/documents", isAuthenticated, async (req: any, res) => {
    const encounter = await storage.getEncounterByReferenceNumber(req.params.referenceNumber);
    if (!encounter) return res.status(404).json({ message: "Encounter not found" });
    if (!(await canAccessEncounter(req.user?.claims?.sub, encounter))) {
      return res.status(403).json({ message: "Forbidden" });
    }
    res.json(await storage.getDocumentsForEncounter(encounter.id));
  });

  // Resend the files that didn't reach OpenEMR (admin)
  app.post("/api/encounters/:referenceNumber/documents/sync", isAuthenticated, isAdmin, async (req, res) => {
    try {
      const encounter = await storage.getEncounterByReferenceNumber(req.params.referenceNumber);
      if (!encounter) return res.status(404).json({ message: "Encounter not found" });
      const patient = await storage.getPatientById(encounter.patientId);
      if (!patient?.openemrPatientPid) {
        return res.status(409).json({ message: "Sync the patient to OpenEMR first." });
      }
      const result = await syncEncounterDocuments(encounter.id, patient.openemrPatientPid);
      res.status(result.failed ? 502 : 200).json({
        ...result,
        message: result.failed
          ? `${result.failed} file(s) didn't upload: ${result.error}`
          : result.uploaded ? `Uploaded ${result.uploaded} file(s) to OpenEMR.` : "All files are already in OpenEMR.",
      });
    } catch (error) {
      console.error("[Documents] Resync failed:", error);
      res.status(500).json({ message: "Couldn't send the files to OpenEMR." });
    }
  });

  // Patient API Endpoints

  // Protected: Get all patients (respects user access)
  app.get("/api/patients", isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user?.claims?.sub;
      if (!userId) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      const userData = await storage.getUser(userId);
      const isUserAdmin = userData?.isAdmin || false;

      // Admin sees all patients, regular users see only patients they submitted
      const patients = isUserAdmin
        ? await storage.getAllPatients()
        : await storage.getPatientsForUser(userId);

      res.json(patients);
    } catch (error) {
      console.error("Error fetching patients:", error);
      res.status(500).json({ error: "Failed to fetch patients" });
    }
  });

  // Protected: Search patients by name
  app.get("/api/patients/search", isAuthenticated, async (req: any, res) => {
    try {
      const { q } = req.query;
      if (!q || typeof q !== 'string') {
        return res.status(400).json({ error: "Search query is required" });
      }
      const patients = await storage.findPatientsByName(q);
      res.json(patients);
    } catch (error) {
      console.error("Error searching patients:", error);
      res.status(500).json({ error: "Failed to search patients" });
    }
  });

  // Protected: Get patient by ID (with ownership check)
  app.get("/api/patients/:id", isAuthenticated, async (req: any, res) => {
    try {
      const patient = await storage.getPatientById(req.params.id);
      if (!patient) {
        return res.status(404).json({ error: "Patient not found" });
      }

      // Authorization check: user must own at least one encounter for this patient or be an admin
      const userId = req.user?.claims?.sub;
      if (!userId) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      const userData = await storage.getUser(userId);
      const isUserAdmin = userData?.isAdmin || false;

      if (!isUserAdmin) {
        // Check if user has any encounters for this patient
        const encounters = await storage.getEncountersByPatientId(req.params.id);
        const userOwnsPatient = encounters.some(e => e.userId === userId);
        
        if (!userOwnsPatient) {
          return res.status(403).json({ error: "Forbidden: You don't have access to this patient" });
        }
      }

      res.json(patient);
    } catch (error) {
      console.error("Error fetching patient:", error);
      res.status(500).json({ error: "Failed to fetch patient" });
    }
  });

  // Protected: Create new patient
  app.post("/api/patients", isAuthenticated, async (req: any, res) => {
    try {
      const validatedData = insertPatientSchema.parse(req.body);
      const patient = await storage.createPatient(validatedData);
      res.json(patient);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: "Validation error", details: error.errors });
      }
      console.error("Error creating patient:", error);
      res.status(500).json({ error: "Failed to create patient" });
    }
  });

  // Protected: Sync patient to OpenEMR
  app.post("/api/patients/:id/sync-openemr", isAuthenticated, async (req: any, res) => {
    try {
      const patient = await storage.getPatientById(req.params.id);
      if (!patient) {
        return res.status(404).json({ error: "Patient not found" });
      }

      // Check if OpenEMR is configured
      const config = getOpenEMRConfig();
      if (!config) {
        return res.status(400).json({ error: "OpenEMR is not configured" });
      }

      // If patient already has OpenEMR ID, check if they exist
      if (patient.openemrPatientId) {
        // Try to verify the patient exists in OpenEMR
        try {
          const existingPatient = await getPatient(patient.openemrPatientId);
          if (existingPatient) {
            return res.json({ 
              success: true, 
              message: "Patient already synced to OpenEMR",
              patientFhirId: patient.openemrPatientId,
              patientPid: patient.openemrPid,
              alreadySynced: true
            });
          }
        } catch (error) {
          // Patient doesn't exist in OpenEMR, clear the IDs and create new
          console.log(`[Patient Sync] Patient ${patient.id} has stale OpenEMR ID, will create new`);
        }
      }

      // Create patient in OpenEMR
      console.log(`[Patient Sync] Creating patient ${patient.firstName} ${patient.lastName} in OpenEMR`);
      
      const result = await createPatient({
        firstName: patient.firstName,
        lastName: patient.lastName,
        dateOfBirth: patient.dateOfBirth,
        gender: patient.gender || "unknown",
        email: patient.email || undefined,
        phone: patient.phone || undefined,
      });

      // Update local patient with OpenEMR IDs
      await storage.updatePatientOpenEMRIds(patient.id, result.fhirId, result.pid);

      console.log(`[Patient Sync] Patient synced successfully - FHIR ID: ${result.fhirId}, PID: ${result.pid}`);

      res.json({
        success: true,
        message: "Patient synced to OpenEMR successfully",
        patientFhirId: result.fhirId,
        patientPid: result.pid,
      });
    } catch (error: any) {
      console.error("[Patient Sync] Error syncing patient:", error);
      res.status(500).json({ 
        error: "Failed to sync patient to OpenEMR",
        message: error.message || "Unknown error"
      });
    }
  });

  // Protected: Get encounters for a patient (with ownership check)
  app.get("/api/patients/:id/encounters", isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user?.claims?.sub;
      if (!userId) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      const encounters = await storage.getEncountersByPatientId(req.params.id);
      
      // Authorization check: user must own at least one encounter for this patient or be an admin
      const userData = await storage.getUser(userId);
      const isUserAdmin = userData?.isAdmin || false;

      if (!isUserAdmin) {
        // Filter to only show encounters owned by this user
        const userEncounters = encounters.filter(e => e.userId === userId);
        res.json(userEncounters.map(redactEncounter));
      } else {
        // Admin sees all encounters for this patient
        res.json(encounters.map(redactEncounter));
      }
    } catch (error) {
      console.error("Error fetching patient encounters:", error);
      res.status(500).json({ error: "Failed to fetch encounters" });
    }
  });

  // Encounter API Endpoints

  // Protected: Get all encounters (respects user access)
  app.get("/api/encounters", isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user?.claims?.sub;
      if (!userId) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      const userData = await storage.getUser(userId);
      const isUserAdmin = userData?.isAdmin || false;

      // Admin sees all encounters, regular users see only their own
      const encounters = isUserAdmin
        ? await storage.getAllEncounters()
        : await storage.getEncountersByUserId(userId);

      res.json(encounters.map(redactEncounter));
    } catch (error) {
      console.error("Error fetching encounters:", error);
      res.status(500).json({ error: "Failed to fetch encounters" });
    }
  });

  // Protected: Get encounter by reference number (with ownership check)
  app.get("/api/encounters/:referenceNumber", isAuthenticated, async (req: any, res) => {
    try {
      const encounter = await storage.getEncounterByReferenceNumber(req.params.referenceNumber);
      if (!encounter) {
        return res.status(404).json({ error: "Encounter not found" });
      }

      // Authorization check: user must own the encounter or be an admin
      const userId = req.user?.claims?.sub;
      if (!userId) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      const userData = await storage.getUser(userId);
      const isOwner = encounter.userId === userId;
      const isUserAdmin = userData?.isAdmin || false;

      if (!isOwner && !isUserAdmin) {
        return res.status(403).json({ error: "Forbidden: You don't have access to this encounter" });
      }

      res.json(redactEncounter(encounter));
    } catch (error) {
      console.error("Error fetching encounter:", error);
      res.status(500).json({ error: "Failed to fetch encounter" });
    }
  });

  // Protected: Create new encounter
  app.post("/api/encounters", isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user?.claims?.sub;
      if (!userId) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      const { patientId, documentIds: rawDocumentIds, ...encounterData } = req.body;
      
      if (!patientId || typeof patientId !== "string") {
        return res.status(400).json({ error: "Valid patient ID is required" });
      }

      const documentIds = z.array(z.string()).max(DOCUMENT_MAX_FILES).optional().safeParse(rawDocumentIds);
      if (!documentIds.success) {
        return res.status(400).json({ error: `Attach at most ${DOCUMENT_MAX_FILES} files.` });
      }

      // Verify patient exists
      const patient = await storage.getPatientById(patientId);
      if (!patient) {
        return res.status(404).json({ error: "Patient not found" });
      }

      // Validate encounter data using schema (already omits auto-generated fields)
      const validatedEncounterData = insertEncounterSchema.parse(encounterData);

      const encounter = await storage.createEncounter(
        validatedEncounterData,
        patientId,
        userId
      );
      const attachedDocuments = await storage.attachDocumentsToEncounter(documentIds.data || [], userId, encounter.id);

      // Auto-sync to OpenEMR (async, non-blocking)
      // This runs in the background and doesn't block the response
      let syncStatus = "not_synced";
      let syncError: string | null = null;
      let originalError: any = null;
      
      try {
        console.log(`[Auto-Sync] Syncing encounter ${encounter.referenceNumber} to OpenEMR`);
        const submitter = await storage.getUser(userId);
        const syncResult = await pushEncounterToOpenEMR(patient, encounter, {
          referringProviderId: submitter?.openemrProviderId,
        });
        
        // Handle success case - save IDs and mark as synced
        if (syncResult.success) {
          // Update patient with OpenEMR IDs if they were newly created
          if (syncResult.updatedPatient) {
            await storage.updatePatientOpenEMRIds(
              patient.id,
              syncResult.patientFhirId,
              syncResult.patientPid
            );
            console.log(`[Auto-Sync] Saved OpenEMR patient IDs: ${syncResult.patientFhirId}, ${syncResult.patientPid}`);
          }
          
          // Update encounter with OpenEMR encounter ID
          if (syncResult.encounterId) {
            await storage.updateEncounterOpenEMRIds(
              encounter.id,
              syncResult.encounterId
            );
          }
          
          syncStatus = syncResult.partial ? "partial" : "synced";
          syncError = syncResult.error || null;

          // Attached files go to the patient's documents in OpenEMR
          if (attachedDocuments > 0) {
            const docs = await syncEncounterDocuments(encounter.id, syncResult.patientPid);
            if (docs.failed > 0) {
              syncStatus = "partial";
              const docError = `${docs.failed} of ${attachedDocuments} document(s) didn't reach OpenEMR: ${docs.error}`;
              syncError = syncError ? `${syncError} ${docError}` : docError;
            }
          }
          
          await storage.updateEncounterSyncStatus(
            encounter.id,
            syncStatus,
            syncError
          );
          
          console.log(`[Auto-Sync] Successfully synced encounter to OpenEMR (status: ${syncStatus})`);
        } else {
          // Handle failure case
          syncStatus = "failed";
          syncError = syncResult.error || "Unknown sync error";
          await storage.updateEncounterSyncStatus(
            encounter.id,
            syncStatus,
            syncError
          );
          console.log(`[Auto-Sync] Sync failed: ${syncError}`);
        }
      } catch (error: any) {
        // Catch sync errors but don't fail the encounter creation
        console.error(`[Auto-Sync] Error syncing encounter to OpenEMR:`, error);
        syncStatus = "failed";
        syncError = error.message || "Failed to sync to OpenEMR";
        originalError = error;
        
        await storage.updateEncounterSyncStatus(
          encounter.id,
          syncStatus,
          syncError
        );
      }

      // Send email notification (async, non-blocking)
      try {
        const settings = await storage.getSystemSettings();
        if (settings?.notificationEmail) {
          await emailService.sendReferralNotification(encounter, patient, settings.notificationEmail);
        }
      } catch (error) {
        console.error("Error sending email notification:", error);
        // Don't fail the request - email sending is optional
      }

      // Fetch the updated encounter with sync status from storage
      const updatedEncounter = await storage.getEncounterByReferenceNumber(encounter.referenceNumber);
      res.json(redactEncounter(updatedEncounter || encounter));
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ 
          error: "Validation error", 
          details: error.errors.map(e => ({
            path: e.path.join('.'),
            message: e.message,
          }))
        });
      }
      console.error("Error creating encounter:", error);
      res.status(500).json({ error: "Failed to create encounter" });
    }
  });

  // Settings Endpoints

  // Protected: Get system settings
  app.get("/api/settings", isAuthenticated, isAdmin, async (_req, res) => {
    try {
      const settings = await storage.getSystemSettings();
      res.json(settings || { id: "singleton", notificationEmail: null });
    } catch (error) {
      console.error("Error fetching settings:", error);
      res.status(500).json({ error: "Failed to fetch settings" });
    }
  });

  // Protected: Update system settings
  app.patch("/api/settings", isAuthenticated, isAdmin, async (req: any, res) => {
    try {
      const validated = updateSystemSettingsSchema.parse(req.body);
      const updated = await storage.updateSystemSettings(validated.notificationEmail || null);
      res.json(updated);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({
          error: "Validation error",
          details: error.errors.map(e => ({
            path: e.path.join('.'),
            message: e.message,
          }))
        });
      }
      console.error("Error updating settings:", error);
      res.status(500).json({ error: "Failed to update settings" });
    }
  });

  // User Management Endpoints (Admin only, for standalone mode)
  
  // Validation schemas for user management
  const createUserSchema = z.object({
    username: z.string().min(3, "Username must be at least 3 characters").max(50),
    email: z.string().email().optional().or(z.literal("")),
    password: z.string().min(6, "Password must be at least 6 characters"),
    firstName: z.string().max(100).optional(),
    lastName: z.string().max(100).optional(),
    isAdmin: z.boolean().optional(),
  });
  
  const updateUserSchema = z.object({
    email: z.string().email().optional().or(z.literal("")).nullable(),
    password: z.string().min(6, "Password must be at least 6 characters").optional().refine(
      (val) => val === undefined || val.length >= 6,
      { message: "Password must be at least 6 characters" }
    ),
    firstName: z.string().max(100).optional().nullable(),
    lastName: z.string().max(100).optional().nullable(),
    isAdmin: z.boolean().optional(),
    isActive: z.boolean().optional(),
  });

  // Protected: Get all users
  app.get("/api/users", isAuthenticated, isAdmin, async (_req, res) => {
    try {
      const allUsers = await storage.getAllUsers();
      const safeUsers = allUsers.map(({ passwordHash, ...user }) => user);
      res.json(safeUsers);
    } catch (error) {
      console.error("Error fetching users:", error);
      res.status(500).json({ error: "Failed to fetch users" });
    }
  });

  // Protected: Create new user
  app.post("/api/users", isAuthenticated, isAdmin, async (req: any, res) => {
    try {
      const validated = createUserSchema.parse(req.body);
      
      const existingUser = await storage.getUserByUsername(validated.username);
      if (existingUser) {
        return res.status(400).json({ error: "Username already exists" });
      }
      
      const newUser = await storage.createUserWithPassword({
        username: validated.username,
        email: validated.email || undefined,
        password: validated.password,
        firstName: validated.firstName || undefined,
        lastName: validated.lastName || undefined,
        isAdmin: validated.isAdmin || false,
      });
      
      const { passwordHash, ...safeUser } = newUser;
      console.log(`✅ New user created: ${validated.username}`);
      res.status(201).json(safeUser);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({
          error: "Validation error",
          details: error.errors.map(e => ({
            path: e.path.join('.'),
            message: e.message,
          }))
        });
      }
      console.error("Error creating user:", error);
      res.status(500).json({ error: "Failed to create user" });
    }
  });

  // Protected: Update user
  app.patch("/api/users/:id", isAuthenticated, isAdmin, async (req: any, res) => {
    try {
      const { id } = req.params;
      const userId = req.user?.claims?.sub;
      const validated = updateUserSchema.parse(req.body);
      
      // Prevent admins from removing their own admin status
      if (id === userId && validated.isAdmin === false) {
        return res.status(400).json({ error: "Cannot remove your own admin privileges" });
      }
      
      // Prevent admins from deactivating themselves
      if (id === userId && validated.isActive === false) {
        return res.status(400).json({ error: "Cannot deactivate your own account" });
      }
      
      // Ensure at least one admin remains when demoting or deactivating an admin
      if (validated.isAdmin === false || validated.isActive === false) {
        const targetUser = await storage.getUser(id);
        if (targetUser?.isAdmin && targetUser?.isActive) {
          const allUsers = await storage.getAllUsers();
          const activeAdmins = allUsers.filter(u => u.isAdmin && u.isActive && u.id !== id);
          if (activeAdmins.length === 0) {
            const action = validated.isAdmin === false ? "demote" : "deactivate";
            return res.status(400).json({ error: `Cannot ${action} the last active admin. At least one active admin must remain.` });
          }
        }
      }
      
      const updatedUser = await storage.updateUserById(id, {
        email: validated.email ?? undefined,
        password: validated.password,
        firstName: validated.firstName ?? undefined,
        lastName: validated.lastName ?? undefined,
        isAdmin: validated.isAdmin,
        isActive: validated.isActive,
      });
      
      const { passwordHash, ...safeUser } = updatedUser;
      console.log(`✅ User updated: ${id}`);
      res.json(safeUser);
    } catch (error: any) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({
          error: "Validation error",
          details: error.errors.map(e => ({
            path: e.path.join('.'),
            message: e.message,
          }))
        });
      }
      console.error("Error updating user:", error);
      if (error.message?.includes("not found")) {
        return res.status(404).json({ error: "User not found" });
      }
      res.status(500).json({ error: "Failed to update user" });
    }
  });

  // Protected: Delete user
  app.delete("/api/users/:id", isAuthenticated, isAdmin, async (req: any, res) => {
    try {
      const { id } = req.params;
      const userId = req.user?.claims?.sub;
      
      if (id === userId) {
        return res.status(400).json({ error: "Cannot delete your own account" });
      }
      
      // Ensure at least one admin remains when deleting an admin
      const targetUser = await storage.getUser(id);
      if (targetUser?.isAdmin && targetUser?.isActive) {
        const allUsers = await storage.getAllUsers();
        const activeAdmins = allUsers.filter(u => u.isAdmin && u.isActive && u.id !== id);
        if (activeAdmins.length === 0) {
          return res.status(400).json({ error: "Cannot delete the last active admin. At least one active admin must remain." });
        }
      }
      
      await storage.deleteUserById(id);
      console.log(`✅ User deleted: ${id}`);
      res.json({ success: true, message: "User deleted successfully" });
    } catch (error) {
      console.error("Error deleting user:", error);
      res.status(500).json({ error: "Failed to delete user" });
    }
  });

  // ICD-10 Code Search Endpoints

  // Public: Search ICD-10 codes
  app.get("/api/icd10/search", async (req, res) => {
    try {
      const query = req.query.q as string || "";
      const results = searchICD10Codes(query);
      res.json(results);
    } catch (error) {
      console.error("Error searching ICD-10 codes:", error);
      res.status(500).json({ error: "Failed to search ICD-10 codes" });
    }
  });

  // OpenEMR Integration Endpoints

  // Protected: Test OpenEMR connection
  app.get("/api/openemr/status", isAuthenticated, isAdmin, async (_req, res) => {
    try {
      const config = getOpenEMRConfig();
      if (!config) {
        return res.json({
          configured: false,
          connected: false,
          message: "OpenEMR credentials not configured",
        });
      }

      const connected = await testConnection();
      
      // Test specific endpoints
      const endpointTests = {
        patientRead: false,
        patientSearch: false,
        patientReadError: null as string | null,
        patientSearchError: null as string | null,
        encounterFhir: false,
        encounterRest: false,
        encounterError: null as string | null
      };
      
      if (connected) {
        // Test Patient READ endpoint (get single patient)
        try {
          await import("./openemr/client").then(m => m.openEMRRequest("/apis/default/fhir/Patient?_count=1", { method: "GET" }));
          endpointTests.patientRead = true;
          console.log("✓ Patient READ endpoint working");
        } catch (e: any) {
          endpointTests.patientReadError = e.message;
          console.log("✗ Patient READ endpoint failed:", e.message);
        }
        
        // Test Patient SEARCH endpoint
        try {
          await import("./openemr/client").then(m => m.openEMRRequest("/apis/default/fhir/Patient?given=Test&_count=1", { method: "GET" }));
          endpointTests.patientSearch = true;
          console.log("✓ Patient SEARCH endpoint working");
        } catch (e: any) {
          endpointTests.patientSearchError = e.message;
          console.log("✗ Patient SEARCH endpoint failed:", e.message);
        }
        
        // Test FHIR Encounter endpoint
        try {
          await import("./openemr/client").then(m => m.openEMRRequest("/apis/default/fhir/Encounter?_count=1", { method: "GET" }));
          endpointTests.encounterFhir = true;
          console.log("✓ FHIR Encounter endpoint working");
        } catch (e: any) {
          console.log("✗ FHIR Encounter endpoint failed:", e.message);
        }
        
        // Test REST Encounter endpoint
        try {
          await import("./openemr/client").then(m => m.openEMRRequest("/apis/default/api/encounter", { method: "GET" }));
          endpointTests.encounterRest = true;
          console.log("✓ REST Encounter endpoint working");
        } catch (e: any) {
          endpointTests.encounterError = e.message;
          console.log("✗ REST Encounter endpoint failed:", e.message);
        }
      }
      
      // Build detailed status message
      let statusMessage = "";
      let statusDetails = "";
      
      if (!connected) {
        statusMessage = "Failed to connect to OpenEMR";
        statusDetails = "Check OpenEMR base URL and credentials";
      } else if (endpointTests.patientRead && endpointTests.patientSearch) {
        if (endpointTests.encounterFhir || endpointTests.encounterRest) {
          statusMessage = "All APIs working - full sync available";
          statusDetails = "Patient and Encounter endpoints are functional";
        } else {
          statusMessage = "Patient API working - partial sync available";
          statusDetails = "Encounter API not enabled. Sync will create/update patients but cannot create encounters.";
        }
      } else {
        statusMessage = "OpenEMR API has errors";
        if (endpointTests.patientReadError) {
          statusDetails = `Patient API error: ${endpointTests.patientReadError}`;
        } else if (endpointTests.patientSearchError) {
          statusDetails = `Patient Search error: ${endpointTests.patientSearchError}`;
        } else {
          statusDetails = "Check OpenEMR logs for details";
        }
      }
      
      res.json({
        configured: true,
        connected,
        baseUrl: config.baseUrl,
        endpoints: endpointTests,
        message: statusMessage,
        details: statusDetails
      });
    } catch (error) {
      console.error("Error checking OpenEMR status:", error);
      res.status(500).json({ error: "Failed to check OpenEMR status" });
    }
  });

  // Protected: Search for patients in OpenEMR
  app.get("/api/openemr/patients/search", isAuthenticated, isAdmin, async (req, res) => {
    try {
      const { firstName, lastName, dateOfBirth } = req.query;
      
      const patients = await searchPatients(
        firstName as string | undefined,
        lastName as string | undefined,
        dateOfBirth as string | undefined
      );

      res.json({ patients });
    } catch (error: any) {
      if (error.status !== undefined) {
        const statusCode = error.status === 0 ? 503 : error.status >= 500 ? 502 : error.status;
        return res.status(statusCode).json({
          error: "OpenEMR request failed",
          message: error.userMessage || error.message,
          retryable: error.retryable,
        });
      }
      console.error("Error searching OpenEMR patients:", error);
      res.status(500).json({ error: "Failed to search patients" });
    }
  });

  // Protected: Sync specific referral to OpenEMR
  app.post("/api/openemr/sync/:referenceNumber", isAuthenticated, isAdmin, async (req, res) => {
    try {
      const referral = await storage.getReferralByReferenceNumber(req.params.referenceNumber);
      
      if (!referral) {
        return res.status(404).json({ error: "Referral not found" });
      }

      // Validate required fields before syncing
      const diagnosisTrimmed = referral.diagnosis?.trim() || '';
      if (!diagnosisTrimmed) {
        await storage.updateReferralSyncStatus(
          referral.id, 
          'failed', 
          'Diagnosis is required for OpenEMR sync. Please add a diagnosis and try again.'
        );
        return res.status(400).json({
          error: "Validation failed",
          message: "Diagnosis is required for OpenEMR sync. Please add a diagnosis and try again.",
          retryable: false,
        });
      }

      // Push to OpenEMR (returns SyncResult with partial status if needed)
      const result = await pushReferralToOpenEMR(referral);

      // Save patient IDs even for partial sync (so retry can reuse them)
      await storage.updateReferralOpenEMRIds(
        referral.id,
        result.patientFhirId,
        result.patientPid,
        result.encounterId || null
      );

      // Save document IDs if any were uploaded
      if (result.documentIds && result.documentIds.length > 0) {
        await storage.updateReferralDocumentIds(referral.id, result.documentIds);
      }

      // Set appropriate sync status
      if (result.success) {
        // Full success: patient and encounter created
        await storage.updateReferralSyncStatus(referral.id, 'synced', null);
        res.json({
          success: true,
          patientId: result.patientFhirId,
          encounterId: result.encounterId,
          documentsUploaded: result.documentIds?.length || 0,
        });
      } else if (result.partial) {
        // Partial success: patient created but encounter failed
        await storage.updateReferralSyncStatus(referral.id, 'partial', result.error || null);
        res.json({
          success: false,
          partial: true,
          patientId: result.patientFhirId,
          documentsUploaded: result.documentIds?.length || 0,
          message: result.error,
        });
      } else {
        // Should not happen, but handle gracefully
        await storage.updateReferralSyncStatus(referral.id, 'failed', 'Unknown error');
        res.status(500).json({
          error: "Unexpected sync result",
          message: "Unknown error",
          retryable: true,
        });
      }
    } catch (error: any) {
      const referral = await storage.getReferralByReferenceNumber(req.params.referenceNumber);
      
      // Determine error message and status code
      let errorMessage = "Failed to sync to OpenEMR";
      let userMessage = errorMessage;
      let statusCode = 502;
      
      if (error.status !== undefined) {
        // OpenEMR API error with status code
        statusCode = error.status === 0 ? 503 : error.status >= 500 ? 502 : error.status;
        errorMessage = error.message || errorMessage;
        // Use user-friendly message if available
        userMessage = error.userMessage || errorMessage;
      } else if (error.message) {
        // Generic error with message
        errorMessage = error.message;
        userMessage = errorMessage;
      }
      
      // Clear OpenEMR linkage and store error in database
      // This ensures failed syncs don't leave stale IDs from previous successes
      if (referral) {
        await storage.clearReferralOpenEMRIds(referral.id);
        // Store user-friendly message in database
        await storage.updateReferralSyncStatus(referral.id, 'failed', userMessage);
      }
      
      console.error("Error syncing referral to OpenEMR:", errorMessage);
      
      res.status(statusCode).json({
        error: "Failed to sync to OpenEMR",
        message: userMessage,
        retryable: true,
      });
    }
  });

  // Protected: Pull encounters from OpenEMR
  app.post("/api/openemr/pull-encounters", isAuthenticated, isAdmin, async (req: any, res) => {
    try {
      // Pull encounters from OpenEMR
      console.log("[Pull Encounters] Starting pull from OpenEMR...");
      const encounters = await pullEncountersFromOpenEMR();
      
      if (encounters.length === 0) {
        return res.json({
          success: true,
          message: "No new encounters found in OpenEMR",
          patientsCreated: 0,
          encountersCreated: 0,
        });
      }

      let patientsCreated = 0;
      let encountersCreated = 0;
      const errors: string[] = [];

      // Process each encounter
      for (const item of encounters) {
        try {
          // Find or create patient by OpenEMR patient ID
          let patient = await storage.findPatientByOpenEMRId(item.patient.openemrPatientId);
          
          if (!patient) {
            // Check for duplicate patients using deduplication fingerprint
            const duplicates = await storage.findDuplicatePatients(
              item.patient.firstName,
              item.patient.lastName,
              item.patient.dateOfBirth
            );
            
            if (duplicates.length > 0) {
              // Use existing patient found by deduplication
              patient = duplicates[0];
              console.log(`[Pull Encounters] Found duplicate patient via fingerprint: ${patient.firstName} ${patient.lastName}`);
              
              // Update the existing patient with OpenEMR IDs
              await storage.updatePatientOpenEMRIds(
                patient.id,
                item.patient.openemrPatientId,
                item.patient.openemrPatientPid || ""
              );
            } else {
              // Create new patient
              console.log(`[Pull Encounters] Creating patient from OpenEMR: ${item.patient.firstName} ${item.patient.lastName}`);
              patient = await storage.createPatient({
                firstName: item.patient.firstName,
                lastName: item.patient.lastName,
                dateOfBirth: item.patient.dateOfBirth,
                gender: item.patient.gender,
                email: item.patient.email || "",
                phone: item.patient.phone || "",
                primaryLanguage: item.patient.primaryLanguage,
                insurancePlan: item.patient.insurancePlan,
                policyNumber: item.patient.policyNumber,
                groupNumber: item.patient.groupNumber,
                effectiveDate: item.patient.effectiveDate,
              });
              
              // Update patient with OpenEMR IDs
              await storage.updatePatientOpenEMRIds(
                patient.id,
                item.patient.openemrPatientId,
                item.patient.openemrPatientPid || ""
              );
              patientsCreated++;
            }
          } else {
            console.log(`[Pull Encounters] Found existing patient: ${patient.firstName} ${patient.lastName}`);
          }

          // Check if encounter already exists by OpenEMR encounter ID
          const existingEncounter = await storage.findEncounterByOpenEMRId(item.encounter.openemrEncounterId);
          
          if (existingEncounter) {
            console.log(`[Pull Encounters] Encounter ${item.encounter.openemrEncounterId} already exists, skipping`);
            continue;
          }

          // Create encounter with system ownership marker
          // NOTE: OpenEMR encounters are marked as SYSTEM_IMPORT because we cannot reliably
          // map OpenEMR practitioners to local user accounts. However, we now preserve the
          // OpenEMR practitioner information for display and tracking purposes.
          console.log(`[Pull Encounters] Creating encounter from OpenEMR for patient ${patient.id}`);
          const encounter = await storage.createEncounter(
            {
              diagnosis: item.encounter.diagnosis,
              urgency: item.encounter.urgency,
              medicalHistory: item.encounter.medicalHistory,
              currentMedications: item.encounter.currentMedications,
              icd10Code: item.encounter.icd10Code,
              referralReason: item.encounter.referralReason,
              referringProvider: item.encounter.referringProvider || "Unknown Provider",
              providerContact: item.encounter.providerContact || "",
              status: "submitted",
            },
            patient.id,
            "SYSTEM_IMPORT" // System marker for OpenEMR imports
          );

          // Update encounter with OpenEMR ID, practitioner info, sync status, and original submission date
          await storage.updateEncounterOpenEMRIds(encounter.id, item.encounter.openemrEncounterId);
          
          // Store practitioner information if available
          if (item.encounter.openemrPractitioner || item.encounter.openemrPractitionerId) {
            await storage.updateEncounterPractitionerInfo(
              encounter.id,
              item.encounter.openemrPractitioner || null,
              item.encounter.openemrPractitionerId || null
            );
          }
          
          await storage.updateEncounterSyncStatus(encounter.id, "synced", null);
          await storage.updateEncounterSubmittedAt(encounter.id, item.encounter.submittedAt);
          
          encountersCreated++;
        } catch (error: any) {
          console.error("[Pull Encounters] Error processing encounter:", error);
          const errorMessage = `Patient: ${item.patient.firstName} ${item.patient.lastName} - ${error.message}`;
          errors.push(errorMessage);
          continue;
        }
      }

      // If all encounters failed, return 502 Bad Gateway
      if (encountersCreated === 0 && errors.length > 0) {
        return res.status(502).json({
          success: false,
          error: "Failed to import any encounters from OpenEMR",
          message: `All ${encounters.length} encounter(s) failed to import. Check the errors for details.`,
          patientsCreated: 0,
          encountersCreated: 0,
          errors,
        });
      }

      res.json({
        success: true,
        message: `Successfully pulled ${encountersCreated} encounter(s) from OpenEMR${errors.length > 0 ? ` (${errors.length} failed)` : ''}`,
        patientsCreated,
        encountersCreated,
        errors: errors.length > 0 ? errors : undefined,
      });
    } catch (error: any) {
      console.error("[Pull Encounters] Error pulling encounters from OpenEMR:", error);
      res.status(500).json({
        success: false,
        error: "Failed to pull encounters from OpenEMR",
        message: error.message || "Unknown error",
      });
    }
  });

  // Reconcile encounters with OpenEMR (Admin only)
  // Deletes local encounters that don't exist in OpenEMR
  app.post('/api/openemr/reconcile-encounters', isAuthenticated, isAdmin, async (req: any, res) => {
    try {
      console.log("[Reconcile Encounters] Starting reconciliation...");

      // Fetch all encounter IDs from OpenEMR
      const { openemrEncounterIds, errors } = await reconcileEncountersWithOpenEMR();
      
      if (errors.length > 0) {
        return res.status(502).json({
          success: false,
          error: "Failed to fetch encounters from OpenEMR",
          message: errors.join("; "),
          deletedCount: 0,
        });
      }

      console.log(`[Reconcile Encounters] Found ${openemrEncounterIds.length} encounters in OpenEMR`);

      // Get all local encounters
      const localEncounters = await storage.getAllEncounters();
      console.log(`[Reconcile Encounters] Found ${localEncounters.length} local encounters`);

      // Find encounters to delete
      const encountersToDelete: string[] = [];
      
      for (const encounter of localEncounters) {
        // Delete if:
        // 1. Has no OpenEMR ID (never synced)
        // 2. Has OpenEMR ID but it doesn't exist in OpenEMR anymore (deleted)
        if (!encounter.openemrEncounterId) {
          console.log(`[Reconcile] Marking unsynced encounter ${encounter.referenceNumber} for deletion`);
          encountersToDelete.push(encounter.id);
        } else if (!openemrEncounterIds.includes(encounter.openemrEncounterId)) {
          console.log(`[Reconcile] Marking deleted encounter ${encounter.referenceNumber} (OpenEMR ID: ${encounter.openemrEncounterId}) for deletion`);
          encountersToDelete.push(encounter.id);
        }
      }

      console.log(`[Reconcile Encounters] Deleting ${encountersToDelete.length} encounters`);

      // Delete encounters
      const deletedEncounterCount = await storage.deleteEncountersByIds(encountersToDelete);

      // Delete orphaned patients (patients with no encounters)
      console.log(`[Reconcile Encounters] Cleaning up orphaned patients...`);
      const deletedPatientCount = await storage.deleteOrphanedPatients();
      console.log(`[Reconcile Encounters] Deleted ${deletedPatientCount} orphaned patient(s)`);

      res.json({
        success: true,
        message: `Successfully cleaned up. Deleted ${deletedEncounterCount} encounter(s) and ${deletedPatientCount} orphaned patient(s).`,
        deletedCount: deletedEncounterCount,
        deletedPatientCount,
        openemrEncounterCount: openemrEncounterIds.length,
        localEncounterCount: localEncounters.length - deletedEncounterCount,
      });
    } catch (error: any) {
      console.error("[Reconcile Encounters] Error reconciling encounters:", error);
      res.status(500).json({
        success: false,
        error: "Failed to reconcile encounters",
        message: error.message || "Unknown error",
        deletedCount: 0,
      });
    }
  });

  // Make user admin by email (Admin only)
  app.post('/api/admin/users', isAuthenticated, isAdmin, async (req: any, res) => {
    try {
      const { email } = req.body;
      
      if (!email || typeof email !== 'string' || !email.includes('@')) {
        return res.status(400).json({ error: "Valid email is required" });
      }
      
      const user = await storage.makeUserAdmin(email);
      res.json({ success: true, user });
    } catch (error: any) {
      console.error("Error making user admin:", error);
      if (error.message.includes("not found")) {
        return res.status(404).json({ error: error.message });
      }
      res.status(500).json({ error: "Failed to make user admin", message: error.message });
    }
  });

  const httpServer = createServer(app);

  return httpServer;
}
