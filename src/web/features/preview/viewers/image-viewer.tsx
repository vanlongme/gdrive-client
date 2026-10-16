import { useEffect, useRef, useState } from "react";
import { useI18n } from "../../../lib/i18n";
import type { ViewerProps } from "../viewer-types";
import "../preview.css";

const MIN_SCALE = 0.05;
const MAX_SCALE = 8;
const SCALE_STEP = 1.25;

type Fit = "fit" | "actual" | number;

/**
 * Image viewer (architecture §8.1): zoom in/out, fit-to-window, 100%,
 * quarter-turn rotation. Next/previous lives on the dialog toolbar since it
 * switches files, not viewer state.
 */
export default function ImageViewer({ file, sourceUrl, signal }: ViewerProps) {
  const { t } = useI18n();
  const imgRef = useRef<HTMLImageElement>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  const [fit, setFit] = useState<Fit>("fit");
  const [rotation, setRotation] = useState(0);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(
    null,
  );

  // Cleanup: dropping the src cancels any in-flight decode/download when
  // the dialog closes or navigates away.
  useEffect(() => {
    const img = imgRef.current;
    const onAbort = () => img?.removeAttribute("src");
    signal.addEventListener("abort", onAbort);
    return () => {
      signal.removeEventListener("abort", onAbort);
      img?.removeAttribute("src");
    };
  }, [signal, sourceUrl]);

  const zoomBy = (factor: number) => {
    setFit((prev) => {
      const base = typeof prev === "number" ? prev : 1;
      return Math.min(MAX_SCALE, Math.max(MIN_SCALE, base * factor));
    });
  };

  const numericScale = typeof fit === "number" ? fit : null;
  const imgStyle =
    numericScale === null || natural === null
      ? undefined
      : { width: Math.round(natural.w * numericScale) };

  return (
    <div className="preview-viewer">
      <div
        className="preview-toolbar"
        role="toolbar"
        aria-label={t("preview.imageControls")}
      >
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => zoomBy(1 / SCALE_STEP)}
          disabled={numericScale !== null && numericScale <= MIN_SCALE}
        >
          {t("preview.zoomOut")}
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => zoomBy(SCALE_STEP)}
          disabled={numericScale !== null && numericScale >= MAX_SCALE}
        >
          {t("preview.zoomIn")}
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          aria-pressed={fit === "fit"}
          onClick={() => setFit("fit")}
        >
          {t("preview.zoomFit")}
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          aria-pressed={fit === "actual"}
          onClick={() => setFit("actual")}
        >
          {t("preview.zoomActual")}
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => setRotation((r) => (r + 90) % 360)}
        >
          {t("preview.rotate")}
        </button>
        {numericScale !== null ? (
          <span className="preview-toolbar-label">
            {Math.round(numericScale * 100)}%
          </span>
        ) : null}
      </div>
      <div className="preview-stage preview-stage-image">
        {status === "loading" ? <p>{t("common.loading")}</p> : null}
        {status === "error" ? (
          <div className="preview-center">
            <div className="preview-center-stack">
              <p className="alert alert-error" role="alert">
                {t("preview.imageError")}
              </p>
            </div>
          </div>
        ) : (
          <img
            ref={imgRef}
            src={sourceUrl}
            alt={file.name}
            draggable={false}
            className={
              numericScale === null || natural === null
                ? "preview-image-fit"
                : undefined
            }
            style={{
              ...imgStyle,
              transform: rotation === 0 ? undefined : `rotate(${rotation}deg)`,
            }}
            onLoad={(event) => {
              const img = event.currentTarget;
              setNatural({ w: img.naturalWidth, h: img.naturalHeight });
              setStatus("ready");
              if (fit === "actual") setFit(1);
            }}
            onError={() => setStatus("error")}
          />
        )}
      </div>
    </div>
  );
}
