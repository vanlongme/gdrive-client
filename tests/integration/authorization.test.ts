import { env } from "cloudflare:workers";
import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  authorizeMount,
  canAccessMount,
  type Actor,
} from "../../src/worker/auth/grants";
import type { AuthUser } from "../../src/worker/auth/session";

const TEST_MIGRATIONS = JSON.parse(
  (env as unknown as { TEST_MIGRATIONS: string }).TEST_MIGRATIONS,
) as D1Migration[];

const NOW = 1_700_000_000_000;

const adminUser: AuthUser = {
  id: "u-admin",
  name: "Admin",
  email: "admin@example.test",
  role: "admin",
  disabled: false,
  createdAt: new Date(NOW).toISOString(),
};

const viewerUser: AuthUser = {
  id: "u-viewer",
  name: "Viewer",
  email: "viewer@example.test",
  role: "user",
  disabled: false,
  createdAt: new Date(NOW).toISOString(),
};

const uploaderUser: AuthUser = {
  id: "u-uploader",
  name: "Uploader",
  email: "uploader@example.test",
  role: "user",
  disabled: false,
  createdAt: new Date(NOW).toISOString(),
};

const userActor = (user: AuthUser): Actor => ({
  kind: "user",
  user,
  sessionId: "sess-1",
});

async function resetState() {
  for (const table of [
    "mount_drive_permissions",
    "mount_grants",
    "mount_read_credentials",
    "mounts",
    "google_connections",
    "google_oauth_clients",
    "service_accounts",
    "session",
    "account",
    "user",
  ]) {
    await env.DB.prepare(`DELETE FROM "${table}"`).run();
  }
}

async function seedMount(visibility: "private" | "public_read" = "private") {
  await env.DB.prepare(
    'INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") VALUES (?, ?, ?, 1, ?, ?)',
  )
    .bind(adminUser.id, adminUser.name, adminUser.email, NOW, NOW)
    .run();
  await env.DB.prepare(
    "INSERT INTO google_oauth_clients (id, project_id, client_id, secret_envelope, redirect_uri, created_at, updated_at) VALUES ('oc-1', 'proj-1', 'client-1', 'env', 'https://x/cb', ?, ?)",
  )
    .bind(NOW, NOW)
    .run();
  await env.DB.prepare(
    "INSERT INTO google_connections (id, oauth_client_id, principal_id, granted_scopes, created_at, updated_at) VALUES ('conn-1', 'oc-1', 'p-1', 'drive', ?, ?)",
  )
    .bind(NOW, NOW)
    .run();
  await env.DB.prepare(
    "INSERT INTO mounts (id, label, drive_id, root_folder_id, catalog_connection_id, write_connection_id, visibility, created_at, updated_at) VALUES ('m-1', 'Mount', 'drive-1', 'drive-1', 'conn-1', 'conn-1', ?, ?, ?)",
  )
    .bind(visibility, NOW, NOW)
    .run();
}

async function seedViewerUsers() {
  for (const u of [viewerUser, uploaderUser]) {
    await env.DB.prepare(
      'INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") VALUES (?, ?, ?, 1, ?, ?)',
    )
      .bind(u.id, u.name, u.email, NOW, NOW)
      .run();
  }
}

async function grant(
  userId: string,
  role: "viewer" | "uploader",
  operations: string = JSON.stringify(
    role === "uploader" ? ["read", "upload"] : ["read"],
  ),
) {
  await env.DB.prepare(
    "INSERT INTO mount_grants (user_id, mount_id, role, operations, granted_by, created_at, updated_at) VALUES (?, 'm-1', ?, ?, ?, ?, ?)",
  )
    .bind(userId, role, operations, adminUser.id, NOW, NOW)
    .run();
}

beforeEach(async () => {
  await applyD1Migrations(env.DB, TEST_MIGRATIONS);
  await resetState();
});

describe("authorizeMount", () => {
  it("grants the admin full operations on a private mount", async () => {
    await seedMount();
    const access = await authorizeMount(env.DB, userActor(adminUser), "m-1");
    expect(access).not.toBeNull();
    expect(access?.operations.has("read")).toBe(true);
    expect(access?.operations.has("upload")).toBe(true);
    expect(access?.operations.has("admin")).toBe(true);
  });

  it("viewer grant allows read only, uploader grant allows read+upload", async () => {
    await seedMount();
    await seedViewerUsers();
    await grant(viewerUser.id, "viewer");
    await grant(uploaderUser.id, "uploader");

    expect(await canAccessMount(env.DB, userActor(viewerUser), "m-1", "read")).toBe(true);
    expect(await canAccessMount(env.DB, userActor(viewerUser), "m-1", "upload")).toBe(false);
    expect(await canAccessMount(env.DB, userActor(viewerUser), "m-1", "admin")).toBe(false);
    expect(await canAccessMount(env.DB, userActor(uploaderUser), "m-1", "read")).toBe(true);
    expect(await canAccessMount(env.DB, userActor(uploaderUser), "m-1", "upload")).toBe(true);
    expect(await canAccessMount(env.DB, userActor(uploaderUser), "m-1", "admin")).toBe(false);
  });

  it("narrows an uploader by an explicit operations allowlist", async () => {
    await seedMount();
    await seedViewerUsers();
    // Grant ceiling is uploader, but only 'read' is allowed explicitly.
    await grant(uploaderUser.id, "uploader", '["read"]');
    const access = await authorizeMount(env.DB, userActor(uploaderUser), "m-1");
    expect(access?.role).toBe("uploader");
    expect(access?.operations.has("read")).toBe(true);
    expect(access?.operations.has("upload")).toBe(false);
  });

  it("an operations list cannot widen past the role ceiling", async () => {
    await seedMount();
    await seedViewerUsers();
    // Viewer role ceiling is {read}; granting 'upload'/'admin' explicitly
    // must still deny them.
    await grant(viewerUser.id, "viewer", '["read","upload","admin"]');
    const access = await authorizeMount(env.DB, userActor(viewerUser), "m-1");
    expect(access?.operations.has("read")).toBe(true);
    expect(access?.operations.has("upload")).toBe(false);
    expect(access?.operations.has("admin")).toBe(false);
  });

  it("denies a grant with an empty operations list", async () => {
    await seedMount();
    await seedViewerUsers();
    await grant(viewerUser.id, "viewer", "[]");
    expect(await authorizeMount(env.DB, userActor(viewerUser), "m-1")).toBeNull();
  });

  it("fails closed on malformed grant operations", async () => {
    await seedMount();
    await seedViewerUsers();
    for (const raw of ["not-json", '{"read":true}', '["teleport"]', "null"]) {
      await env.DB.prepare("DELETE FROM mount_grants").run();
      await grant(viewerUser.id, "viewer", raw);
      expect(
        await authorizeMount(env.DB, userActor(viewerUser), "m-1"),
        `operations=${raw} must deny`,
      ).toBeNull();
    }
  });

  it("revoking a grant removes access immediately", async () => {
    await seedMount();
    await seedViewerUsers();
    await grant(viewerUser.id, "viewer");
    expect(
      await canAccessMount(env.DB, userActor(viewerUser), "m-1", "read"),
    ).toBe(true);
    await env.DB.prepare("DELETE FROM mount_grants").run();
    expect(
      await canAccessMount(env.DB, userActor(viewerUser), "m-1", "read"),
    ).toBe(false);
  });

  it("denies a user without any grant on a private mount", async () => {
    await seedMount();
    await seedViewerUsers();
    expect(await authorizeMount(env.DB, userActor(viewerUser), "m-1")).toBeNull();
  });

  it("denies a disabled user even with an existing grant", async () => {
    await seedMount();
    await seedViewerUsers();
    await grant(viewerUser.id, "viewer");
    const disabled = { ...viewerUser, disabled: true };
    expect(await authorizeMount(env.DB, userActor(disabled), "m-1")).toBeNull();
  });

  it("denies a disabled admin", async () => {
    await seedMount();
    const disabled = { ...adminUser, disabled: true };
    expect(await authorizeMount(env.DB, userActor(disabled), "m-1")).toBeNull();
  });

  it("public mounts allow anonymous read only", async () => {
    await seedMount("public_read");
    const access = await authorizeMount(env.DB, { kind: "public" }, "m-1");
    expect(access?.operations.has("read")).toBe(true);
    expect(access?.operations.has("upload")).toBe(false);
    expect(access?.operations.has("admin")).toBe(false);
  });

  it("private mounts deny anonymous access", async () => {
    await seedMount();
    expect(await authorizeMount(env.DB, { kind: "public" }, "m-1")).toBeNull();
  });

  it("returns null for unknown mounts and share actors stay unscoped until T06", async () => {
    await seedMount();
    expect(await authorizeMount(env.DB, userActor(adminUser), "no-such")).toBeNull();
    const share: Actor = { kind: "share", shareId: "s-1", mountId: "m-1" };
    expect(await authorizeMount(env.DB, share, "m-1")).toBeNull();
  });
});
