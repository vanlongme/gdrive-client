import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { useAdminStorage } from "./helpers";
import { installUploadFixtures, UPLOAD_MOUNT } from "./upload-fixtures";

/**
 * Upload E2E (T09). Real sign-in against the local workerd preview; the
 * catalog/upload endpoints are protocol-faithful Playwright fixtures
 * ([fixture] label) because no live Google boundary exists locally. The
 * browser code under test is real: hash-wasm worker hashing, IndexedDB
 * recovery metadata, Blob.slice chunk bodies, the persistent drawer and the
 * reload → reselect → canonical-view resume flow.
 */

const admin = useAdminStorage();

const UPLOAD_INPUT = '[data-testid="upload-input"]';
const RESELECT_INPUT = '[data-testid="reselect-input"]';

function makeFile(name: string, size: number, fill: number) {
  return { name, mimeType: "application/octet-stream", buffer: Buffer.alloc(size, fill) };
}

async function gotoExplorerWithFixtures(page: Page) {
  const fixture = installUploadFixtures(page);
  await page.goto("/explorer");
  await expect(page.getByText(UPLOAD_MOUNT.label).first()).toBeVisible();
  return fixture;
}

test.describe.configure({ mode: "serial" });

test("[fixture] uploads a file end-to-end: hash → init → chunks → completed", async ({
  browser,
}) => {
  const context = await browser.newContext({ storageState: admin.get() });
  const page = await context.newPage();
  const fixture = await gotoExplorerWithFixtures(page);

  // Hash timing note for T09.md: enqueue → first chunk request covers the
  // real hash-wasm worker pass over 200 KiB in the browser.
  const enqueueAt = Date.now();
  await page.setInputFiles(UPLOAD_INPUT, [
    makeFile("hello.bin", 200 * 1024, 0x41),
  ]);
  const drawer = page.getByTestId("transfer-drawer");
  await expect(drawer).toBeVisible();
  await expect(drawer.getByText("hello.bin")).toBeVisible();
  await expect(drawer.getByText("Hoàn tất")).toBeVisible({ timeout: 15_000 });
  console.log(`[t09-timing] enqueue->first chunk: ${fixture.chunkStartedAt !== undefined ? fixture.chunkStartedAt - enqueueAt : -1}ms; total: ${Date.now() - enqueueAt}ms`);
  const offsets = fixture.chunks.map((c) => c.offset);
  expect(offsets).toEqual(["0", "65536", "131072", "196608"]);
  expect(fixture.chunks.map((c) => c.byteLength)).toEqual([
    65536, 65536, 65536, 8192,
  ]);
  // The completed upload surfaces in the folder listing after refresh.
  await expect(page.getByText("hello.bin").first()).toBeVisible();
  await context.close();
});

test("[fixture] runs at most two chunk uploads concurrently", async ({
  browser,
}) => {
  const context = await browser.newContext({ storageState: admin.get() });
  const page = await context.newPage();
  const fixture = await gotoExplorerWithFixtures(page);

  await page.setInputFiles(UPLOAD_INPUT, [
    makeFile("a.bin", 140 * 1024, 1),
    makeFile("b.bin", 140 * 1024, 2),
    makeFile("c.bin", 140 * 1024, 3),
  ]);
  const drawer = page.getByTestId("transfer-drawer");
  await expect(drawer.getByText("Hoàn tất")).toHaveCount(3, {
    timeout: 20_000,
  });
  expect(fixture.maxConcurrentChunks).toBeLessThanOrEqual(2);
  expect(fixture.maxConcurrentChunks).toBeGreaterThanOrEqual(2);
  await context.close();
});

test("[fixture] pause and resume keep confirmed offsets", async ({
  browser,
}) => {
  const context = await browser.newContext({ storageState: admin.get() });
  const page = await context.newPage();
  const fixture = await gotoExplorerWithFixtures(page);

  await page.setInputFiles(UPLOAD_INPUT, [
    makeFile("pausable.bin", 300 * 1024, 7),
  ]);
  const drawer = page.getByTestId("transfer-drawer");
  const pauseButton = drawer.getByRole("button", { name: "Tạm dừng" });
  await expect(pauseButton).toBeVisible({ timeout: 10_000 });
  await pauseButton.click();
  await expect(drawer.getByText("Đã tạm dừng")).toBeVisible();
  const sentBefore = fixture.chunks.length;
  await page.waitForTimeout(300);
  expect(fixture.chunks.length).toBe(sentBefore);
  await drawer.getByRole("button", { name: "Tiếp tục" }).click();
  await expect(drawer.getByText("Hoàn tất")).toBeVisible({ timeout: 15_000 });
  await context.close();
});

test("[fixture] route change does not cancel the queue", async ({
  browser,
}) => {
  const context = await browser.newContext({ storageState: admin.get() });
  const page = await context.newPage();
  const fixture = await gotoExplorerWithFixtures(page);
  void fixture;

  await page.setInputFiles(UPLOAD_INPUT, [
    makeFile("route-survivor.bin", 400 * 1024, 9),
  ]);
  const drawer = page.getByTestId("transfer-drawer");
  await expect(drawer.getByText("route-survivor.bin")).toBeVisible();
  // Navigate mid-upload; the drawer lives outside routes.
  await page.getByRole("link", { name: "Truyền tệp" }).first().click();
  await expect(page).toHaveURL(/\/transfers/);
  // The same item is visible on the page AND in the drawer — assert both.
  await expect(page.getByTestId("transfer-drawer").getByText("route-survivor.bin")).toBeVisible();
  await expect(page.locator("#main-content").getByText("route-survivor.bin")).toBeVisible();
  await expect(
    page.getByTestId("transfer-drawer").getByText("Hoàn tất"),
  ).toBeVisible({ timeout: 15_000 });
  await context.close();
});

test("[fixture] reload requires reselect, rehashes, resumes from canonical view", async ({
  browser,
}) => {
  const context = await browser.newContext({ storageState: admin.get() });
  const page = await context.newPage();
  const fixture = await gotoExplorerWithFixtures(page);
  const source = makeFile("resume-me.bin", 300 * 1024, 0x5a);

  await page.setInputFiles(UPLOAD_INPUT, [source]);
  const drawer = page.getByTestId("transfer-drawer");
  await expect(
    drawer.getByRole("button", { name: "Tạm dừng" }),
  ).toBeVisible({ timeout: 10_000 });
  await drawer.getByRole("button", { name: "Tạm dừng" }).click();
  await expect(drawer.getByText("Đã tạm dừng")).toBeVisible();

  // Reload drops the in-memory File; the IndexedDB record drives reselect.
  await page.reload();
  await expect(page.getByText(UPLOAD_MOUNT.label).first()).toBeVisible();
  const drawerAfter = page.getByTestId("transfer-drawer");
  await expect(drawerAfter.getByText("Cần chọn lại tệp")).toBeVisible({
    timeout: 10_000,
  });

  // Same name/size but different bytes: rehash must reject the reselect.
  const wrong = makeFile("resume-me.bin", 300 * 1024, 0x99);
  const chunksBefore = fixture.chunks.length;
  await page.setInputFiles(RESELECT_INPUT, [wrong]);
  await expect(
    drawerAfter.getByText(/không khớp nội dung/i),
  ).toBeVisible({ timeout: 10_000 });
  expect(fixture.chunks.length).toBe(chunksBefore);

  // Correct file: rehash matches, canonical view says resume at the pause
  // point; the upload completes with no re-sent chunks.
  await page.setInputFiles(RESELECT_INPUT, [source]);
  await expect(drawerAfter.getByText("Hoàn tất")).toBeVisible({
    timeout: 15_000,
  });
  expect(fixture.calls.some((c) => c.includes("/resume"))).toBe(true);
  // No offset was sent twice across the reload: strictly increasing chunks.
  const offsets = fixture.chunks.map((c) => BigInt(c.offset));
  for (let i = 1; i < offsets.length; i++) {
    expect(offsets[i]).toBeGreaterThan(offsets[i - 1] ?? 0n);
  }
  await context.close();
});

test("[fixture] completed upload with blocked reader shows a distinct note", async ({
  browser,
}) => {
  const context = await browser.newContext({ storageState: admin.get() });
  const page = await context.newPage();
  const fixture = await gotoExplorerWithFixtures(page);
  fixture.blockedReaderNames.add("sa-blocked.bin");

  await page.setInputFiles(UPLOAD_INPUT, [
    makeFile("sa-blocked.bin", 40 * 1024, 0x11),
  ]);
  const drawer = page.getByTestId("transfer-drawer");
  await expect(drawer.getByText("Hoàn tất")).toBeVisible({ timeout: 15_000 });
  await expect(
    drawer.getByText(/chưa thể xem hoặc tải xuống/i),
  ).toBeVisible();
  await context.close();
});

test("[fixture] lost chunk response recovers via reconcile", async ({
  browser,
}) => {
  const context = await browser.newContext({ storageState: admin.get() });
  const page = await context.newPage();
  const fixture = await gotoExplorerWithFixtures(page);
  fixture.silentNextChunk(); // second chunk commits upstream, response lost

  await page.setInputFiles(UPLOAD_INPUT, [
    makeFile("lost-response.bin", 140 * 1024, 0x22),
  ]);
  const drawer = page.getByTestId("transfer-drawer");
  await expect(drawer.getByText("Hoàn tất")).toBeVisible({ timeout: 20_000 });
  expect(
    fixture.calls.filter((c) => c.includes("/reconcile")).length,
  ).toBeGreaterThanOrEqual(1);
  await context.close();
});
