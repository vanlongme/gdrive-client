import { mkdirSync } from "node:fs";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

/**
 * Preview E2E (T12). Real local workerd preview + page.route fixtures for
 * catalog/content/export — every fixture-backed assertion is labelled
 * [fixture] and never claimed as live Google evidence. Fixture bytes are
 * real files under tests/fixtures/preview/.
 */

import { EVIDENCE_DIR, useAdminStorage } from "./helpers";
import {
  ALL_ENTRIES,
  BAD_VIDEO,
  BIG_LOG,
  GDOC,
  GDOC_FAIL,
  HTML,
  MD,
  MOUNT,
  NOTES,
  PDF_DOC,
  PHOTO,
  PINNED,
  SVG,
  TONE,
  XSS_NAME,
  ZIP,
  routePreview,
} from "./preview-fixtures";

const admin = useAdminStorage();

async function gotoExplorer(page: Page): Promise<void> {
  await page.goto("/explorer");
  await expect(
    page.getByRole("heading", { name: "Explorer" }),
  ).toBeVisible();
}

/** Opens the file's detail panel then the preview dialog. */
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

test("image preview: zoom, fit, rotate, next/prev and focus restore [fixture]", async ({
  browser,
}) => {
  const context = await browser.newContext({ storageState: admin.get() });
  const page = await context.newPage();
  try {
    routePreview(page);
    await gotoExplorer(page);
    await expect(
      page.getByRole("button", { name: PHOTO.name, exact: true }),
    ).toBeVisible();

    const dialog = await openPreview(page, NOTES.name);
    // The text file previews first; next/prev follows the name-sorted
    // listing, so "Tệp sau" from notes.txt lands on photo.png.
    await expect(dialog.locator("pre")).toContainText("plain text");
    await dialog.getByRole("button", { name: "Tệp sau" }).click();
    await expect(
      dialog.getByRole("heading", { name: PHOTO.name }),
    ).toBeVisible();
    const img = dialog.locator("img");
    await expect(img).toBeVisible();
    // Real decode: the fixture PNG produces a natural size.
    await expect
      .poll(async () => img.evaluate((el) => (el as { naturalWidth: number }).naturalWidth))
      .toBe(1);

    // Zoom switches the image off fit-mode into an explicit pixel width.
    await dialog.getByRole("button", { name: "Phóng to" }).click();
    await expect(img).not.toHaveClass(/preview-image-fit/);
    await dialog.getByRole("button", { name: "Vừa khung" }).click();
    await expect(img).toHaveClass(/preview-image-fit/);
    // Rotate applies a transform.
    await dialog.getByRole("button", { name: "Xoay 90°" }).click();
    await expect(img).toHaveCSS("transform", /matrix|rotate/);

    // Previous returns to the text file.
    await dialog.getByRole("button", { name: "Tệp trước" }).click();
    await expect(
      dialog.getByRole("heading", { name: NOTES.name }),
    ).toBeVisible();
    await expect(dialog.locator("pre")).toContainText("plain text");

    // Closing restores focus to the launcher button.
    await dialog.getByRole("button", { name: "Đóng" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Xem trước" }),
    ).toBeFocused();
  } finally {
    await context.close();
  }
});

test("audio preview loads native player with speed control [fixture]", async ({
  browser,
}) => {
  const context = await browser.newContext({ storageState: admin.get() });
  const page = await context.newPage();
  try {
    routePreview(page);
    await gotoExplorer(page);
    const dialog = await openPreview(page, TONE.name);
    const audio = dialog.locator("audio");
    await expect(audio).toBeVisible();
    // The WAV fixture really loads metadata (seekable duration).
    await expect
      .poll(async () =>
        audio.evaluate((el) => (el as { readyState: number }).readyState),
      )
      .toBeGreaterThanOrEqual(1);
    await expect
      .poll(async () =>
        audio.evaluate((el) => (el as { duration: number }).duration),
      )
      .toBeGreaterThan(0);
    // Speed selector drives playbackRate.
    await dialog.locator("#preview-speed").selectOption("2");
    await expect
      .poll(async () =>
        audio.evaluate((el) => (el as { playbackRate: number }).playbackRate),
      )
      .toBe(2);
  } finally {
    await context.close();
  }
});

test("undecodable video falls back to a clear codec error [fixture]", async ({
  browser,
}) => {
  const context = await browser.newContext({ storageState: admin.get() });
  const page = await context.newPage();
  try {
    routePreview(page);
    await gotoExplorer(page);
    const dialog = await openPreview(page, BAD_VIDEO.name);
    await expect(
      dialog.getByText(/không giải mã được/),
    ).toBeVisible({ timeout: 12_000 });
    const download = dialog.getByRole("link", { name: "Tải xuống" }).last();
    await expect(download).toHaveAttribute(
      "href",
      `/api/v1/mounts/${MOUNT.id}/files/${BAD_VIDEO.id}/content`,
    );
  } finally {
    await context.close();
  }
});

test("pdf preview renders, navigates pages and searches text [fixture]", async ({
  browser,
}) => {
  const context = await browser.newContext({ storageState: admin.get() });
  const page = await context.newPage();
  try {
    routePreview(page);
    await gotoExplorer(page);
    const dialog = await openPreview(page, PDF_DOC.name);
    await expect(dialog.getByText("Trang 1 / 2")).toBeVisible({
      timeout: 15_000,
    });
    const canvas = dialog.locator("canvas");
    await expect
      .poll(async () =>
        canvas.evaluate((el) => (el as { width: number }).width),
      )
      .toBeGreaterThan(0);
    // Text layer carries selectable text spans.
    await expect(
      dialog.locator(".preview-textlayer span", {
        hasText: "Hello, Drive Worker!",
      }),
    ).toHaveCount(1);

    await dialog.getByRole("button", { name: "Trang sau" }).click();
    await expect(dialog.getByText("Trang 2 / 2")).toBeVisible();
    await expect(
      dialog.locator(".preview-textlayer span", {
        hasText: "Second page needle text",
      }),
    ).toHaveCount(1);

    // Search jumps back to the page containing the match and counts it.
    await dialog.getByPlaceholder("Tìm trong tài liệu…").fill("Hello");
    await dialog.getByRole("button", { name: "Tìm", exact: true }).click();
    await expect(dialog.getByText(/1\/1 kết quả/)).toBeVisible();
    await expect(dialog.getByText("Trang 1 / 2")).toBeVisible();
    mkdirSync(EVIDENCE_DIR, { recursive: true });
    await page.screenshot({
      path: `${EVIDENCE_DIR}/t12-pdf-preview.png`,
      fullPage: true,
    });
  } finally {
    await context.close();
  }
});

test("markdown renders GFM with sanitized links and images [fixture]", async ({
  browser,
}) => {
  const context = await browser.newContext({ storageState: admin.get() });
  const page = await context.newPage();
  try {
    const remoteRequests: string[] = [];
    const cspViolations: string[] = [];
    page.on("request", (request) => {
      if (!request.url().startsWith("http://localhost:8877")) {
        remoteRequests.push(request.url());
      }
    });
    page.on("console", (message) => {
      if (/Content Security Policy|violates the following/i.test(message.text())) {
        cspViolations.push(message.text());
      }
    });
    routePreview(page);
    await gotoExplorer(page);
    const dialog = await openPreview(page, MD.name);

    // Real GFM rendering: bold text, a safe link and a rendered image.
    await expect(
      dialog.locator(".preview-markdown strong"),
    ).toHaveText("bold");
    const safeLink = dialog.getByRole("link", { name: "safe link" });
    await expect(safeLink).toHaveAttribute("href", "https://example.com");
    await expect(safeLink).toHaveAttribute("rel", /noopener/);
    // Remote and protocol-relative images never render — the allowlist is
    // same-origin paths and raster data: URLs only — so they degrade to
    // their alt text and issue NO request to the remote host.
    await expect(
      dialog.locator(
        '.preview-markdown img[alt="safe image"], .preview-markdown img[alt="proto relative"], .preview-markdown img[alt="backslash host"]',
      ),
    ).toHaveCount(0);
    const markdown = dialog.locator(".preview-markdown");
    await expect(markdown).toContainText("safe image");
    await expect(markdown).toContainText("proto relative");
    await expect(markdown).toContainText("backslash host");
    expect(
      remoteRequests.filter((u) => /example\.com|evil\.example/.test(u)),
      `remote requests: ${JSON.stringify(remoteRequests)}`,
    ).toEqual([]);
    expect(cspViolations, JSON.stringify(cspViolations)).toEqual([]);
    // micromark strips data: destinations upstream (src=""), so even an
    // allowed raster data: image degrades to alt text — the renderer's
    // data:image/* allowlist only matters if that default ever changes.
    await expect(
      markdown.locator('img[alt="data image"]'),
    ).toHaveCount(0);
    await expect(markdown).toContainText("data image");

    // Raw HTML is escaped, not executed: the script tag is inert text.
    await expect(
      dialog.locator(".preview-markdown"),
    ).toContainText('<script>window.__xss = "script-tag"</script>');
    expect(await page.evaluate("() => window.__xss")).toBeUndefined();

    // Dangerous URL schemes never reach an href/src attribute.
    const evilLink = dialog.locator("a", { hasText: "evil javascript link" });
    await expect(evilLink).not.toHaveAttribute("href", /.+/);
    await expect(
      dialog.locator('a[href^="javascript:"], img[src^="javascript:"]'),
    ).toHaveCount(0);
    await expect(
      dialog.locator('a[href^="data:"], a[href^="vbscript:"]'),
    ).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("html and svg preview as escaped source only [fixture]", async ({
  browser,
}) => {
  const context = await browser.newContext({ storageState: admin.get() });
  const page = await context.newPage();
  try {
    routePreview(page);
    await gotoExplorer(page);

    const htmlDialog = await openPreview(page, HTML.name);
    await expect(
      htmlDialog.getByText(/mã nguồn, không chạy/),
    ).toBeVisible();
    await expect(
      htmlDialog.locator("pre.preview-code"),
    ).toContainText('__xss = "html-script"');
    await expect(htmlDialog.locator("img[onerror]")).toHaveCount(0);
    await htmlDialog.getByRole("button", { name: "Đóng" }).click();

    const svgDialog = await openPreview(page, SVG.name);
    await expect(svgDialog.locator("pre.preview-code")).toContainText(
      "<rect",
    );
    await expect(svgDialog.locator("svg")).toHaveCount(0);
    expect(await page.evaluate("() => window.__xss")).toBeUndefined();
  } finally {
    await context.close();
  }
});

test("unsupported format shows metadata plus the download action [fixture]", async ({
  browser,
}) => {
  const context = await browser.newContext({ storageState: admin.get() });
  const page = await context.newPage();
  try {
    routePreview(page);
    await gotoExplorer(page);
    const dialog = await openPreview(page, ZIP.name);
    await expect(dialog.getByText("Không có bản xem trước")).toBeVisible();
    await expect(
      dialog.locator("dd", { hasText: "application/zip" }),
    ).toBeVisible();
    const download = dialog.getByRole("link", { name: "Tải xuống" }).last();
    await expect(download).toHaveAttribute(
      "href",
      `/api/v1/mounts/${MOUNT.id}/files/${ZIP.id}/content`,
    );
  } finally {
    await context.close();
  }
});

test("google workspace document previews through the pdf export [fixture]", async ({
  browser,
}) => {
  const context = await browser.newContext({ storageState: admin.get() });
  const page = await context.newPage();
  try {
    const calls = routePreview(page);
    await gotoExplorer(page);
    const dialog = await openPreview(page, GDOC.name);
    await expect(dialog.getByText("Trang 1 / 2")).toBeVisible({
      timeout: 15_000,
    });
    expect(
      calls.exports.some((call) =>
        call.includes(`${GDOC.id}?format=pdf`),
      ),
      `export calls: ${JSON.stringify(calls.exports)}`,
    ).toBe(true);
  } finally {
    await context.close();
  }
});

test("workspace export failure surfaces an honest error [fixture]", async ({
  browser,
}) => {
  const context = await browser.newContext({ storageState: admin.get() });
  const page = await context.newPage();
  try {
    routePreview(page);
    await gotoExplorer(page);
    const dialog = await openPreview(page, GDOC_FAIL.name);
    await expect(dialog.getByText(/Xuất tài liệu/)).toBeVisible();
  } finally {
    await context.close();
  }
});

test("pinned revision mode=revision failure shows snapshot error [fixture]", async ({
  browser,
}) => {
  const context = await browser.newContext({ storageState: admin.get() });
  const page = await context.newPage();
  try {
    const calls = routePreview(page);
    await gotoExplorer(page);
    const dialog = await openPreview(page, PINNED.name);
    await expect(dialog.getByText(/Revision đã ghim/)).toBeVisible();
    expect(
      calls.content.some((call) =>
        call.includes(`${PINNED.id}?mode=revision&revision=rev-1`),
      ),
      `content calls: ${JSON.stringify(calls.content)}`,
    ).toBe(true);
  } finally {
    await context.close();
  }
});

test("text preview truncates past the 2 MiB budget [fixture]", async ({
  browser,
}) => {
  const context = await browser.newContext({ storageState: admin.get() });
  const page = await context.newPage();
  try {
    const big = {
      ...BIG_LOG,
      inlineBody: "0123456789abcdef\n".repeat(160_000), // ~2.6 MiB
    };
    routePreview(page, [big]);
    await gotoExplorer(page);
    const dialog = await openPreview(page, big.name);
    await expect(dialog.getByText(/chỉ hiển thị/)).toBeVisible();
    await expect(dialog.locator("pre.preview-code")).toContainText(
      "0123456789abcdef",
    );
  } finally {
    await context.close();
  }
});

test("hostile filename renders as inert text [fixture]", async ({
  browser,
}) => {
  const context = await browser.newContext({ storageState: admin.get() });
  const page = await context.newPage();
  try {
    page.on("dialog", (jsDialog) => {
      void jsDialog.dismiss();
      throw new Error("unexpected alert() from preview");
    });
    routePreview(page);
    await gotoExplorer(page);
    const dialog = await openPreview(page, XSS_NAME.name);
    await expect(
      dialog.getByRole("heading", { name: XSS_NAME.name }),
    ).toBeVisible();
    expect(await page.evaluate("() => window.__xss")).toBeUndefined();
  } finally {
    await context.close();
  }
});

test("spa CSP allows wasm+media and preview produces no violation [fixture]", async ({
  browser,
}) => {
  const context = await browser.newContext({ storageState: admin.get() });
  const page = await context.newPage();
  try {
    const violations: string[] = [];
    page.on("console", (message) => {
      if (
        message.type() === "error" &&
        /Content Security Policy|violates the following/i.test(
          message.text(),
        )
      ) {
        violations.push(message.text());
      }
    });
    routePreview(page);
    const response = await page.goto("/explorer");
    const csp = response?.headers()["content-security-policy"] ?? "";
    expect(csp).toContain("'wasm-unsafe-eval'");
    expect(csp).not.toContain("'unsafe-eval'");
    expect(csp).toContain("media-src 'self' blob:");
    expect(csp).toContain("worker-src 'self'");

    // PDF (worker + wasm + ranged fetches) and media previews must run clean.
    await gotoExplorer(page);
    const pdfDialog = await openPreview(page, PDF_DOC.name);
    await expect(pdfDialog.getByText("Trang 1 / 2")).toBeVisible({
      timeout: 15_000,
    });
    await pdfDialog.getByRole("button", { name: "Đóng" }).click();
    const audioDialog = await openPreview(page, TONE.name);
    await expect(audioDialog.locator("audio")).toBeVisible();
    expect(violations, JSON.stringify(violations)).toEqual([]);
  } finally {
    await context.close();
  }
});

test("closing during a slow load aborts the viewer request [fixture]", async ({
  browser,
}) => {
  const context = await browser.newContext({ storageState: admin.get() });
  const page = await context.newPage();
  try {
    const contentReq = (request: { url(): string }) =>
      request.url().includes(`${NOTES.id}/content`);
    routePreview(page, ALL_ENTRIES, {
      delayedContent: new Set([NOTES.id]),
    });
    await gotoExplorer(page);
    const sent = page.waitForEvent("request", { predicate: contentReq });
    const dialog = await openPreview(page, NOTES.name);
    await sent;
    const failed = page.waitForEvent("requestfailed", {
      predicate: contentReq,
      timeout: 10_000,
    });
    await dialog.getByRole("button", { name: "Đóng" }).click();
    await expect(dialog).toHaveCount(0);
    const request = await failed;
    // Chromium reports net::ERR_ABORTED, Firefox NS_BINDING_ABORTED.
    expect(request.failure()?.errorText).toMatch(
      /ERR_ABORTED|NS_BINDING_ABORTED/,
    );
  } finally {
    await context.close();
  }
});
