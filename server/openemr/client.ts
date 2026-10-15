import { z } from "zod";

// OpenEMR Configuration
export interface OpenEMRConfig {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
}

// OAuth2 Token Response
export interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token?: string;
}

// Cached token with expiration
let cachedToken: {
  accessToken: string;
  expiresAt: number;
  refreshToken?: string;
} | null = null;

// Promise to track in-flight token refresh (prevents concurrent refresh)
let tokenRefreshPromise: Promise<string | null> | null = null;

/**
 * Persist the refresh token to the database so the OpenEMR connection
 * survives container restarts. Imported lazily to avoid a circular import.
 */
async function persistRefreshToken(refreshToken: string | null): Promise<void> {
  try {
    const { storage } = await import("../storage");
    await storage.saveOpenEMRRefreshToken(refreshToken);
  } catch (error) {
    console.error("[OAuth] Failed to persist refresh token:", error);
  }
}

async function loadPersistedRefreshToken(): Promise<string | null> {
  try {
    const { storage } = await import("../storage");
    return await storage.getOpenEMRRefreshToken();
  } catch (error) {
    console.error("[OAuth] Failed to load persisted refresh token:", error);
    return null;
  }
}

// Everything this app asks OpenEMR for. The client is registered with exactly this
// list and authorize requests it again, so the two can never drift apart.
export const OPENEMR_SCOPES = [
  "openid", "offline_access", "api:oemr", "api:fhir",
  "user/Patient.read", "user/Patient.write", "user/patient.read", "user/patient.write",
  "user/Encounter.read", "user/encounter.read", "user/encounter.write",
  "user/Practitioner.read", "user/practitioner.read", "user/practitioner.write",
  "user/prescription.read",
  "user/medical_problem.read", "user/medical_problem.write",
  "user/medication.read", "user/medication.write",
  "user/insurance.read", "user/insurance.write",
  "user/insurance_company.read", "user/insurance_company.write",
  // Not used yet: referral documents will be uploaded to the patient chart
  "user/document.read", "user/document.write",
].join(" ");

// Fixed paths: OpenEMR's registration endpoint and this app's callback route
export const OPENEMR_REGISTRATION_PATH = "/oauth2/default/registration";
export const OAUTH_CALLBACK_PATH = "/api/oauth/callback";

// Client registered by the setup wizard, loaded from the database at startup.
// Kept in memory so getOpenEMRConfig() stays synchronous.
let savedClient: { baseUrl: string; appUrl: string; clientId: string; clientSecret: string } | null = null;

export async function loadOpenEMRClient(): Promise<void> {
  try {
    const { storage } = await import("../storage");
    const row = await storage.getOpenEMRClient();
    savedClient = row ?? null;
    if (row) console.log(`[OpenEMR] Using client "${row.clientName}" registered with ${row.baseUrl}`);
  } catch (error) {
    console.error("[OpenEMR] Failed to load saved client:", error);
  }
}

/**
 * Get OpenEMR configuration: the client saved by the setup wizard, otherwise
 * the OPENEMR_* environment variables (older installs).
 */
export function getOpenEMRConfig(): OpenEMRConfig | null {
  if (savedClient) {
    return {
      baseUrl: savedClient.baseUrl,
      clientId: savedClient.clientId,
      clientSecret: savedClient.clientSecret,
    };
  }

  const baseUrl = process.env.OPENEMR_BASE_URL;
  const clientId = process.env.OPENEMR_CLIENT_ID;
  const clientSecret = process.env.OPENEMR_CLIENT_SECRET;

  if (!baseUrl || !clientId || !clientSecret) {
    console.warn("OpenEMR credentials not configured. Sync features will be disabled.");
    return null;
  }

  return {
    baseUrl: baseUrl.replace(/\/+$/, ''), // Remove trailing slashes
    clientId,
    clientSecret,
  };
}

/**
 * The redirect URI OpenEMR sends the admin back to. It must match the one the
 * client was registered with, so prefer the address saved by the setup wizard.
 */
export function getOAuthRedirectUri(): string {
  if (savedClient) return `${savedClient.appUrl}${OAUTH_CALLBACK_PATH}`;

  const domain = process.env.APP_DOMAIN || process.env.REPLIT_DOMAINS?.split(',')[0];
  const protocol = process.env.APP_PROTOCOL || 'https';
  return domain
    ? `${protocol}://${domain}${OAUTH_CALLBACK_PATH}`
    : `http://localhost:5000${OAUTH_CALLBACK_PATH}`;
}

export class OpenEMRRegistrationError extends Error {}

/**
 * Register this app as a confidential OAuth client in OpenEMR (dynamic client
 * registration), then save the client so it replaces any earlier one.
 */
export async function registerOpenEMRClient(input: {
  openemrUrl: string;
  appUrl: string;
  clientName: string;
}): Promise<{ clientId: string; redirectUri: string }> {
  const redirectUri = `${input.appUrl}${OAUTH_CALLBACK_PATH}`;
  const registrationUrl = `${input.openemrUrl}${OPENEMR_REGISTRATION_PATH}`;

  console.log('[OpenEMR] Registering client', input.clientName, 'at', registrationUrl);

  let response: globalThis.Response;
  try {
    response = await fetch(registrationUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify({
        application_type: "private",
        client_name: input.clientName,
        redirect_uris: [redirectUri],
        token_endpoint_auth_method: "client_secret_post",
        scope: OPENEMR_SCOPES,
      }),
      signal: AbortSignal.timeout(20000),
    });
  } catch (error: any) {
    console.error("[OpenEMR] Registration request failed:", error?.message || error);
    throw new OpenEMRRegistrationError(
      `Couldn't reach OpenEMR at ${input.openemrUrl}. Check the address and that this server can reach it.`
    );
  }

  const text = await response.text();
  let data: any = null;
  try { data = JSON.parse(text); } catch { /* not JSON */ }

  if (!response.ok || !data?.client_id || !data?.client_secret) {
    console.error("[OpenEMR] Registration rejected:", response.status, text.slice(0, 500));
    if (response.status === 404) {
      throw new OpenEMRRegistrationError(
        "OpenEMR has no registration endpoint at that address. Check the address, and that the REST/FHIR APIs are turned on in OpenEMR (Administration > Config > Connectors)."
      );
    }
    const detail = data?.error_description || data?.error || `HTTP ${response.status}`;
    throw new OpenEMRRegistrationError(`OpenEMR refused the registration: ${detail}`);
  }

  const { storage } = await import("../storage");
  const row = await storage.saveOpenEMRClient({
    baseUrl: input.openemrUrl,
    appUrl: input.appUrl,
    clientName: input.clientName,
    clientId: data.client_id,
    clientSecret: data.client_secret,
  });
  savedClient = row;

  // Tokens from an earlier client are useless with the new one
  cachedToken = null;
  await persistRefreshToken(null);

  console.log('[OpenEMR] Client registered:', data.client_id);
  return { clientId: data.client_id, redirectUri };
}

/**
 * Get API base URL (strips /login suffix if present for API calls)
 */
export function getApiBaseUrl(): string {
  const config = getOpenEMRConfig();
  if (!config) {
    throw new Error("OpenEMR not configured");
  }
  
  // Strip /login suffix for API calls (OAuth uses full base URL, API doesn't)
  const apiBaseUrl = config.baseUrl.replace(/\/login$/, '');
  return apiBaseUrl;
}

/**
 * Exchange authorization code for access token (Authorization Code flow)
 * Caches token like other grant flows
 */
export async function exchangeAuthorizationCode(code: string, redirectUri: string): Promise<TokenResponse> {
  const config = getOpenEMRConfig();
  if (!config) {
    throw new Error("OpenEMR not configured");
  }

  const tokenUrl = `${config.baseUrl}/oauth2/default/token`;
  
  console.log('[OAuth] Exchanging authorization code for token');
  console.log('[OAuth] Token URL:', tokenUrl);
  console.log('[OAuth] Redirect URI:', redirectUri);
  console.log('[OAuth] Client ID:', config.clientId);
  console.log('[OAuth] Code length:', code.length);
  
  // For Authorization Code flow - use client_secret_post method (credentials in body)
  // OpenEMR typically expects this method
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: code,
    redirect_uri: redirectUri,
    client_id: config.clientId,
    client_secret: config.clientSecret,
  });
  
  console.log('[OAuth] Request body params:', {
    grant_type: body.get('grant_type'),
    code: code.substring(0, 20) + '...',
    redirect_uri: body.get('redirect_uri'),
    auth_method: 'client_secret_post',
    client_id: config.clientId,
    secret_length: config.clientSecret.length,
  });
  
  let response = await fetch(tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  // If client_secret_post fails, try client_secret_basic (header method)
  if (!response.ok) {
    const errorText = await response.text();
    console.log("[OAuth] client_secret_post failed, trying client_secret_basic:", errorText);
    
    // Try with Basic auth header instead
    const credentials = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64');
    const basicBody = new URLSearchParams({
      grant_type: "authorization_code",
      code: code,
      redirect_uri: redirectUri,
    });
    
    response = await fetch(tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Authorization": `Basic ${credentials}`,
      },
      body: basicBody,
    });
  }

  if (!response.ok) {
    const errorText = await response.text();
    console.error("[OAuth] Token exchange failed with both methods:", response.status);
    console.error("[OAuth] Error response:", errorText);
    throw new Error(`Token exchange failed: ${response.status} ${errorText}`);
  }

  const data = await response.json();
  
  // Log the full token response for debugging (excluding sensitive tokens)
  console.log('[OAuth] Token exchange successful!');
  console.log('[OAuth] Token type:', data.token_type);
  console.log('[OAuth] Expires in:', data.expires_in, 'seconds');
  console.log('[OAuth] Scopes GRANTED:', data.scope || 'NOT RETURNED IN RESPONSE');
  console.log('[OAuth] Has refresh token:', !!data.refresh_token);

  // Cache the token (subtract 60 seconds for safety margin)
  cachedToken = {
    accessToken: data.access_token,
    expiresAt: Date.now() + (data.expires_in - 60) * 1000,
    refreshToken: data.refresh_token,
  };

  if (data.refresh_token) {
    await persistRefreshToken(data.refresh_token);
  }

  return data as TokenResponse;
}

/**
 * Refresh access token using refresh token
 */
async function refreshAccessToken(): Promise<string | null> {
  const config = getOpenEMRConfig();
  if (!config || !cachedToken?.refreshToken) {
    console.error('[OAuth] Cannot refresh token: missing config or refresh token');
    return null;
  }

  try {
    const tokenUrl = `${config.baseUrl}/oauth2/default/token`;
    
    console.log('[OAuth] Refreshing access token using refresh token');
    
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: cachedToken.refreshToken,
      client_id: config.clientId,
      client_secret: config.clientSecret,
    });
    
    const response = await fetch(tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("[OAuth] Token refresh failed:", response.status, errorText);
      // Clear cached token on refresh failure
      cachedToken = null;
      // 400/401 means OpenEMR rejected the refresh token itself (expired or revoked),
      // so forget it. Other errors (e.g. OpenEMR down) keep it for the next attempt.
      if (response.status === 400 || response.status === 401) {
        await persistRefreshToken(null);
      }
      return null;
    }

    const data: TokenResponse = await response.json();

    // Cache the new token (subtract 60 seconds for safety margin)
    cachedToken = {
      accessToken: data.access_token,
      expiresAt: Date.now() + (data.expires_in - 60) * 1000,
      refreshToken: data.refresh_token || cachedToken.refreshToken, // Keep old refresh token if new one not provided
    };

    // OpenEMR rotates refresh tokens, so save the new one each time
    if (data.refresh_token) {
      await persistRefreshToken(data.refresh_token);
    }

    console.log('[OAuth] Token refreshed successfully');
    return data.access_token;
  } catch (error) {
    console.error("[OAuth] Error refreshing token:", error);
    cachedToken = null;
    return null;
  }
}

/**
 * Get access token (uses cached OAuth token and refreshes if needed)
 * Caches token until expiration and prevents concurrent token refresh
 */
export async function getAccessToken(): Promise<string | null> {
  const config = getOpenEMRConfig();
  if (!config) {
    return null;
  }

  // Return cached token if still valid
  if (cachedToken && cachedToken.expiresAt > Date.now()) {
    return cachedToken.accessToken;
  }

  // If a token refresh is already in progress, wait for it
  if (tokenRefreshPromise) {
    return tokenRefreshPromise;
  }

  // Start a new token refresh
  tokenRefreshPromise = (async () => {
    try {
      // After a restart the in-memory cache is empty; recover the saved refresh token
      if (!cachedToken?.refreshToken) {
        const savedRefreshToken = await loadPersistedRefreshToken();
        if (savedRefreshToken) {
          console.log('[OAuth] Restored saved refresh token from database');
          cachedToken = { accessToken: "", expiresAt: 0, refreshToken: savedRefreshToken };
        }
      }

      // Try to refresh using OAuth refresh token
      if (cachedToken?.refreshToken) {
        const token = await refreshAccessToken();
        if (token) {
          return token;
        }
      }
      
      // If refresh failed or no refresh token, user needs to re-authorize
      console.warn('[OAuth] No valid token available. User needs to connect OpenEMR again.');
      return null;
    } catch (error) {
      console.error("Error fetching OpenEMR access token:", error);
      return null;
    } finally {
      // Clear the in-flight promise
      tokenRefreshPromise = null;
    }
  })();

  return tokenRefreshPromise;
}

// API error types
export interface OpenEMRError {
  status: number;
  message: string;
  retryable: boolean;
  userMessage?: string;
}

/**
 * Convert technical OpenEMR errors into user-friendly messages
 */
function getUserFriendlyError(status: number, errorText: string): string {
  // Check for specific error patterns in the error text
  if (errorText.includes("createFromGlobals()")) {
    return "OpenEMR system is not properly configured. Please contact your system administrator to check the OpenEMR installation.";
  }
  
  // Status 0 typically means network/timeout error or configuration issue
  // Check errorText for more specific information
  if (status === 0) {
    // Check for missing configuration
    const textLower = errorText.toLowerCase();
    if (textLower.includes("not configured") || textLower.includes("not set up") || 
        textLower.includes("missing") && (textLower.includes("credential") || textLower.includes("oauth"))) {
      return "OpenEMR integration is not set up. Please configure your OpenEMR credentials (base URL, client ID, and client secret).";
    }
    // Check for OAuth/authentication errors
    if (textLower.includes("scope") || textLower.includes("oauth") || textLower.includes("authenticate")) {
      return "OAuth authentication error: insufficient permissions. Please check that your OpenEMR credentials have the required scopes.";
    }
    // Check for timeout
    if (textLower.includes("timeout") || textLower.includes("etimedout")) {
      return "Connection timeout. OpenEMR server is not responding. Please try again later.";
    }
    // Check for connection refused
    if (textLower.includes("econnrefused") || textLower.includes("connection refused")) {
      return "Connection refused. OpenEMR server is not accessible. Please check the server URL and network settings.";
    }
    // Generic network error
    return "Network error occurred while connecting to OpenEMR. Please check your internet connection.";
  }
  
  // Use status code (not substring matching) for HTTP errors
  if (status === 404) {
    return "The requested OpenEMR feature is not available. Your OpenEMR installation may need to be updated or configured.";
  }
  
  if (status === 401) {
    return "Authentication failed with OpenEMR. Please check your credentials and try again.";
  }
  
  if (status === 403) {
    return "Access denied. Your OpenEMR account may not have the required permissions.";
  }
  
  if (status === 400 || status === 422) {
    return "Invalid data sent to OpenEMR. Please check that all required fields are filled correctly.";
  }
  
  if (status >= 500) {
    return "OpenEMR server is experiencing technical difficulties. Please try again later or contact your system administrator.";
  }
  
  // Default message for other errors
  return "Unable to connect to OpenEMR. Please check your connection and try again.";
}

/**
 * Make an authenticated request to OpenEMR API
 * Returns result or throws OpenEMRError for proper error handling
 */
export async function openEMRRequest<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  const config = getOpenEMRConfig();
  if (!config) {
    throw {
      status: 0,
      message: "OpenEMR not configured",
      userMessage: "OpenEMR integration is not set up. Please contact your system administrator.",
      retryable: false,
    } as OpenEMRError;
  }

  const token = await getAccessToken();
  if (!token) {
    throw {
      status: 0,
      message: "Failed to obtain access token",
      userMessage: "Unable to authenticate with OpenEMR. Please try again later.",
      retryable: true,
    } as OpenEMRError;
  }

  try {
    // Use API base URL (without /login suffix) for API calls
    const apiBaseUrl = getApiBaseUrl();
    const url = `${apiBaseUrl}${endpoint}`;
    
    console.log(`[OpenEMR API] ${options.method || 'GET'} ${url}`);
    
    const response = await fetch(url, {
      ...options,
      headers: {
        ...options.headers,
        "Authorization": `Bearer ${token}`,
        "Accept": "application/json",
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`OpenEMR API request failed: ${endpoint}`, response.status, errorText);
      
      // Expire the access token on 401 to force a refresh on next request,
      // but keep the refresh token so we don't lose the connection
      if (response.status === 401 && cachedToken) {
        cachedToken = { ...cachedToken, expiresAt: 0 };
      }
      
      // Determine if error is retryable
      const retryable = response.status === 401 || response.status === 429 || response.status >= 500;
      
      // Get user-friendly error message
      const userMessage = getUserFriendlyError(response.status, errorText);
      
      throw {
        status: response.status,
        message: `API request failed: ${response.status} ${errorText}`,
        userMessage,
        retryable,
      } as OpenEMRError;
    }

    return await response.json();
  } catch (error) {
    if ((error as OpenEMRError).status !== undefined) {
      throw error;
    }
    console.error(`Error making OpenEMR request to ${endpoint}:`, error);
    throw {
      status: 0,
      message: `Network error: ${error}`,
      userMessage: "Network error occurred while connecting to OpenEMR. Please check your internet connection.",
      retryable: true,
    } as OpenEMRError;
  }
}

/**
 * Test OpenEMR connection
 */
export async function testConnection(): Promise<boolean> {
  const config = getOpenEMRConfig();
  if (!config) {
    console.log("❌ OpenEMR not configured");
    return false;
  }

  const token = await getAccessToken();
  if (!token) {
    console.log("❌ Failed to obtain OpenEMR access token");
    return false;
  }

  console.log("✅ OpenEMR connection successful");
  return true;
}

/**
 * Check which OpenEMR APIs are available
 */
export async function checkAvailableAPIs(): Promise<{
  fhir: { available: boolean; resources: string[] };
  rest: { available: boolean; endpoints: string[] };
  errors: string[];
}> {
  const result = {
    fhir: { available: false, resources: [] as string[] },
    rest: { available: false, endpoints: [] as string[] },
    errors: [] as string[],
  };

  const config = getOpenEMRConfig();
  if (!config) {
    result.errors.push("OpenEMR not configured");
    return result;
  }

  const token = await getAccessToken();
  if (!token) {
    result.errors.push("Failed to obtain access token");
    return result;
  }

  const apiBaseUrl = getApiBaseUrl();

  // Check FHIR Capability Statement
  try {
    console.log("[OpenEMR Diag] Checking FHIR capability statement...");
    const fhirCapUrl = `${apiBaseUrl}/apis/default/fhir/metadata`;
    const fhirResponse = await fetch(fhirCapUrl, {
      headers: {
        "Authorization": `Bearer ${token}`,
        "Accept": "application/fhir+json",
      },
    });

    if (fhirResponse.ok) {
      const capStatement = await fhirResponse.json();
      result.fhir.available = true;
      
      // Extract available resources
      if (capStatement.rest?.[0]?.resource) {
        result.fhir.resources = capStatement.rest[0].resource
          .map((r: any) => r.type)
          .filter(Boolean);
      }
      console.log("[OpenEMR Diag] FHIR resources available:", result.fhir.resources.join(", "));
    } else {
      result.errors.push(`FHIR metadata returned ${fhirResponse.status}`);
    }
  } catch (error: any) {
    result.errors.push(`FHIR check failed: ${error.message}`);
  }

  // Check REST API endpoints
  const restEndpoints = [
    "/apis/default/api/patient",
    "/apis/default/api/encounter",
    "/apis/default/api/facility",
  ];

  for (const endpoint of restEndpoints) {
    try {
      const url = `${apiBaseUrl}${endpoint}`;
      const response = await fetch(url, {
        method: "GET",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Accept": "application/json",
        },
      });

      if (response.ok || response.status === 200) {
        result.rest.available = true;
        result.rest.endpoints.push(endpoint);
      }
    } catch (error) {
      // Silently skip failed endpoints
    }
  }

  console.log("[OpenEMR Diag] REST endpoints available:", result.rest.endpoints.join(", ") || "none");
  
  return result;
}
