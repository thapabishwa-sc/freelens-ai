import { createHash, randomBytes } from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { request as httpsRequest } from "node:https";
import { readFileSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import Anthropic from "@anthropic-ai/sdk";
import { logger } from "./logger";

// Node.js fetch that bypasses Chromium's CORS in Electron renderer
function nodeFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  return new Promise((resolve, reject) => {
    const url = typeof input === "string" ? new URL(input) : input instanceof URL ? input : new URL(input.url);
    if (url.protocol !== "https:") {
      reject(new Error(`Refusing non-HTTPS request to ${url.hostname}`));
      return;
    }
    const headers: Record<string, string> = {};
    if (init?.headers) {
      if (init.headers instanceof Headers) {
        init.headers.forEach((v, k) => { headers[k] = v; });
      } else if (!Array.isArray(init.headers)) {
        Object.assign(headers, init.headers);
      }
    }

    const req = httpsRequest(url, { method: init?.method || "GET", headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf-8");
        const responseHeaders: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers)) {
          if (typeof v === "string") responseHeaders[k] = v;
        }
        resolve(new Response(body, {
          status: res.statusCode || 200,
          statusText: res.statusMessage || "",
          headers: responseHeaders,
        }));
      });
    });

    req.on("error", reject);
    if (init?.body) req.write(typeof init.body === "string" ? init.body : String(init.body));
    req.end();
  });
}

// ── Types ──

export interface OAuthTokens {
  access_token: string;
  refresh_token: string;
  expires_at: number;
}

// ── OAuth PKCE Login ──

const OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const OAUTH_AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
const OAUTH_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const OAUTH_SCOPES = ["org:create_api_key", "user:profile", "user:inference", "user:sessions:claude_code", "user:mcp_servers"];
const OAUTH_REFRESH_SCOPES = ["user:profile", "user:inference", "user:sessions:claude_code", "user:mcp_servers"];
const OAUTH_TIMEOUT_MS = 5 * 60 * 1000;

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

export function openSystemBrowser(url: string): void {
  const platform = process.platform;
  if (platform === "darwin") {
    execFile("open", [url]);
  } else if (platform === "win32") {
    execFile("rundll32", ["url,OpenURL", url]);
  } else {
    execFile("xdg-open", [url]);
  }
}

let _pendingOAuth: {
  server: Server;
  timeout: ReturnType<typeof setTimeout>;
  abort: () => void;
} | null = null;

export async function startOAuthFlowAsync(): Promise<{ url: string; completion: Promise<OAuthTokens>; abort: () => void }> {
  if (_pendingOAuth) {
    _pendingOAuth.abort();
    _pendingOAuth = null;
  }

  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  const state = base64url(randomBytes(32));

  let resolvePromise!: (tokens: OAuthTokens) => void;
  let rejectPromise!: (err: Error) => void;

  const completion = new Promise<OAuthTokens>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });

  const server = createServer((req, res) => {
    if (!req.url?.startsWith("/callback")) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    const params = new URL(req.url, "http://localhost").searchParams;
    const code = params.get("code");
    const returnedState = params.get("state");

    if (!code) {
      res.writeHead(400, { "Content-Type": "text/html" });
      res.end("<html><body><h2>Authentication failed</h2><p>No authorization code received.</p></body></html>");
      cleanup();
      rejectPromise(new Error("No authorization code received."));
      return;
    }

    if (returnedState !== state) {
      res.writeHead(400, { "Content-Type": "text/html" });
      res.end("<html><body><h2>Authentication failed</h2><p>State mismatch — please try again.</p></body></html>");
      cleanup();
      rejectPromise(new Error("State mismatch — possible CSRF. Please try again."));
      return;
    }

    res.writeHead(200, { "Content-Type": "text/html" });
    res.end("<html><body style=\"font-family:system-ui;text-align:center;padding:60px\"><h2>Authenticated!</h2><p>You can close this tab and return to FreeLens.</p></body></html>");

    const port = (server.address() as { port: number }).port;
    exchangeCodeForTokens(code, port, verifier, state)
      .then((tokens) => { cleanup(); resolvePromise(tokens); })
      .catch((err) => { cleanup(); rejectPromise(err); });
  });

  const timeout = setTimeout(() => {
    cleanup();
    rejectPromise(new Error("Authentication timed out (5 min). Please try again."));
  }, OAUTH_TIMEOUT_MS);

  function cleanup() {
    clearTimeout(timeout);
    try { server.close(); } catch { /* ignore */ }
    _pendingOAuth = null;
  }

  const abort = () => {
    cleanup();
    rejectPromise(new Error("Authentication cancelled."));
  };

  const url = await new Promise<string>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      logger.info(`OAuth callback server listening on port ${port}`);
      const authUrl = new URL(OAUTH_AUTHORIZE_URL);
      authUrl.searchParams.append("code", "true");
      authUrl.searchParams.append("client_id", OAUTH_CLIENT_ID);
      authUrl.searchParams.append("response_type", "code");
      authUrl.searchParams.append("redirect_uri", `http://localhost:${port}/callback`);
      authUrl.searchParams.append("scope", OAUTH_SCOPES.join(" "));
      authUrl.searchParams.append("code_challenge", challenge);
      authUrl.searchParams.append("code_challenge_method", "S256");
      authUrl.searchParams.append("state", state);
      resolve(authUrl.toString());
    });
  });

  _pendingOAuth = { server, timeout, abort };

  return { url, completion, abort };
}

// ── Token Exchange ──

async function exchangeCodeForTokens(code: string, port: number, verifier: string, state: string): Promise<OAuthTokens> {
  const body = JSON.stringify({
    grant_type: "authorization_code",
    code,
    redirect_uri: `http://localhost:${port}/callback`,
    client_id: OAUTH_CLIENT_ID,
    code_verifier: verifier,
    state,
  });

  const res = await nodeFetch(OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });

  if (!res.ok) {
    const text = await res.text();
    logger.error("Token exchange failed:", res.status, text);
    throw new Error(`Token exchange failed (${res.status}).`);
  }

  const data = await res.json() as { access_token?: string; refresh_token?: string; expires_in?: number };

  if (!data.access_token) {
    logger.error("No access_token in response:", data);
    throw new Error("No access token received.");
  }

  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token || "",
    expires_at: Date.now() + ((data.expires_in || 28800) * 1000) - 60_000,
  };
}

async function refreshAccessToken(refreshToken: string): Promise<OAuthTokens> {
  const body = JSON.stringify({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: OAUTH_CLIENT_ID,
    scope: OAUTH_REFRESH_SCOPES.join(" "),
  });

  const res = await nodeFetch(OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });

  if (!res.ok) {
    const text = await res.text();
    logger.error("Token refresh failed:", res.status, text);
    throw new Error("Session expired. Please log in again.");
  }

  const data = await res.json() as { access_token?: string; refresh_token?: string; expires_in?: number };

  if (!data.access_token) {
    throw new Error("Session expired. Please log in again.");
  }

  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token || refreshToken,
    expires_at: Date.now() + ((data.expires_in || 28800) * 1000) - 60_000,
  };
}

// ── Client (lazy singleton) ──

let _client: Anthropic | null = null;
let _apiKey: string | null = null;
let _authToken: string | null = null;
let _refreshToken: string | null = null;
let _tokenExpiresAt: number = 0;

// ── Auth persistence: Keychain (macOS) with file fallback ──

const AUTH_DIR = join(homedir(), ".freelens-ai");
const AUTH_FILE = join(AUTH_DIR, "auth.json");
const KEYCHAIN_SERVICE = "FreeLens AI";
const KEYCHAIN_ACCOUNT = "freelens-ai";
const CLAUDE_CODE_KEYCHAIN_SERVICE = "Claude Code-credentials";

interface PersistedAuth {
  type: "oauth" | "apikey";
  authToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  apiKey?: string;
}

/** Synchronously run `security` CLI and return stdout, or null on failure */
function keychainReadSync(service: string): string | null {
  if (process.platform !== "darwin") return null;
  try {
    const result = execFileSync("security", ["find-generic-password", "-s", service, "-w"], {
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    logger.debug(`Keychain read "${service}": got ${result.length} chars`);
    return result;
  } catch (err: any) {
    logger.warn(`Keychain read "${service}" failed:`, err.message || err);
    return null;
  }
}

function keychainWriteSync(service: string, account: string, data: string): boolean {
  if (process.platform !== "darwin") return false;
  try {
    execFileSync("security", [
      "add-generic-password", "-U",
      "-s", service,
      "-a", account,
      "-w", data,
    ], { timeout: 5000, stdio: "ignore" });
    return true;
  } catch (err: any) {
    logger.warn(`Keychain write "${service}" failed:`, err.message || err);
    return false;
  }
}

function keychainDeleteSync(service: string): void {
  if (process.platform !== "darwin") return;
  try {
    execFileSync("security", ["delete-generic-password", "-s", service], {
      timeout: 5000,
      stdio: "ignore",
    });
  } catch { /* ignore if not exists */ }
}

/** Try to read Claude Code's OAuth credentials from the macOS Keychain */
function readClaudeCodeCredentials(): PersistedAuth | null {
  logger.debug("Attempting to read Claude Code credentials from Keychain...");
  const raw = keychainReadSync(CLAUDE_CODE_KEYCHAIN_SERVICE);
  if (!raw) {
    logger.debug("No Claude Code credentials found in Keychain");
    return null;
  }
  try {
    const data = JSON.parse(raw);
    const oauth = data?.claudeAiOauth;
    if (oauth?.accessToken && oauth?.refreshToken) {
      logger.debug("Found Claude Code credentials in Keychain");
      return {
        type: "oauth",
        authToken: oauth.accessToken,
        refreshToken: oauth.refreshToken,
        expiresAt: oauth.expiresAt || 0,
      };
    }
    logger.debug("Claude Code keychain data missing accessToken or refreshToken. Keys found:", Object.keys(data || {}));
  } catch (err: any) {
    logger.warn("Failed to parse Claude Code keychain data:", err.message);
  }
  return null;
}

/**
 * Read persisted auth. Priority:
 * 1. Our own Keychain entry ("FreeLens AI")
 * 2. Claude Code's Keychain entry ("Claude Code-credentials")
 * 3. File fallback (~/.freelens-ai/auth.json)
 */
function readAuthFile(): PersistedAuth | null {
  logger.debug("readAuthFile: checking auth sources...");

  // 1. Our keychain
  const kcRaw = keychainReadSync(KEYCHAIN_SERVICE);
  if (kcRaw) {
    try {
      const parsed = JSON.parse(kcRaw) as PersistedAuth;
      if ((parsed.type === "oauth" && parsed.authToken) || (parsed.type === "apikey" && parsed.apiKey)) {
        logger.debug("readAuthFile: found in FreeLens AI keychain (type:", parsed.type, ")");
        return parsed;
      }
    } catch { /* malformed */ }
  }

  // 2. Claude Code credentials
  const ccAuth = readClaudeCodeCredentials();
  if (ccAuth) {
    logger.debug("readAuthFile: using Claude Code credentials");
    return ccAuth;
  }

  // 3. File fallback
  try {
    const data = readFileSync(AUTH_FILE, "utf-8");
    const parsed = JSON.parse(data) as PersistedAuth;
    logger.debug("readAuthFile: found in file fallback (type:", parsed.type, ")");
    return parsed;
  } catch {
    logger.debug("readAuthFile: no auth found in any source");
    return null;
  }
}

function writeAuthFile(auth: PersistedAuth): void {
  // Try keychain first
  const json = JSON.stringify(auth);
  if (keychainWriteSync(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT, json)) {
    return;
  }

  // File fallback
  try {
    mkdirSync(AUTH_DIR, { recursive: true });
    writeFileSync(AUTH_FILE, json, { mode: 0o600 });
  } catch (err) {
    logger.warn("Failed to write auth file:", err);
  }
}

function removeAuthFile(): void {
  keychainDeleteSync(KEYCHAIN_SERVICE);
  try {
    unlinkSync(AUTH_FILE);
  } catch { /* ignore if not exists */ }
}

let _refreshPromise: Promise<void> | null = null;

export async function getClient(): Promise<Anthropic> {
  if (_authToken) {
    if (Date.now() >= _tokenExpiresAt && _refreshToken) {
      // Guard: only one refresh at a time — concurrent callers share the same promise
      if (!_refreshPromise) {
        _refreshPromise = refreshAccessToken(_refreshToken)
          .then((tokens) => {
            _authToken = tokens.access_token;
            _refreshToken = tokens.refresh_token;
            _tokenExpiresAt = tokens.expires_at;
            _client = null;
            writeAuthFile({
              type: "oauth",
              authToken: tokens.access_token,
              refreshToken: tokens.refresh_token,
              expiresAt: tokens.expires_at,
            });
          })
          .catch(() => {
            _authToken = null;
            _refreshToken = null;
            _tokenExpiresAt = 0;
            _client = null;
          })
          .finally(() => {
            _refreshPromise = null;
          });
      }
      await _refreshPromise;
      if (!_authToken) {
        throw new Error("Session expired. Please log in again.");
      }
    }
    if (!_client) {
      _client = new Anthropic({
        authToken: _authToken,
        fetch: nodeFetch,
        dangerouslyAllowBrowser: true,
        defaultHeaders: { "anthropic-beta": "oauth-2025-04-20" },
      });
    }
    return _client;
  }

  const key = _apiKey || process.env.ANTHROPIC_API_KEY;
  if (key) {
    if (!_client) {
      _client = new Anthropic({ apiKey: key, fetch: nodeFetch, dangerouslyAllowBrowser: true });
    }
    return _client;
  }

  throw new Error("Not authenticated. Click 'Login with Claude' or paste an API key.");
}

export function setApiKey(key: string): void {
  _apiKey = key;
  _authToken = null;
  _refreshToken = null;
  _tokenExpiresAt = 0;
  _client = null;
}

export function setAuthTokens(tokens: OAuthTokens): void {
  _authToken = tokens.access_token;
  _refreshToken = tokens.refresh_token;
  _tokenExpiresAt = tokens.expires_at;
  _apiKey = null;
  _client = null;
}

export function clearAuth(): void {
  _apiKey = null;
  _authToken = null;
  _refreshToken = null;
  _tokenExpiresAt = 0;
  _client = null;
}

export function isClaudeAvailable(): boolean {
  return !!(_authToken || _apiKey || process.env.ANTHROPIC_API_KEY);
}

export function loadPersistedAuth(): boolean {
  try {
    const auth = readAuthFile();
    if (auth?.type === "oauth" && auth.authToken && auth.refreshToken) {
      logger.info("Restored persisted OAuth tokens from", AUTH_FILE);
      setAuthTokens({
        access_token: auth.authToken,
        refresh_token: auth.refreshToken,
        expires_at: auth.expiresAt || 0,
      });
      return true;
    }
    if (auth?.type === "apikey" && auth.apiKey) {
      logger.info("Restored persisted API key from", AUTH_FILE);
      setApiKey(auth.apiKey);
      return true;
    }
    logger.info("No persisted auth found");
  } catch (err) {
    logger.warn("Failed to load persisted auth:", err);
  }
  return false;
}

export function persistOAuthTokens(tokens: OAuthTokens): void {
  writeAuthFile({
    type: "oauth",
    authToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: tokens.expires_at,
  });
  logger.info("OAuth tokens persisted to", AUTH_FILE);
}

export function persistApiKey(key: string): void {
  writeAuthFile({ type: "apikey", apiKey: key });
  logger.info("API key persisted to", AUTH_FILE);
}

export function clearPersistedAuth(): void {
  removeAuthFile();
}

/** Attempt to refresh the OAuth token. Returns true if successful. */
export async function tryRefreshAuth(): Promise<boolean> {
  if (!_refreshToken) return false;
  try {
    const tokens = await refreshAccessToken(_refreshToken);
    setAuthTokens(tokens);
    writeAuthFile({
      type: "oauth",
      authToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: tokens.expires_at,
    });
    return true;
  } catch {
    return false;
  }
}
