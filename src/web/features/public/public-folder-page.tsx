import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useParams } from "react-router";
import type {
  PublicFolderEntry,
  PublicFolderMeta,
} from "../../../shared/contracts/public-links";
import {
  ApiClientError,
  getPublicFolderMeta,
  listPublicChildren,
  publicArchiveUrl,
  publicContentUrl,
  unlockPublicLink,
} from "../../lib/api";
import { messageKeyForError } from "../../lib/error-message";
import { formatBytes, formatDateTime } from "../../lib/format";
import { useI18n } from "../../lib/i18n";
import { useDocumentTitle, useSite } from "../../lib/site";
import { BrandBlock } from "../../components/brand";
import {
  DownloadIcon,
  FileIcon,
  FolderIcon,
  LockIcon,
} from "../../components/icons";
import { PublicPreviewDialog } from "./public-preview-dialog";
import "./public.css";

/**
 * Anonymous public folder surface (wave-8 C5): /p/:slug outside the auth
 * shell. Only /api/v1/site and /api/v1/p/<slug> endpoints are reachable —
 * the router mounts no session/setup providers on this route, so no session
 * or admin call can ever fire here. Locked links collect a password; the
 * MACed cookie rides subsequent same-origin requests automatically.
 */

type MetaState =
  | { status: "loading" }
  | { status: "error"; error: unknown }
  | { status: "ready"; meta: PublicFolderMeta };

type ListingState =
  | { status: "loading" }
  | { status: "error"; error: unknown }
  | {
      status: "ready";
      folderId: string;
      folderName: string;
      breadcrumbs: { id: string; name: string }[];
      entries: PublicFolderEntry[];
      nextPageToken: string | null;
      loadingMore: boolean;
    };

type UnlockState =
  | "idle"
  | "checking" // probing whether a stored cookie already admits us
  | "locked" // password form
  | "submitting"
  | { error: "wrong" | { retryAfterSeconds: number } | { other: unknown } };

function kindLabelOf(
  t: ReturnType<typeof useI18n>["t"],
  entry: PublicFolderEntry,
): string {
  return entry.kind === "folder"
    ? t("explorer.kindFolder")
    : t("explorer.kindFile");
}

function PublicErrorCard({
  error,
  onRetry,
}: {
  error: unknown;
  onRetry: () => void;
}) {
  const { t } = useI18n();
  const mapped = messageKeyForError(error);
  return (
    <section className="card empty-state">
      <p className="alert alert-error" role="alert">
        {t(mapped.key, { seconds: mapped.retryAfterSeconds ?? 0 })}
      </p>
      <button type="button" className="btn btn-ghost" onClick={onRetry}>
        {t("common.retry")}
      </button>
    </section>
  );
}

export function PublicFolderPage() {
  const { t, locale } = useI18n();
  const { site } = useSite();
  const { slug = "" } = useParams();

  const [meta, setMeta] = useState<MetaState>({ status: "loading" });
  const [listing, setListing] = useState<ListingState>({ status: "loading" });
  const [unlock, setUnlock] = useState<UnlockState>("checking");
  const [password, setPassword] = useState("");
  const [view, setView] = useState<"list" | "grid">("list");
  const [filter, setFilter] = useState("");
  const [previewFile, setPreviewFile] = useState<PublicFolderEntry | null>(
    null,
  );
  const listGen = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  // noindex: public link pages must never be indexed (API responses carry
  // X-Robots-Tag; the SPA shell adds the meta here while mounted).
  useEffect(() => {
    const tag = document.createElement("meta");
    tag.name = "robots";
    tag.content = "noindex";
    document.head.appendChild(tag);
    return () => tag.remove();
  }, []);

  const loadMeta = useCallback(async () => {
    setMeta({ status: "loading" });
    try {
      const view = await getPublicFolderMeta(slug);
      setMeta({ status: "ready", meta: view });
    } catch (error) {
      setMeta({ status: "error", error });
    }
  }, [slug]);

  useEffect(() => {
    void loadMeta();
  }, [loadMeta]);

  const readyMeta = meta.status === "ready" ? meta.meta : null;
  useDocumentTitle(readyMeta?.folderName ?? null);

  const loadChildren = useCallback(
    async (folderId?: string, pageToken?: string) => {
      if (readyMeta === null) return;
      const gen = ++listGen.current;
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      if (pageToken === undefined) setListing({ status: "loading" });
      else {
        setListing((prev) =>
          prev.status === "ready" ? { ...prev, loadingMore: true } : prev,
        );
      }
      try {
        const page = await listPublicChildren(
          slug,
          { folderId: folderId ?? readyMeta.rootFolderId, pageToken },
          controller.signal,
        );
        if (listGen.current !== gen) return;
        setUnlock("idle"); // admitted — cookie or open link
        setListing((prev) => ({
          status: "ready",
          folderId: page.folderId,
          folderName: page.folderName,
          breadcrumbs: page.breadcrumbs,
          entries:
            pageToken !== undefined && prev.status === "ready"
              ? [...prev.entries, ...page.entries]
              : page.entries,
          nextPageToken: page.nextPageToken,
          loadingMore: false,
        }));
      } catch (error) {
        if (listGen.current !== gen) return;
        if (
          error instanceof ApiClientError &&
          error.code === "PUBLIC_LINK_PASSWORD_REQUIRED"
        ) {
          setUnlock("locked");
          setListing({ status: "loading" });
          return;
        }
        setListing({ status: "error", error });
      }
    },
    [slug, readyMeta],
  );

  // Admission probe: open links list immediately; locked links first try the
  // stored cookie, and only then show the password form.
  useEffect(() => {
    if (readyMeta === null) return;
    if (!readyMeta.locked) {
      setUnlock("idle");
      void loadChildren();
      return;
    }
    setUnlock("checking");
    void loadChildren();
  }, [readyMeta, loadChildren]);

  const submitUnlock = (event: React.FormEvent) => {
    event.preventDefault();
    if (password === "") return;
    setUnlock("submitting");
    void unlockPublicLink(slug, password)
      .then(() => {
        setPassword("");
        void loadChildren();
      })
      .catch((error: unknown) => {
        if (error instanceof ApiClientError) {
          if (error.code === "PUBLIC_LINK_INVALID_PASSWORD") {
            setUnlock({ error: "wrong" });
            return;
          }
          if (error.status === 429) {
            setUnlock({
              error: { retryAfterSeconds: error.retryAfterSeconds ?? 60 },
            });
            return;
          }
        }
        setUnlock({ error: { other: error } });
      });
  };

  const navigateTo = useCallback(
    (folderId: string) => {
      setFilter("");
      void loadChildren(folderId);
    },
    [loadChildren],
  );

  const openEntry = useCallback(
    (entry: PublicFolderEntry) => {
      if (entry.kind === "folder") {
        navigateTo(entry.id);
      } else {
        setPreviewFile(entry);
      }
    },
    [navigateTo],
  );

  const displayedEntries = useMemo(() => {
    if (listing.status !== "ready") return [];
    const q = filter.trim().toLowerCase();
    if (q === "") return listing.entries;
    return listing.entries.filter((entry) =>
      entry.name.toLowerCase().includes(q),
    );
  }, [listing, filter]);

  const supportNote =
    site.supportEmail !== null ? (
      <p className="hint">{t("pub.support", { email: site.supportEmail })}</p>
    ) : null;

  // --- Render ---

  return (
    <div className="public-shell">
      <header className="public-header">
        <BrandBlock />
        {readyMeta !== null && readyMeta.allowZip && unlock === "idle" ? (
          <a
            className="btn btn-ghost btn-sm"
            href={publicArchiveUrl(
              slug,
              listing.status === "ready" ? listing.folderId : undefined,
            )}
            download
          >
            <DownloadIcon className="nav-icon" />
            {t("pub.downloadAll")}
          </a>
        ) : null}
      </header>

      <main className="public-main">
        {meta.status === "loading" ? (
          <p role="status">{t("common.loading")}</p>
        ) : meta.status === "error" ? (
          <section className="card empty-state public-state">
            {meta.error instanceof ApiClientError &&
            meta.error.code === "PUBLIC_LINK_EXPIRED" ? (
              <>
                <h1>{t("pub.expiredTitle")}</h1>
                <p>{t("pub.expiredBody")}</p>
                {supportNote}
              </>
            ) : meta.error instanceof ApiClientError &&
              meta.error.status === 404 ? (
              <>
                <h1>{t("pub.notFoundTitle")}</h1>
                <p>{t("pub.notFoundBody")}</p>
                {supportNote}
              </>
            ) : (
              <PublicErrorCard
                error={meta.error}
                onRetry={() => void loadMeta()}
              />
            )}
          </section>
        ) : readyMeta === null ? null : unlock === "checking" ? (
          <p role="status">{t("common.loading")}</p>
        ) : unlock === "locked" ||
          unlock === "submitting" ||
          typeof unlock === "object" ? (
          <section className="card auth-panel public-state">
            <h1 className="public-folder-title">
              <LockIcon className="entry-icon" />
              {readyMeta.folderName}
            </h1>
            <p className="section-note">
              {t("pub.sharedBy", { name: readyMeta.sharedByName })}
            </p>
            <p>{t("pub.lockedIntro")}</p>
            {typeof unlock === "object" ? (
              <p className="alert alert-error" role="alert">
                {unlock.error === "wrong"
                  ? t("pub.wrongPassword")
                  : "retryAfterSeconds" in unlock.error
                    ? t("pub.tooManyAttempts", {
                        seconds: unlock.error.retryAfterSeconds,
                      })
                    : t(messageKeyForError(unlock.error.other).key)}
              </p>
            ) : null}
            <form onSubmit={submitUnlock}>
              <div className="field">
                <label htmlFor="public-password">{t("pub.passwordLabel")}</label>
                <input
                  id="public-password"
                  className="input"
                  type="password"
                  autoComplete="off"
                  required
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </div>
              <button
                type="submit"
                className="btn btn-primary"
                disabled={unlock === "submitting" || password === ""}
              >
                {unlock === "submitting" ? t("pub.unlocking") : t("pub.unlock")}
              </button>
            </form>
            {supportNote}
          </section>
        ) : listing.status === "loading" ? (
          <p role="status">{t("common.loading")}</p>
        ) : listing.status === "error" ? (
          <PublicErrorCard
            error={listing.error}
            onRetry={() => void loadChildren()}
          />
        ) : (
          <>
            <header className="page-header public-head">
              <h1 className="public-folder-title">
                <FolderIcon className="entry-icon entry-icon-folder" />
                {readyMeta.folderName}
              </h1>
              <p className="section-note">
                {t("pub.sharedBy", { name: readyMeta.sharedByName })}
                {readyMeta.expiresAt !== null
                  ? ` · ${t("pub.expiresOn", { date: formatDateTime(readyMeta.expiresAt, locale) })}`
                  : ""}
              </p>
            </header>

            <nav aria-label={t("explorer.breadcrumbs")} className="breadcrumbs">
              <ol>
                {listing.breadcrumbs.map((crumb, index) => (
                  <li key={crumb.id}>
                    {index === listing.breadcrumbs.length - 1 ? (
                      <span aria-current="page">{crumb.name}</span>
                    ) : (
                      <button
                        type="button"
                        className="crumb"
                        onClick={() => navigateTo(crumb.id)}
                      >
                        {crumb.name}
                      </button>
                    )}
                  </li>
                ))}
              </ol>
            </nav>

            <div className="explorer-toolbar">
              <form
                className="search-bar"
                role="search"
                onSubmit={(event) => event.preventDefault()}
              >
                <label htmlFor="public-filter" className="visually-hidden">
                  {t("pub.filterLabel")}
                </label>
                <input
                  id="public-filter"
                  className="input"
                  type="search"
                  value={filter}
                  placeholder={t("pub.filterPlaceholder")}
                  onChange={(event) => setFilter(event.target.value)}
                />
              </form>
              <div
                className="toolbar-group"
                role="group"
                aria-label={t("explorer.viewLabel")}
              >
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  aria-pressed={view === "list"}
                  onClick={() => setView("list")}
                >
                  {t("explorer.viewList")}
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  aria-pressed={view === "grid"}
                  onClick={() => setView("grid")}
                >
                  {t("explorer.viewGrid")}
                </button>
              </div>
            </div>

            {displayedEntries.length === 0 ? (
              <section className="card empty-state">
                <p>
                  {filter !== ""
                    ? t("explorer.searchEmpty")
                    : t("explorer.folderEmpty")}
                </p>
              </section>
            ) : view === "list" ? (
              <div className="table-wrap">
                <table className="entry-table">
                  <thead>
                    <tr>
                      <th scope="col">{t("explorer.colName")}</th>
                      <th scope="col">{t("explorer.colSize")}</th>
                      <th scope="col">{t("explorer.colModified")}</th>
                      <th scope="col">
                        <span className="visually-hidden">
                          {t("explorer.colActions")}
                        </span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {displayedEntries.map((entry) => (
                      <tr key={entry.id}>
                        <td className="entry-name">
                          <button
                            type="button"
                            className="entry-link"
                            title={entry.name}
                            onClick={() => openEntry(entry)}
                          >
                            {entry.kind === "folder" ? (
                              <FolderIcon className="entry-icon entry-icon-folder" />
                            ) : (
                              <FileIcon className="entry-icon" />
                            )}
                            {entry.name}
                          </button>
                        </td>
                        <td className="entry-meta">
                          {entry.size === null
                            ? "—"
                            : formatBytes(entry.size, locale)}
                        </td>
                        <td className="entry-meta">
                          {formatDateTime(entry.modifiedTime, locale)}
                        </td>
                        <td className="entry-actions">
                          {entry.kind === "file" ? (
                            <a
                              className="btn btn-ghost btn-sm"
                              href={publicContentUrl(slug, entry.id, true)}
                              download
                              aria-label={t("explorer.downloadEntry", {
                                name: entry.name,
                              })}
                            >
                              {t("explorer.download")}
                            </a>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <ul className="entry-grid">
                {displayedEntries.map((entry) => (
                  <li key={entry.id} className="entry-card card">
                    <span className="entry-thumb-icon" aria-hidden="true">
                      {entry.kind === "folder" ? (
                        <FolderIcon className="entry-icon entry-icon-folder" />
                      ) : (
                        <FileIcon className="entry-icon" />
                      )}
                    </span>
                    <button
                      type="button"
                      className="entry-link entry-card-name"
                      title={entry.name}
                      onClick={() => openEntry(entry)}
                    >
                      {entry.name}
                    </button>
                    <span className="entry-card-meta">
                      {entry.kind === "folder"
                        ? kindLabelOf(t, entry)
                        : formatBytes(entry.size ?? "0", locale)}
                      {" · "}
                      {formatDateTime(entry.modifiedTime, locale)}
                    </span>
                  </li>
                ))}
              </ul>
            )}

            {listing.nextPageToken !== null ? (
              <div className="load-more">
                <button
                  type="button"
                  className="btn btn-ghost"
                  disabled={listing.loadingMore}
                  onClick={() =>
                    void loadChildren(listing.folderId, listing.nextPageToken ?? undefined)
                  }
                >
                  {listing.loadingMore
                    ? t("common.loading")
                    : t("explorer.loadMore")}
                </button>
              </div>
            ) : null}
          </>
        )}
      </main>

      {previewFile !== null ? (
        <PublicPreviewDialog
          slug={slug}
          initialFile={previewFile}
          siblings={
            listing.status === "ready" ? listing.entries : undefined
          }
          onClose={() => setPreviewFile(null)}
        />
      ) : null}
    </div>
  );
}
