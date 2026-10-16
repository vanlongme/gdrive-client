import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

/**
 * HLS preview E2E (T13 UI). Real local workerd preview + real Chromium
 * playback (hls.js + MSE over ffmpeg-produced segments); all
 * /api/v1/media-packages traffic is page.route fixtures — [fixture] and
 * never live Google evidence.
 */

import { EVIDENCE_DIR, useAdminStorage } from "./helpers";

/** DOM lib isn't in this tsconfig — structural shape for evaluate(). */
interface VideoEl {
  currentTime: number;
  play(): Promise<void>;
}
import { HLS_ENTRY, routeHlsPackage } from "./hls-fixtures";
import { routePreview } from "./preview-fixtures";

const admin = useAdminStorage();

async function gotoExplorer(page: Page): Promise<void> {
  await page.goto("/explorer");
  await expect(
    page.getByRole("heading", { name: "Explorer" }),
  ).toBeVisible();
}

async function openPreview(page: Page, name: string) {
  await page
    .locator(".entry-table")
    .getByRole("button", { name, exact: true })
    .click();
  await page.getByRole("button", { name: "Xem trước" }).click();
  const dialog = page.getByRole("dialog", { name: "Xem trước" });
  await expect(dialog).toBeVisible();
  return dialog;
}

test("hls package: preparing -> ready -> real playback, seek, track switch, cleanup [fixture]", async ({
  browser,
}) => {
  const context = await browser.newContext({ storageState: admin.get() });
  const page = await context.newPage();
  const cspViolations: string[] = [];
  page.on("console", (msg) => {
    if (/content security policy|violat/i.test(msg.text())) {
      cspViolations.push(msg.text());
    }
  });
  try {
    routePreview(page, [HLS_ENTRY]);
    const calls = routeHlsPackage(page, { advancesBeforeReady: 2 });
    let documentCsp = "";
    page.on("response", (res) => {
      if (res.request().resourceType() === "document") {
        documentCsp =
          res.headers()["content-security-policy"] ?? documentCsp;
      }
    });
    await gotoExplorer(page);

    // CSP: the served document keeps 'self' + media/worker blob allowances.
    expect(documentCsp).toContain("media-src 'self' blob:");
    expect(documentCsp).toContain("worker-src 'self' blob:");
    expect(documentCsp).not.toMatch(/https?:/);

    const dialog = await openPreview(page, HLS_ENTRY.name);
    // Preparing phase is visible while the bounded advance loop runs.
    await expect(
      dialog.getByText("Đang chuẩn bị gói phát…"),
    ).toBeVisible();

    const video = dialog.getByTestId("hls-video");
    await expect(video).toBeVisible({ timeout: 20_000 });
    expect(calls.creates).toBe(1);
    expect(calls.advances).toBeGreaterThanOrEqual(3);
    // The player only ever loaded the ready generation's playerUrl.
    expect(calls.resources[0]).toBe("r1");

    // Real playback: Chromium + hls.js + MSE decode the fixture segments.
    await video.evaluate((v: VideoEl) => {
      void v.play();
    });
    await expect
      .poll(
        async () =>
          video.evaluate((v: VideoEl) => v.currentTime),
        { timeout: 15_000 },
      )
      .toBeGreaterThan(0.5);

    // Seek.
    await video.evaluate((v: VideoEl) => {
      v.currentTime = 4;
    });
    await expect
      .poll(async () =>
        video.evaluate((v: VideoEl) => v.currentTime),
      )
      .toBeGreaterThan(3.5);

    // Alternate audio tracks: the master exposes English/Français.
    const audioSel = dialog.getByTestId("hls-audio-track");
    await expect(audioSel).toBeVisible({ timeout: 10_000 });
    await expect(audioSel.locator("option")).toHaveCount(2);
    const frRequestsBefore = calls.resources.filter((r) =>
      ["r10", "r11", "r12", "r13"].includes(r),
    ).length;
    await audioSel.selectOption("1");
    await expect
      .poll(
        () =>
          calls.resources.filter((r) =>
            ["r10", "r11", "r12", "r13"].includes(r),
          ).length,
        { timeout: 10_000 },
      )
      .toBeGreaterThan(frRequestsBefore);

    // Subtitle track selection.
    const subSel = dialog.getByTestId("hls-subtitle-track");
    await expect(subSel).toBeVisible();
    await expect(subSel.locator("option")).toHaveCount(2);
    await subSel.selectOption("0");
    await expect
      .poll(() => calls.resources.includes("r17"), { timeout: 10_000 })
      .toBe(true);

    await page.screenshot({
      path: `${EVIDENCE_DIR}/t13-hls-playback.png`,
      fullPage: true,
    });

    // Close cleanup: dialog unmounts, no further advance polling, and the
    // media element is gone (hls.destroy() + detach inside unmount).
    const advanceCountAtClose = calls.advances;
    await dialog.getByRole("button", { name: "Đóng" }).click();
    await expect(dialog).toBeHidden();
    await page.waitForTimeout(1_000);
    expect(calls.advances).toBe(advanceCountAtClose);
    expect(cspViolations).toEqual([]);
  } finally {
    await context.close();
  }
});

test("hostile package: advance failure surfaces an error, no playback [fixture]", async ({
  browser,
}) => {
  const context = await browser.newContext({ storageState: admin.get() });
  const page = await context.newPage();
  try {
    routePreview(page, [HLS_ENTRY]);
    const calls = routeHlsPackage(page, {
      advanceError: {
        status: 400,
        code: "VALIDATION_FAILED",
        message: "The HLS playlist is outside the supported subset.",
      },
    });
    await gotoExplorer(page);
    const dialog = await openPreview(page, HLS_ENTRY.name);
    await expect(dialog.locator(".alert-error")).toBeVisible({
      timeout: 15_000,
    });
    expect(calls.resources).toEqual([]);
  } finally {
    await context.close();
  }
});

test("stale generation: resource 409 CONTENT_CHANGED surfaces an error [fixture]", async ({
  browser,
}) => {
  const context = await browser.newContext({ storageState: admin.get() });
  const page = await context.newPage();
  try {
    routePreview(page, [HLS_ENTRY]);
    routeHlsPackage(page, { staleResources: new Set(["r1"]) });
    await gotoExplorer(page);
    const dialog = await openPreview(page, HLS_ENTRY.name);
    await expect(dialog.locator(".alert-error")).toBeVisible({
      timeout: 15_000,
    });
    // The fatal playlist failure swaps the player for the error panel.
    await expect(dialog.getByTestId("hls-video")).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("unauthorized package access surfaces an honest error [fixture]", async ({
  browser,
}) => {
  const context = await browser.newContext({ storageState: admin.get() });
  const page = await context.newPage();
  try {
    routePreview(page, [HLS_ENTRY]);
    routeHlsPackage(page, {
      advanceError: {
        status: 403,
        code: "FORBIDDEN",
        message: "Access to this package is denied.",
      },
    });
    await gotoExplorer(page);
    const dialog = await openPreview(page, HLS_ENTRY.name);
    await expect(dialog.locator(".alert-error")).toBeVisible({
      timeout: 15_000,
    });
  } finally {
    await context.close();
  }
});
