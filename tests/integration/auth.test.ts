import { env, exports } from "cloudflare:workers";
import {
  applyD1Migrations,
  type D1Migration,
} from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { ApiErrorBodySchema } from "../../src/shared/contracts/common";
import { SessionViewSchema } from "../../src/shared/contracts/admin";
import { AuthError, requireAdmin, requireUser } from "../../src/worker/auth/session";
import { getAuthInstance } from "../../src/worker/auth/session";

const worker = exports.default;
const TEST_MIGRATIONS = JSON.parse(
  (env as unknown as { TEST_MIGRATIONS: string }).TEST_MIGRATIONS,
) as D1Migration[];

// Matches vitest.config.ts miniflare bindings.
const SETUP_TOKEN = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=";
const ORIGIN = "http://worker.test";
const CANONICAL_ORIGIN = "https://worker.test";

const ADMIN = {
  token: SETUP_TOKEN,
  name: "Admin",
  email: "admin@example.test",
  password: "correct-horse-battery-staple",
  canonicalOrigin: CANONICAL_ORIGIN,
};

function api(path: string, init?: RequestInit): Promise<Response> {
  return worker.fetch(new Request(`${ORIGIN}${path}`, init));
}

async function completeSetup() {
  const res = await api("/api/v1/setup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(ADMIN),
  });
  expect(res.status).toBe(200);
}

async function signIn(email: string, password: string): Promise<Response> {
  return api("/api/auth/sign-in/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
}

/** Extract the session cookie header value from a sign-in response. */
function sessionCookie(res: Response): string {
  const cookies = res.headers.getSetCookie();
  const session = cookies.find((c) => c.includes("session_token="));
  expect(session, "sign-in sets a session cookie").toBeTruthy();
  return (session as string).split(";")[0]!;
}

async function resetState() {
  for (const table of [
    "app_settings",
    "setup_throttle",
    "user",
    "session",
    "account",
    "verification",
    "rateLimit",
  ]) {
    await env.DB.prepare(`DELETE FROM "${table}"`).run();
  }
}

beforeEach(async () => {
  await applyD1Migrations(env.DB, TEST_MIGRATIONS);
  await resetState();
});

describe("sign-in and session flow", () => {
  it("signs in with email/password, sets a Secure+HttpOnly+SameSite cookie and returns no token", async () => {
    await completeSetup();
    const res = await signIn(ADMIN.email, ADMIN.password);
    expect(res.status).toBe(200);

    const cookies = res.headers.getSetCookie();
    const session = cookies.find((c) => c.includes("session_token="));
    expect(session).toBeTruthy();
    expect(session).toContain("HttpOnly");
    expect(session).toContain("SameSite=Lax");
    expect(session).toContain("Secure");

    const body = (await res.json()) as Record<string, unknown>;
    // Credential scrub: the raw session token must never reach the client.
    expect(body.token).toBeUndefined();
    expect((body.user as Record<string, unknown>).role).toBe("admin");
    expect(JSON.stringify(body)).not.toContain('"token"');
  });

  it("returns a safe {session,user} projection from get-session", async () => {
    await completeSetup();
    const cookie = sessionCookie(await signIn(ADMIN.email, ADMIN.password));
    const res = await api("/api/auth/get-session", {
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      session: Record<string, unknown>;
      user: Record<string, unknown>;
    };
    expect(body.user.role).toBe("admin");
    expect(body.user.email).toBe(ADMIN.email);
    expect(body.session.id).toBeTruthy();
    expect(body.session.expiresAt).toBeTruthy();
    expect(body.session.token).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('"token"');
  });

  it("returns null from get-session when unauthenticated", async () => {
    await completeSetup();
    const res = await api("/api/auth/get-session");
    expect(res.status).toBe(200);
    expect(await res.json()).toBeNull();
  });

  it("serves the credential-free /api/v1/session view", async () => {
    await completeSetup();
    const cookie = sessionCookie(await signIn(ADMIN.email, ADMIN.password));
    const res = await api("/api/v1/session", { headers: { cookie } });
    expect(res.status).toBe(200);
    const view = SessionViewSchema.parse(await res.json());
    expect(view.user.role).toBe("admin");
    expect(view.user.email).toBe(ADMIN.email);
  });

  it("rejects /api/v1/session without a session", async () => {
    await completeSetup();
    const res = await api("/api/v1/session");
    expect(res.status).toBe(401);
    const body = ApiErrorBodySchema.parse(await res.json());
    expect(body.error.code).toBe("AUTH_REQUIRED");
  });

  it("rejects a wrong password", async () => {
    await completeSetup();
    const res = await signIn(ADMIN.email, "wrong-password-000");
    expect(res.status).toBe(401);
  });

  it("denies public sign-up", async () => {
    await completeSetup();
    const res = await api("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "intruder@example.test",
        password: "some-password-123",
        name: "Intruder",
      }),
    });
    expect(res.status).toBe(400);
    const users = await env.DB.prepare('SELECT COUNT(*) AS n FROM "user"').first<{
      n: number;
    }>();
    expect(users?.n).toBe(1);
  });

  it("signs out and invalidates the session", async () => {
    await completeSetup();
    const cookie = sessionCookie(await signIn(ADMIN.email, ADMIN.password));
    const out = await api("/api/auth/sign-out", {
      method: "POST",
      headers: { cookie, origin: CANONICAL_ORIGIN },
    });
    expect(out.status).toBe(200);
    const after = await api("/api/auth/get-session", { headers: { cookie } });
    expect(await after.json()).toBeNull();
  });

  it("rejects a mutation carrying a foreign Origin with a valid cookie", async () => {
    await completeSetup();
    const cookie = sessionCookie(await signIn(ADMIN.email, ADMIN.password));
    const res = await api("/api/auth/sign-out", {
      method: "POST",
      headers: { cookie, origin: "https://evil.example" },
    });
    expect(res.status).toBe(403);
    // The session must still be valid — the request never executed.
    const after = await api("/api/auth/get-session", { headers: { cookie } });
    expect((await after.json()) !== null).toBe(true);
  });

  it("rejects a /api/v1 mutation carrying a foreign Origin", async () => {
    await completeSetup();
    const res = await api("/api/v1/mounts", {
      method: "POST",
      headers: { origin: "https://evil.example" },
    });
    expect(res.status).toBe(403);
    const body = ApiErrorBodySchema.parse(await res.json());
    expect(body.error.code).toBe("ORIGIN_REJECTED");
  });

  it("writes durable rate-limit rows on sign-in attempts", async () => {
    await completeSetup();
    await signIn(ADMIN.email, "wrong-password-000");
    await signIn(ADMIN.email, "wrong-password-000");
    const rows = await env.DB.prepare('SELECT COUNT(*) AS n FROM "rateLimit"').first<{
      n: number;
    }>();
    expect(rows?.n ?? 0).toBeGreaterThan(0);
  });
});

describe("authorization helpers", () => {
  it("requireAdmin resolves the admin session to {userId, sessionId}", async () => {
    await completeSetup();
    const cookie = sessionCookie(await signIn(ADMIN.email, ADMIN.password));
    const request = new Request(`${ORIGIN}/api/v1/admin/google/connections`, {
      headers: { cookie },
    });
    const resolved = await requireAdmin(request, env);
    expect(resolved.userId).toBeTruthy();
    expect(resolved.sessionId).toBeTruthy();
  });

  it("requireAdmin throws AuthError 401 without a session", async () => {
    await completeSetup();
    const err = await requireAdmin(
      new Request(`${ORIGIN}/api/v1/admin/x`),
      env,
    ).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AuthError);
    expect((err as AuthError).status).toBe(401);
    expect((err as AuthError).code).toBe("AUTH_REQUIRED");
  });

  it("requireAdmin throws AuthError 403 for a non-admin user", async () => {
    await completeSetup();
    const auth = await getAuthInstance(env);
    await auth.api.createUser({
      body: {
        email: "viewer@example.test",
        name: "Viewer",
        password: "viewer-password-123",
        role: "user",
      },
    });
    const cookie = sessionCookie(await signIn("viewer@example.test", "viewer-password-123"));
    const err = await requireAdmin(
      new Request(`${ORIGIN}/api/v1/admin/x`, { headers: { cookie } }),
      env,
    ).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AuthError);
    expect((err as AuthError).status).toBe(403);
    expect((err as AuthError).code).toBe("FORBIDDEN");
  });

  it("requireUser throws AuthError 403 for a disabled user holding a live session", async () => {
    await completeSetup();
    const cookie = sessionCookie(await signIn(ADMIN.email, ADMIN.password));
    await env.DB.prepare('UPDATE "user" SET banned = 1').run();
    const err = await requireUser(
      new Request(`${ORIGIN}/api/v1/session`, { headers: { cookie } }),
      env,
    ).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AuthError);
    expect((err as AuthError).status).toBe(403);
    expect((err as AuthError).code).toBe("FORBIDDEN");
  });
});

describe("password hashing cost", () => {
  it("measures scrypt hash/verify latency inside workerd", async () => {
    await completeSetup();
    const auth = await getAuthInstance(env);
    const ctx = await auth.$context;
    const t0 = Date.now();
    const hash = await ctx.password.hash("measurement-password-123");
    const t1 = Date.now();
    await ctx.password.verify({ hash, password: "measurement-password-123" });
    const t2 = Date.now();
    // Local workerd timing evidence only — production CPU acceptance is a
    // separate gate (recorded in docs/evidence/W2-A.md).
    console.log(
      `[hash-timing] scrypt hash=${t1 - t0}ms verify=${t2 - t1}ms (workerd local)`,
    );
    expect(hash.length).toBeGreaterThan(0);
  });
});
