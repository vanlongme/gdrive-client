import { ApiClientError } from "../../lib/api";
import { messageKeyForError } from "../../lib/error-message";
import { useI18n } from "../../lib/i18n";
import type { MessagePath } from "../../lib/i18n";
import "./preview.css";

/**
 * Shared honest-error panel for viewers: known codes get a preview-specific
 * next-action message, everything else falls back to the global mapping.
 */
export function ViewerError({ error }: { error: unknown }) {
  const { t } = useI18n();
  let key: MessagePath;
  let requestId: string | undefined;
  let retryAfter: number | undefined;
  if (error instanceof ApiClientError && error.code === "SNAPSHOT_UNAVAILABLE") {
    key = "preview.revisionUnavailable";
    requestId = error.requestId;
  } else if (
    error instanceof ApiClientError &&
    error.code === "PREVIEW_UNSUPPORTED"
  ) {
    key = "preview.exportFailed";
    requestId = error.requestId;
  } else {
    const mapped = messageKeyForError(error);
    key = mapped.key;
    requestId = mapped.requestId;
    retryAfter = mapped.retryAfterSeconds;
  }
  return (
    <div className="preview-center">
      <div className="preview-center-stack">
        <p className="alert alert-error" role="alert">
          {retryAfter !== undefined
            ? t(key, { seconds: retryAfter })
            : t(key)}
        </p>
        {requestId !== undefined ? (
          <p>
            {t("common.requestId")}: <code>{requestId}</code>
          </p>
        ) : null}
      </div>
    </div>
  );
}
