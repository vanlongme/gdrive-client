import { env, exports } from "cloudflare:workers";
import {
  applyD1Migrations,
  type D1Migration,
} from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { ApiErrorBodySchema } from "../../src/shared/contracts/common";
import { SetupStatusViewSchema } from "../../src/shared/contracts/admin";
import { getAuthInstance } from "../../src/worker/auth/session";

const worker = exports.default;
const TEST_MIGRATIONS = JSON.parse(
  (env as unknown as { TEST_MIGRATIONS: string }).TEST_MIGRATIONS,
) as D1Migration[];

// Matches vitest.config.ts miniflare bindings.
const SETUP_TOKEN = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=";
// workerd test requests run on http://worker.test; the pinned canonical
// origin may still be https because it is a stored identity value, not the
// request URL — request origins are separately trusted for CSRF.
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

function postSetup(body: unknown, headers?: HeadersInit): Promise<Response> {
  return api("/api/v1/setup", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
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

async function userCount(): Promise<number> {
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM "user"').first<{
    n: number;
  }>();
  return row?.n ?? -1;
}

async function sha256Hex(base64Token: string): Promise<string> {
  // setup_owner stores the SHA-256 of the decoded token bytes.
  const decoded = Uint8Array.from(atob(base64Token), (c) => c.charCodeAt(0));
  const digest = await crypto.subtle.digest(
    "SHA-256",
    decoded as Uint8Array<ArrayBuffer>,
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function clearThrottle() {
  await env.DB.prepare("DELETE FROM setup_throttle").run();
}

beforeEach(async () => {
  await applyD1Migrations(env.DB, TEST_MIGRATIONS);
  await resetState();
});

describe("setup claim", () => {
  it("completes setup with a valid token and pins the canonical origin", async () => {
    const res = await postSetup(ADMIN);
    expect(res.status).toBe(200);
    const status = SetupStatusViewSchema.parse(await res.json());
    expect(status).toEqual({ setupState: "complete", canonicalOrigin: CANONICAL_ORIGIN });

    const users = await env.DB.prepare('SELECT role, email FROM "user"').all<{
      role: string;
      email: string;
    }>();
    expect(users.results).toEqual([{ role: "admin", email: "admin@example.test" }]);
    // The pending admin identity is cleared on completion.
    const row = await env.DB
      .prepare("SELECT setup_pending_email, setup_owner FROM app_settings WHERE id = 1")
      .first<{ setup_pending_email: string | null; setup_owner: string | null }>();
    expect(row?.setup_pending_email).toBeNull();
    expect(row?.setup_owner).not.toBeNull();

    const statusRes = await api("/api/v1/setup/status");
    expect(await statusRes.json()).toEqual({
      setupState: "complete",
      canonicalOrigin: CANONICAL_ORIGIN,
    });
  });

  it("rejects an invalid setup token and records the failure", async () => {
    const res = await postSetup({ ...ADMIN, token: "B".repeat(44) });
    expect(res.status).toBe(403);
    const body = ApiErrorBodySchema.parse(await res.json());
    expect(body.error.code).toBe("SETUP_TOKEN_INVALID");
    expect(await userCount()).toBe(0);
    const throttle = await env.DB
      .prepare("SELECT failed_attempts FROM setup_throttle WHERE id = 1")
      .first<{ failed_attempts: number }>();
    expect(throttle?.failed_attempts).toBe(1);
    await clearThrottle();
  });

  it("bounds setup attempts: a locked window rejects even valid tokens", async () => {
    await postSetup({ ...ADMIN, token: "B".repeat(44) });
    const res = await postSetup(ADMIN);
    expect(res.status).toBe(429);
    const body = ApiErrorBodySchema.parse(await res.json());
    expect(body.error.code).toBe("RATE_LIMITED");
    expect(body.error.retryAfterSeconds).toBeGreaterThan(0);
    await clearThrottle();
  });

  it("rejects a malformed base64 token without throttling side effects beyond the counter", async () => {
    const res = await postSetup({ ...ADMIN, token: "not-base64!!" });
    expect(res.status).toBe(403);
    await clearThrottle();
  });

  it("consumes the token permanently: a valid token cannot reopen setup", async () => {
    expect((await postSetup(ADMIN)).status).toBe(200);
    const res = await postSetup({ ...ADMIN, email: "second@example.test" });
    expect(res.status).toBe(409);
    const body = ApiErrorBodySchema.parse(await res.json());
    expect(body.error.code).toBe("SETUP_ALREADY_COMPLETED");
    expect(await userCount()).toBe(1);
  });

  it("creates exactly one admin across concurrent claims", async () => {
    const [a, b] = await Promise.all([postSetup(ADMIN), postSetup(ADMIN)]);
    // Both requests converge on the single claim: a loser that arrives after
    // completion sees SETUP_ALREADY_COMPLETED, one still in the window resumes
    // the same claim and converges. Either way the outcome is identical.
    expect([a.status, b.status].every((s) => s === 200 || s === 409)).toBe(true);
    expect([a.status, b.status]).toContain(200);
    expect(await userCount()).toBe(1);
    const row = await env.DB
      .prepare("SELECT setup_state FROM app_settings WHERE id = 1")
      .first<{ setup_state: string }>();
    expect(row?.setup_state).toBe("complete");
  });

  it("resumes an in-progress claim owned by the same token", async () => {
    // Simulate a crash after claim but before admin creation.
    const owner = await sha256Hex(SETUP_TOKEN);
    await env.DB.prepare(
      "INSERT INTO app_settings (id, setup_state, setup_owner, setup_pending_email, setup_pending_name, canonical_origin, installation_id, version, created_at, updated_at) " +
        "VALUES (1, 'in_progress', ?, ?, ?, ?, 'install-1', 3, 0, 0)",
    )
      .bind(owner, ADMIN.email, ADMIN.name, CANONICAL_ORIGIN)
      .run();

    const res = await postSetup(ADMIN);
    expect(res.status).toBe(200);
    expect(await userCount()).toBe(1);
    const row = await env.DB
      .prepare("SELECT setup_state, installation_id FROM app_settings WHERE id = 1")
      .first<{ setup_state: string; installation_id: string }>();
    expect(row?.setup_state).toBe("complete");
    expect(row?.installation_id).toBe("install-1");
  });

  it("refuses to overwrite the persisted credential on a delayed divergent resume", async () => {
    // Crash after the account AND credential were created but before the
    // claim completed: the account row is authoritative, so a delayed racing
    // request with the same token+email but a different password must lose.
    const auth = await getAuthInstance(env);
    await auth.api.createUser({
      body: {
        email: ADMIN.email,
        name: ADMIN.name,
        password: "winner-password-123",
        role: "admin",
      },
    });
    const owner = await sha256Hex(SETUP_TOKEN);
    await env.DB.prepare(
      "INSERT INTO app_settings (id, setup_state, setup_owner, setup_pending_email, setup_pending_name, canonical_origin, installation_id, version, created_at, updated_at) " +
        "VALUES (1, 'in_progress', ?, ?, ?, ?, 'install-1', 1, 0, 0)",
    )
      .bind(owner, ADMIN.email, ADMIN.name, CANONICAL_ORIGIN)
      .run();

    const bad = await postSetup({ ...ADMIN, password: "loser-password-999" });
    expect(bad.status).toBe(409);
    expect(ApiErrorBodySchema.parse(await bad.json()).error.code).toBe(
      "SETUP_IN_PROGRESS",
    );
    const stored = await env.DB
      .prepare("SELECT password FROM account WHERE providerId = 'credential'")
      .first<{ password: string }>();
    const ctx = await auth.$context;
    expect(
      await ctx.password.verify({
        hash: stored!.password,
        password: "winner-password-123",
      }),
    ).toBe(true);

    // The claim still converges when the matching credential is presented.
    const good = await postSetup({ ...ADMIN, password: "winner-password-123" });
    expect(good.status).toBe(200);
    expect(await userCount()).toBe(1);
  });

  it("concurrent same-email claims with different passwords produce one admin and no duplicate accounts", async () => {
    const [a, b] = await Promise.all([
      postSetup(ADMIN),
      postSetup({ ...ADMIN, password: "different-password-999" }),
    ]);
    for (const res of [a, b]) {
      expect([200, 409]).toContain(res.status);
    }
    // Exactly one user and exactly one credential account may exist.
    expect(await userCount()).toBe(1);
    const accounts = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM account WHERE providerId = 'credential'",
    ).first<{ n: number }>();
    expect(accounts?.n).toBe(1);
    // The persisted credential must verify against the winner's password, and
    // whichever password persisted, the claim owner can sign in with it.
    const stored = await env.DB
      .prepare("SELECT password FROM account WHERE providerId = 'credential'")
      .first<{ password: string }>();
    const auth = await getAuthInstance(env);
    const ctx = await auth.$context;
    const firstMatches = await ctx.password.verify({
      hash: stored!.password,
      password: ADMIN.password,
    });
    const secondMatches = await ctx.password.verify({
      hash: stored!.password,
      password: "different-password-999",
    });
    expect(firstMatches || secondMatches).toBe(true);
    expect(firstMatches && secondMatches).toBe(false);
    // A request replaying AFTER completion cannot mutate the credential.
    const after = await postSetup({ ...ADMIN, password: "late-password-000" });
    expect(after.status).toBe(409);
    const still = await env.DB
      .prepare("SELECT password FROM account WHERE providerId = 'credential'")
      .first<{ password: string }>();
    expect(still!.password).toBe(stored!.password);
  });

  it("rejects a resumed claim that presents a different admin email", async () => {
    const owner = await sha256Hex(SETUP_TOKEN);
    await env.DB.prepare(
      "INSERT INTO app_settings (id, setup_state, setup_owner, setup_pending_email, setup_pending_name, canonical_origin, installation_id, version, created_at, updated_at) " +
        "VALUES (1, 'in_progress', ?, ?, ?, ?, 'install-1', 1, 0, 0)",
    )
      .bind(owner, "first@example.test", "First", CANONICAL_ORIGIN)
      .run();

    const res = await postSetup(ADMIN);
    expect(res.status).toBe(409);
    const body = ApiErrorBodySchema.parse(await res.json());
    expect(body.error.code).toBe("SETUP_IN_PROGRESS");
    expect(await userCount()).toBe(0);
  });

  it("rejects an invalid canonical origin", async () => {
    const res = await postSetup({ ...ADMIN, canonicalOrigin: "http://drive.example.com" });
    expect(res.status).toBe(400);
    const body = ApiErrorBodySchema.parse(await res.json());
    expect(body.error.code).toBe("VALIDATION_FAILED");
    expect(await userCount()).toBe(0);
  });

  it("rejects a cross-site origin before claiming", async () => {
    const res = await postSetup(ADMIN, { origin: "https://evil.example" });
    expect(res.status).toBe(403);
    const body = ApiErrorBodySchema.parse(await res.json());
    expect(body.error.code).toBe("ORIGIN_REJECTED");
    expect(await userCount()).toBe(0);
  });
});
