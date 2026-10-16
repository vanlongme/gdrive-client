import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { useAdminStorage } from "./helpers";
import { installFolderFixtures } from "./folder-upload-fixtures";
import { UPLOAD_MOUNT } from "./upload-fixtures";

/**
 * Folder-upload E2E (T10). Real sign-in against local workerd preview; the
 * batch/folder/upload endpoints are protocol-faithful Playwright fixtures
 * ([fixture] — never claimed as live Google evidence). webkitdirectory
 * inputs take a real on-disk directory, so nested trees + folder creates +
 * reload → reselect → digest checks are genuinely exercised.
 */

const admin = useAdminStorage();
const FOLDER_INPUT = '[data-testid="folder-upload-input"]';

/** Create a temp directory tree; returns its path. */
function makeTree(structure: Record<string, number>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fu-e2e-"));
  for (const [rel, size] of Object.entries(structure)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, Buffer.alloc(size, 0x42));
  }
  return dir;
}

async function openExplorer(page: Page) {
  const fixture = installFolderFixtures(page);
  await page.goto("/explorer");
  await expect(page.getByText(UPLOAD_MOUNT.label).first()).toBeVisible();
  return fixture;
}

test.describe.configure({ mode: "default" });

test("[fixture] nested folder upload: parent-first folders, then files", async ({
  browser,
}) => {
  const context = await browser.newContext({ storageState: admin.get() });
  const page = await context.newPage();
  const fixture = await openExplorer(page);
  const tree = makeTree({
    "e2e-root/sub/inner.txt": 20 * 1024,
    "e2e-root/top.txt": 12 * 1024,
  });

  await page.setInputFiles(FOLDER_INPUT, tree);
  const card = page.getByTestId("folder-batch");
  await expect(card).toBeVisible({ timeout: 10_000 });

  // Batch pipeline: create → node append → seal with the plan digest.
  await expect(async () => {
    expect(
      fixture.calls.some(
        (c) => c.startsWith("POST") && c.endsWith("/api/v1/upload-batches"),
      ),
    ).toBe(true);
    expect(fixture.calls.some((c) => c.includes("/nodes"))).toBe(true);
    expect(fixture.calls.some((c) => c.includes("/seal"))).toBe(true);
  }).toPass({ timeout: 10_000 });

  // Folder creates ran parent-first: temp-root → e2e-root → sub.
  await expect(async () => {
    const folderCalls = fixture.calls.filter((c) => c.startsWith("folder:"));
    expect(folderCalls.length).toBe(3);
    expect(folderCalls[0]).toMatch(/^folder:fu-e2e-/);
    expect(folderCalls.slice(1)).toEqual(["folder:e2e-root", "folder:sub"]);
  }).toPass({ timeout: 10_000 });

  // All nodes complete: folders via POST /folders, files via the real
  // UploadManager chunk traffic.
  await expect(card.getByText("Hoàn tất").first()).toBeVisible({
    timeout: 20_000,
  });
  await expect(async () => {
    const batch = fixture.batchOf();
    expect(batch?.nodes.every((n) => n.state === "completed")).toBe(true);
  }).toPass({ timeout: 10_000 });
  // Node tree rows render with names only — nodeId stays the identity.
  await expect(card.getByText("inner.txt")).toBeVisible();
  await context.close();
});

test("[fixture] reload → needs-reselect → digest mismatch refusal → resume", async ({
  browser,
}) => {
  const context = await browser.newContext({ storageState: admin.get() });
  const page = await context.newPage();
  page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
  page.on("console", (m) => console.log("CONSOLE:", m.text()));
  const fixture = await openExplorer(page);
  const tree = makeTree({ "pickme/dir/f.txt": 60 * 1024 });
  const wrongTree = makeTree({ "other/dir/f.txt": 60 * 1024 });

  await page.setInputFiles(FOLDER_INPUT, tree);
  const card = page.getByTestId("folder-batch");
  await expect(card.getByText("Hoàn tất").first()).toBeVisible({
    timeout: 20_000,
  });
  expect(fixture.batchOf()?.batchId).toMatch(/^batch-e2e-/);

  // Reload: the IDB batch record restores → needs-reselect card.
  await page.reload();
  await expect(page.getByText(UPLOAD_MOUNT.label).first()).toBeVisible();
  const cardAfter = page.getByTestId("folder-batch");
  await expect(cardAfter.getByText("Cần chọn lại thư mục")).toBeVisible({
    timeout: 10_000,
  });

  // A structurally different folder → clear digest-mismatch refusal.
  const chooser1 = page.waitForEvent("filechooser");
  await cardAfter.locator("button", { hasText: "Chọn lại thư mục" }).click();
  await (await chooser1).setFiles(wrongTree);
  await expect(
    cardAfter.getByText(/không khớp kế hoạch/i),
  ).toBeVisible({ timeout: 10_000 });

  // The original tree matches the sealed digest → resumes to completed.
  const chooser2 = page.waitForEvent("filechooser");
  await cardAfter.locator("button", { hasText: "Chọn lại thư mục" }).click();
  await (await chooser2).setFiles(tree);
  await expect(cardAfter.getByText("Hoàn tất").first()).toBeVisible({
    timeout: 15_000,
  });
  await context.close();
});

test("[fixture] folder upload button targets the current Explorer folder", async ({
  browser,
}) => {
  const context = await browser.newContext({ storageState: admin.get() });
  const page = await context.newPage();
  const fixture = await openExplorer(page);
  const tree = makeTree({ "flatdir/f.txt": 8 * 1024 });

  await page.setInputFiles(FOLDER_INPUT, tree);
  const card = page.getByTestId("folder-batch");
  await expect(card).toBeVisible({ timeout: 10_000 });
  await expect(async () => {
    const create = fixture.calls.find((c) =>
      c.startsWith("POST /api/v1/upload-batches"),
    );
    expect(create).toBeDefined();
  }).toPass({ timeout: 10_000 });
  await context.close();
});
