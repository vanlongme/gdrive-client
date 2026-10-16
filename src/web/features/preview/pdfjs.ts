import { getDocument, GlobalWorkerOptions } from "pdfjs-dist";
import type { PDFDocumentLoadingTask } from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

/**
 * pdfjs-dist wiring (plan T12): the same-version bundled worker is served
 * from this app's own origin — never a CDN. pdf.js also fetches CMaps,
 * standard fonts and image-decoder wasm at runtime; those ship inside
 * pdfjs-dist and are emitted as hashed Vite assets via import.meta.glob.
 * The custom BinaryDataFactory resolves each requested filename to its
 * bundled asset URL, so no directory prefix or remote origin is needed.
 * (`iccUrl` stays unset: pdf.js degrades gracefully for CMYK images.)
 */

type AssetManifest = Record<string, string>;

function toManifest(modules: Record<string, unknown>): AssetManifest {
  const manifest: AssetManifest = {};
  for (const [path, url] of Object.entries(modules)) {
    if (typeof url === "string") {
      manifest[path.slice(path.lastIndexOf("/") + 1)] = url;
    }
  }
  return manifest;
}

const CMAP_ASSETS = toManifest(
  import.meta.glob("../../../../node_modules/pdfjs-dist/cmaps/*.bcmap", {
    eager: true,
    query: "?url",
    import: "default",
  }),
);
const FONT_ASSETS = toManifest(
  import.meta.glob("../../../../node_modules/pdfjs-dist/standard_fonts/*", {
    eager: true,
    query: "?url",
    import: "default",
  }),
);
const WASM_ASSETS = toManifest(
  import.meta.glob("../../../../node_modules/pdfjs-dist/wasm/*.wasm", {
    eager: true,
    query: "?url",
    import: "default",
  }),
);

class BundledBinaryDataFactory {
  async fetch({
    kind,
    filename,
  }: {
    kind: string;
    filename: string;
  }): Promise<Uint8Array> {
    const manifest =
      kind === "cMapUrl"
        ? CMAP_ASSETS
        : kind === "standardFontDataUrl"
          ? FONT_ASSETS
          : WASM_ASSETS;
    const url = manifest[filename];
    if (url === undefined) {
      throw new Error(`No bundled pdf.js data for ${kind}:${filename}`);
    }
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`pdf.js data ${filename} failed (${res.status})`);
    }
    return new Uint8Array(await res.arrayBuffer());
  }
}

GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

/**
 * Opens a same-origin PDF URL. Range and streaming stay enabled so large
 * documents are never fully buffered; auto-fetch stays enabled too (its
 * documented pairing — disabling it requires disabling streaming, and it
 * would stall random access once the reader moves past loaded pages).
 */
export function openPdfDocument(url: string): PDFDocumentLoadingTask {
  // Note: the `isEvalSupported` option no longer exists in pdfjs-dist
  // 6.4.299 — the eval font path was removed upstream entirely (grep of
  // build/pdf.mjs + build/pdf.worker.mjs returns zero hits), so it is
  // intentionally absent rather than disabled.
  return getDocument({
    url,
    useWorkerFetch: false,
    BinaryDataFactory: BundledBinaryDataFactory,
    cMapPacked: true,
    rangeChunkSize: 65_536,
    enableXfa: false,
  });
}
