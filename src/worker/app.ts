import { Hono } from "hono";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import {
  apiError as buildApiError,
  type ApiErrorCode,
} from "../shared/contracts/common";
import {
  SessionViewSchema,
  SetupRequestSchema,
} from "../shared/contracts/admin";
import { getBootstrapConfig } from "./security/bootstrap-config";
import {
  applyApiSecurityHeaders,
  isMutationOriginAllowed,
} from "./security/headers";
import { readCanonicalOrigin } from "./auth/better-auth";
import { handleAuthRequest } from "./auth/routes";
import { runSetup } from "./auth/setup";
import { AuthError, getAuthSession, requireUser } from "./auth/session";
import {
  RequestTiming,
  setRequestHints,
  setRequestTiming,
  timedEnv,
} from "./timing";
import { createOAuthRouter } from "./drive/oauth/routes";
import { createCatalogRouter } from "./drive/catalog";
import { createContentRouter } from "./transfers/download";
import { createShareRouter } from "./security/shares";
import { createAdminRouter } from "./admin/routes";
import { createReadGrantsRouter } from "./admin/read-grants-routes";
import { createDriveFoldersRouter } from "./admin/drive-folders-routes";
import { createMaintenanceRouter } from "./admin/maintenance";
import { createDiagnosticsRouter } from "./admin/diagnostics";
import { createUploadRouter } from "./transfers/upload-routes";
import { createBatchRouter } from "./transfers/batches";
import { createFolderRouter } from "./transfers/folders";
import { createPackageRouter } from "./media/package-routes";
import { createSiteAdminRouter, createSiteRouter } from "./site/routes";
import { createPublicLinkAdminRouter } from "./public-links/admin-routes";
import { createPublicLinkRouter } from "./public-links/public-routes";

/**
 * Worker-first API surface (T01 foundation, T03 setup/auth).
 *
 * Before setup completes only health, setup status, the setup claim and the
 * static shell are reachable; every known protected API prefix below fails
 * closed (bootstrap secrets first, then setup state). Unknown API paths
 * always return a JSON 404 — they are never rewritten to the SPA shell.
 * Non-API paths are delegated to the ASSETS binding, whose single-page
 * application handling serves the shell; in production they never reach this
 * Worker at all (assets `run_worker_first` is scoped to /api).
 */

export type SetupState = "uninitialized" | "in_progress" | "complete";
export type SetupStateRead = SetupState | "unavailable";

const SETUP_STATES = new Set<string>(["uninitialized", "in_progress", "complete"]);

/**
 * Protected namespaces from spec section 10.2. Requests under these prefixes
 * require valid bootstrap secrets and a completed setup; any other /api path
 * falls through to the JSON 404.
 */
const PROTECTED_API_PREFIXES = [
  "/api/v1/mounts",
  "/api/v1/uploads",
  "/api/v1/upload-batches",
  "/api/v1/folders",
  "/api/v1/media-packages",
  "/api/v1/shares",
  "/api/v1/public-links",
  "/api/v1/p",
  "/api/v1/admin",
  "/api/v1/session",
  "/api/auth",
] as const;

// Setup surface itself needs valid secrets to validate the claim token.
const BOOTSTRAP_GATED_PATHS = new Set(["/api/v1/setup", "/api/v1/setup/status"]);

/**
 * Session-authenticated surfaces: the request-context middleware resolves
 * the app_settings row, the Better Auth session and the latency recorder
 * once per request for these prefixes. /api/v1/p and /api/v1/site are
 * deliberately excluded (anonymous public surface — no session lookup, no
 * Server-Timing ever), and /api/auth runs Better Auth's own session path.
 */
const SESSION_RESOLVED_PREFIXES = [
  "/api/v1/mounts",
  "/api/v1/uploads",
  "/api/v1/upload-batches",
  "/api/v1/folders",
  "/api/v1/media-packages",
  "/api/v1/shares",
  "/api/v1/public-links",
  "/api/v1/admin",
  "/api/v1/session",
] as const;

function isSessionResolvedPath(path: string): boolean {
  return SESSION_RESOLVED_PREFIXES.some(
    (prefix) => path === prefix || path.startsWith(`${prefix}/`),
  );
}

function isProtectedApiPath(path: string): boolean {
  return PROTECTED_API_PREFIXES.some(
    (prefix) => path === prefix || path.startsWith(`${prefix}/`),
  );
}

function isApiPath(path: string): boolean {
  return path === "/api" || path.startsWith("/api/");
}

function isMutationMethod(method: string): boolean {
  return method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
}

interface AppSettingsRow {
  id: number;
  setup_state: string;
  canonical_origin: string | null;
  version: number;
}

interface ErrorVariables {
  requestId: string;
  appSettings?: AppSettingsRead;
  actorIsAdmin?: boolean;
}

type AppContext = Context<{ Bindings: Env; Variables: ErrorVariables }>;

function apiError(
  c: AppContext,
  status: ContentfulStatusCode,
  code: ApiErrorCode,
  message: string,
  retryAfterSeconds?: number,
): Response {
  const requestId = c.get("requestId") ?? crypto.randomUUID();
  return c.json(buildApiError(code, message, requestId, retryAfterSeconds), status);
}

/**
 * Reads the app_settings singleton (id = 1) following the schema contract.
 * An absent row means "uninitialized". Any database error or malformed row is
 * reported as "unavailable" — never as uninitialized — so a query failure can
 * never silently reopen setup or unlock protected routes.
 */
export interface AppSettingsRead {
  readonly row: AppSettingsRow | null;
  /** True when the read itself failed — callers must fail closed. */
  readonly error: boolean;
}

/** Read the app_settings singleton row once; errors surface, never vanish. */
export async function readAppSettings(
  db: D1Database,
): Promise<AppSettingsRead> {
  try {
    const row = await db
      .prepare(
        "SELECT id, setup_state, canonical_origin, version FROM app_settings WHERE id = 1",
      )
      .first<AppSettingsRow>();
    return { row, error: false };
  } catch {
    return { row: null, error: true };
  }
}

function setupStateFromRead(read: AppSettingsRead): SetupStateRead {
  if (read.error) return "unavailable";
  const row = read.row;
  if (row === null) return "uninitialized";
  if (row.id !== 1 || typeof row.version !== "number" || !SETUP_STATES.has(row.setup_state)) {
    return "unavailable";
  }
  return row.setup_state as SetupState;
}

export async function readSetupState(db: D1Database): Promise<SetupStateRead> {
  return setupStateFromRead(await readAppSettings(db));
}

export function createApp() {
  const app = new Hono<{ Bindings: Env; Variables: ErrorVariables }>();

  // Request id + security headers on every API response.
  app.use("/api/*", async (c, next) => {
    c.set("requestId", crypto.randomUUID());
    await next();
    applyApiSecurityHeaders(c);
    const path = c.req.path;
    // Anonymous public-link surface: never indexable, never cached.
    if (path === "/api/v1/p" || path.startsWith("/api/v1/p/")) {
      c.header("X-Robots-Tag", "noindex");
    }
    // Thumbnails keep the short PRIVATE cache the route set — the global
    // no-store overwrote it (review M1). Private, never public: the bytes
    // passed session admission. Errors stay no-store.
    if (
      c.res.status === 200 &&
      /^\/api\/v1\/mounts\/[^/]+\/files\/[^/]+\/thumbnail$/.test(path)
    ) {
      c.header("Cache-Control", "private, max-age=300");
    }
    // The site logo is the one cacheable API response: restore the short
    // shared cache the global no-store overwrote, plus the SVG sandbox CSP.
    if (path === "/api/v1/site/logo") {
      c.header("Cache-Control", "public, max-age=300");
      if (c.res.headers.get("content-type") === "image/svg+xml") {
        c.header(
          "Content-Security-Policy",
          "default-src 'none'; style-src 'unsafe-inline'; sandbox",
        );
      }
    }
  });

  // Request context (wave 9): the settings row, session and latency
  // recorder resolve once here and are carried as per-request hints, so
  // the preamble of protected routes does not re-read them. /api/v1/p and
  // /api/v1/site are anonymous surfaces: no session work, no Server-Timing.
  app.use("/api/*", async (c, next) => {
    const path = c.req.path;
    const gated = BOOTSTRAP_GATED_PATHS.has(path) || isProtectedApiPath(path);
    if (!gated) return next();

    const sessionPath = isSessionResolvedPath(path);
    const timing = sessionPath ? new RequestTiming() : undefined;
    if (timing !== undefined) {
      setRequestTiming(c.req.raw, timing);
      // Every downstream c.env.DB access is counted through the timed
      // clone; consumers with env-keyed caches resolve the raw env via
      // rawEnvOf (better-auth.ts).
      c.env = timedEnv(c.env, timing);
    }
    const settings = await readAppSettings(c.env.DB);
    c.set("appSettings", settings);
    const canonicalOrigin =
      !settings.error && setupStateFromRead(settings) === "complete"
        ? (settings.row?.canonical_origin ?? null)
        : null;

    let isAdmin = false;
    if (sessionPath && canonicalOrigin !== null) {
      const bootstrap = getBootstrapConfig(c.env);
      if (bootstrap.ok) {
        // Origin hint lands first so the auth adapter does not re-read the
        // settings row the middleware just fetched.
        setRequestHints(c.req.raw, { canonicalOrigin, session: null });
        let session: Awaited<ReturnType<typeof getAuthSession>> | "error";
        try {
          session = await getAuthSession(c.req.raw, c.env);
        } catch {
          session = "error";
        }
        setRequestHints(c.req.raw, {
          canonicalOrigin,
          session,
        });
        isAdmin =
          typeof session === "object" &&
          session !== null &&
          session.user.role === "admin" &&
          !session.user.disabled;
      }
    } else if (sessionPath) {
      // Setup incomplete (or origin missing): downstream resolvers must
      // fail closed without a second settings read.
      setRequestHints(c.req.raw, { canonicalOrigin, session: null });
    }
    c.set("actorIsAdmin", isAdmin);

    await next();
    if (timing !== undefined && isAdmin) {
      const header = timing.render();
      if (header !== "") c.header("Server-Timing", header);
    }
  });

  // Bootstrap secrets gate: every known API surface except liveness fails
  // closed when APP_MASTER_KEY/SETUP_TOKEN are missing or malformed. Unknown
  // paths are not checked here — they get the 404 below either way.
  app.use("/api/*", async (c, next) => {
    const path = c.req.path;
    if (!BOOTSTRAP_GATED_PATHS.has(path) && !isProtectedApiPath(path)) return next();
    const bootstrap = getBootstrapConfig(c.env);
    if (!bootstrap.ok) {
      return apiError(
        c,
        503,
        "BOOTSTRAP_SECRETS_INVALID",
        "Worker bootstrap secrets are missing or malformed.",
      );
    }
    return next();
  });

  // Mutation origin check on /api/v1/* (Better Auth enforces its own
  // Origin/Fetch-Metadata policy under /api/auth). Foreign cross-site origins
  // are rejected before any state is touched; the trusted set is the pinned
  // canonical origin plus the request's own origin.
  app.use("/api/v1/*", async (c, next) => {
    if (!isMutationMethod(c.req.method)) return next();
    const settings = c.get("appSettings");
    const canonicalOrigin =
      settings !== undefined
        ? (!settings.error && setupStateFromRead(settings) === "complete"
            ? (settings.row?.canonical_origin ?? null)
            : null)
        : await readCanonicalOrigin(c.env.DB);
    if (!isMutationOriginAllowed(c.req.raw, canonicalOrigin)) {
      return apiError(
        c,
        403,
        "ORIGIN_REJECTED",
        "The request origin is not trusted.",
      );
    }
    return next();
  });

  // Setup-state gate on protected namespaces only: before setup completes they
  // stay closed, and a database error keeps the gate closed too.
  app.use("/api/*", async (c, next) => {
    if (!isProtectedApiPath(c.req.path)) return next();
    const settings =
      c.get("appSettings") ?? (await readAppSettings(c.env.DB));
    if (setupStateFromRead(settings) !== "complete") {
      return apiError(c, 503, "SETUP_REQUIRED", "Initial setup has not completed.");
    }
    return next();
  });

  app.get("/api/v1/health", (c) => c.json({ status: "ok" }));

  app.get("/api/v1/setup/status", async (c) => {
    const state = await readSetupState(c.env.DB);
    if (state === "unavailable") {
      return apiError(c, 503, "SETUP_STATUS_UNAVAILABLE", "Setup status could not be read.");
    }
    const canonicalOrigin =
      state === "complete" ? await readCanonicalOrigin(c.env.DB) : null;
    return c.json({ setupState: state, canonicalOrigin });
  });

  app.post("/api/v1/setup", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return apiError(c, 400, "VALIDATION_FAILED", "Request body must be JSON.");
    }
    const parsed = SetupRequestSchema.safeParse(body);
    if (!parsed.success) {
      return apiError(c, 400, "VALIDATION_FAILED", "Setup request is invalid.");
    }
    const outcome = await runSetup(c.env, parsed.data);
    if (!outcome.ok) {
      return apiError(c, outcome.status, outcome.code, outcome.message, outcome.retryAfterSeconds);
    }
    return c.json(outcome.status, 200);
  });

  // Current-session view for the SPA: the user view plus session expiry, no
  // credential material. Better Auth's own /api/auth/* endpoints are mounted
  // below; this is the credential-free application surface.
  app.get("/api/v1/session", async (c) => {
    try {
      const auth = await requireUser(c.req.raw, c.env);
      const view = SessionViewSchema.parse({
        user: auth.user,
        expiresAt: auth.expiresAt,
      });
      return c.json(view);
    } catch (err) {
      if (err instanceof AuthError) {
        return apiError(c, err.status, err.code, err.message);
      }
      throw err;
    }
  });

  // Better Auth routes: email/password sign-in/out, get-session and the admin
  // plugin's user-management surface. Public sign-up is disabled in the auth
  // config; JSON responses are scrubbed of credential material, and the
  // bootstrap/setup/mutation gates above still apply first.
  app.all("/api/auth/*", async (c) => handleAuthRequest(c.req.raw, c.env));

  // Track C's OAuth router (wave-2): paths are relative to
  // /api/v1/admin/google. The bootstrap, setup and mutation-origin
  // middleware above run first; every handler independently re-verifies the
  // admin session through requireAdmin and throws AuthError.
  app.route("/api/v1/admin/google", createOAuthRouter());
  app.route("/api/v1/admin/maintenance", createMaintenanceRouter());
  app.route("/api/v1/admin/diagnostics", createDiagnosticsRouter());
  app.route("/api/v1/admin/drive-folders", createDriveFoldersRouter());
  app.route("/api/v1/admin", createReadGrantsRouter());
  app.route("/api/v1/admin", createAdminRouter());

  app.route("/api/v1/mounts", createContentRouter());
  app.route("/api/v1/mounts", createCatalogRouter());
  app.route("/api/v1/shares", createShareRouter());
  app.route("/api/v1/uploads", createUploadRouter());
  app.route("/api/v1/upload-batches", createBatchRouter());
  app.route("/api/v1/folders", createFolderRouter());
  app.route("/api/v1/media-packages", createPackageRouter());

  // Wave-8 Phase B: /api/v1/site answers before setup (unprotected prefix,
  // defaults when the row is absent); /api/v1/p requires completed setup via
  // the gate above but runs no session check — the public routes ignore
  // session cookies by construction. Admin surfaces mount under the
  // existing /api/v1/admin + /api/v1/public-links protected prefixes.
  app.route("/api/v1/site", createSiteRouter());
  app.route("/api/v1/p", createPublicLinkRouter());
  app.route("/api/v1/public-links", createPublicLinkAdminRouter());
  app.route("/api/v1/admin", createSiteAdminRouter());

  app.notFound((c) => {
    if (isApiPath(c.req.path)) return apiError(c, 404, "NOT_FOUND", "Not found.");
    const assets = (c.env as { ASSETS?: Fetcher }).ASSETS;
    if (assets !== undefined) return assets.fetch(c.req.raw);
    return c.text("Not found", 404);
  });

  app.onError((err, c) => {
    if (isApiPath(c.req.path)) return apiError(c, 500, "INTERNAL_ERROR", "Internal error.");
    throw err;
  });

  return app;
}
