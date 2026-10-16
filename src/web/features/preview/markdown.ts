import { micromark } from "micromark";
import { gfm, gfmHtml } from "micromark-extension-gfm";

/**
 * Markdown → sanitized HTML (architecture §8.1, plan T12). micromark runs
 * with raw HTML off (it is escaped, not stripped) and the built-in
 * dangerous-protocol filter on. A DOM pass then applies the explicit
 * link/image policy — DOMParser documents are inert and never fetch
 * subresources, so nothing hostile can run or leak during sanitization.
 */

const LINK_SCHEMES = new Set(["https:", "http:", "mailto:"]);

function schemeOf(url: string): string | null {
  try {
    return new URL(url, "https://preview.invalid/").protocol;
  } catch {
    return null;
  }
}

function isSafeLink(href: string): boolean {
  if (href.startsWith("#")) return true;
  const scheme = schemeOf(href);
  return scheme !== null && LINK_SCHEMES.has(scheme);
}

function isSafeImage(src: string): boolean {
  // Same-origin path only: exactly one leading '/' — '//host' (protocol-
  // relative) and '/\host' (UNC-style) are NOT same-origin, and neither are
  // the percent-encoded forms micromark can emit ('/%2f…', '/%5c…').
  if (src.startsWith("/")) {
    const rest = src.slice(1).toLowerCase();
    if (
      !rest.startsWith("/") &&
      !rest.startsWith("\\") &&
      !rest.startsWith("%2f") &&
      !rest.startsWith("%5c")
    ) {
      return true;
    }
  }
  // Embedded raster images only; data:image/svg+xml can carry script.
  // Word-boundary (not literal ';'/'<,') because micromark may percent-
  // encode the separator.
  if (/^data:image\/(png|jpe?g|gif|webp)\b/i.test(src)) return true;
  // Remote images (http/https/anything else) are never loaded from
  // untrusted Drive content — they would leak the viewer's IP/referer and
  // are blocked by CSP anyway.
  return false;
}

function sanitizeRenderedHtml(html: string): string {
  const doc = new DOMParser().parseFromString(
    `<div>${html}</div>`,
    "text/html",
  );
  const root = doc.body.firstElementChild;
  if (root === null) return "";

  for (const anchor of Array.from(root.querySelectorAll("a"))) {
    const href = anchor.getAttribute("href") ?? "";
    if (!isSafeLink(href)) {
      anchor.removeAttribute("href");
    }
    anchor.setAttribute("rel", "noopener noreferrer");
    anchor.setAttribute("target", "_blank");
  }

  for (const image of Array.from(root.querySelectorAll("img"))) {
    const src = image.getAttribute("src") ?? "";
    if (!isSafeImage(src)) {
      image.replaceWith(doc.createTextNode(image.getAttribute("alt") ?? ""));
      continue;
    }
    image.setAttribute("loading", "lazy");
    image.setAttribute("referrerpolicy", "no-referrer");
  }

  return root.innerHTML;
}

/** Renders GFM Markdown to an HTML string safe for dangerouslySetInnerHTML. */
export function renderMarkdown(source: string): string {
  const html = micromark(source, {
    allowDangerousHtml: false,
    allowDangerousProtocol: false,
    extensions: [gfm()],
    htmlExtensions: [gfmHtml()],
  });
  return sanitizeRenderedHtml(html);
}
