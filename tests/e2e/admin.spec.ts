import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import type { APIRequestContext, Page } from "@playwright/test";

/**
 * Admin E2E (wave-3 D). Every backend call here is a REAL local API against
 * the isolated workerd preview — credential import/disable, user create/
 * disable, grant upsert/revoke, share create/revoke and provider health are
 * pure D1/Better-Auth operations and never touch Google. The only synthetic
 * data is a labelled SQL fixture: one google_connections pair + one mount +
 * its read-pool row, seeded because mount creation itself requires a live
 * Google Shared Drive validation call (gate, not a mock). The mount-create
 * form is exercised against the real API and its honest Google-dependent
 * failure is asserted.
 */

import {
  ADMIN,
  AUTH_HEADERS,
  EVIDENCE_DIR,
  apiSignIn,
  ensureSetupComplete,
} from "./helpers";
import { E2E_ORIGIN } from "./e2e-env";

const CLIENT_ID = "1234567890-e2eclient.apps.googleusercontent.com";
// Throwaway test-only RSA key — the API now verifies PKCS8 material with
// crypto.subtle.importKey, so the fixture must be structurally real even
// though it signs nothing and reaches no Google endpoint.
const { privateKey: SA_PRIVATE_KEY } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
const SA_KEY_JSON = JSON.stringify({
  type: "service_account",
  project_id: "e2e-sa-project",
  private_key_id: "e2ekey0001",
  private_key: SA_PRIVATE_KEY,
  client_email: "e2e-sa@e2e-sa-project.iam.gserviceaccount.com",
});
const CONN_CATALOG = "e2e-conn-catalog";
const CONN_WRITE = "e2e-conn-write";
const MOUNT_ID = "e2e-mount-1";
const VIEWER = {
  name: "E2E Grant Target",
  email: "e2e-grant-target@gdrive-client.test",
  password: "e2e-grant-password-1!",
};

function d1(sql: string): void {
  const persistDir = readFileSync(
    ".e2e-state/current-persist-dir",
    "utf8",
  ).trim();
  execFileSync(
    "npx",
    [
      "wrangler",
      "d1",
      "execute",
      "DB",
      "--local",
      "--persist-to",
      persistDir,
      "--command",
      sql,
    ],
    { stdio: "pipe" },
  );
}

let clientRowId = "";
let saRowId = "";
let viewerId = "";
let storageState: StorageState;

test.beforeAll(async ({ playwright }) => {
  const rc = await playwright.request.newContext({ baseURL: E2E_ORIGIN });
  await ensureSetupComplete(rc);
  await apiSignIn(rc, ADMIN.email, ADMIN.password);

  // Real credential imports (sealed vault writes, no Google call).
  const client = await rc.post("/api/v1/admin/google/clients", {
    data: { clientId: CLIENT_ID, clientSecret: "e2e-client-secret-123" },
    headers: AUTH_HEADERS,
  });
  expect(client.status(), `client import ${client.status()}`).toBe(200);
  clientRowId = ((await client.json()) as { client: { id: string } }).client.id;

  const sa = await rc.post("/api/v1/admin/service-accounts", {
    data: { keyJson: SA_KEY_JSON },
    headers: AUTH_HEADERS,
  });
  expect(sa.status(), `sa import ${sa.status()}`).toBe(200);
  saRowId = ((await sa.json()) as { serviceAccount: { id: string } })
    .serviceAccount.id;

  const viewer = await rc.post("/api/v1/admin/users", {
    data: { ...VIEWER, role: "user" },
    headers: AUTH_HEADERS,
  });
  expect([200, 201, 400, 409]).toContain(viewer.status());
  if (viewer.ok()) {
    viewerId = ((await viewer.json()) as { user: { id: string } }).user.id;
  } else {
    const users = await rc.get("/api/v1/admin/users");
    const body = (await users.json()) as {
      users: { id: string; email: string }[];
    };
    viewerId =
      body.users.find((u) => u.email === VIEWER.email)?.id ?? "";
  }
  expect(viewerId, "viewer user id").not.toBe("");
  storageState = await rc.storageState();
  await rc.dispose();

  // Labelled SQL fixture: two connection rows (no refresh envelopes — token
  // material can only come from a live Google consent) plus one mount and
  // its read-pool row so grant/share/read-pool APIs operate on real rows.
  const now = 1760000000000;
  d1(
    `INSERT INTO google_connections (id, oauth_client_id, principal_id, display_email, refresh_envelope, granted_scopes, state, enabled, version, connected_by, created_at, updated_at) VALUES` +
      `('${CONN_CATALOG}','${clientRowId}','principal-e2e-1','e2e-catalog@example.test',NULL,'https://www.googleapis.com/auth/drive','connected',1,1,NULL,${now},${now}),` +
      `('${CONN_WRITE}','${clientRowId}','principal-e2e-2','e2e-write@example.test',NULL,'https://www.googleapis.com/auth/drive','connected',1,1,NULL,${now},${now});` +
      `INSERT INTO mounts (id, label, drive_id, root_folder_id, catalog_connection_id, write_connection_id, read_pool_version, visibility, policy_version, created_at, updated_at) VALUES` +
      `('${MOUNT_ID}','E2E Seeded Mount','e2e-drive-1','e2e-drive-1','${CONN_CATALOG}','${CONN_WRITE}',1,'private',1,${now},${now});` +
      `INSERT INTO mount_read_credentials (mount_id, service_account_id, priority, weight, created_at) VALUES` +
      `('${MOUNT_ID}','${saRowId}',0,1,${now});`,
  );
});

test.afterAll(async () => {
  // Ordered by FK dependency; each statement runs separately so one
  // failure can never strand later cleanup (a leaked seeded mount makes
  // admins' real /api/v1/mounts non-empty and breaks other specs).
  const statements = [
    // audit_events.actor_share_id FKs into share_links, so share rows must
    // be unreferenced before they (and then the mount) can go.
    `DELETE FROM audit_events WHERE actor_share_id IN (SELECT id FROM share_links WHERE mount_id='${MOUNT_ID}')`,
    `DELETE FROM share_links WHERE mount_id='${MOUNT_ID}'`,
    `DELETE FROM mount_grants WHERE mount_id='${MOUNT_ID}'`,
    `DELETE FROM mount_read_credentials WHERE mount_id='${MOUNT_ID}'`,
    `DELETE FROM mounts WHERE id='${MOUNT_ID}'`,
    `DELETE FROM oauth_transactions WHERE oauth_client_id='${clientRowId}'`,
    `DELETE FROM google_connections WHERE id IN ('${CONN_CATALOG}','${CONN_WRITE}')`,
    `DELETE FROM google_oauth_clients WHERE id='${clientRowId}'`,
    `DELETE FROM service_accounts WHERE id='${saRowId}'`,
    `DELETE FROM session WHERE "userId"='${viewerId}'`,
    `DELETE FROM "user" WHERE id='${viewerId}'`,
  ];
  for (const sql of statements) {
    try {
      d1(sql);
    } catch (error) {
      console.warn(`e2e cleanup failed: ${sql}`, error);
    }
  }
});

type StorageState = Awaited<
  ReturnType<APIRequestContext["storageState"]>
>;

async function adminPage(
  browser: import("@playwright/test").Browser,
  storageState: StorageState,
): Promise<{ context: import("@playwright/test").BrowserContext; page: Page }> {
  const context = await browser.newContext({ storageState });
  const page = await context.newPage();
  await page.goto("/admin");
  await expect(
    page.getByRole("heading", { name: "Quản trị", exact: true }),
  ).toBeVisible();
  return { context, page };
}

test("oauth client import, list and disable on the real API", async ({
  browser,
  playwright,
}) => {
  const { context, page } = await adminPage(browser, storageState);
  try {
    mkdirSync(EVIDENCE_DIR, { recursive: true });
    // Wave 5: /admin now lands on the onboarding tab; open connections.
    await page
      .getByRole("navigation", { name: "Các mục quản trị" })
      .getByRole("button", { name: "Kết nối Google" })
      .click();
    // The beforeAll-imported client is already listed through the real API.
    await expect(page.getByText(CLIENT_ID)).toBeVisible();
    // Seeded connections render with their real rows.
    await expect(page.getByText("e2e-catalog@example.test")).toBeVisible();
    await expect(page.getByText("e2e-write@example.test")).toBeVisible();
    await page.screenshot({
      path: `${EVIDENCE_DIR}/w3d-admin-connections.png`,
      fullPage: true,
    });

    // Import a second client through the real form.
    // Projects (chromium, firefox) share one backend state and run in order,
    // so each project imports its own client instead of finding the previous
    // project's already-disabled row.
    const projectTag = test.info().project.name.replace(/[^A-Za-z0-9]/g, "");
    const secondClient = `9876543210-second${projectTag}.apps.googleusercontent.com`;
    await page.locator("#oauth-client-id").fill(secondClient);
    await page.locator("#oauth-client-secret").fill("e2e-second-secret");
    await page.locator("#oauth-project-id").fill("e2e-project-2");
    await page.getByRole("button", { name: "Nhập", exact: true }).click();
    await expect(page.getByText(secondClient)).toBeVisible();

    // Disable it through the two-step confirm — real POST then real list.
    const row = page.locator(".client-row", { hasText: secondClient });
    await row.getByRole("button", { name: "Vô hiệu", exact: true }).click();
    await page
      .locator(".confirm-panel")
      .getByRole("button", { name: "Vô hiệu" })
      .click();
    await expect(row.getByText("Đã vô hiệu")).toBeVisible();
    const apiCheck = await playwright.request.newContext({
      baseURL: E2E_ORIGIN,
      storageState,
    });
    const clients = await apiCheck.get("/api/v1/admin/google/clients");
    const body = (await clients.json()) as {
      clients: { clientId: string; enabled: boolean }[];
    };
    expect(
      body.clients.find((c) => c.clientId === secondClient)?.enabled,
    ).toBe(false);
    await apiCheck.dispose();
  } finally {
    await context.close();
  }
});

test("service account list shows the imported credential without secrets", async ({
  browser,
  playwright,
}) => {
  const rc = await playwright.request.newContext({
    baseURL: E2E_ORIGIN,
    storageState,
  });

  // DTO honesty: the SA list must never carry envelope/key material.
  const list = await rc.get("/api/v1/admin/service-accounts");
  const listText = await list.text();
  expect(listText).not.toContain("private_key");
  expect(listText).not.toContain("envelope");
  expect(listText).not.toContain("QUJDREVGR0hJSktMTU5PUFFSUwo");
  await rc.dispose();

  const { context, page } = await adminPage(browser, storageState);
  try {
    await page
      .getByRole("button", { name: "Service account", exact: true })
      .click();
    await expect(
      page.getByText("e2e-sa@e2e-sa-project.iam.gserviceaccount.com"),
    ).toBeVisible();
    await page.screenshot({
      path: `${EVIDENCE_DIR}/w3d-admin-service-accounts.png`,
      fullPage: true,
    });
  } finally {
    await context.close();
  }
});

test("user create, disable and enable through the real admin API", async ({
  browser,
  playwright,
}) => {
  const { context, page } = await adminPage(browser, storageState);
  try {
    await page.getByRole("button", { name: "Người dùng", exact: true }).click();

    const email = `e2e-user-${Date.now()}@gdrive-client.test`;
    await page.locator("#user-name").fill("E2E Temp User");
    await page.locator("#user-email").fill(email);
    await page.locator("#user-password").fill("e2e-temp-password-1!");
    await page
      .getByRole("button", { name: "Tạo người dùng", exact: true })
      .click();
    await expect(page.getByText("Đã tạo người dùng.")).toBeVisible();
    const row = page.locator("tr", { hasText: email });
    await expect(row).toBeVisible();

    // Disable via two-step confirm; badge appears through a real reload.
    await row.getByRole("button", { name: "Vô hiệu", exact: true }).click();
    await page
      .locator(".confirm-panel")
      .getByRole("button", { name: "Vô hiệu" })
      .click();
    await expect(row.getByText("Đã vô hiệu")).toBeVisible();

    // Enable again — symmetric real call.
    await row.getByRole("button", { name: "Bật lại", exact: true }).click();
    await page
      .locator(".confirm-panel")
      .getByRole("button", { name: "Bật lại" })
      .click();
    await expect(row.getByText("Đã vô hiệu")).toHaveCount(0);

    // The disabled user truly cannot sign in while disabled: re-disable via
    // the real API and check a sign-in attempt is rejected.
    const api = await playwright.request.newContext({
      baseURL: E2E_ORIGIN,
      storageState,
    });
    const users = await api.get("/api/v1/admin/users");
    const body = (await users.json()) as {
      users: { id: string; email: string }[];
    };
    const tempId = body.users.find((u) => u.email === email)?.id ?? "";
    const disable = await api.post(`/api/v1/admin/users/${tempId}/disable`, {
      data: {},
      headers: AUTH_HEADERS,
    });
    expect(disable.status()).toBe(200);
    const anon = await playwright.request.newContext({ baseURL: E2E_ORIGIN });
    const denied = await anon.post("/api/auth/sign-in/email", {
      data: { email, password: "e2e-temp-password-1!" },
      headers: AUTH_HEADERS,
    });
    expect(denied.status()).not.toBe(200);
    await anon.dispose();
    await api.dispose();
  } finally {
    await context.close();
  }
});

test("mount create hits real Google-bound validation and reports honestly", async ({
  browser,
}) => {
  const { context, page } = await adminPage(browser, storageState);
  try {
    await page.getByRole("button", { name: "Mounts", exact: true }).click();

    // The seeded mount renders with real admin view data.
    await expect(
      page.getByRole("cell", { name: "E2E Seeded Mount" }),
    ).toBeVisible();
    await expect(
      page.getByRole("cell", { name: "e2e-catalog@example.test" }),
    ).toBeVisible();

    await page.locator("#mount-label").fill("E2E New Mount");
    await page.locator("#mount-drive").fill("e2e-drive-2");
    await page.locator("#mount-catalog-conn").selectOption(CONN_CATALOG);
    await page.locator("#mount-write-conn").selectOption(CONN_WRITE);
    await page
      .getByLabel("e2e-sa@e2e-sa-project.iam.gserviceaccount.com")
      .check();
    await page.getByRole("button", { name: "Tạo mount" }).click();

    // The real server validates through OAuth+Google; without a live grant
    // the honest failure surfaces as a localized error, never a fake mount.
    const alert = page.getByRole("alert").last();
    await expect(alert).toBeVisible();
    expect((await alert.innerText()).trim().length).toBeGreaterThan(10);
    await expect(page.getByText("Đã tạo mount.")).toHaveCount(0);
    await page.screenshot({
      path: `${EVIDENCE_DIR}/w3d-admin-mount-denied.png`,
      fullPage: true,
    });
  } finally {
    await context.close();
  }
});

test("grant upsert and revoke against the seeded mount", async ({
  browser,
  playwright,
}) => {
  const { context, page } = await adminPage(browser, storageState);
  try {
    await page.getByRole("button", { name: "Mounts", exact: true }).click();
    await page.locator("#grant-mount").selectOption(MOUNT_ID);
    await expect(page.getByText("Chưa cấp quyền nào.")).toBeVisible();

    await page.locator("#grant-user").selectOption(viewerId);
    await page.locator("#grant-role").selectOption("viewer");
    await page.getByRole("button", { name: "Cấp quyền" }).click();
    const grantRow = page.locator("tr", { hasText: VIEWER.email });
    await expect(grantRow).toBeVisible();
    await expect(grantRow.getByText("Xem")).toBeVisible();

    // Real server check: the grant exists via the API.
    const api = await playwright.request.newContext({
      baseURL: E2E_ORIGIN,
      storageState,
    });
    const grants = await api.get(`/api/v1/admin/mounts/${MOUNT_ID}/grants`);
    const grantsBody = (await grants.json()) as {
      grants: { userId: string; role: string }[];
    };
    expect(
      grantsBody.grants.some(
        (g) => g.userId === viewerId && g.role === "viewer",
      ),
    ).toBe(true);

    await grantRow.getByRole("button", { name: "Thu hồi" }).click();
    await page
      .locator(".confirm-panel")
      .getByRole("button", { name: "Thu hồi" })
      .click();
    await expect(page.getByText("Chưa cấp quyền nào.")).toBeVisible();
    const after = await api.get(`/api/v1/admin/mounts/${MOUNT_ID}/grants`);
    const afterBody = (await after.json()) as { grants: unknown[] };
    expect(afterBody.grants).toHaveLength(0);
    await api.dispose();
  } finally {
    await context.close();
  }
});

test("share create, list and revoke on the real share API", async ({
  browser,
  playwright,
}) => {
  const rc = await playwright.request.newContext({
    baseURL: E2E_ORIGIN,
    storageState,
  });

  // Real share creation (mount scope; one-time token asserted present then
  // discarded — it must never reappear in later DTOs).
  const expires = new Date(Date.now() + 3_600_000).toISOString();
  const created = await rc.post("/api/v1/shares", {
    data: {
      scope: { kind: "mount", mountId: MOUNT_ID },
      expiresAt: expires,
    },
    headers: AUTH_HEADERS,
  });
  expect(created.status(), `share create ${created.status()}`).toBe(201);
  const shareBody = (await created.json()) as {
    shareId: string;
    token: string;
  };
  expect(shareBody.token.startsWith("shr_")).toBe(true);
  await rc.dispose();

  const { context, page } = await adminPage(browser, storageState);
  try {
    await page.getByRole("button", { name: "Chia sẻ", exact: true }).click();
    const row = page.locator("tr", { hasText: MOUNT_ID });
    await expect(row).toBeVisible();
    // The token is not re-rendered anywhere in the list.
    await expect(page.getByText(shareBody.token)).toHaveCount(0);

    await row.getByRole("button", { name: "Thu hồi" }).click();
    await page
      .locator(".confirm-panel")
      .getByRole("button", { name: "Thu hồi" })
      .click();
    // Wait for the reloaded list, not its temporary loading-state unmount.
    await expect(page.getByText("Chưa có chia sẻ nào.")).toBeVisible();
    await expect(row).toHaveCount(0);
    const listed = await page.request.get("/api/v1/shares");
    expect(listed.status()).toBe(200);
    const listedBody = (await listed.json()) as {
      shares: { shareId: string; revokedAt?: string }[];
    };
    expect(
      listedBody.shares.find((share) => share.shareId === shareBody.shareId)
        ?.revokedAt,
    ).toBeDefined();
    await page.reload();
    await page.getByRole("button", { name: "Chia sẻ", exact: true }).click();
    await expect(page.getByText("Chưa có chia sẻ nào.")).toBeVisible();
    await expect(row).toHaveCount(0);
    await page.screenshot({
      path: `${EVIDENCE_DIR}/w3d-admin-shares.png`,
      fullPage: true,
    });
  } finally {
    await context.close();
  }
});

test("provider health separates OAuth and SA axes", async ({
  browser,
}) => {
  const { context, page } = await adminPage(browser, storageState);
  try {
    await page.getByRole("button", { name: "Trạng thái", exact: true }).click();
    await expect(page.getByText("API đang hoạt động")).toBeVisible();
    // level 3 = provider-health section; the async diagnostics panel can
    // render same-named h4 headings, which made this racy on slower runners.
    await expect(
      page.getByRole("heading", {
        name: "Kết nối OAuth (catalog/upload)",
        level: 3,
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", {
        name: "Service account (đọc nội dung)",
        level: 3,
      }),
    ).toBeVisible();
    await expect(page.getByText(CONN_CATALOG).first()).toBeVisible();
    await expect(page.getByText(saRowId).first()).toBeVisible();
    await page.screenshot({
      path: `${EVIDENCE_DIR}/w3d-admin-health.png`,
      fullPage: true,
    });
  } finally {
    await context.close();
  }
});
