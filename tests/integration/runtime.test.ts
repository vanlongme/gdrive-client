import { env, exports } from "cloudflare:workers";
import {
  applyD1Migrations,
  runInDurableObject,
  type D1Migration,
} from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { ApiErrorBodySchema } from "../../src/shared/contracts/common";
import { createApp } from "../../src/worker/app";

const worker = exports.default;
const TEST_MIGRATIONS = JSON.parse(
  (env as unknown as { TEST_MIGRATIONS: string }).TEST_MIGRATIONS,
) as D1Migration[];

function api(path: string, init?: RequestInit): Promise<Response> {
  return worker.fetch(new Request(`http://worker.test${path}`, init));
}

async function seedSetupState(state: "uninitialized" | "in_progress" | "complete") {
  await env.DB.prepare(
    "INSERT OR REPLACE INTO app_settings (id, setup_state, canonical_origin, version, created_at, updated_at) " +
      "VALUES (1, ?, NULL, 1, 0, 0)",
  )
    .bind(state)
    .run();
}

async function expectApiError(res: Response, status: number, code: string) {
  expect(res.status).toBe(status);
  expect(res.headers.get("content-type")).toContain("application/json");
  const body = ApiErrorBodySchema.parse(await res.json());
  expect(body.error.code).toBe(code);
  expect(body.error.requestId.length).toBeGreaterThan(0);
}

beforeEach(async () => {
  await applyD1Migrations(env.DB, TEST_MIGRATIONS);
  // The suite shares one D1 across files (like a real deployment): reset the
  // setup singleton so each test observes a clean gate state.
  await env.DB.prepare("DELETE FROM app_settings").run();
  await env.DB.prepare("DELETE FROM setup_throttle").run();
});

describe("security headers", () => {
  it("applies CSP, nosniff, Referrer-Policy and no-store to API responses", async () => {
    const res = await api("/api/v1/health");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("cache-control")).toContain("no-store");
  });

  it("keeps security headers on JSON errors", async () => {
    const res = await api("/api/v1/definitely-missing");
    expect(res.status).toBe(404);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  });
});

describe("health", () => {
  it("GET /api/v1/health returns minimal readiness", async () => {
    const res = await api("/api/v1/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });
});

describe("setup status", () => {
  it("reports uninitialized when the app_settings row is absent", async () => {
    const res = await api("/api/v1/setup/status");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      setupState: "uninitialized",
      canonicalOrigin: null,
    });
  });

  it("reports the persisted state and survives across requests", async () => {
    await seedSetupState("in_progress");
    const first = await api("/api/v1/setup/status");
    const second = await api("/api/v1/setup/status");
    expect(await first.json()).toEqual({
      setupState: "in_progress",
      canonicalOrigin: null,
    });
    expect(await second.json()).toEqual({
      setupState: "in_progress",
      canonicalOrigin: null,
    });
  });

  it("does not reopen setup on a database error", async () => {
    await env.DB.exec("DROP TABLE app_settings");
    try {
      const res = await api("/api/v1/setup/status");
      expect(res.status).toBe(503);
      const body = ApiErrorBodySchema.parse(await res.json());
      expect(body.error.code).toBe("SETUP_STATUS_UNAVAILABLE");
      expect(JSON.stringify(body)).not.toContain("uninitialized");
    } finally {
      // Rebuild the dropped table to its exact migrated shape: re-apply only
      // 0001 (all idempotent CREATE IF NOT EXISTS) then restore the columns
      // forward-only migration 0002 added. Forward-only ALTERs must not be
      // re-run through the ledger, so the two app_settings columns are added
      // directly here to keep later files on the full schema.
      await env.DB.prepare(
        "DELETE FROM d1_migrations WHERE name = '0001_initial.sql'",
      ).run();
      await applyD1Migrations(env.DB, TEST_MIGRATIONS.slice(0, 1));
      await env.DB.exec(
        "ALTER TABLE app_settings ADD COLUMN setup_pending_email TEXT;" +
          " ALTER TABLE app_settings ADD COLUMN setup_pending_name TEXT;",
      );
    }
  });
});

describe("fail-closed gates", () => {
  it("rejects known protected API paths before setup completes", async () => {
    await expectApiError(await api("/api/v1/mounts"), 503, "SETUP_REQUIRED");
    await expectApiError(await api("/api/v1/uploads/abc/chunks"), 503, "SETUP_REQUIRED");
    await expectApiError(await api("/api/v1/admin/users"), 503, "SETUP_REQUIRED");
  });

  it("rejects API requests when bootstrap secrets are missing", async () => {
    const app = createApp();
    const brokenEnv = { ...env, APP_MASTER_KEY: "" } as Env;
    const res = await app.fetch(
      new Request("http://worker.test/api/v1/setup/status"),
      brokenEnv,
    );
    await expectApiError(res, 503, "BOOTSTRAP_SECRETS_INVALID");
  });

  it("rejects API requests when bootstrap secrets are malformed", async () => {
    const app = createApp();
    const badKey = { ...env, APP_MASTER_KEY: "not-base64!!" } as Env;
    const res1 = await app.fetch(new Request("http://worker.test/api/v1/mounts"), badKey);
    await expectApiError(res1, 503, "BOOTSTRAP_SECRETS_INVALID");
    // Valid base64 but the wrong decoded length.
    const badToken = { ...env, SETUP_TOKEN: "c2hvcnQ=" } as Env;
    const res2 = await app.fetch(new Request("http://worker.test/api/v1/mounts"), badToken);
    await expectApiError(res2, 503, "BOOTSTRAP_SECRETS_INVALID");
  });

  it("rejects base64 secrets whose padding bits are nonzero", async () => {
    // "B=" decodes under atob but is not canonical base64 (pad bits set).
    const nonCanonical = "A".repeat(42) + "B=";
    const app = createApp();
    const res = await app.fetch(new Request("http://worker.test/api/v1/mounts"), {
      ...env,
      APP_MASTER_KEY: nonCanonical,
    } as Env);
    await expectApiError(res, 503, "BOOTSTRAP_SECRETS_INVALID");
  });
});

describe("routing", () => {
  it("returns a structured JSON 404 for unknown API paths before setup", async () => {
    await expectApiError(await api("/api"), 404, "NOT_FOUND");
    await expectApiError(await api("/api/v1/definitely-missing"), 404, "NOT_FOUND");
    await expectApiError(await api("/api/nested/unknown"), 404, "NOT_FOUND");
  });

  it("returns a JSON 404 for unknown API paths after setup too", async () => {
    await seedSetupState("complete");
    await expectApiError(await api("/api/v1/definitely-missing"), 404, "NOT_FOUND");
  });

  it("serves the SPA shell for nested non-API routes", async () => {
    const res = await api("/explorer/some/nested/route");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("integration-shell-marker");
  });

  it("does not serve index.html for unknown API paths", async () => {
    const res = await api("/api/v1/unknown");
    expect(res.headers.get("content-type")).not.toContain("text/html");
  });
});

describe("setup route validation", () => {
  it("rejects a non-JSON setup body before touching setup state", async () => {
    await expectApiError(
      await api("/api/v1/setup", { method: "POST" }),
      400,
      "VALIDATION_FAILED",
    );
    // No claim row must have been written by the rejected request.
    const res = await api("/api/v1/setup/status");
    expect(await res.json()).toEqual({
      setupState: "uninitialized",
      canonicalOrigin: null,
    });
  });

  it("keeps Better Auth routes closed before setup completes", async () => {
    await expectApiError(
      await api("/api/auth/get-session"),
      503,
      "SETUP_REQUIRED",
    );
  });
});

describe("D1 binding", () => {
  it("persists writes across separate requests", async () => {
    await seedSetupState("complete");
    const res = await api("/api/v1/setup/status");
    expect(await res.json()).toEqual({
      setupState: "complete",
      canonicalOrigin: null,
    });
    // A second request through the same binding observes the earlier write.
    const res2 = await api("/api/v1/setup/status");
    expect(await res2.json()).toEqual({
      setupState: "complete",
      canonicalOrigin: null,
    });
  });
});

describe("Durable Object shells", () => {
  it("UploadSession keeps storage across invocations", async () => {
    const stub = env.UPLOAD_SESSION.get(env.UPLOAD_SESSION.idFromName("session-a"));
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.put("marker", "confirmed-1");
      state.storage.sql.exec(
        "CREATE TABLE IF NOT EXISTS foundation (v TEXT); INSERT INTO foundation VALUES ('sqlite-ok')",
      );
    });
    const read = await runInDurableObject(stub, async (_instance, state) => {
      const rows = [...state.storage.sql.exec("SELECT v FROM foundation")].map(
        (row) => row.v,
      );
      return { kv: await state.storage.get("marker"), rows };
    });
    expect(read.kv).toBe("confirmed-1");
    expect(read.rows).toEqual(["sqlite-ok"]);
  });

  it("ProjectCoordinator keeps storage across invocations", async () => {
    const stub = env.PROJECT_COORDINATOR.get(
      env.PROJECT_COORDINATOR.idFromName("project-a"),
    );
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.put("health", "cooldown-none");
    });
    const read = await runInDurableObject(stub, async (_instance, state) =>
      state.storage.get("health"),
    );
    expect(read).toBe("cooldown-none");
  });

  it("UploadSession enforces the internal command protocol", async () => {
    const stub = env.UPLOAD_SESSION.get(env.UPLOAD_SESSION.idFromName("session-b"));
    // Foreign origins and unknown paths are rejected structurally.
    const foreign = await stub.fetch("http://do.test/");
    expect(foreign.status).toBe(400);
    // A snapshot before initialize reports NOT_INITIALIZED.
    const uninit = await stub.fetch("https://upload-session.internal/snapshot");
    expect(uninit.status).toBe(404);
    const uninitBody = (await uninit.json()) as { code: string };
    expect(uninitBody.code).toBe("NOT_INITIALIZED");
    // A valid initialize command claims the first init attempt.
    const init = await stub.fetch("https://upload-session.internal/initialize", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        uploadId: "session-b",
        ownerId: "user-1",
        mountId: "mount-1",
        kind: "file",
        inputHash: "hash-1",
        parentId: "parent-1",
        name: "f.bin",
        mimeType: "application/octet-stream",
        totalBytes: "6",
        sha256: "a".repeat(64),
        md5: "b".repeat(32),
        chunkSize: 8 * 1024 * 1024,
        pinned: {
          connectionId: "conn-1",
          principalId: "perm-1",
          oauthClientId: "client-1",
          projectId: "proj-1",
          connectionVersion: 1,
          oauthClientVersion: 1,
          driveId: "drive-1",
        },
        now: 1,
        leaseMs: 120_000,
      }),
    });
    expect(init.status).toBe(200);
    const initBody = (await init.json()) as {
      ok: boolean;
      snapshot: { state: string; stateVersion: number };
      directive: { kind: string };
    };
    expect(initBody.ok).toBe(true);
    expect(initBody.snapshot.state).toBe("preparing");
    expect(initBody.directive.kind).toBe("generate-id");
  });
});
