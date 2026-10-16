import { useCallback, useEffect, useRef, useState } from "react";
import {
  listSharedDrives,
  type SharedDriveEntry,
} from "../../lib/admin-api";
import { messageKeyForError } from "../../lib/error-message";
import { useI18n } from "../../lib/i18n";

/**
 * Shared Drive chooser (spec section 11.3 step 6; wave-5 T11): pages the
 * Shared Drives visible to ONE OAuth catalog connection through the real
 * admin API. Only id/name are rendered — no identity or token internals —
 * and every failure surfaces the localized next action for its error code.
 * Picking a drive only fills the caller's mount form; the backend still
 * validates the driveId on submit.
 */
export function SharedDriveChooser({
  connectionId,
  onPick,
}: {
  /** OAuth catalog connection to list through (empty = not chosen yet). */
  connectionId: string;
  onPick: (drive: SharedDriveEntry) => void;
}) {
  const { t } = useI18n();
  const [drives, setDrives] = useState<SharedDriveEntry[]>([]);
  const [nextPageToken, setNextPageToken] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [queried, setQueried] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const generation = useRef(0);

  // A different connection sees a different drive set; reset stale results.
  useEffect(() => {
    setDrives([]);
    setNextPageToken(undefined);
    setQueried(false);
    setError(null);
  }, [connectionId]);

  const load = useCallback(
    async (pageToken?: string) => {
      if (connectionId === "") return;
      const run = ++generation.current;
      setBusy(true);
      setError(null);
      try {
        const res = await listSharedDrives(connectionId, {
          pageSize: 100,
          ...(pageToken === undefined ? {} : { pageToken }),
        });
        if (run !== generation.current) return;
        setQueried(true);
        setNextPageToken(res.nextPageToken);
        setDrives((prev) =>
          pageToken === undefined ? res.drives : [...prev, ...res.drives],
        );
      } catch (err) {
        if (run !== generation.current) return;
        setQueried(true);
        setError(err);
      } finally {
        if (run === generation.current) setBusy(false);
      }
    },
    [connectionId],
  );

  const mapped = error !== null ? messageKeyForError(error) : null;

  return (
    <div className="drive-chooser">
      <div className="entry-actions">
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          disabled={connectionId === "" || busy}
          onClick={() => void load()}
        >
          {busy && !queried ? t("admin.drivesLoading") : t("admin.browseDrives")}
        </button>
      </div>
      <p className="hint">{t("admin.drivesHint")}</p>

      {mapped !== null ? (
        <p className="alert alert-error" role="alert">
          {t(mapped.key, { seconds: mapped.retryAfterSeconds ?? 0 })}
          {mapped.requestId !== undefined ? ` (${mapped.requestId})` : ""}
        </p>
      ) : null}

      {drives.length > 0 ? (
        <ul className="drive-list">
          {drives.map((drive) => (
            <li key={drive.id} className="drive-row">
              <span className="drive-name">{drive.name}</span>{" "}
              <span className="detail-mono">{drive.id}</span>{" "}
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={busy}
                onClick={() => onPick(drive)}
              >
                {t("admin.driveUse")}
              </button>
            </li>
          ))}
        </ul>
      ) : queried && error === null && !busy ? (
        <p>{t("admin.drivesEmpty")}</p>
      ) : null}

      {nextPageToken !== undefined ? (
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          disabled={busy}
          onClick={() => void load(nextPageToken)}
        >
          {busy ? t("admin.drivesLoading") : t("admin.drivesLoadMore")}
        </button>
      ) : null}
    </div>
  );
}
