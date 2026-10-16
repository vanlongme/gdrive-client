import { useEffect, useState } from "react";
import { formatBytes } from "../../../lib/format";
import { useI18n } from "../../../lib/i18n";
import { fetchBoundedText, TEXT_PREVIEW_MAX_BYTES } from "../content-source";
import type { TextKind } from "../registry";
import { ViewerError } from "../viewer-error";
import type { ViewerProps } from "../viewer-types";
import "../preview.css";

const MAX_NUMBERED_LINES = 10_000;

type LoadState =
  | { status: "loading" }
  | { status: "error"; error: unknown }
  | { status: "ready"; text: string; truncated: boolean };

/**
 * Plain-text and active-content source view (architecture §8.1/§9.4):
 * escaped text capped at 2 MiB. `source` mode is for HTML/SVG/XML/script —
 * it always renders as code, never markup.
 */
export default function TextViewer({
  file,
  sourceUrl,
  signal,
  textKind,
}: ViewerProps & { textKind: TextKind }) {
  const { t, locale } = useI18n();
  const [state, setState] = useState<LoadState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    fetchBoundedText(sourceUrl, signal)
      .then((result) => {
        if (!cancelled) {
          setState({
            status: "ready",
            text: result.text,
            truncated: result.truncated,
          });
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) setState({ status: "error", error });
      });
    return () => {
      cancelled = true;
    };
  }, [sourceUrl, signal]);

  if (state.status === "error") return <ViewerError error={state.error} />;

  const lines = state.status === "ready" ? state.text.split("\n") : null;
  const numbered = lines !== null && lines.length <= MAX_NUMBERED_LINES;

  return (
    <div className="preview-viewer">
      {textKind === "source" ? (
        <p className="preview-banner preview-banner-warn">
          {t("preview.sourceNotice")}
        </p>
      ) : null}
      {state.status === "ready" && state.truncated ? (
        <p className="preview-banner">
          {t("preview.truncated", {
            limit: formatBytes(String(TEXT_PREVIEW_MAX_BYTES), locale),
            size: formatBytes(file.size, locale),
          })}
        </p>
      ) : null}
      <div className="preview-code-scroll">
        {state.status === "loading" ? (
          <p>{t("common.loading")}</p>
        ) : numbered ? (
          <pre className="preview-code" data-filename={file.name}>
            {lines.map((line, index) => (
              <span className="preview-code-line" key={index}>
                {line}
                {"\n"}
              </span>
            ))}
          </pre>
        ) : (
          <pre className="preview-code">{state.text}</pre>
        )}
      </div>
    </div>
  );
}
