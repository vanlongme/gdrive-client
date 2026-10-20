import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import type { APIRequestContext, Page } from "@playwright/test";

/**
 * Wave-10 SA-management E2E (worker S): every call is a REAL local API
 * against the isolated workerd preview — SQL fixtures only seed rows the UI
 * must list (connections/mounts/SAs; envelopes are never read by these
 * surfaces). The multi-file import goes through the real vault: keys are
 * generated per run, one file duplicates an already-imported SA.
 */

import {
  ADMIN,
  AUTH_HEADERS,
  apiSignIn,
  ensureSetupComplete,
} from "./helpers";
import { E2E_ORIGIN } from "./e2e-env";

const P = "w10s-";
const CLIENT_ID = `${P}client`;
const CONN = `${P}conn`;
const MOUNT = `${P}mount`;
const MYMOUNT = `${P}mymount`;

function saKeyJson(email: string, keyId: string, project = `${P}proj`) {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  return JSON.stringify({
    type: "service_account",
    project_id: project,
    private_key_id: keyId,
    private_key: privateKey,
    client_email: email,
  });
}

const DUP_EMAIL = `${P}dup@${P}dup.iam.gserviceaccount.com`;
const DUP_KEY_JSON = saKeyJson(DUP_EMAIL, `${P}key1`);

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

type StorageState = Awaited<
  ReturnType<APIRequestContext["storageState"]>
>;
let storageState: StorageState;
let dupSaId = "";

test.beforeAll(async ({ playwright }) => {
  const rc = await playwright.request.newContext({ baseURL: E2E_ORIGIN });
  await ensureSetupComplete(rc);
  await apiSignIn(rc, ADMIN.email, ADMIN.password);

  // The duplicate file re-imports this exact SA (same email + key id).
  const sa = await rc.post("/api/v1/admin/service-accounts", {
    data: { keyJson: DUP_KEY_JSON },
    headers: AUTH_HEADERS,
  });
  expect(sa.status(), `dup sa import ${sa.status()}`).toBe(200);
  dupSaId = ((await sa.json()) as { serviceAccount: { id: string } })
    .serviceAccount.id;
  storageState = await rc.storageState();
  await rc.dispose();

  const now = Date.now();
  d1(
    `INSERT OR REPLACE INTO google_oauth_clients (id, project_id, client_id, secret_envelope, redirect_uri, enabled, version, created_at, updated_at) VALUES` +
      `('${CLIENT_ID}','${P}proj','${P}cid','envelope','https://x.test/cb',1,1,${now},${now});` +
      `INSERT OR REPLACE INTO google_connections (id, oauth_client_id, principal_id, display_email, refresh_envelope, granted_scopes, state, enabled, version, connected_by, created_at, updated_at) VALUES` +
      `('${CONN}','${CLIENT_ID}','${P}principal','${P}op@example.test',NULL,'scope','connected',1,1,NULL,${now},${now});` +
      `INSERT OR REPLACE INTO mounts (id, label, drive_id, root_folder_id, catalog_connection_id, write_connection_id, read_pool_version, visibility, policy_version, created_at, updated_at) VALUES` +
      `('${MOUNT}','W10S Drive','${P}drive','${P}drive','${CONN}','${CONN}',1,'private',1,${now},${now}),` +
      `('${MYMOUNT}','W10S My Drive',NULL,'${P}folder','${CONN}','${CONN}',1,'private',1,${now},${now});` +
      `INSERT OR REPLACE INTO service_accounts (id, project_id, email, key_id, envelope, enabled, version, created_at, updated_at) VALUES` +
      `('${P}sa-1','${P}proj','${P}sa-1@${P}proj.iam.gserviceaccount.com','k1','env',1,1,${now},${now}),` +
      `('${P}sa-2','${P}proj','${P}sa-2@${P}proj.iam.gserviceaccount.com','k2','env',1,1,${now},${now}),` +
      `('${P}sa-free','${P}other','${P}free@other.iam.gserviceaccount.com','k3','env',1,1,${now},${now});` +
      `INSERT OR REPLACE INTO mount_read_credentials (mount_id, service_account_id, priority, weight, created_at) VALUES` +
      `('${MYMOUNT}','${P}sa-1',0,1,${now});`,
  );
});

test.afterAll(async () => {
  for (const sql of [
    `DELETE FROM mount_drive_permissions WHERE mount_id IN ('${MOUNT}','${MYMOUNT}')`,
    `DELETE FROM mount_read_credentials WHERE mount_id IN ('${MOUNT}','${MYMOUNT}')`,
    `DELETE FROM mounts WHERE id IN ('${MOUNT}','${MYMOUNT}')`,
    `DELETE FROM google_connections WHERE id='${CONN}'`,
    `DELETE FROM google_oauth_clients WHERE id='${CLIENT_ID}'`,
    `DELETE FROM service_accounts WHERE id IN ('${P}sa-1','${P}sa-2','${P}sa-free','${dupSaId}')`,
    `DELETE FROM service_accounts WHERE email LIKE '${P}new-%'`,
    `DELETE FROM service_accounts WHERE email LIKE '${P}conf-%'`,
    `DELETE FROM service_accounts WHERE email LIKE '${P}fresh-%'`,
  ]) {
    try {
      d1(sql);
    } catch (error) {
      console.warn(`e2e sa cleanup failed: ${sql}`, error);
    }
  }
});

async function adminSaPage(
  browser: import("@playwright/test").Browser,
): Promise<{ context: import("@playwright/test").BrowserContext; page: Page }> {
  const context = await browser.newContext({ storageState });
  const page = await context.newPage();
  await page.goto("/admin");
  await page.getByRole("button", { name: "Service account", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Service account chỉ đọc" })).toBeVisible();
  return { context, page };
}

test("summary strip, filters, select-all and bulk disable [real local api]", async ({
  browser,
  playwright,
}) => {
  const { context, page } = await adminSaPage(browser);
  try {
    // Summary chips with real counts (>= our three seeds + the dup SA).
    await expect(
      page.getByRole("button", { name: /Tổng \d+/ }),
    ).toBeVisible();

    // Text filter narrows to the two project SAs; URL carries the filter.
    await page.locator('input[type="search"]').fill(`${P}sa-`);
    await expect(page).toHaveURL(/q=w10s-sa-/);
    const rows = page.locator(".admin-table tbody tr");
    await expect(rows).toHaveCount(2);

    // Select-all over the filtered set, then bulk disable with one confirm.
    await page
      .getByRole("checkbox", { name: "Chọn tất cả SA đang lọc" })
      .check();
    await expect(page.getByText("Đã chọn 2")).toBeVisible();
    await page
      .getByRole("button", { name: "Vô hiệu", exact: true })
      .first()
      .click();
    const panel = page.getByRole("alertdialog");
    await expect(panel).toBeVisible();
    await panel.getByRole("button", { name: "Vô hiệu" }).click();
    await expect(page.getByText(/Đã áp dụng cho 2 SA \(0 lỗi\)/)).toBeVisible();

    const api = await playwright.request.newContext({
      baseURL: E2E_ORIGIN,
      storageState,
    });
    const list = await api.get("/api/v1/admin/service-accounts");
    const body = (await list.json()) as {
      serviceAccounts: { id: string; enabled: boolean }[];
    };
    for (const id of [`${P}sa-1`, `${P}sa-2`]) {
      expect(
        body.serviceAccounts.find((s) => s.id === id)?.enabled,
        `${id} disabled`,
      ).toBe(false);
    }
    await api.dispose();
  } finally {
    await context.close();
  }
});

test("add selection to a mount pool and see the My Drive grants hint [real local api]", async ({
  browser,
  playwright,
}) => {
  const { context, page } = await adminSaPage(browser);
  try {
    // Search + select the free SA, add it to the My Drive mount's pool.
    await page.locator('input[type="search"]').fill(`${P}free`);
    const row = page.locator(".admin-table tbody tr", {
      hasText: `${P}free@`,
    });
    await row.getByRole("checkbox").check();
    await page
      .locator(".sa-pool-pick")
      .selectOption({ label: "W10S My Drive" });
    await page.getByRole("button", { name: "Thêm vào pool" }).click();
    await expect(
      page.getByText(/Đã thêm 1 SA vào pool của W10S My Drive/),
    ).toBeVisible();
    // My Drive mounts surface the read-grant sync hint + panel link.
    await expect(page.getByText(/chạy Đồng bộ quyền truy cập/)).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Mở panel quyền của mount" }),
    ).toBeVisible();

    const api = await playwright.request.newContext({
      baseURL: E2E_ORIGIN,
      storageState,
    });
    const mount = await api.get(`/api/v1/admin/mounts/${MYMOUNT}`);
    const body = (await mount.json()) as {
      mount: { readPool: { id: string }[]; readPoolVersion: number };
    };
    expect(body.mount.readPool.map((sa) => sa.id)).toContain(`${P}sa-free`);
    await api.dispose();
  } finally {
    await context.close();
  }
});

test("multi-file import reports imported and duplicate per file [real local api]", async ({
  browser,
}) => {
  const { context, page } = await adminSaPage(browser);
  try {
    const projectTag = test.info().project.name.replace(/[^A-Za-z0-9]/g, "");
    const newEmail = `${P}new-${projectTag}@${P}proj.iam.gserviceaccount.com`;
    const newKey = saKeyJson(newEmail, `${P}new-${projectTag}`);
    await page.locator("#sa-key-files").setInputFiles([
      {
        name: "new-sa.json",
        mimeType: "application/json",
        buffer: Buffer.from(newKey),
      },
      {
        name: "dup-sa.json",
        mimeType: "application/json",
        buffer: Buffer.from(DUP_KEY_JSON),
      },
    ]);
    const results = page.locator(".sa-file-results li");
    await expect(results).toHaveCount(2);
    await expect(results.filter({ hasText: "new-sa.json" })).toContainText(
      "đã nhập",
    );
    await expect(results.filter({ hasText: "dup-sa.json" })).toContainText(
      "trùng",
    );
    // The new account appears in the table through the real reload.
    await expect(page.getByText(newEmail)).toBeVisible();
  } finally {
    await context.close();
  }
});

test("conflict rotate requires confirmation; non-conflict rows cannot rotate [real local api]", async ({
  browser,
  playwright,
}) => {
  const { context, page } = await adminSaPage(browser);
  const api = await playwright.request.newContext({
    baseURL: E2E_ORIGIN,
    storageState,
  });
  try {
    const projectTag = test.info().project.name.replace(/[^A-Za-z0-9]/g, "");
    const confEmail = `${P}conf-${projectTag}@${P}proj.iam.gserviceaccount.com`;
    // Seed the identity through the real API with key A; the file then
    // carries the same email with key B — a genuine conflict.
    const seed = await api.post("/api/v1/admin/service-accounts", {
      data: {
        keyJson: saKeyJson(confEmail, `${P}conf-${projectTag}-a`),
      },
      headers: AUTH_HEADERS,
    });
    expect(seed.status(), `conflict seed ${seed.status()}`).toBe(200);

    await page.locator("#sa-key-files").setInputFiles([
      {
        name: "conf-sa.json",
        mimeType: "application/json",
        buffer: Buffer.from(
          saKeyJson(confEmail, `${P}conf-${projectTag}-b`),
        ),
      },
      {
        name: "fresh-sa.json",
        mimeType: "application/json",
        buffer: Buffer.from(
          saKeyJson(
            `${P}fresh-${projectTag}@${P}proj.iam.gserviceaccount.com`,
            `${P}fresh-${projectTag}`,
          ),
        ),
      },
    ]);
    const results = page.locator(".sa-file-results li");
    await expect(results).toHaveCount(2);
    const conflictRow = results.filter({ hasText: "conf-sa.json" });
    const freshRow = results.filter({ hasText: "fresh-sa.json" });
    await expect(conflictRow).toContainText("xung đột");
    await expect(freshRow).toContainText("đã nhập");
    // Only the conflict row offers rotation — a non-conflict row has none.
    await expect(
      freshRow.getByRole("button", { name: "Thay khóa" }),
    ).toHaveCount(0);

    // Arming "Thay khóa" opens a confirm; cancel leaves the row untouched.
    await conflictRow.getByRole("button", { name: "Thay khóa" }).click();
    const panel = page.getByRole("alertdialog");
    await expect(panel).toBeVisible();
    await panel.getByRole("button", { name: "Hủy" }).click();
    await expect(conflictRow).toContainText("xung đột");

    // Confirming performs the real rotate; the row releases its handle, so
    // no second rotate is offered.
    await conflictRow.getByRole("button", { name: "Thay khóa" }).click();
    await panel.getByRole("button", { name: "Thay khóa" }).click();
    await expect(conflictRow).toContainText("đã xoay khóa");
    await expect(
      conflictRow.getByRole("button", { name: "Thay khóa" }),
    ).toHaveCount(0);
  } finally {
    await api.dispose();
    await context.close();
  }
});

test("evidence screenshots of the new SA section (chromium only)", async ({
  browser,
}, testInfo) => {
  testInfo.skip(
    testInfo.project.name !== "chromium",
    "one browser is enough for screenshots",
  );
  const { context, page } = await adminSaPage(browser);
  try {
    mkdirSync("docs/evidence/W10-S", { recursive: true });
    // Select the two project SAs so the sticky action bar renders too.
    await page.locator('input[type="search"]').fill(`${P}sa-`);
    await page
      .getByRole("checkbox", { name: "Chọn tất cả SA đang lọc" })
      .check();
    for (const [width, height] of [
      [1440, 900],
      [390, 844],
    ] as const) {
      await page.setViewportSize({ width, height });
      await page.screenshot({
        path: `docs/evidence/W10-S/admin-sa-${width}-light.png`,
        fullPage: true,
      });
    }
    // Dark pass at both sizes via the system theme (choice 'system' tracks
    // prefers-color-scheme through the real media query listener).
    await page.emulateMedia({ colorScheme: "dark" });
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    for (const [width, height] of [
      [1440, 900],
      [390, 844],
    ] as const) {
      await page.setViewportSize({ width, height });
      await page.screenshot({
        path: `docs/evidence/W10-S/admin-sa-${width}-dark.png`,
        fullPage: true,
      });
    }
  } finally {
    await context.close();
  }
});
