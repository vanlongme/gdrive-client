import { mkdirSync } from "node:fs";
import { expect, test } from "@playwright/test";
import type { Page, Route } from "@playwright/test";

/**
 * Explorer E2E (wave-3 D). Auth/session/setup run against the REAL local
 * workerd preview. Catalog/content/thumbnail/readiness responses are
 * Playwright `page.route` fixtures because Drive transport pins
 * googleapis.com and no production fixture seam is allowed — every
 * fixture-backed assertion is labelled [fixture] and never claimed as live
 * Google evidence. Real local admin/session APIs are covered in
 * admin.spec.ts.
 */

import { EVIDENCE_DIR, useAdminStorage } from "./helpers";

const admin = useAdminStorage();

const MOUNT = {
  id: "mnt-e2e-1",
  label: "E2E Drive",
  visibility: "private",
  rootFolderId: "root-folder",
  operations: ["read"],
};

interface FixtureEntry {
  id: string;
  kind: "file" | "folder" | "shortcut";
  name: string;
  mimeType: string;
  size: string;
  modifiedTime: string;
  shortcutTargetId?: string;
  hasThumbnail: boolean;
}

const FOLDER_A: FixtureEntry = {
  id: "folder-a",
  kind: "folder",
  name: "Tài liệu",
  mimeType: "application/vnd.google-apps.folder",
  size: "0",
  modifiedTime: "2026-10-01T09:00:00Z",
  hasThumbnail: false,
};
const FILE_X: FixtureEntry = {
  id: "file-x",
  kind: "file",
  name: "báo cáo tài chính ư.pdf",
  mimeType: "application/pdf",
  size: "2048",
  modifiedTime: "2026-10-02T09:00:00Z",
  hasThumbnail: false,
};
// Two rows with identical display names but distinct Drive IDs (duplicate
// names must never collapse into one identity).
const DUP_1: FixtureEntry = {
  id: "file-dup-1",
  kind: "file",
  name: "report.pdf",
  mimeType: "application/pdf",
  size: "1024",
  modifiedTime: "2026-10-03T09:00:00Z",
  hasThumbnail: false,
};
const DUP_2: FixtureEntry = {
  id: "file-dup-2",
  kind: "file",
  name: "report.pdf",
  mimeType: "application/pdf",
  size: "4096",
  modifiedTime: "2026-10-04T09:00:00Z",
  hasThumbnail: false,
};
const FILE_Y: FixtureEntry = {
  id: "file-y",
  kind: "file",
  name: "photo.jpg",
  mimeType: "image/jpeg",
  size: "90000",
  modifiedTime: "2026-10-05T09:00:00Z",
  hasThumbnail: true,
};
const CHILD_A: FixtureEntry = {
  id: "child-a",
  kind: "file",
  name: "Hợp đồng ✓.txt",
  mimeType: "text/plain",
  size: "12",
  modifiedTime: "2026-10-06T09:00:00Z",
  hasThumbnail: false,
};

const MOUNT_2 = {
  id: "mnt-e2e-2",
  label: "Second Drive",
  visibility: "private",
  rootFolderId: "root-2",
  operations: ["read"],
};

interface CatalogCalls {
  children: string[];
  searches: string[];
  details: string[];
}

const SECRET_FOLDER: FixtureEntry = {
  id: "secret-folder",
  kind: "folder",
  name: "Khu vực bí mật",
  mimeType: "application/vnd.google-apps.folder",
  size: "0",
  modifiedTime: "2026-10-07T09:00:00Z",
  hasThumbnail: false,
};
// A shortcut whose server-side resolution lands on FOLDER_A — exercises the
// "open entry by its own ID, let the server resolve" path.
const SHORTCUT: FixtureEntry = {
  id: "lnk-1",
  kind: "shortcut",
  name: "Phím tắt Tài liệu",
  mimeType: "application/vnd.google-apps.shortcut",
  size: "0",
  modifiedTime: "2026-10-08T09:00:00Z",
  shortcutTargetId: "folder-a",
  hasThumbnail: false,
};

/** Installs the labelled catalog fixture; returns the captured call log. */
function routeCatalog(
  page: Page,
  options?: {
    delayedDetails?: Set<string>;
    delayedChildren?: Set<string>;
    forbidFolders?: Set<string>;
    extraRootEntries?: FixtureEntry[];
    mounts?: typeof MOUNT[];
    rejectDetails?: Set<string>;
  },
): CatalogCalls {
  const calls: CatalogCalls = { children: [], searches: [], details: [] };
  const json = (route: Route, body: unknown, status = 200) =>
    route.fulfill({
      status,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  const detailFor = (entry: FixtureEntry) => ({
    ...entry,
    readerAccessState: "unchecked",
  });
  const childrenOf = (folderId: string, cursor: string | null) => {
    if (folderId === MOUNT.rootFolderId) {
      return cursor === null
        ? {
            entries: [
              FOLDER_A,
              FILE_X,
              DUP_1,
              DUP_2,
              ...(options?.extraRootEntries ?? []),
            ],
            nextCursor: "page-2",
          }
        : { entries: [FILE_Y] };
    }
    if (folderId === FOLDER_A.id) return { entries: [CHILD_A] };
    return { entries: [] };
  };

  void page.route("**/api/v1/mounts**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const method = route.request().method();

    if (path === "/api/v1/mounts") {
      await json(route, { mounts: options?.mounts ?? [MOUNT] });
      return;
    }
    const childrenMatch = path.match(
      /^\/api\/v1\/mounts\/([^/]+)\/folders\/([^/]+)\/children$/,
    );
    if (childrenMatch !== null && method === "GET") {
      const folderId = decodeURIComponent(childrenMatch[2] ?? "");
      calls.children.push(`${folderId}?${url.searchParams.toString()}`);
      if (options?.forbidFolders?.has(folderId)) {
        await json(
          route,
          {
            error: {
              code: "FORBIDDEN",
              message: "Forbidden.",
              requestId: "e2e-req",
            },
          },
          403,
        );
        return;
      }
      if (options?.delayedChildren?.has(folderId)) {
        await new Promise((resolve) => setTimeout(resolve, 600));
      }
      await json(route, childrenOf(folderId, url.searchParams.get("cursor")));
      return;
    }
    const searchMatch = path.match(/^\/api\/v1\/mounts\/([^/]+)\/search$/);
    if (searchMatch !== null && method === "GET") {
      calls.searches.push(url.searchParams.toString());
      await json(route, {
        entries: [FILE_X],
        scope: url.searchParams.get("scope") ?? "drive",
      });
      return;
    }
    const contentMatch = path.match(
      /^\/api\/v1\/mounts\/([^/]+)\/files\/([^/]+)\/content$/,
    );
    if (contentMatch !== null && method === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/octet-stream",
        headers: { "content-disposition": 'attachment; filename="file.bin"' },
        body: "fixture-bytes",
      });
      return;
    }
    const thumbMatch = path.match(
      /^\/api\/v1\/mounts\/([^/]+)\/files\/([^/]+)\/thumbnail$/,
    );
    if (thumbMatch !== null && method === "GET") {
      await route.fulfill({ status: 404 });
      return;
    }
    const readinessMatch = path.match(
      /^\/api\/v1\/mounts\/([^/]+)\/files\/([^/]+)\/readiness$/,
    );
    if (readinessMatch !== null && method === "POST") {
      await json(route, {
        fileId: decodeURIComponent(readinessMatch[2] ?? ""),
        readerAccessState: "readable",
        checkedAt: "2026-10-12T10:00:00Z",
      });
      return;
    }
    const fileMatch = path.match(/^\/api\/v1\/mounts\/([^/]+)\/files\/([^/]+)$/);
    if (fileMatch !== null && method === "GET") {
      const fileId = decodeURIComponent(fileMatch[2] ?? "");
      calls.details.push(fileId);
      if (options?.delayedDetails?.has(fileId)) {
        await new Promise((resolve) => setTimeout(resolve, 800));
      }
      if (options?.rejectDetails?.has(fileId)) {
        await json(
          route,
          {
            error: {
              code: "NOT_FOUND",
              message: "Not found.",
              requestId: "e2e-req",
            },
          },
          404,
        );
        return;
      }
      if (fileId === SHORTCUT.id) {
        // Server-side shortcut resolution returns the target's detail.
        await json(route, detailFor(FOLDER_A));
        return;
      }
      const entry = [
        FOLDER_A,
        FILE_X,
        DUP_1,
        DUP_2,
        FILE_Y,
        CHILD_A,
        SHORTCUT,
      ].find((e) => e.id === fileId);
      if (entry === undefined) {
        await json(
          route,
          {
            error: {
              code: "NOT_FOUND",
              message: "Not found.",
              requestId: "e2e-req",
            },
          },
          404,
        );
        return;
      }
      await json(route, detailFor(entry));
      return;
    }
    await route.fallback();
  });
  return calls;
}

async function gotoExplorer(page: Page): Promise<void> {
  await page.goto("/explorer");
  await expect(
    page.getByRole("heading", { name: "Explorer" }),
  ).toBeVisible();
}

test("browse folders, breadcrumbs, Unicode names and cursor paging [fixture]", async ({
  browser,
}) => {
  const context = await browser.newContext({ storageState: admin.get() });
  const page = await context.newPage();
  try {
    const calls = routeCatalog(page);
    await gotoExplorer(page);

    // Root listing: Unicode name, duplicate names as separate rows.
    const table = page.locator(".entry-table");
    await expect(table.getByText("Tài liệu")).toBeVisible();
    await expect(table.getByText("báo cáo tài chính ư.pdf")).toBeVisible();
    await expect(
      table.getByRole("button", { name: "report.pdf", exact: true }),
    ).toHaveCount(2);
    mkdirSync(EVIDENCE_DIR, { recursive: true });
    await page.screenshot({
      path: `${EVIDENCE_DIR}/w3d-explorer-list.png`,
      fullPage: true,
    });

    // Cursor paging appends the second page and sends the cursor param.
    await page.getByRole("button", { name: "Tải thêm" }).click();
    await expect(table.getByText("photo.jpg")).toBeVisible();
    expect(
      calls.children.some((c) => c.includes("cursor=page-2")),
      `expected cursor page-2 in ${JSON.stringify(calls.children)}`,
    ).toBe(true);

    // Folder navigation pushes an ID breadcrumb; the crumb returns to root.
    await table.getByRole("button", { name: "Tài liệu" }).click();
    await expect(
      page.getByRole("button", { name: "Hợp đồng ✓.txt" }),
    ).toBeVisible();
    const crumbs = page.locator(".breadcrumbs");
    await expect(crumbs.getByText("Tài liệu")).toBeVisible();
    await crumbs.getByRole("button", { name: "E2E Drive" }).click();
    await expect(table.getByText("báo cáo tài chính ư.pdf")).toBeVisible();
  } finally {
    await context.close();
  }
});

test("scoped search sends q/scope/folderId and restores browse [fixture]", async ({
  browser,
}) => {
  const context = await browser.newContext({ storageState: admin.get() });
  const page = await context.newPage();
  try {
    const calls = routeCatalog(page);
    await gotoExplorer(page);
    await expect(page.getByText("Tài liệu")).toBeVisible();

    // Drive-scope search.
    await page.locator("#explorer-search").fill("báo cáo");
    await page.locator("#explorer-scope").selectOption("drive");
    await page.getByRole("button", { name: "Tìm", exact: true }).click();
    await expect(
      page.getByText(/Kết quả cho “báo cáo”/),
    ).toBeVisible();
    expect(
      calls.searches.some((q) => q.includes("scope=drive")),
      `searches: ${JSON.stringify(calls.searches)}`,
    ).toBe(true);
    const driveQuery = calls.searches.find((q) => q.includes("scope=drive"));
    expect(driveQuery).toContain("q=b%C3%A1o+c%C3%A1o");

    // Folder-scope search carries the current folder ID.
    await page.locator("#explorer-scope").selectOption("folder");
    await page.getByRole("button", { name: "Tìm", exact: true }).click();
    // The click only schedules the request; poll until the route sees it.
    await expect
      .poll(
        () =>
          calls.searches.some(
            (q) =>
              q.includes("scope=folder") && q.includes("folderId=root-folder"),
          ),
        { message: `searches: ${JSON.stringify(calls.searches)}` },
      )
      .toBe(true);

    // Clearing returns to the folder listing.
    await page.getByRole("button", { name: "Xóa tìm kiếm" }).click();
    await expect(page.getByText("Tài liệu")).toBeVisible();
  } finally {
    await context.close();
  }
});

test("grid view, multiselect and a real anchor download [fixture]", async ({
  browser,
}) => {
  const context = await browser.newContext({ storageState: admin.get() });
  const page = await context.newPage();
  try {
    routeCatalog(page);
    await gotoExplorer(page);
    await expect(page.getByText("Tài liệu")).toBeVisible();

    // Grid view renders cards.
    await page.getByRole("button", { name: "Lưới" }).click();
    const grid = page.locator(".entry-grid");
    await expect(grid.getByText("report.pdf").first()).toBeVisible();
    await page.screenshot({
      path: `${EVIDENCE_DIR}/w3d-explorer-grid.png`,
      fullPage: true,
    });

    // Multiselect: checking two rows reports the count; one file enables
    // the direct-download anchor.
    await grid
      .getByLabel(/Chọn báo cáo tài chính ư\.pdf/)
      .check();
    await expect(page.getByText("1 mục đã chọn")).toBeVisible();
    const download = page.locator(
      `.selection-bar a[href="/api/v1/mounts/${MOUNT.id}/files/${FILE_X.id}/content"]`,
    );
    await expect(download).toBeVisible();

    // The anchor performs a real navigation download (no fetch/blob path).
    // Note: a routed fulfill never sees this request — Chrome's download
    // path fetches the URL itself and the real worker answers (here: a
    // JSON 404 for the fixture mount). The meaningful assertion is that
    // the download is a plain same-origin URL — never a blob: URI, which
    // is what a fetch+Blob implementation would produce.
    const downloadEvent = page.waitForEvent("download");
    await download.click();
    const file = await downloadEvent;
    expect(file.url()).toBe(
      `http://localhost:8877/api/v1/mounts/${MOUNT.id}/files/${FILE_X.id}/content`,
    );
    expect(file.url().startsWith("blob:")).toBe(false);

    // Selecting a second entry disables the single-file download action.
    await grid.getByLabel(/Chọn report\.pdf/).first().check();
    await expect(page.getByText("2 mục đã chọn")).toBeVisible();
    await expect(
      page.locator(".selection-bar a", { hasText: "Tải xuống" }),
    ).toHaveCount(0);
    await page.getByRole("button", { name: "Bỏ chọn" }).click();
    await expect(page.getByText(/mục đã chọn/)).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("file detail shows readiness probe result [fixture]", async ({
  browser,
}) => {
  const context = await browser.newContext({ storageState: admin.get() });
  const page = await context.newPage();
  try {
    routeCatalog(page);
    await gotoExplorer(page);
    await expect(page.getByText("Tài liệu")).toBeVisible();

    await page
      .locator(".entry-table")
      .getByRole("button", { name: "báo cáo tài chính ư.pdf" })
      .click();
    const panel = page.locator(".detail-panel");
    await expect(panel.getByText("application/pdf")).toBeVisible();
    await expect(panel.getByText("Chưa kiểm tra")).toBeVisible();

    await page.getByRole("button", { name: "Kiểm tra quyền đọc" }).click();
    await expect(panel.getByText("Đọc được")).toBeVisible();
  } finally {
    await context.close();
  }
});

test("a denied folder surfaces the permission error honestly [fixture]", async ({
  browser,
}) => {
  const context = await browser.newContext({ storageState: admin.get() });
  const page = await context.newPage();
  try {
    routeCatalog(page, {
      forbidFolders: new Set([SECRET_FOLDER.id]),
      extraRootEntries: [SECRET_FOLDER],
    });
    await gotoExplorer(page);
    await expect(page.getByText("Khu vực bí mật")).toBeVisible();

    await page
      .locator(".entry-table")
      .getByRole("button", { name: "Khu vực bí mật" })
      .click();
    // The 403 FORBIDDEN body maps to a localized permission message with a
    // retry affordance — never silent emptiness or fabricated entries.
    const alert = page.getByRole("alert");
    await expect(alert).toBeVisible();
    await expect(alert).toContainText(/không có quyền/i);
    await page.screenshot({
      path: `${EVIDENCE_DIR}/w3d-explorer-denied.png`,
      fullPage: true,
    });
  } finally {
    await context.close();
  }
});

test("a stale detail response cannot resurrect across navigation [fixture]", async ({
  browser,
}) => {
  const context = await browser.newContext({ storageState: admin.get() });
  const page = await context.newPage();
  try {
    routeCatalog(page, { delayedDetails: new Set([FILE_X.id]) });
    await gotoExplorer(page);
    await expect(page.getByText("Tài liệu")).toBeVisible();

    // Open the slow file detail, then navigate into the folder before it
    // resolves — the late response must not reopen the panel or push a
    // crumb onto the new location.
    await page
      .locator(".entry-table")
      .getByRole("button", { name: "báo cáo tài chính ư.pdf" })
      .click();
    await page
      .locator(".entry-table")
      .getByRole("button", { name: "Tài liệu" })
      .click();
    await expect(page.getByText("Hợp đồng ✓.txt")).toBeVisible();
    await page.waitForTimeout(1000);
    await expect(page.locator(".detail-panel")).toHaveCount(0);
    const crumbs = page.locator(".breadcrumbs");
    await expect(crumbs.getByText("Tài liệu")).toBeVisible();
  } finally {
    await context.close();
  }
});

test("a stale detail response cannot resurrect across a mount switch [fixture]", async ({
  browser,
}) => {
  const context = await browser.newContext({ storageState: admin.get() });
  const page = await context.newPage();
  try {
    routeCatalog(page, {
      mounts: [MOUNT, MOUNT_2],
      delayedDetails: new Set([FILE_X.id]),
    });
    await gotoExplorer(page);
    await expect(page.getByText("Tài liệu")).toBeVisible();

    // Start a slow detail load on mount 1, then switch mounts — the late
    // response belongs to the old mount and must never land on mount 2.
    await page
      .locator(".entry-table")
      .getByRole("button", { name: "báo cáo tài chính ư.pdf" })
      .click();
    await page.locator("#mount-select").selectOption(MOUNT_2.id);
    await expect(
      page.locator(".breadcrumbs").getByText("Second Drive"),
    ).toBeVisible();
    await page.waitForTimeout(1000);
    await expect(page.locator(".detail-panel")).toHaveCount(0);
    const crumbs = page.locator(".breadcrumbs");
    await expect(crumbs.getByText("báo cáo tài chính ư.pdf")).toHaveCount(0);
    await expect(crumbs.getByText("Tài liệu")).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("a rejected detail cannot reopen the panel after close [fixture]", async ({
  browser,
}) => {
  const context = await browser.newContext({ storageState: admin.get() });
  const page = await context.newPage();
  try {
    routeCatalog(page, {
      delayedDetails: new Set([FILE_X.id]),
      rejectDetails: new Set([FILE_X.id]),
    });
    await gotoExplorer(page);
    await expect(page.getByText("Tài liệu")).toBeVisible();

    // Open the delayed detail, then close the panel before the rejection
    // lands — invalidateDetail must fence both the abort and the late error.
    await page
      .locator(".entry-table")
      .getByRole("button", { name: "báo cáo tài chính ư.pdf" })
      .click();
    await expect(page.locator(".detail-panel")).toBeVisible();
    await page
      .getByRole("button", { name: "Đóng chi tiết", exact: true })
      .click();
    await expect(page.locator(".detail-panel")).toHaveCount(0);
    await page.waitForTimeout(1000);
    await expect(page.locator(".detail-panel")).toHaveCount(0);
    await expect(page.getByRole("alert")).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("a shortcut resolving to a folder pushes exactly one breadcrumb [fixture]", async ({
  browser,
}) => {
  const context = await browser.newContext({ storageState: admin.get() });
  const page = await context.newPage();
  try {
    const calls = routeCatalog(page, { extraRootEntries: [SHORTCUT] });
    await gotoExplorer(page);
    await expect(
      page.getByRole("button", { name: "Tài liệu", exact: true }),
    ).toBeVisible();

    // Shortcut entries never get a direct-download anchor — content
    // endpoints reject shortcut IDs; resolution goes through the detail
    // path. Selecting the shortcut shows the count but no download action.
    const shortcutRow = page.locator("tr", {
      hasText: "Phím tắt Tài liệu",
    });
    await expect(shortcutRow.locator("a")).toHaveCount(0);
    await page.getByLabel("Chọn Phím tắt Tài liệu").check();
    await expect(page.getByText("1 mục đã chọn")).toBeVisible();
    await expect(
      page.locator(".selection-bar a", { hasText: "Tải xuống" }),
    ).toHaveCount(0);

    // Clicking the shortcut sends the shortcut's own ID to /files/:id —
    // never shortcutTargetId — and the server resolves the folder.
    await page
      .locator(".entry-table")
      .getByRole("button", { name: "Phím tắt Tài liệu" })
      .click();
    expect(calls.details).toContain(SHORTCUT.id);
    expect(calls.details).not.toContain("folder-a");

    await expect(
      page.getByRole("button", { name: "Hợp đồng ✓.txt" }),
    ).toBeVisible();
    // Exactly one crumb for the resolved folder (impure updaters would
    // double-push under StrictMode).
    const crumbs = page.locator(".breadcrumbs");
    await expect(
      crumbs.getByText("Tài liệu", { exact: true }),
    ).toHaveCount(1);
    await expect(crumbs.locator("li")).toHaveCount(2);
    // The detail panel navigated away rather than staying open.
    await expect(page.locator(".detail-panel")).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("empty mount list shows the honest empty state [fixture]", async ({
  browser,
}) => {
  const context = await browser.newContext({ storageState: admin.get() });
  const page = await context.newPage();
  try {
    await page.route("**/api/v1/mounts**", async (route) => {
      if (new URL(route.request().url()).pathname === "/api/v1/mounts") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ mounts: [] }),
        });
        return;
      }
      await route.fallback();
    });
    await gotoExplorer(page);
    await expect(page.getByText("Chưa có Drive nào")).toBeVisible();
  } finally {
    await context.close();
  }
});

test("mobile viewport keeps a one-column list and drawer access [fixture]", async ({
  browser,
}) => {
  const context = await browser.newContext({
    storageState: admin.get(),
    viewport: { width: 390, height: 844 },
  });
  const page = await context.newPage();
  try {
    routeCatalog(page);
    await gotoExplorer(page);
    await expect(page.getByText("Tài liệu")).toBeVisible();

    // Mobile list regression (visual QA): the name column must stay
    // readable — full stacked width, rows bounded — not a ~20px column
    // with 400px-tall rows.
    const nameCell = page.locator(".entry-table td.entry-name").first();
    const nameBox = await nameCell.boundingBox();
    expect(
      nameBox?.width ?? 0,
      "name column usable width at 390px",
    ).toBeGreaterThan(200);
    const rowBox = await page
      .locator(".entry-table tbody tr")
      .first()
      .boundingBox();
    expect(
      rowBox?.height ?? 0,
      "row height must be a compact stacked card",
    ).toBeLessThan(200);

    mkdirSync(EVIDENCE_DIR, { recursive: true });
    await page.screenshot({
      path: `${EVIDENCE_DIR}/w3d-explorer-mobile.png`,
      fullPage: true,
    });
  } finally {
    await context.close();
  }
});
