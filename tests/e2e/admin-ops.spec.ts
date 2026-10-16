import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import type { APIRequestContext, Page } from "@playwright/test";

/**
 * Admin operations E2E (T14 UI). Every call is a REAL local API against the
 * isolated workerd preview — diagnostics/status/mode/cleanup/rotation are
 * pure D1 operations, never Google calls. Labelled SQL fixtures seed one
 * connection + mount + upload/file_readiness/audit rows so the diagnostics
 * counters are non-empty; the IDs carry an `ops-` prefix and are cleaned up
 * in afterAll. APP_MASTER_KEY_NEXT is unset in the preview env, so rotation
 * start is asserted through its honest NEXT_KEY_MISSING error + next action.
 */

import {
  ADMIN,
  AUTH_HEADERS,
  EVIDENCE_DIR,
  apiSignIn,
  ensureSetupComplete,
  useAdminStorage,
} from "./helpers";
import { E2E_ORIGIN } from "./e2e-env";

const OPS_PREFIX = "ops-";
const OPS_CONN = `${OPS_PREFIX}conn-catalog`;
const OPS_CONN_W = `${OPS_PREFIX}conn-write`;
const OPS_MOUNT = `${OPS_PREFIX}mount-1`;
const OPS_VIEWER = {
  name: "E2E Ops Viewer",
  email: "e2e-ops-viewer@gdrive-client.test",
  password: "e2e-ops-viewer-password-1!",
};
const CLIENT_ID = "9876543210-e2eops.apps.googleusercontent.com";
// Throwaway test-only RSA key; the import API requires structurally real
// PKCS8 material even though nothing here ever signs or reaches Google.
import { generateKeyPairSync } from "node:crypto";
const { privateKey: SA_PRIVATE_KEY } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
const SA_KEY_JSON = JSON.stringify({
  type: "service_account",
  project_id: "e2e-ops-sa-project",
  private_key_id: "e2eopskey001",
  private_key: SA_PRIVATE_KEY,
  client_email: "e2e-ops-sa@e2e-ops-sa-project.iam.gserviceaccount.com",
});

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

const admin = useAdminStorage();
let clientRowId = "";
let saRowId = "";
let adminUserId = "";
let viewerId = "";
let viewerStorage: Awaited<ReturnType<APIRequestContext["storageState"]>>;

test.beforeAll(async ({ playwright }) => {
  const rc = await playwright.request.newContext({ baseURL: E2E_ORIGIN });
  await ensureSetupComplete(rc);
  await apiSignIn(rc, ADMIN.email, ADMIN.password);

  const client = await rc.post("/api/v1/admin/google/clients", {
    data: { clientId: CLIENT_ID, clientSecret: "e2e-ops-client-secret" },
    headers: AUTH_HEADERS,
  });
  clientRowId = ((await client.json()) as { client: { id: string } }).client
    .id;

  const sa = await rc.post("/api/v1/admin/service-accounts", {
    data: { keyJson: SA_KEY_JSON },
    headers: AUTH_HEADERS,
  });
  saRowId = ((await sa.json()) as { serviceAccount: { id: string } })
    .serviceAccount.id;

  const users = await rc.get("/api/v1/admin/users");
  const usersBody = (await users.json()) as {
    users: { id: string; email: string }[];
  };
  adminUserId =
    usersBody.users.find((u) => u.email === ADMIN.email)?.id ?? "";

  const viewer = await rc.post("/api/v1/admin/users", {
    data: { ...OPS_VIEWER, role: "user" },
    headers: AUTH_HEADERS,
  });
  if (viewer.ok()) {
    viewerId = ((await viewer.json()) as { user: { id: string } }).user.id;
  } else {
    viewerId =
      usersBody.users.find((u) => u.email === OPS_VIEWER.email)?.id ?? "";
    if (viewerId === "") {
      const again = await rc.get("/api/v1/admin/users");
      const againBody = (await again.json()) as {
        users: { id: string; email: string }[];
      };
      viewerId =
        againBody.users.find((u) => u.email === OPS_VIEWER.email)?.id ??
        "";
    }
  }
  expect(viewerId, "viewer user id").not.toBe("");

  await apiSignIn(rc, OPS_VIEWER.email, OPS_VIEWER.password);
  viewerStorage = await rc.storageState();
  await rc.dispose();

  const now = Date.now();
  const old = now - 40 * 24 * 60 * 60 * 1000; // >30d → cleanup eligible
  const recent = now - 60_000;
  d1(
    `INSERT INTO google_connections (id, oauth_client_id, principal_id, display_email, refresh_envelope, granted_scopes, state, enabled, version, connected_by, created_at, updated_at) VALUES` +
      `('${OPS_CONN}','${clientRowId}','principal-ops-1','e2e-ops-catalog@example.test',NULL,'https://www.googleapis.com/auth/drive','connected',1,1,NULL,${now},${now}),` +
      `('${OPS_CONN_W}','${clientRowId}','principal-ops-2','e2e-ops-write@example.test',NULL,'https://www.googleapis.com/auth/drive','connected',1,1,NULL,${now},${now});` +
      `INSERT INTO mounts (id, label, drive_id, catalog_connection_id, write_connection_id, read_pool_version, visibility, policy_version, created_at, updated_at) VALUES` +
      `('${OPS_MOUNT}','E2E Ops Mount','ops-drive-1','${OPS_CONN}','${OPS_CONN_W}',1,'private',1,${now},${now});` +
      `INSERT INTO mount_read_credentials (mount_id, service_account_id, priority, weight, created_at) VALUES` +
      `('${OPS_MOUNT}','${saRowId}',0,1,${now});` +
      `INSERT INTO upload_operations (id, owner_id, mount_id, kind, idempotency_hash, input_hash, generated_file_id, pinned_oauth_connection_id, pinned_principal_id, pinned_oauth_client_id, pinned_project_id, state, result, summary, created_at, updated_at, completed_at) VALUES` +
      `('${OPS_PREFIX}up-done','${adminUserId}','${OPS_MOUNT}','file','ops-idem-1','ops-input-1','ops-file-1','${OPS_CONN_W}','principal-ops-2','${clientRowId}','ops-project','completed',` +
      `'{"view":{"confirmedOffset":"2048","readerAccessState":"blocked"}}','{"confirmedOffset":"2048"}',${old},${old},${old}),` +
      `('${OPS_PREFIX}up-live','${adminUserId}','${OPS_MOUNT}','file','ops-idem-2','ops-input-2',NULL,'${OPS_CONN_W}','principal-ops-2','${clientRowId}','ops-project','uploading',NULL,NULL,${now},${now},NULL);` +
      `INSERT INTO file_readiness (mount_id, file_id, reader_access_state, read_pool_version, policy_version, updated_at) VALUES` +
      `('${OPS_MOUNT}','ops-file-1','blocked',1,1,${now}),` +
      `('${OPS_MOUNT}','ops-file-2','readable',1,1,${now});` +
      `INSERT INTO audit_events (id, actor_kind, operation, result, request_id, created_at) VALUES` +
      `('${OPS_PREFIX}audit-old','system','admin.maintenance.cleanup','error','ops-req-1',${old}),` +
      `('${OPS_PREFIX}audit-new','system','explorer.list','error','ops-req-2',${recent});`,
  );
});

test.afterAll(async () => {
  // Best-effort: leave the DB exactly as found (mode off, seeds removed).
  const statements = [
    `DELETE FROM audit_events WHERE id LIKE '${OPS_PREFIX}%'`,
    `DELETE FROM file_readiness WHERE mount_id='${OPS_MOUNT}'`,
    `DELETE FROM upload_operations WHERE id LIKE '${OPS_PREFIX}%'`,
    `DELETE FROM mount_read_credentials WHERE mount_id='${OPS_MOUNT}'`,
    `DELETE FROM mounts WHERE id='${OPS_MOUNT}'`,
    `DELETE FROM google_connections WHERE id IN ('${OPS_CONN}','${OPS_CONN_W}')`,
    `DELETE FROM google_oauth_clients WHERE id='${clientRowId}'`,
    `DELETE FROM service_accounts WHERE id='${saRowId}'`,
    `DELETE FROM session WHERE "userId"='${viewerId}'`,
    `DELETE FROM "user" WHERE id='${viewerId}'`,
    `UPDATE maintenance_state SET mode='off', phase='idle', checkpoint='{}', processed_count=0, verified_count=0 WHERE id=1`,
  ];
  for (const sql of statements) {
    try {
      d1(sql);
    } catch (error) {
      console.warn(`e2e admin-ops cleanup failed: ${sql}`, error);
    }
  }
});

async function gotoAdmin(page: Page, tab?: string) {
  await page.goto("/admin");
  if (tab !== undefined) {
    await page.getByRole("button", { name: tab }).click();
  }
}

test("health tab shows separated diagnostics counters [real local api]", async ({
  browser,
}) => {
  const context = await browser.newContext({
    storageState: admin.get(),
  });
  const page = await context.newPage();
  try {
    await gotoAdmin(page, "Trạng thái");

    // OAuth plane — real imported client + seeded connections.
    await expect(
      page.getByRole("heading", { name: "Chẩn đoán hệ thống" }),
    ).toBeVisible();
    await expect(page.getByText(OPS_CONN).first()).toBeVisible();
    await expect(page.getByText(saRowId).first()).toBeVisible();

    // Upload counters from the seeded D1 rows.
    await expect(
      page.getByRole("heading", { name: "Upload", exact: true }),
    ).toBeVisible();
    await expect(page.getByText("completed").first()).toBeVisible();
    await expect(page.getByText("uploading").first()).toBeVisible();
    await expect(
      page.getByText("Hoàn tất nhưng reader bị chặn"),
    ).toBeVisible();

    // Reader states + audit errors seeded for the last 24 h.
    await expect(page.getByText("blocked").first()).toBeVisible();
    await expect(page.getByText("readable").first()).toBeVisible();
    await expect(page.getByText("explorer.list").first()).toBeVisible();

    // Maintenance snapshot and no leaked secret material anywhere.
    await expect(
      page.getByRole("heading", { name: "Trạng thái bảo trì" }),
    ).toBeVisible();
    const html = await page.content();
    expect(html).not.toMatch(
      /refresh_envelope|private_key|APP_MASTER_KEY|client_secret/,
    );
    mkdirSync(EVIDENCE_DIR, { recursive: true });
    await page.screenshot({
      path: `${EVIDENCE_DIR}/t14-health-diagnostics.png`,
      fullPage: true,
    });
  } finally {
    await context.close();
  }
});

test("maintenance mode toggle is confirmation-gated [real local api]", async ({
  browser,
}) => {
  const context = await browser.newContext({ storageState: admin.get() });
  const page = await context.newPage();
  try {
    const mutations: string[] = [];
    page.on("request", (request) => {
      if (
        request.method() === "POST" &&
        request.url().includes("/api/v1/admin/maintenance/")
      ) {
        mutations.push(request.url());
      }
    });
    await gotoAdmin(page, "Vận hành");
    await expect(
      page.getByRole("heading", { name: "Chế độ bảo trì" }),
    ).toBeVisible();

    // Arm the toggle — the confirm panel explains impact; no POST yet.
    await page.getByRole("button", { name: "Bật chế độ bảo trì" }).click();
    const panel = page.getByRole("alertdialog", {
      name: "Bật chế độ bảo trì?",
    });
    await expect(panel).toBeVisible();
    await expect(panel).toContainText("upload");
    expect(mutations).toEqual([]);

    // Confirm → real POST → drain badge; then lift again.
    await panel
      .getByRole("button", { name: "Bật chế độ bảo trì" })
      .click();
    await expect
      .poll(() => mutations.length)
      .toBeGreaterThanOrEqual(1);
    await expect(page.getByText("Bảo trì (chặn admission)")).toBeVisible();

    await page.getByRole("button", { name: "Tắt chế độ bảo trì" }).click();
    const liftPanel = page.getByRole("alertdialog", {
      name: "Tắt chế độ bảo trì?",
    });
    await expect(liftPanel).toBeVisible();
    await liftPanel
      .getByRole("button", { name: "Tắt chế độ bảo trì" })
      .click();
    await expect(page.getByText("Tắt", { exact: true })).toBeVisible();
  } finally {
    await context.close();
  }
});

test("cleanup runs dry-run preview before confirmed pass [real local api]", async ({
  browser,
}) => {
  const context = await browser.newContext({ storageState: admin.get() });
  const page = await context.newPage();
  try {
    await gotoAdmin(page, "Vận hành");
    await expect(
      page.getByRole("heading", { name: "Dọn dữ liệu định kỳ" }),
    ).toBeVisible();

    // Dry-run first: the real run button only appears after a preview.
    await page
      .getByRole("button", { name: "Xem trước (dry-run)" })
      .click();
    await expect(
      page.getByText("Audit event đủ điều kiện"),
    ).toBeVisible();
    await expect(
      page.getByText("Kết quả xem trước", { exact: false }),
    ).toBeVisible();
    const runBtn = page.getByRole("button", { name: "Chạy cleanup" });
    await expect(runBtn).toBeVisible();

    // Explicit confirm → real pass deletes the >30d seeded audit row.
    await runBtn.click();
    const panel = page.getByRole("alertdialog", {
      name: "Chạy cleanup thật?",
    });
    await expect(panel).toBeVisible();
    await panel.getByRole("button", { name: "Chạy cleanup" }).click();
    await expect(
      page.getByText("Cleanup đã chạy xong."),
    ).toBeVisible();
    await expect(page.getByText("Audit event đã xóa")).toBeVisible();
  } finally {
    await context.close();
  }
});

test("rotation start surfaces NEXT_KEY_MISSING with a next action [real local api]", async ({
  browser,
}) => {
  const context = await browser.newContext({ storageState: admin.get() });
  const page = await context.newPage();
  try {
    await gotoAdmin(page, "Vận hành");
    await expect(
      page.getByRole("heading", { name: "Rotation khóa chủ" }),
    ).toBeVisible();
    // The stepper explains staging before any button is pressed.
    await expect(
      page.getByText(/APP_MASTER_KEY_NEXT phải được cấu hình/),
    ).toBeVisible();

    await page.getByRole("button", { name: "Bắt đầu rotation" }).click();
    const panel = page.getByRole("alertdialog", {
      name: "Bắt đầu rotation khóa?",
    });
    await expect(panel).toBeVisible();
    await panel
      .getByRole("button", { name: "Bắt đầu rotation" })
      .click();

    // Real 400 → error block + concrete next action (stage NEXT, restart).
    await expect(
      page.getByRole("heading", { name: "Bước tiếp theo" }).or(
        page.getByText("Bước tiếp theo:"),
      ),
    ).toBeVisible();
    await expect(
      page.getByText(/APP_MASTER_KEY_NEXT.*base64/),
    ).toBeVisible();

    mkdirSync(EVIDENCE_DIR, { recursive: true });
    await page.screenshot({
      path: `${EVIDENCE_DIR}/t14-ops-desktop.png`,
      fullPage: true,
    });
    // Mobile viewport evidence.
    await page.setViewportSize({ width: 375, height: 812 });
    await page.screenshot({
      path: `${EVIDENCE_DIR}/t14-ops-mobile.png`,
      fullPage: true,
    });
  } finally {
    await context.close();
  }
});

test("non-admin sees neither the ops tab nor the endpoints [real local api]", async ({
  browser,
}) => {
  const context = await browser.newContext({
    storageState: viewerStorage,
  });
  const page = await context.newPage();
  try {
    await page.goto("/admin");
    await expect(
      page.getByText("Khu vực chỉ dành cho quản trị viên"),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Vận hành" }),
    ).toHaveCount(0);

    // Server-side enforcement is the real gate: direct calls still fail.
    const diag = await page.request.get(
      "/api/v1/admin/diagnostics",
    );
    expect([401, 403]).toContain(diag.status());
    const status = await page.request.get(
      "/api/v1/admin/maintenance/status",
    );
    expect([401, 403]).toContain(status.status());
    const mode = await page.request.post(
      "/api/v1/admin/maintenance/mode",
      { data: { enabled: true }, headers: AUTH_HEADERS },
    );
    expect([401, 403]).toContain(mode.status());
  } finally {
    await context.close();
  }
});
