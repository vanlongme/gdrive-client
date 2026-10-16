import { useEffect, useRef, useState } from "react";
import type {
  PDFDocumentLoadingTask,
  PDFDocumentProxy,
  RenderTask,
  TextLayer,
} from "pdfjs-dist";
import { useI18n } from "../../../lib/i18n";
import { ViewerError } from "../viewer-error";
import type { ViewerProps } from "../viewer-types";
import "../preview.css";

const MIN_SCALE = 0.25;
const MAX_SCALE = 5;
const SCALE_STEP = 1.25;
const MAX_MATCHES = 500;

interface Match {
  page: number;
  item: number;
}

function isPdfError(error: unknown, name: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { name?: string }).name === name
  );
}

/**
 * PDF viewer via pdfjs-dist (plan T12): one page at a time on canvas with a
 * selectable text layer, page prev/next, zoom, fit-width and text search.
 * The same-version bundled worker and packaged CMaps/fonts/wasm load from
 * this origin only (see ../pdfjs.ts). Document bytes stream through the SA
 * content URL; Range requests are enabled so large PDFs never buffer fully.
 */
export default function PdfViewer({
  file,
  sourceUrl,
  signal,
  exportFallback,
}: ViewerProps & { exportFallback?: boolean }) {
  const { t } = useI18n();
  const [status, setStatus] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  const [error, setError] = useState<unknown>(null);
  const [numPages, setNumPages] = useState(0);
  const [pageNum, setPageNum] = useState(1);
  const [scale, setScale] = useState(1.25);
  const [renderNonce, setRenderNonce] = useState(0);

  const docRef = useRef<PDFDocumentProxy | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textDivRef = useRef<HTMLDivElement>(null);
  const renderTaskRef = useRef<RenderTask | null>(null);
  const textLayerRef = useRef<TextLayer | null>(null);
  const textCache = useRef(new Map<number, string[]>());

  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<Match[]>([]);
  const [matchIdx, setMatchIdx] = useState(0);
  const [searching, setSearching] = useState(false);

  // Document lifecycle: lazy-loads pdf.js itself, aborts in-flight work on
  // close/navigation and destroys the document + worker port on cleanup.
  useEffect(() => {
    let cancelled = false;
    let task: PDFDocumentLoadingTask | null = null;
    setStatus("loading");
    setError(null);
    setPageNum(1);
    setNumPages(0);
    setMatches([]);
    setMatchIdx(0);
    textCache.current.clear();
    (async () => {
      const { openPdfDocument } = await import("../pdfjs");
      task = openPdfDocument(sourceUrl);
      const doc = await task.promise;
      if (cancelled) {
        await task?.destroy();
        return;
      }
      docRef.current = doc;
      setNumPages(doc.numPages);
      setStatus("ready");
    })().catch((err: unknown) => {
      if (!cancelled) {
        setError(err);
        setStatus("error");
      }
    });
    const onAbort = () => {
      void task?.destroy();
    };
    signal.addEventListener("abort", onAbort);
    return () => {
      cancelled = true;
      signal.removeEventListener("abort", onAbort);
      void task?.destroy();
      docRef.current = null;
    };
  }, [sourceUrl, signal]);

  // Page render lifecycle: canvas at device pixels + selectable text layer.
  useEffect(() => {
    const doc = docRef.current;
    const canvas = canvasRef.current;
    const textDiv = textDivRef.current;
    if (status !== "ready" || doc === null || canvas === null || textDiv === null)
      return;
    let cancelled = false;
    (async () => {
      const { TextLayer: TextLayerClass } = await import("pdfjs-dist");
      const page = await doc.getPage(pageNum);
      if (cancelled) return;
      const viewport = page.getViewport({ scale });
      const outputScale = Math.max(1, window.devicePixelRatio || 1);
      canvas.width = Math.floor(viewport.width * outputScale);
      canvas.height = Math.floor(viewport.height * outputScale);
      canvas.style.width = `${Math.floor(viewport.width)}px`;
      canvas.style.height = `${Math.floor(viewport.height)}px`;
      const transform =
        outputScale === 1 ? undefined : [outputScale, 0, 0, outputScale, 0, 0];
      const task = page.render({ canvas, viewport, transform });
      renderTaskRef.current = task;
      await task.promise;
      const textContent = await page.getTextContent({
        includeMarkedContent: false,
      });
      if (cancelled) return;
      textCache.current.set(
        pageNum,
        textContent.items.map((item) =>
          "str" in item ? item.str : "",
        ),
      );
      textDiv.replaceChildren();
      const layer = new TextLayerClass({
        textContentSource: textContent,
        container: textDiv,
        viewport,
      });
      textLayerRef.current = layer;
      await layer.render();
      if (!cancelled) setRenderNonce((n) => n + 1);
    })().catch((err: unknown) => {
      if (cancelled) return;
      if (isPdfError(err, "RenderingCancelledException")) return;
      if (isPdfError(err, "AbortException")) return;
      setError(err);
      setStatus("error");
    });
    return () => {
      cancelled = true;
      renderTaskRef.current?.cancel();
      renderTaskRef.current = null;
      textLayerRef.current?.cancel();
      textLayerRef.current = null;
    };
  }, [status, pageNum, scale]);

  // Highlight search matches that belong to the rendered page.
  useEffect(() => {
    const layer = textLayerRef.current;
    if (layer === null) return;
    const wanted = new Set(
      matches.filter((m) => m.page === pageNum).map((m) => m.item),
    );
    layer.textDivs.forEach((div, index) => {
      div.classList.toggle("preview-match", wanted.has(index));
    });
    if (wanted.size > 0) {
      const first = Math.min(...wanted);
      layer.textDivs[first]?.scrollIntoView({ block: "center" });
    }
  }, [matches, matchIdx, pageNum, renderNonce]);

  const runSearch = (rawQuery: string) => {
    const doc = docRef.current;
    const needle = rawQuery.trim().toLowerCase();
    setQuery(rawQuery);
    setMatches([]);
    setMatchIdx(0);
    if (doc === null || needle === "") return;
    setSearching(true);
    let cancelled = false;
    const onAbort = () => {
      cancelled = true;
    };
    signal.addEventListener("abort", onAbort);
    (async () => {
      const found: Match[] = [];
      outer: for (let page = 1; page <= doc.numPages; page++) {
        let strings = textCache.current.get(page);
        if (strings === undefined) {
          const pdfPage = await doc.getPage(page);
          const content = await pdfPage.getTextContent({
            includeMarkedContent: false,
          });
          strings = content.items.map((item) =>
            "str" in item ? item.str : "",
          );
          textCache.current.set(page, strings);
        }
        for (let item = 0; item < strings.length; item++) {
          if (strings[item]?.toLowerCase().includes(needle)) {
            found.push({ page, item });
            if (found.length >= MAX_MATCHES) break outer;
          }
        }
        if (cancelled) return;
      }
      if (cancelled) return;
      setMatches(found);
      if (found.length > 0) {
        setPageNum(found[0]!.page);
      }
    })()
      .catch(() => undefined)
      .finally(() => {
        signal.removeEventListener("abort", onAbort);
        setSearching(false);
      });
  };

  const goToMatch = (direction: 1 | -1) => {
    if (matches.length === 0) return;
    const next =
      (matchIdx + direction + matches.length) % matches.length;
    setMatchIdx(next);
    const match = matches[next];
    if (match !== undefined && match.page !== pageNum) {
      setPageNum(match.page);
    } else if (match !== undefined) {
      textLayerRef.current?.textDivs[match.item]?.scrollIntoView({
        block: "center",
      });
    }
  };

  const zoomBy = (factor: number) => {
    setScale((s) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s * factor)));
  };

  const fitWidth = () => {
    const doc = docRef.current;
    const stage = canvasRef.current?.parentElement?.parentElement;
    if (doc === null || stage == null) return;
    void doc.getPage(pageNum).then((page) => {
      const viewport = page.getViewport({ scale: 1 });
      const available = stage.clientWidth - 32;
      if (viewport.width > 0 && available > 0) {
        setScale(
          Math.min(MAX_SCALE, Math.max(MIN_SCALE, available / viewport.width)),
        );
      }
    });
  };

  if (status === "error") {
    // A Workspace export failing upstream (size limit, permission) is not a
    // corrupt PDF — it gets the honest export-failure message.
    if (exportFallback) {
      return (
        <div className="preview-center">
          <div className="preview-center-stack">
            <p className="alert alert-error" role="alert">
              {t("preview.exportFailed")}
            </p>
          </div>
        </div>
      );
    }
    if (isPdfError(error, "PasswordException")) {
      return (
        <div className="preview-center">
          <div className="preview-center-stack">
            <p className="alert alert-error" role="alert">
              {t("preview.pdfPassword")}
            </p>
          </div>
        </div>
      );
    }
    if (isPdfError(error, "InvalidPDFException")) {
      return (
        <div className="preview-center">
          <div className="preview-center-stack">
            <p className="alert alert-error" role="alert">
              {t("preview.pdfError")}
            </p>
          </div>
        </div>
      );
    }
    return <ViewerError error={error} />;
  }

  const pageLabel = t("preview.pdfPage", { page: pageNum, total: numPages });

  return (
    <div className="preview-viewer">
      <div
        className="preview-toolbar"
        role="toolbar"
        aria-label={t("preview.pdfControls")}
      >
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          disabled={pageNum <= 1 || status !== "ready"}
          onClick={() => setPageNum((p) => Math.max(1, p - 1))}
        >
          {t("preview.pdfPrevPage")}
        </button>
        <span className="preview-toolbar-label" aria-live="polite">
          {status === "ready" ? pageLabel : t("common.loading")}
        </span>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          disabled={pageNum >= numPages || status !== "ready"}
          onClick={() => setPageNum((p) => Math.min(numPages, p + 1))}
        >
          {t("preview.pdfNextPage")}
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          disabled={status !== "ready" || scale <= MIN_SCALE}
          onClick={() => zoomBy(1 / SCALE_STEP)}
        >
          {t("preview.zoomOut")}
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          disabled={status !== "ready" || scale >= MAX_SCALE}
          onClick={() => zoomBy(SCALE_STEP)}
        >
          {t("preview.zoomIn")}
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          disabled={status !== "ready"}
          onClick={fitWidth}
        >
          {t("preview.zoomFit")}
        </button>
        <form
          className="preview-toolbar preview-toolbar-plain"
          onSubmit={(event) => {
            event.preventDefault();
            const input = event.currentTarget.elements.namedItem(
              "pdf-search",
            ) as HTMLInputElement | null;
            runSearch(input?.value ?? "");
          }}
        >
          <input
            name="pdf-search"
            type="search"
            className="preview-search-input"
            placeholder={t("preview.pdfSearch")}
            defaultValue={query}
            disabled={status !== "ready"}
          />
          <button
            type="submit"
            className="btn btn-ghost btn-sm"
            disabled={status !== "ready" || searching}
          >
            {t("preview.pdfSearchGo")}
          </button>
        </form>
        {matches.length > 0 ? (
          <>
            <span className="preview-toolbar-label" aria-live="polite">
              {t("preview.pdfSearchCount", {
                current: matchIdx + 1,
                total: matches.length,
              })}
            </span>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => goToMatch(-1)}
            >
              {t("preview.pdfPrevMatch")}
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => goToMatch(1)}
            >
              {t("preview.pdfNextMatch")}
            </button>
          </>
        ) : query.trim() !== "" && !searching ? (
          <span className="preview-toolbar-label">
            {t("preview.pdfSearchEmpty")}
          </span>
        ) : null}
      </div>
      <div className="preview-stage preview-stage-pdf">
        {status === "loading" ? <p>{t("common.loading")}</p> : null}
        <div className="preview-pdf-page">
          <canvas ref={canvasRef} aria-label={file.name} />
          <div ref={textDivRef} className="preview-textlayer" />
        </div>
      </div>
    </div>
  );
}
