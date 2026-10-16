import { formatBytes, formatDateTime } from "../../../lib/format";
import { useI18n } from "../../../lib/i18n";
import type { UnsupportedReason } from "../registry";
import type { ViewerProps } from "../viewer-types";
import "../preview.css";

/**
 * Fallback for formats with no viewer (architecture §8.1): honest metadata
 * plus the ordinary download action — never a fake preview.
 */
export default function UnsupportedViewer({
  file,
  downloadUrl,
  reason,
}: ViewerProps & { reason: UnsupportedReason | undefined }) {
  const { t, locale } = useI18n();
  return (
    <div className="preview-center">
      <div className="preview-center-stack">
        <h3 className="preview-title">{t("preview.unsupportedTitle")}</h3>
        <p>
          {reason === "workspace"
            ? t("preview.unsupportedWorkspace")
            : t("preview.unsupportedNoViewer", { mime: file.mimeType })}
        </p>
        <dl className="preview-meta">
          <dt>{t("preview.metaName")}</dt>
          <dd>{file.name}</dd>
          <dt>{t("preview.metaMime")}</dt>
          <dd>{file.mimeType}</dd>
          <dt>{t("preview.metaSize")}</dt>
          <dd>{formatBytes(file.size, locale)}</dd>
          <dt>{t("preview.metaModified")}</dt>
          <dd>{formatDateTime(file.modifiedTime, locale)}</dd>
        </dl>
        <a className="btn btn-primary" href={downloadUrl} download>
          {t("preview.download")}
        </a>
      </div>
    </div>
  );
}
