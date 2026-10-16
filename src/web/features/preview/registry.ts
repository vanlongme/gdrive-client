import type { DriveFileEntry } from "../../../shared/contracts/drive";

/**
 * PreviewRegistry resolution (architecture §8.1, plan T12). MIME is the
 * primary signal; the filename extension is a secondary hint only when the
 * MIME type is generic or a known mislabel (e.g. text/plain for Markdown).
 * The extension is normalized for lookup and never mutates the real name.
 */

export type PreviewViewer =
  | "image"
  | "media"
  | "pdf"
  | "text"
  | "markdown"
  | "hls"
  | "unsupported";

export type MediaKind = "audio" | "video";

/** "source" renders active content (HTML/SVG/XML/script) as escaped text. */
export type TextKind = "text" | "source";

export type UnsupportedReason = "no-viewer" | "workspace";

// HLS package entry playlists: .m3u8 files are the package surface (T13);
// the hls viewer creates/advances the package and plays only the ready
// generation's playerUrl. Detection is MIME first, then the .m3u8
// extension on generic/mislabelled types.
const HLS_MIME = new Set([
  "application/vnd.apple.mpegurl",
  "application/x-mpegurl",
  "application/mpegurl",
  "audio/mpegurl",
  "audio/x-mpegurl",
]);

const HLS_EXTENSIONS = new Set(["m3u8", "m3u"]);

export interface PreviewPlan {
  viewer: PreviewViewer;
  /** Where bytes come from: the SA content route or a Workspace export. */
  source: "content" | "export-pdf";
  mediaKind?: MediaKind;
  textKind?: TextKind;
  reason?: UnsupportedReason;
}

// Google Workspace types exportable to PDF for preview (the server's export
// allowlist currently carries only 'pdf').
const WORKSPACE_EXPORTABLE = new Set([
  "application/vnd.google-apps.document",
  "application/vnd.google-apps.spreadsheet",
  "application/vnd.google-apps.presentation",
  "application/vnd.google-apps.drawing",
]);

const WORKSPACE_PREFIX = "application/vnd.google-apps.";

// Active content: never rendered on this origin — source view only.
const ACTIVE_SOURCE_MIME = new Set([
  "text/html",
  "application/xhtml+xml",
  "image/svg+xml",
  "text/xml",
  "application/xml",
  "text/javascript",
  "application/javascript",
  "application/ecmascript",
  "text/ecmascript",
  "application/x-javascript",
]);

// Browsers decode these natively. HEIC/RAW/TIFF and friends stay unsupported.
const IMAGE_MIME = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/bmp",
  "image/x-icon",
  "image/vnd.microsoft.icon",
]);

const MARKDOWN_MIME = new Set(["text/markdown", "text/x-markdown"]);

const TEXTUAL_MIME = new Set([
  "application/json",
  "application/x-ndjson",
  "application/ld+json",
  "application/yaml",
  "application/x-yaml",
  "application/toml",
  "application/sql",
  "application/x-sh",
  "application/x-httpd-php",
  "application/rtf",
]);

const GENERIC_MIME = new Set([
  "",
  "application/octet-stream",
  "binary/octet-stream",
  "application/x-binary",
  "application/unknown",
]);

type ExtensionKind =
  | "image"
  | "audio"
  | "video"
  | "pdf"
  | "text"
  | "source"
  | "markdown"
  | "unsupported";

// Consulted only for generic/MIME-less files — and for .md on text/plain,
// the one common Drive mislabel where the extension changes the viewer.
const EXTENSION_KIND: Record<string, ExtensionKind> = {
  pdf: "pdf",
  md: "markdown",
  markdown: "markdown",
  txt: "text",
  text: "text",
  log: "text",
  json: "text",
  csv: "text",
  tsv: "text",
  yaml: "text",
  yml: "text",
  toml: "text",
  ini: "text",
  cfg: "text",
  py: "text",
  rb: "text",
  ts: "text",
  tsx: "text",
  java: "text",
  c: "text",
  h: "text",
  cpp: "text",
  cs: "text",
  go: "text",
  rs: "text",
  php: "text",
  sql: "text",
  sh: "text",
  css: "text",
  html: "source",
  htm: "source",
  xhtml: "source",
  svg: "source",
  xml: "source",
  xsl: "source",
  js: "source",
  mjs: "source",
  cjs: "source",
  jsx: "source",
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  avif: "image",
  bmp: "image",
  ico: "image",
  mp3: "audio",
  wav: "audio",
  ogg: "audio",
  oga: "audio",
  flac: "audio",
  m4a: "audio",
  aac: "audio",
  opus: "audio",
  weba: "audio",
  mp4: "video",
  m4v: "video",
  webm: "video",
  mov: "video",
  ogv: "video",
  heic: "unsupported",
  heif: "unsupported",
  tiff: "unsupported",
  tif: "unsupported",
};

const UNSUPPORTED_PLAN: PreviewPlan = {
  viewer: "unsupported",
  source: "content",
  reason: "no-viewer",
};

function extensionOf(name: string): string {
  const base = name.slice(name.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "";
  return base.slice(dot + 1).toLowerCase();
}

function planFromExtension(kind: ExtensionKind): PreviewPlan {
  switch (kind) {
    case "image":
      return { viewer: "image", source: "content" };
    case "audio":
      return { viewer: "media", source: "content", mediaKind: "audio" };
    case "video":
      return { viewer: "media", source: "content", mediaKind: "video" };
    case "pdf":
      return { viewer: "pdf", source: "content" };
    case "source":
      return { viewer: "text", source: "content", textKind: "source" };
    case "markdown":
      return { viewer: "markdown", source: "content" };
    case "text":
      return { viewer: "text", source: "content", textKind: "text" };
    default:
      return UNSUPPORTED_PLAN;
  }
}

export function resolvePreviewPlan(
  file: Pick<DriveFileEntry, "kind" | "mimeType" | "name">,
): PreviewPlan {
  if (file.kind !== "file") return UNSUPPORTED_PLAN;

  const mime = file.mimeType.trim().toLowerCase().split(";")[0]?.trim() ?? "";
  const ext = extensionOf(file.name);

  if (mime.startsWith(WORKSPACE_PREFIX)) {
    return WORKSPACE_EXPORTABLE.has(mime)
      ? { viewer: "pdf", source: "export-pdf" }
      : { viewer: "unsupported", source: "export-pdf", reason: "workspace" };
  }

  // Active content must never render with the app's origin — source text
  // (escaped) is the only preview, and this check precedes image/* and
  // text/* matching on purpose.
  if (ACTIVE_SOURCE_MIME.has(mime) || mime.endsWith("+xml")) {
    return { viewer: "text", source: "content", textKind: "source" };
  }

  if (mime === "application/pdf") {
    return { viewer: "pdf", source: "content" };
  }

  // HLS entry playlist: explicit MIME wins over the extension; the
  // extension route only fires for generic/ambiguous types below.
  if (HLS_MIME.has(mime)) {
    return { viewer: "hls", source: "content" };
  }

  if (mime.startsWith("image/")) {
    return IMAGE_MIME.has(mime)
      ? { viewer: "image", source: "content" }
      : UNSUPPORTED_PLAN;
  }

  if (mime.startsWith("video/")) {
    return { viewer: "media", source: "content", mediaKind: "video" };
  }
  if (mime.startsWith("audio/")) {
    return { viewer: "media", source: "content", mediaKind: "audio" };
  }

  if (MARKDOWN_MIME.has(mime) || (mime === "text/plain" && ext === "md")) {
    return { viewer: "markdown", source: "content" };
  }

  if (mime.startsWith("text/") || TEXTUAL_MIME.has(mime) || mime.endsWith("+json")) {
    return { viewer: "text", source: "content", textKind: "text" };
  }

  if (GENERIC_MIME.has(mime) || mime === "text/plain") {
    if (HLS_EXTENSIONS.has(ext)) {
      return { viewer: "hls", source: "content" };
    }
  }

  if (GENERIC_MIME.has(mime)) {
    const kind = ext === "" ? "unsupported" : (EXTENSION_KIND[ext] ?? "unsupported");
    return planFromExtension(kind);
  }

  return UNSUPPORTED_PLAN;
}
