import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import type { APIRequestContext, Page } from "@playwright/test";

/**
 * Onboarding E2E (wave-5 T11). Every backend call is a REAL local API against
 * the isolated workerd preview: the OAuth client/SA imports, the onboarding
 * status lists and the /api/v1/admin/shared-drives route all hit the real
 * worker. The seeded connections carry no refresh envelopes, so the live
 * drives.list call asserts its honest shared-envelope failure
 * (GOOGLE_REAUTH_REQUIRED) — the only synthetic surface is a page.route
 * fixture on the chooser that proves the mount form fill, mirroring the
 * wave-4 fixture-routing for Google-dependent paths.
 */

import {
  ADMIN,
  AUTH_HEADERS,
  EVIDENCE_DIR,
  apiSignIn,
  ensureSetupComplete,
} from "./helpers";
import { E2E_ORIGIN } from "./e2e-env";

const CLIENT_ID = "1122334455-onboard.apps.googleusercontent.com";
const { privateKey: SA_PRIVATE_KEY } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
const SA_KEY_JSON = JSON.stringify({
  type: "service_account",
  project_id: "e2e-ob-sa-project",
  private_key_id: "e2eobkey001",
  private_key: SA_PRIVATE_KEY,
  client_email: "e2e-ob-sa@e2e-ob-sa-project.iam.gserviceaccount.com",
});
const CONN_CATALOG = "e2e-ob-conn-catalog";
const CONN_WRITE = "e2e-ob-conn-write";

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
let storageState: StorageState;

test.beforeAll(async ({ playwright }) => {
  const rc = await playwright.request.newContext({ baseURL: E2E_ORIGIN });
  await ensureSetupComplete(rc);
  await apiSignIn(rc, ADMIN.email, ADMIN.password);

  const client = await rc.post("/api/v1/admin/google/clients", {
    data: { clientId: CLIENT_ID, clientSecret: "e2e-ob-client-secret" },
    headers: AUTH_HEADERS,
  });
  if (client.ok()) {
    clientRowId = ((await client.json()) as { client: { id: string } }).client
      .id;
  } else {
    const list = await rc.get("/api/v1/admin/google/clients");
    const body = (await list.json()) as {
      clients: { id: string; clientId: string }[];
    };
    clientRowId =
      body.clients.find((c) => c.clientId === CLIENT_ID)?.id ?? "";
  }
  expect(clientRowId, "oauth client row").not.toBe("");

  const sa = await rc.post("/api/v1/admin/service-accounts", {
    data: { keyJson: SA_KEY_JSON },
    headers: AUTH_HEADERS,
  });
  if (sa.ok()) {
    saRowId = ((await sa.json()) as { serviceAccount: { id: string } })
      .serviceAccount.id;
  } else {
    const list = await rc.get("/api/v1/admin/service-accounts");
    const body = (await list.json()) as {
      serviceAccounts: { id: string; email: string }[];
    };
    saRowId =
      body.serviceAccounts.find(
        (s) => s.email === "e2e-ob-sa@e2e-ob-sa-project.iam.gserviceaccount.com",
      )?.id ?? "";
  }
  expect(saRowId, "sa row").not.toBe("");
  storageState = await rc.storageState();
  await rc.dispose();

  // Labelled SQL fixture: two 'connected' rows with no refresh envelopes —
  // token material can only come from a live Google consent.
  const now = 1760000000000;
  d1(
    `INSERT OR IGNORE INTO google_connections (id, oauth_client_id, principal_id, display_email, refresh_envelope, granted_scopes, state, enabled, version, connected_by, created_at, updated_at) VALUES` +
      `('${CONN_CATALOG}','${clientRowId}','principal-ob-1','e2e-ob-catalog@example.test',NULL,'https://www.googleapis.com/auth/drive','connected',1,1,NULL,${now},${now}),` +
      `('${CONN_WRITE}','${clientRowId}','principal-ob-2','e2e-ob-write@example.test',NULL,'https://www.googleapis.com/auth/drive','connected',1,1,NULL,${now},${now});`,
  );
});

test.afterAll(async () => {
  for (const sql of [
    `DELETE FROM google_connections WHERE id IN ('${CONN_CATALOG}','${CONN_WRITE}')`,
    `DELETE FROM oauth_transactions WHERE oauth_client_id='${clientRowId}'`,
    `DELETE FROM google_oauth_clients WHERE id='${clientRowId}'`,
    `DELETE FROM service_accounts WHERE id='${saRowId}'`,
  ]) {
    try {
      d1(sql);
    } catch (error) {
      console.warn(`e2e onboarding cleanup failed: ${sql}`, error);
    }
  }
});

type StorageState = Awaited<
  ReturnType<APIRequestContext["storageState"]>
>;

async function adminPage(
  browser: import("@playwright/test").Browser,
): Promise<{ context: import("@playwright/test").BrowserContext; page: Page }> {
  const context = await browser.newContext({ storageState });
  const page = await context.newPage();
  await page.goto("/admin");
  await expect(
    page.getByRole("heading", { name: "Quản trị", exact: true }),
  ).toBeVisible();
  return { context, page };
}

const adminNav = (page: Page) =>
  page.getByRole("navigation", { name: "Các mục quản trị" });

test("onboarding tab is the admin landing and shows real step statuses", async ({
  browser,
}) => {
  const { context, page } = await adminPage(browser);
  try {
    mkdirSync(EVIDENCE_DIR, { recursive: true });
    // Landing tab (default section) is the onboarding guide.
    await expect(
      page.getByRole("heading", { name: "Hướng dẫn thiết lập sau deploy" }),
    ).toBeVisible();
    // Canonical callback URL rendered from the real canonical origin.
    await expect(
      page.getByText(`${E2E_ORIGIN}/api/v1/admin/google/oauth/callback`),
    ).toBeVisible();
    // Real imported state surfaces on the checklist.
    await expect(page.getByText(/Đã nhập \d+ OAuth client/)).toBeVisible();
    await expect(
      page.getByText("Đã kết nối e2e-ob-catalog@example.test"),
    ).toBeVisible();
    await expect(page.getByText(/Đã nhập \d+ service account/)).toBeVisible();
    // Viewer-membership guidance is present verbatim (vi locale).
    await expect(
      page.getByText(/quyền Viewer trên từng Shared Drive/),
    ).toBeVisible();
    await page.screenshot({
      path: `${EVIDENCE_DIR}/t11-onboarding-desktop.png`,
      fullPage: true,
    });
  } finally {
    await context.close();
  }
});

test("shared-drives API is admin-only with the shared error envelope", async ({
  playwright,
}) => {
  const anon = await playwright.request.newContext({ baseURL: E2E_ORIGIN });
  const denied = await anon.get(
    `/api/v1/admin/shared-drives?connectionId=${CONN_CATALOG}`,
  );
  expect([401, 403]).toContain(denied.status());
  await anon.dispose();

  const rc = await playwright.request.newContext({
    baseURL: E2E_ORIGIN,
    storageState,
  });
  const missing = await rc.get("/api/v1/admin/shared-drives");
  expect(missing.status()).toBe(400);
  expect(((await missing.json()) as { error: { code: string } }).error.code).toBe(
    "VALIDATION_FAILED",
  );
  const unknown = await rc.get(
    "/api/v1/admin/shared-drives?connectionId=nope",
  );
  expect(unknown.status()).toBe(409);
  expect(((await unknown.json()) as { error: { code: string } }).error.code).toBe(
    "GOOGLE_CONNECTION_DISABLED",
  );
  // Seeded connection holds no refresh grant: honest re-auth, never a fake list.
  const live = await rc.get(
    `/api/v1/admin/shared-drives?connectionId=${CONN_CATALOG}`,
  );
  expect(live.status()).toBe(502);
  expect(((await live.json()) as { error: { code: string } }).error.code).toBe(
    "GOOGLE_REAUTH_REQUIRED",
  );
  await rc.dispose();
});

test("chooser surfaces the localized next action for a real failure", async ({
  browser,
}) => {
  const { context, page } = await adminPage(browser);
  try {
    await page.locator("#onboard-drive-conn").selectOption(CONN_CATALOG);
    await page
      .getByRole("button", { name: "Duyệt shared drives", exact: true })
      .click();
    const alert = page.getByRole("alert");
    await expect(alert).toBeVisible();
    // GOOGLE_REAUTH_REQUIRED -> reconnect next action (vi), not a raw error.
    await expect(alert).toContainText(/xác thực lại|Kết nối lại/);
    await page.screenshot({
      path: `${EVIDENCE_DIR}/t11-chooser-error-desktop.png`,
      fullPage: true,
    });
  } finally {
    await context.close();
  }
});

test("picking a drive fills the existing mount form (fixture route)", async ({
  browser,
}) => {
  const { context, page } = await adminPage(browser);
  try {
    // Fixture-route the Google-dependent list (wave-4 pattern); the fill
    // path itself is the real component under test.
    await page.route("**/api/v1/admin/shared-drives**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          drives: [
            { id: "0ABConboard-drive", name: "Onboarding Drive" },
            { id: "0ABCsecond-drive", name: "Second Drive" },
          ],
        }),
      });
    });

    await adminNav(page)
      .getByRole("button", { name: "Mounts" })
      .click();
    await page.locator("#mount-catalog-conn").selectOption(CONN_CATALOG);
    // The expander lives in the drive-id field; the chooser's own load
    // button appears inside .drive-chooser only after expanding.
    await page
      .locator(".field", { has: page.locator("#mount-drive") })
      .getByRole("button", { name: "Duyệt shared drives" })
      .click();
    await page
      .locator(".drive-chooser")
      .getByRole("button", { name: "Duyệt shared drives" })
      .click();
    await page
      .getByRole("button", { name: "Dùng drive này" })
      .first()
      .click();
    await expect(page.locator("#mount-drive")).toHaveValue("0ABConboard-drive");
    await expect(page.locator("#mount-label")).toHaveValue("Onboarding Drive");
    await expect(
      page.getByText("Đã điền form mount với Onboarding Drive."),
    ).toBeVisible();
    await page.unroute("**/api/v1/admin/shared-drives**");

    // The same chooser is embedded on the onboarding tab: pick there and the
    // flow lands on Mounts with the form already filled.
    await adminNav(page)
      .getByRole("button", { name: "Hướng dẫn thiết lập" })
      .click();
    await page.locator("#onboard-drive-conn").selectOption(CONN_CATALOG);
    await page.route("**/api/v1/admin/shared-drives**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          drives: [{ id: "0ABCsecond-drive", name: "Second Drive" }],
        }),
      });
    });
    await page
      .getByRole("button", { name: "Duyệt shared drives", exact: true })
      .click();
    await page.getByRole("button", { name: "Dùng drive này" }).click();
    // Lands on the Mounts tab with the drive already in the form.
    await expect(
      page.getByRole("heading", { name: "Mounts" }),
    ).toBeVisible();
    await expect(page.locator("#mount-drive")).toHaveValue("0ABCsecond-drive");
    await expect(page.locator("#mount-label")).toHaveValue("Second Drive");
    await page.screenshot({
      path: `${EVIDENCE_DIR}/t11-mount-filled-desktop.png`,
      fullPage: true,
    });
  } finally {
    await context.close();
  }
});

test("onboarding renders on a mobile viewport without overflow", async ({
  browser,
}) => {
  const context = await browser.newContext({
    storageState,
    viewport: { width: 390, height: 844 },
  });
  const page = await context.newPage();
  try {
    await page.goto("/admin");
    await expect(
      page.getByRole("heading", { name: "Hướng dẫn thiết lập sau deploy" }),
    ).toBeVisible();
    await expect(
      page.getByText(`${E2E_ORIGIN}/api/v1/admin/google/oauth/callback`),
    ).toBeVisible();
    mkdirSync(EVIDENCE_DIR, { recursive: true });
    await page.screenshot({
      path: `${EVIDENCE_DIR}/t11-onboarding-mobile.png`,
      fullPage: true,
    });
  } finally {
    await context.close();
  }
});
