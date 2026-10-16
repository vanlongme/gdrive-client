import { readFileSync } from "node:fs";
import type { Page, Route } from "@playwright/test";

/**
 * Preview E2E fixtures (T12). Same convention as explorer.spec.ts: auth and
 * shell run against the REAL local workerd preview while catalog/detail/
 * content/export responses are Playwright `page.route` fixtures — Drive
 * transport pins googleapis.com and no production fixture seam exists.
 * Bytes served here come from real files under tests/fixtures/preview/.
 */

export const MOUNT = {
  id: "mnt-e2e-prev",
  label: "Preview Drive",
  visibility: "private",
  rootFolderId: "prev-root",
  operations: ["read"],
};

export interface PreviewEntry {
  id: string;
  kind: "file" | "folder" | "shortcut";
  name: string;
  mimeType: string;
  size: string;
  modifiedTime: string;
  hasThumbnail: boolean;
  /** Fixture file under tests/fixtures/preview/, or an inline body. */
  fixture?: string;
  inlineBody?: string;
  /** Content-Type the content route answers (defaults to mimeType). */
  contentType?: string;
  /** Preview descriptor attached to the FileDetail response. */
  preview?: Record<string, unknown>;
}

function loadFixture(name: string): Buffer {
  return readFileSync(`tests/fixtures/preview/${name}`);
}

export const PHOTO: PreviewEntry = {
  id: "pv-photo",
  kind: "file",
  name: "photo.png",
  mimeType: "image/png",
  size: "95",
  modifiedTime: "2026-10-01T09:00:00Z",
  hasThumbnail: false,
  fixture: "photo.png",
};

export const NOTES: PreviewEntry = {
  id: "pv-notes",
  kind: "file",
  name: "notes.txt",
  mimeType: "text/plain",
  size: "90",
  modifiedTime: "2026-10-02T09:00:00Z",
  hasThumbnail: false,
  fixture: "notes.txt",
};

export const TONE: PreviewEntry = {
  id: "pv-tone",
  kind: "file",
  name: "tone.wav",
  mimeType: "audio/wav",
  size: "4844",
  modifiedTime: "2026-10-03T09:00:00Z",
  hasThumbnail: false,
  fixture: "tone.wav",
};

export const BAD_VIDEO: PreviewEntry = {
  id: "pv-bad-video",
  kind: "file",
  name: "bad-codec.mp4",
  mimeType: "video/mp4",
  size: "40",
  modifiedTime: "2026-10-04T09:00:00Z",
  hasThumbnail: false,
  fixture: "bad-codec.mp4",
};

export const PDF_DOC: PreviewEntry = {
  id: "pv-pdf",
  kind: "file",
  name: "sample.pdf",
  mimeType: "application/pdf",
  size: "1400",
  modifiedTime: "2026-10-05T09:00:00Z",
  hasThumbnail: false,
  fixture: "sample.pdf",
};

export const MD: PreviewEntry = {
  id: "pv-md",
  kind: "file",
  name: "xss.md",
  mimeType: "text/markdown",
  size: "700",
  modifiedTime: "2026-10-06T09:00:00Z",
  hasThumbnail: false,
  fixture: "xss.md",
};

export const HTML: PreviewEntry = {
  id: "pv-html",
  kind: "file",
  name: "xss.html",
  mimeType: "text/html",
  size: "200",
  modifiedTime: "2026-10-07T09:00:00Z",
  hasThumbnail: false,
  fixture: "xss.html",
};

export const SVG: PreviewEntry = {
  id: "pv-svg",
  kind: "file",
  name: "xss.svg",
  mimeType: "image/svg+xml",
  size: "200",
  modifiedTime: "2026-10-08T09:00:00Z",
  hasThumbnail: false,
  fixture: "xss.svg",
};

export const ZIP: PreviewEntry = {
  id: "pv-zip",
  kind: "file",
  name: "archive.zip",
  mimeType: "application/zip",
  size: "4096",
  modifiedTime: "2026-10-09T09:00:00Z",
  hasThumbnail: false,
};

export const GDOC: PreviewEntry = {
  id: "pv-gdoc",
  kind: "file",
  name: "Báo cáo Docs",
  mimeType: "application/vnd.google-apps.document",
  size: "0",
  modifiedTime: "2026-10-10T09:00:00Z",
  hasThumbnail: false,
};

export const GDOC_FAIL: PreviewEntry = {
  id: "pv-gdoc-fail",
  kind: "file",
  name: "Huge Slides",
  mimeType: "application/vnd.google-apps.presentation",
  size: "0",
  modifiedTime: "2026-10-11T09:00:00Z",
  hasThumbnail: false,
};

export const PINNED: PreviewEntry = {
  id: "pv-pinned",
  kind: "file",
  name: "pinned.txt",
  mimeType: "text/plain",
  size: "30",
  modifiedTime: "2026-10-12T09:00:00Z",
  hasThumbnail: false,
  preview: {
    contentMode: "pinned-revision",
    revisionId: "rev-1",
    strictResumeSupported: true,
  },
};

export const BIG_LOG: PreviewEntry = {
  id: "pv-biglog",
  kind: "file",
  name: "big.log",
  mimeType: "text/plain",
  size: "3145728",
  modifiedTime: "2026-10-13T09:00:00Z",
  hasThumbnail: false,
};

export const XSS_NAME: PreviewEntry = {
  id: "pv-xss-name",
  kind: "file",
  name: '<img src=x onerror="window.__xss=1">.png',
  mimeType: "image/png",
  size: "95",
  modifiedTime: "2026-10-14T09:00:00Z",
  hasThumbnail: false,
  fixture: "photo.png",
};

export const ALL_ENTRIES = [
  PHOTO,
  NOTES,
  TONE,
  BAD_VIDEO,
  PDF_DOC,
  MD,
  HTML,
  SVG,
  ZIP,
  GDOC,
  GDOC_FAIL,
  PINNED,
  BIG_LOG,
  XSS_NAME,
];

export interface PreviewCalls {
  content: string[];
  exports: string[];
  details: string[];
}

export interface RouteOptions {
  /** File IDs whose detail/content fetches are delayed ~1.2s. */
  delayedContent?: Set<string>;
  /** File IDs whose export route answers a failure envelope. */
  failingExports?: Set<string>;
}

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });

const apiError = (
  code: string,
  message: string,
): { error: { code: string; message: string; requestId: string } } => ({
  error: { code, message, requestId: "e2e-req" },
});

/** Serves entry bytes honoring a single `Range: bytes=a-b` header. */
function fulfillContent(
  route: Route,
  entry: PreviewEntry,
  bytes: Buffer,
): Promise<void> {
  const range = route.request().headers()["range"];
  const type = entry.contentType ?? entry.mimeType;
  if (range !== undefined) {
    const match = /^bytes=(\d+)-(\d*)$/.exec(range);
    if (match !== null) {
      const start = Number(match[1]);
      const end =
        match[2] === "" ? bytes.length - 1 : Math.min(Number(match[2]), bytes.length - 1);
      const slice = bytes.subarray(start, end + 1);
      return route.fulfill({
        status: 206,
        contentType: type,
        headers: {
          "content-range": `bytes ${start}-${end}/${bytes.length}`,
          "accept-ranges": "bytes",
        },
        body: slice,
      });
    }
  }
  return route.fulfill({ status: 200, contentType: type, body: bytes });
}

/**
 * Installs the preview fixture surface; returns the captured call log.
 * Covers mounts/children/detail plus content (with Range + pinned-revision
 * semantics) and the Workspace export route.
 */
export function routePreview(
  page: Page,
  entries: PreviewEntry[] = ALL_ENTRIES,
  options: RouteOptions = {},
): PreviewCalls {
  const calls: PreviewCalls = { content: [], exports: [], details: [] };
  const byId = new Map(entries.map((entry) => [entry.id, entry]));

  const detailFor = (entry: PreviewEntry) => ({
    id: entry.id,
    kind: entry.kind,
    name: entry.name,
    mimeType: entry.mimeType,
    size: entry.size,
    modifiedTime: entry.modifiedTime,
    hasThumbnail: entry.hasThumbnail,
    readerAccessState: "readable",
    preview: {
      contentMode: "current-content",
      strictResumeSupported: false,
      readerAccessState: "readable",
      ...(entry.preview ?? {}),
    },
  });

  void page.route("**/api/v1/mounts**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const method = route.request().method();

    if (path === "/api/v1/mounts") {
      await json(route, { mounts: [MOUNT] });
      return;
    }
    const childrenMatch = path.match(
      /^\/api\/v1\/mounts\/([^/]+)\/folders\/([^/]+)\/children$/,
    );
    if (childrenMatch !== null && method === "GET") {
      await json(route, {
        entries: entries.map((entry) => ({
          id: entry.id,
          kind: entry.kind,
          name: entry.name,
          mimeType: entry.mimeType,
          size: entry.size,
          modifiedTime: entry.modifiedTime,
          hasThumbnail: entry.hasThumbnail,
        })),
      });
      return;
    }
    const contentMatch = path.match(
      /^\/api\/v1\/mounts\/([^/]+)\/files\/([^/]+)\/content$/,
    );
    if (contentMatch !== null && method === "GET") {
      const fileId = decodeURIComponent(contentMatch[2] ?? "");
      calls.content.push(`${fileId}?${url.searchParams.toString()}`);
      const entry = byId.get(fileId);
      if (entry === undefined) {
        await json(route, apiError("NOT_FOUND", "Not found."), 404);
        return;
      }
      if (options.delayedContent?.has(fileId)) {
        await new Promise((resolve) => setTimeout(resolve, 1_200));
      }
      if (url.searchParams.get("mode") === "revision") {
        await json(
          route,
          apiError(
            "SNAPSHOT_UNAVAILABLE",
            "The pinned revision is no longer available.",
          ),
          409,
        );
        return;
      }
      const bytes =
        entry.fixture !== undefined
          ? loadFixture(entry.fixture)
          : Buffer.from(entry.inlineBody ?? "", "utf8");
      await fulfillContent(route, entry, bytes);
      return;
    }
    const exportMatch = path.match(
      /^\/api\/v1\/mounts\/([^/]+)\/files\/([^/]+)\/export$/,
    );
    if (exportMatch !== null && method === "GET") {
      const fileId = decodeURIComponent(exportMatch[2] ?? "");
      calls.exports.push(`${fileId}?${url.searchParams.toString()}`);
      if (
        options.failingExports?.has(fileId) ||
        fileId === GDOC_FAIL.id
      ) {
        await json(
          route,
          apiError(
            "PREVIEW_UNSUPPORTED",
            "The exported document exceeds the size limit.",
          ),
          415,
        );
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/pdf",
        body: loadFixture("sample.pdf"),
      });
      return;
    }
    const thumbMatch = path.match(
      /^\/api\/v1\/mounts\/([^/]+)\/files\/([^/]+)\/thumbnail$/,
    );
    if (thumbMatch !== null) {
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
        checkedAt: "2026-10-15T10:00:00Z",
      });
      return;
    }
    const fileMatch = path.match(/^\/api\/v1\/mounts\/([^/]+)\/files\/([^/]+)$/);
    if (fileMatch !== null && method === "GET") {
      const fileId = decodeURIComponent(fileMatch[2] ?? "");
      calls.details.push(fileId);
      const entry = byId.get(fileId);
      if (entry === undefined) {
        await json(route, apiError("NOT_FOUND", "Not found."), 404);
        return;
      }
      await json(route, detailFor(entry));
      return;
    }
    await route.fallback();
  });

  return calls;
}
