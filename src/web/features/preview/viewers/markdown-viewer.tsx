import { useEffect, useState } from "react";
import { formatBytes } from "../../../lib/format";
import { useI18n } from "../../../lib/i18n";
import { fetchBoundedText, TEXT_PREVIEW_MAX_BYTES } from "../content-source";
import { renderMarkdown } from "../markdown";
import { ViewerError } from "../viewer-error";
import type { ViewerProps } from "../viewer-types";
import "../preview.css";

type LoadState =
  | { status: "loading" }
  | { status: "error"; error: unknown }
  | { status: "ready"; html: string; truncated: boolean };

/**
 * Markdown view (architecture §8.1): GFM via micromark, raw HTML escaped,
 * dangerous protocols filtered and an explicit link/image policy applied
 * (see ../markdown.ts). The result is safe for dangerouslySetInnerHTML.
 */
export default function MarkdownViewer({
  file,
  sourceUrl,
  signal,
}: ViewerProps) {
  const { t, locale } = useI18n();
  const [state, setState] = useState<LoadState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    fetchBoundedText(sourceUrl, signal)
      .then((result) => {
        if (cancelled) return;
        try {
          setState({
            status: "ready",
            html: renderMarkdown(result.text),
            truncated: result.truncated,
          });
        } catch (error) {
          setState({ status: "error", error });
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

  return (
    <div className="preview-viewer">
      {state.status === "ready" && state.truncated ? (
        <p className="preview-banner">
          {t("preview.truncated", {
            limit: formatBytes(String(TEXT_PREVIEW_MAX_BYTES), locale),
            size: formatBytes(file.size, locale),
          })}
        </p>
      ) : null}
      {state.status === "loading" ? (
        <p>{t("common.loading")}</p>
      ) : (
        <div
          className="preview-markdown"
          // Sanitized in ../markdown.ts: no raw HTML, no dangerous schemes,
          // links/images carry an explicit allowlist policy.
          dangerouslySetInnerHTML={{ __html: state.html }}
        />
      )}
    </div>
  );
}
