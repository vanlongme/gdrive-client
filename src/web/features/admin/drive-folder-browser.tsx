import { useCallback, useEffect, useRef, useState } from "react";
import { listDriveFolders, type DriveFolderEntry } from "../../lib/admin-api";
import { parseDriveFolderInput } from "../../lib/drive-link";
import { messageKeyForError } from "../../lib/error-message";
import { useI18n } from "../../lib/i18n";
import "./admin-ops.css";

/** A folder chosen in the browser, or from a pasted link (name = null). */
export interface PickedFolder {
  id: string;
  name: string | null;
}

/**
 * My Drive folder picker: a breadcrumb browser over the folders the OAuth
 * catalog identity owns (GET /api/v1/admin/drive-folders) plus a paste-a-link
 * field parsed client-side. Only id/name are rendered. Picking only fills the
 * caller's form; the server revalidates on submit (MOUNT_ROOT_* codes).
 */
export function DriveFolderBrowser({
  connectionId,
  onPick,
}: {
  connectionId: string;
  onPick: (folder: PickedFolder) => void;
}) {
  const { t } = useI18n();
  const [trail, setTrail] = useState<DriveFolderEntry[]>([]);
  const [folders, setFolders] = useState<DriveFolderEntry[]>([]);
  const [nextPageToken, setNextPageToken] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const generation = useRef(0);
  const current = trail.length === 0 ? undefined : trail[trail.length - 1];
  const parentId = current?.id ?? "root";

  const load = useCallback(
    async (pageToken?: string) => {
      if (connectionId === "") return;
      const run = ++generation.current;
      setBusy(true);
      setError(null);
      try {
        const res = await listDriveFolders(connectionId, {
          parentId,
          ...(pageToken === undefined ? {} : { pageToken }),
        });
        if (run !== generation.current) return;
        setLoaded(true);
        setNextPageToken(res.nextPageToken);
        setFolders((prev) =>
          pageToken === undefined ? res.folders : [...prev, ...res.folders],
        );
      } catch (err) {
        if (run !== generation.current) return;
        setLoaded(true);
        setError(err);
      } finally {
        if (run === generation.current) setBusy(false);
      }
    },
    [connectionId, parentId],
  );

  const reset = () => {
    setFolders([]);
    setNextPageToken(undefined);
    setLoaded(false);
    setError(null);
    setBusy(false);
  };

  // Opening a folder or a breadcrumb changes parentId: reload that level.
  useEffect(() => {
    reset();
    void load();
    return () => {
      generation.current += 1;
    };
  }, [load]);

  const mapped = error !== null ? messageKeyForError(error) : null;

  return (
    <div
      className="folder-browser"
      role="group"
      aria-label={t("admin.folderBrowserLabel")}
    >
      {connectionId === "" ? (
        <p className="hint">{t("admin.folderNeedConnection")}</p>
      ) : (
        <>
          <nav aria-label={t("admin.folderBreadcrumbs")} className="folder-crumbs">
            <ol>
              <li>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  disabled={trail.length === 0}
                  onClick={() => setTrail([])}
                >
                  {t("admin.folderRootName")}
                </button>
              </li>
              {trail.map((crumb, index) => (
                <li key={crumb.id}>
                  <span aria-hidden="true">/</span>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    disabled={index === trail.length - 1}
                    onClick={() => setTrail(trail.slice(0, index + 1))}
                  >
                    {crumb.name}
                  </button>
                </li>
              ))}
            </ol>
            <span className="entry-actions">
              {current !== undefined ? (
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  disabled={busy}
                  onClick={() => onPick({ id: current.id, name: current.name })}
                >
                  {t("admin.folderUseCurrent")}
                </button>
              ) : null}
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={busy}
                onClick={() => {
                  reset();
                  void load();
                }}
              >
                {t("admin.folderRefresh")}
              </button>
            </span>
          </nav>
          <p className="hint">{t("admin.folderHint")}</p>

          {mapped !== null ? (
            <p className="alert alert-error" role="alert">
              {t(mapped.key, { seconds: mapped.retryAfterSeconds ?? 0 })}
              {mapped.requestId !== undefined ? ` (${mapped.requestId})` : ""}
            </p>
          ) : null}

          {busy && !loaded ? (
            <p role="status">{t("admin.folderLoading")}</p>
          ) : folders.length > 0 ? (
            <ul className="drive-list">
              {folders.map((folder) => (
                <li key={folder.id} className="drive-row">
                  <span className="drive-name">{folder.name}</span>{" "}
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    disabled={busy}
                    aria-label={`${t("admin.folderOpen")} ${folder.name}`}
                    onClick={() => setTrail([...trail, folder])}
                  >
                    {t("admin.folderOpen")}
                  </button>{" "}
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    disabled={busy}
                    aria-label={`${t("admin.folderUse")}: ${folder.name}`}
                    onClick={() => onPick({ id: folder.id, name: folder.name })}
                  >
                    {t("admin.folderUse")}
                  </button>
                </li>
              ))}
            </ul>
          ) : loaded && error === null && !busy ? (
            <p>{t("admin.folderEmpty")}</p>
          ) : null}

          {nextPageToken !== undefined ? (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={busy}
              onClick={() => void load(nextPageToken)}
            >
              {busy ? t("admin.folderLoading") : t("admin.drivesLoadMore")}
            </button>
          ) : null}
        </>
      )}

      <PasteLinkField onPick={onPick} />
    </div>
  );
}

function PasteLinkField({
  onPick,
}: {
  onPick: (folder: PickedFolder) => void;
}) {
  const { t } = useI18n();
  const [text, setText] = useState("");
  const parsed = parseDriveFolderInput(text);
  const invalid = text.trim() !== "" && parsed === null;
  return (
    <div className="folder-link">
      <label htmlFor="mount-drive-link">{t("admin.folderLinkLabel")}</label>
      <input
        id="mount-drive-link"
        className="input"
        value={text}
        onChange={(event) => setText(event.target.value)}
        autoComplete="off"
        spellCheck={false}
        aria-invalid={invalid}
        aria-describedby="mount-drive-link-hint"
      />
      <p className="hint" id="mount-drive-link-hint">
        {t("admin.folderLinkHint")}
      </p>
      {invalid ? (
        <p className="field-error" role="status">
          {t("admin.folderLinkInvalid")}
        </p>
      ) : null}
      <div className="entry-actions">
        <button
          type="button"
          className="btn btn-primary btn-sm"
          disabled={parsed === null}
          onClick={() => {
            if (parsed !== null) onPick({ id: parsed, name: null });
          }}
        >
          {t("admin.folderLinkUse")}
        </button>
      </div>
    </div>
  );
}
