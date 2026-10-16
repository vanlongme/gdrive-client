import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  DriveFileEntry,
  FileDetail,
  SearchScope,
} from "../../../shared/contracts";
import {
  ApiClientError,
  contentUrl,
  createShare,
  getFileDetail,
  getMounts,
  listChildren,
  requestReadiness,
  searchEntries,
  thumbnailUrl,
  type MountViewClient,
} from "../../lib/api";
import { messageKeyForError } from "../../lib/error-message";
import { formatBytes, formatDateTime } from "../../lib/format";
import { useI18n } from "../../lib/i18n";
import { useSession } from "../../lib/session";
import { PreviewLauncher } from "../preview/preview-launcher";
import {
  getUploadManager,
  pickFilesWithHandles,
} from "../transfers/upload-runtime";
import {
  collectDroppedDirectory,
  getFolderUploader,
} from "../transfers/folder-runtime";

/**
 * Explorer (spec section 11.2): mount picker, ID-based breadcrumbs, scoped
 * search, cursor paging, list/grid views, multi-select and direct anchor
 * downloads. Names are display-only — every navigation and request addresses
 * entries by Drive ID. Upload (T09) and preview viewers (T12) are Wave 4 and
 * are not faked here.
 */

interface Crumb {
  id: string;
  name: string;
}

type ListingState =
  | { status: "loading" }
  | { status: "error"; error: unknown }
  | {
      status: "ready";
      entries: DriveFileEntry[];
      nextCursor?: string;
      loadingMore: boolean;
    };

type Mode = { kind: "browse" } | { kind: "search"; q: string; scope: SearchScope };

type SortKey = "name-asc" | "name-desc" | "size-asc" | "size-desc" | "modified-asc" | "modified-desc";
type ViewMode = "list" | "grid";

function sortEntries(entries: DriveFileEntry[], key: SortKey): DriveFileEntry[] {
  const sorted = [...entries];
  const byName = (a: DriveFileEntry, b: DriveFileEntry) =>
    a.name.localeCompare(b.name);
  const bySize = (a: DriveFileEntry, b: DriveFileEntry) => {
    const diff = BigInt(a.size) - BigInt(b.size);
    return diff < 0n ? -1 : diff > 0n ? 1 : 0;
  };
  const byModified = (a: DriveFileEntry, b: DriveFileEntry) =>
    a.modifiedTime.localeCompare(b.modifiedTime);
  switch (key) {
    case "name-asc":
      sorted.sort(byName);
      break;
    case "name-desc":
      sorted.sort((a, b) => byName(b, a));
      break;
    case "size-asc":
      sorted.sort(bySize);
      break;
    case "size-desc":
      sorted.sort((a, b) => bySize(b, a));
      break;
    case "modified-asc":
      sorted.sort(byModified);
      break;
    case "modified-desc":
      sorted.sort((a, b) => byModified(b, a));
      break;
  }
  return sorted;
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { name?: string }).name === "AbortError"
  );
}

function ErrorPanel({
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
        {t(mapped.key, {
          seconds: mapped.retryAfterSeconds ?? 0,
        })}
      </p>
      {mapped.requestId !== undefined ? (
        <p>
          {t("common.requestId")}: {mapped.requestId}
        </p>
      ) : null}
      <button type="button" className="btn btn-ghost" onClick={onRetry}>
        {t("common.retry")}
      </button>
    </section>
  );
}

function kindLabel(
  t: ReturnType<typeof useI18n>["t"],
  entry: DriveFileEntry,
): string {
  if (entry.kind === "folder") return t("explorer.kindFolder");
  if (entry.kind === "shortcut") return t("explorer.kindShortcut");
  return t("explorer.kindFile");
}

function kindIcon(entry: DriveFileEntry): string {
  if (entry.kind === "folder") return "📁";
  if (entry.kind === "shortcut") return "↗";
  return "📄";
}

export function ExplorerPage() {
  const { t, locale } = useI18n();

  // --- Mount list ---
  type MountsState =
    | { status: "loading" }
    | { status: "pending" }
    | { status: "error"; error: unknown }
    | { status: "ready"; mounts: MountViewClient[] };
  const [mountsState, setMountsState] = useState<MountsState>({
    status: "loading",
  });
  const [mountId, setMountId] = useState<string | null>(null);

  const loadMounts = useCallback(async () => {
    setMountsState({ status: "loading" });
    try {
      const list = await getMounts();
      setMountsState({ status: "ready", mounts: list.mounts });
      setMountId((current) =>
        current !== null && list.mounts.some((m) => m.id === current)
          ? current
          : (list.mounts[0]?.id ?? null),
      );
    } catch (error) {
      if (error instanceof ApiClientError && error.code === "NOT_FOUND") {
        setMountsState({ status: "pending" });
        return;
      }
      setMountsState({ status: "error", error });
    }
  }, []);

  useEffect(() => {
    void loadMounts();
  }, [loadMounts]);

  const mount: MountViewClient | null = useMemo(() => {
    if (mountsState.status !== "ready" || mountId === null) return null;
    return mountsState.mounts.find((m) => m.id === mountId) ?? null;
  }, [mountsState, mountId]);

  // --- Folder navigation state ---
  const [crumbs, setCrumbs] = useState<Crumb[]>([]);
  const [mode, setMode] = useState<Mode>({ kind: "browse" });
  const [listing, setListing] = useState<ListingState>({ status: "loading" });
  const [view, setView] = useState<ViewMode>("list");
  const [sortKey, setSortKey] = useState<SortKey>("name-asc");
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const [detail, setDetail] = useState<
    | { status: "loading"; id: string }
    | { status: "ready"; file: FileDetail }
    | { status: "error"; id: string; error: unknown }
    | null
  >(null);
  const listGen = useRef(0);
  const detailGen = useRef(0);
  const listAbort = useRef<AbortController | null>(null);
  const detailAbort = useRef<AbortController | null>(null);
  const uploadInputRef = useRef<HTMLInputElement>(null);

  // Every path that closes/navigates away from the detail panel funnels
  // through this fence: bump the generation, abort the request, drop the
  // panel. Without it a late rejected promise could reopen an error panel
  // after the user closed or navigated (coordinator R1).
  const invalidateDetail = useCallback(() => {
    detailGen.current += 1;
    detailAbort.current?.abort();
    detailAbort.current = null;
    setDetail(null);
  }, []);

  // Reset navigation when the mount changes, and cancel every in-flight
  // request so a slow response can never resurrect a previous mount's
  // listing or detail panel.
  useEffect(() => {
    invalidateDetail();
    if (mount === null) return;
    setCrumbs([{ id: mount.rootFolderId, name: mount.label }]);
    setMode({ kind: "browse" });
    setSelectedIds(new Set());
  }, [mount, invalidateDetail]);

  useEffect(() => {
    const listRef = listAbort;
    const detailRef = detailAbort;
    return () => {
      listRef.current?.abort();
      detailRef.current?.abort();
    };
  }, []);

  const currentFolder = crumbs[crumbs.length - 1];

  const loadListing = useCallback(
    async (cursor?: string) => {
      if (mount === null || currentFolder === undefined) return;
      const gen = ++listGen.current;
      const controller = new AbortController();
      listAbort.current?.abort();
      listAbort.current = controller;
      if (cursor === undefined) setListing({ status: "loading" });
      else {
        setListing((prev) =>
          prev.status === "ready" ? { ...prev, loadingMore: true } : prev,
        );
      }
      try {
        const page =
          mode.kind === "search"
            ? await searchEntries(
                mount.id,
                {
                  q: mode.q,
                  scope: mode.scope,
                  folderId:
                    mode.scope === "folder" ? currentFolder.id : undefined,
                  cursor,
                },
                controller.signal,
              )
            : await listChildren(
                mount.id,
                currentFolder.id,
                cursor,
                controller.signal,
              );
        if (listGen.current !== gen) return;
        setListing((prev) => ({
          status: "ready",
          entries:
            cursor !== undefined && prev.status === "ready"
              ? [...prev.entries, ...page.entries]
              : page.entries,
          nextCursor: page.nextCursor,
          loadingMore: false,
        }));
      } catch (error) {
        if (isAbortError(error) || listGen.current !== gen) return;
        setListing({ status: "error", error });
      }
    },
    [mount, currentFolder, mode],
  );

  useEffect(() => {
    if (mount === null || currentFolder === undefined) return;
    void loadListing();
  }, [mount, currentFolder?.id, mode, loadListing, currentFolder]);

  // Upload entry (T09): files enqueue into the singleton UploadManager — the
  // queue lives outside routes, so browsing elsewhere never cancels it. When
  // an item targeting the folder on screen completes, refresh the listing so
  // the new Drive file shows up.
  const uploadManager = getUploadManager();
  const canUpload =
    mount !== null &&
    mount.operations.includes("upload") &&
    mode.kind === "browse" &&
    currentFolder !== undefined;

  useEffect(() => {
    if (mount === null || currentFolder === undefined) return;
    let seen = new Set(
      uploadManager
        .getSnapshot()
        .items.filter((item) => item.state === "completed")
        .map((item) => item.id),
    );
    const folderId = currentFolder.id;
    const mountIdCurrent = mount.id;
    return uploadManager.subscribe(() => {
      const items = uploadManager.getSnapshot().items;
      const justCompleted = items.some(
        (item) =>
          item.state === "completed" &&
          !seen.has(item.id) &&
          item.mountId === mountIdCurrent &&
          item.parentId === folderId,
      );
      seen = new Set(
        items.filter((item) => item.state === "completed").map((i) => i.id),
      );
      if (justCompleted) void loadListing();
    });
  }, [mount, currentFolder, loadListing, uploadManager]);

  const onPickUploadFiles = useCallback(async () => {
    if (mount === null || currentFolder === undefined) return;
    const destination = { mountId: mount.id, parentId: currentFolder.id };
    const picked = await pickFilesWithHandles();
    if (picked === null) {
      uploadInputRef.current?.click();
      return;
    }
    if (picked.length > 0) uploadManager.enqueue(picked, destination);
  }, [mount, currentFolder, uploadManager]);

  const onUploadInput = useCallback(
    (files: FileList | null) => {
      if (mount === null || currentFolder === undefined || files === null) {
        return;
      }
      const entries = [...files].map((file) => ({ file }));
      if (entries.length > 0) {
        uploadManager.enqueue(entries, {
          mountId: mount.id,
          parentId: currentFolder.id,
        });
      }
    },
    [mount, currentFolder, uploadManager],
  );

  // Folder upload entry (T10): webkitdirectory picker plus directory drops;
  // the planner → batch → seal → parent-first folder creates → file nodes
  // pipeline runs through the folder uploader, files through UploadManager.
  const folderUploader = getFolderUploader();
  const folderInputRef = useRef<HTMLInputElement>(null);

  const onFolderInput = useCallback(
    (files: FileList | null) => {
      if (
        mount === null ||
        currentFolder === undefined ||
        files === null ||
        files.length === 0
      ) {
        return;
      }
      const entries = [...files].map((f) => ({
        path:
          f.webkitRelativePath !== undefined && f.webkitRelativePath !== ""
            ? f.webkitRelativePath
            : f.name,
        file: f,
      }));
      const rootName = entries[0]?.path.split("/")[0] ?? "folder";
      void folderUploader.start(
        entries,
        { mountId: mount.id, parentId: currentFolder.id },
        rootName,
      );
    },
    [mount, currentFolder, folderUploader],
  );

  const onDirectoryDrop = useCallback(
    (event: React.DragEvent) => {
      if (!canUpload || mount === null || currentFolder === undefined) return;
      event.preventDefault();
      void collectDroppedDirectory(event.dataTransfer.items).then(
        (entries) => {
          if (entries === null || entries.length === 0) return;
          const rootName = entries[0]?.path.split("/")[0] ?? "folder";
          void folderUploader.start(
            entries,
            { mountId: mount.id, parentId: currentFolder.id },
            rootName,
          );
        },
      );
    },
    [canUpload, mount, currentFolder, folderUploader],
  );

  const navigateToCrumb = useCallback(
    (index: number) => {
      invalidateDetail();
      setCrumbs((prev) => prev.slice(0, index + 1));
      setMode({ kind: "browse" });
      setSelectedIds(new Set());
    },
    [invalidateDetail],
  );

  /**
   * Loads a file's detail with a generation guard + abort: a late response
   * for a previous file/mount can never overwrite the current panel or push
   * a crumb onto the wrong mount (coordinator early-review). The original
   * entry ID is always sent — for shortcuts the server resolves the target
   * with its own resourceKey/authorization (never client-side shortcutTargetId
   * dereference).
   */
  const openDetail = useCallback(
    (entry: DriveFileEntry) => {
      if (mount === null) return;
      const gen = ++detailGen.current;
      const controller = new AbortController();
      detailAbort.current?.abort();
      detailAbort.current = controller;
      setDetail({ status: "loading", id: entry.id });
      void getFileDetail(mount.id, entry.id, controller.signal)
        .then((file) => {
          if (detailGen.current !== gen || controller.signal.aborted) return;
          if (file.kind === "folder") {
            // Shortcut resolving to a folder navigates like a real folder.
            // State updaters stay pure (StrictMode may invoke them twice):
            // the single guarded crumb push happens once, outside any
            // updater, exactly here (coordinator R1).
            setCrumbs((prev) => [...prev, { id: file.id, name: file.name }]);
            setMode({ kind: "browse" });
            setDetail(null);
            return;
          }
          setDetail({ status: "ready", file });
        })
        .catch((error: unknown) => {
          if (isAbortError(error) || detailGen.current !== gen) return;
          setDetail({ status: "error", id: entry.id, error });
        });
    },
    [mount],
  );

  const openEntry = useCallback(
    (entry: DriveFileEntry) => {
      if (entry.kind === "folder") {
        invalidateDetail();
        setCrumbs((prev) => [...prev, { id: entry.id, name: entry.name }]);
        setMode({ kind: "browse" });
        setSelectedIds(new Set());
        return;
      }
      openDetail(entry);
    },
    [openDetail, invalidateDetail],
  );

  const toggleSelected = useCallback((id: string, checked: boolean) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  const toggleSelectAll = useCallback(
    (checked: boolean) => {
      setSelectedIds(() => {
        if (!checked || listing.status !== "ready") return new Set();
        return new Set(listing.entries.map((e) => e.id));
      });
    },
    [listing],
  );

  const selectedEntries = useMemo(() => {
    if (listing.status !== "ready") return [];
    return listing.entries.filter((e) => selectedIds.has(e.id));
  }, [listing, selectedIds]);
  const singleSelectedFile = useMemo(() => {
    const files = selectedEntries.filter((e) => e.kind === "file");
    return selectedEntries.length === 1 && files.length === 1
      ? files[0]
      : undefined;
  }, [selectedEntries]);

  const displayedEntries = useMemo(
    () =>
      listing.status === "ready" ? sortEntries(listing.entries, sortKey) : [],
    [listing, sortKey],
  );

  // --- Render ---

  if (mountsState.status === "loading") {
    return <p role="status">{t("common.loading")}</p>;
  }
  if (mountsState.status === "pending") {
    return (
      <>
        <header className="page-header">
          <h1>{t("explorer.title")}</h1>
        </header>
        <section className="card empty-state">
          <h2>
            {t("explorer.pendingTitle")}{" "}
            <span className="badge badge-pending">
              {t("common.pendingBadge")}
            </span>
          </h2>
          <p>{t("explorer.pendingBody")}</p>
        </section>
      </>
    );
  }
  if (mountsState.status === "error") {
    return (
      <>
        <header className="page-header">
          <h1>{t("explorer.title")}</h1>
        </header>
        <ErrorPanel error={mountsState.error} onRetry={() => void loadMounts()} />
      </>
    );
  }
  if (mountsState.mounts.length === 0 || mount === null) {
    return (
      <>
        <header className="page-header">
          <h1>{t("explorer.title")}</h1>
        </header>
        <section className="card empty-state">
          <h2>{t("explorer.emptyTitle")}</h2>
          <p>{t("explorer.emptyBody")}</p>
        </section>
      </>
    );
  }

  const submitSearch = (q: string, scope: SearchScope) => {
    invalidateDetail();
    setMode({ kind: "search", q, scope });
    setSelectedIds(new Set());
  };

  return (
    <>
      <header className="page-header explorer-header">
        <h1>{t("explorer.title")}</h1>
        {mountsState.mounts.length > 1 ? (
          <div className="field mount-picker">
            <label htmlFor="mount-select">{t("explorer.mountLabel")}</label>
            <select
              id="mount-select"
              className="input"
              value={mount.id}
              onChange={(event) => setMountId(event.target.value)}
            >
              {mountsState.mounts.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </div>
        ) : null}
      </header>

      <nav aria-label={t("explorer.breadcrumbs")} className="breadcrumbs">
        <ol>
          {mode.kind === "search" ? (
            <>
              <li>
                <button
                  type="button"
                  className="crumb"
                  onClick={() => {
                    invalidateDetail();
                    setMode({ kind: "browse" });
                  }}
                >
                  {currentFolder?.name}
                </button>
              </li>
              <li aria-current="page">
                {t("explorer.searchResultsTitle", { query: mode.q })}
              </li>
            </>
          ) : (
            crumbs.map((crumb, index) => (
              <li key={crumb.id}>
                {index === crumbs.length - 1 ? (
                  <span aria-current="page">{crumb.name}</span>
                ) : (
                  <button
                    type="button"
                    className="crumb"
                    onClick={() => navigateToCrumb(index)}
                  >
                    {crumb.name}
                  </button>
                )}
              </li>
            ))
          )}
        </ol>
      </nav>

      <div className="explorer-toolbar">
        <SearchBar
          onSubmit={submitSearch}
          searching={mode.kind === "search"}
          onClear={() => {
            invalidateDetail();
            setMode({ kind: "browse" });
          }}
        />
        <div className="toolbar-group" role="group" aria-label={t("explorer.viewLabel")}>
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
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          disabled={!canUpload}
          title={canUpload ? undefined : t("transfers.uploadingUnsupported")}
          onClick={() => void onPickUploadFiles()}
        >
          {t("transfers.uploadButton")}
        </button>
        <input
          ref={uploadInputRef}
          type="file"
          multiple
          className="visually-hidden"
          data-testid="upload-input"
          aria-label={t("transfers.uploadButton")}
          onChange={(event) => {
            onUploadInput(event.target.files);
            event.target.value = "";
          }}
        />
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          disabled={!canUpload}
          title={canUpload ? undefined : t("transfers.uploadingUnsupported")}
          onClick={() => folderInputRef.current?.click()}
        >
          {t("transfers.uploadFolderButton")}
        </button>
        <input
          ref={folderInputRef}
          type="file"
          {...{ webkitdirectory: "" }}
          className="visually-hidden"
          data-testid="folder-upload-input"
          aria-label={t("transfers.uploadFolderButton")}
          onChange={(event) => {
            onFolderInput(event.target.files);
            event.target.value = "";
          }}
        />
        <div className="field toolbar-sort">
          <label htmlFor="sort-select" className="visually-hidden">
            {t("explorer.sortLabel")}
          </label>
          <select
            id="sort-select"
            className="input"
            value={sortKey}
            onChange={(event) => setSortKey(event.target.value as SortKey)}
          >
            <option value="name-asc">{t("explorer.sortNameAsc")}</option>
            <option value="name-desc">{t("explorer.sortNameDesc")}</option>
            <option value="size-asc">{t("explorer.sortSizeAsc")}</option>
            <option value="size-desc">{t("explorer.sortSizeDesc")}</option>
            <option value="modified-asc">{t("explorer.sortModifiedAsc")}</option>
            <option value="modified-desc">{t("explorer.sortModifiedDesc")}</option>
          </select>
        </div>
      </div>

      {selectedEntries.length > 0 ? (
        <div className="selection-bar" role="status">
          <span>
            {t("explorer.selectedCount", { count: selectedEntries.length })}
          </span>
          {singleSelectedFile !== undefined && mount !== null ? (
            <a
              className="btn btn-ghost btn-sm"
              href={contentUrl(mount.id, singleSelectedFile.id)}
              download
            >
              {t("explorer.download")}
            </a>
          ) : null}
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => setSelectedIds(new Set())}
          >
            {t("explorer.clearSelection")}
          </button>
        </div>
      ) : null}

      <div
        className="listing-drop-area"
        onDrop={onDirectoryDrop}
        onDragOver={(event) => {
          if (canUpload) event.preventDefault();
        }}
      >
      {listing.status === "loading" ? (
        <p role="status">{t("common.loading")}</p>
      ) : listing.status === "error" ? (
        <ErrorPanel error={listing.error} onRetry={() => void loadListing()} />
      ) : displayedEntries.length === 0 ? (
        <section className="card empty-state">
          <p>
            {mode.kind === "search"
              ? t("explorer.searchEmpty")
              : t("explorer.folderEmpty")}
          </p>
        </section>
      ) : view === "list" ? (
        <EntryTable
          entries={displayedEntries}
          locale={locale}
          mount={mount}
          selectedIds={selectedIds}
          onToggle={toggleSelected}
          onToggleAll={toggleSelectAll}
          onOpen={openEntry}
          onShowDetail={openDetail}
        />
      ) : (
        <EntryGrid
          entries={displayedEntries}
          locale={locale}
          mount={mount}
          selectedIds={selectedIds}
          onToggle={toggleSelected}
          onOpen={openEntry}
        />
      )}
      </div>

      {listing.status === "ready" && listing.nextCursor !== undefined ? (
        <div className="load-more">
          <button
            type="button"
            className="btn btn-ghost"
            disabled={listing.loadingMore}
            onClick={() => void loadListing(listing.nextCursor)}
          >
            {listing.loadingMore ? t("common.loading") : t("explorer.loadMore")}
          </button>
        </div>
      ) : null}

      {detail !== null ? (
        <FilePanel
          mount={mount}
          detail={detail}
          siblings={displayedEntries}
          onClose={invalidateDetail}
        />
      ) : null}
    </>
  );
}

function SearchBar({
  onSubmit,
  searching,
  onClear,
}: {
  onSubmit: (q: string, scope: SearchScope) => void;
  searching: boolean;
  onClear: () => void;
}) {
  const { t } = useI18n();
  const [q, setQ] = useState("");
  const [scope, setScope] = useState<SearchScope>("drive");
  return (
    <form
      className="search-bar"
      role="search"
      onSubmit={(event) => {
        event.preventDefault();
        const query = q.trim();
        if (query.length > 0) onSubmit(query, scope);
      }}
    >
      <label htmlFor="explorer-search" className="visually-hidden">
        {t("explorer.searchPlaceholder")}
      </label>
      <input
        id="explorer-search"
        className="input"
        type="search"
        value={q}
        placeholder={t("explorer.searchPlaceholder")}
        onChange={(event) => setQ(event.target.value)}
      />
      <label htmlFor="explorer-scope" className="visually-hidden">
        {t("explorer.searchScopeLabel")}
      </label>
      <select
        id="explorer-scope"
        className="input"
        value={scope}
        onChange={(event) => setScope(event.target.value as SearchScope)}
      >
        <option value="folder">{t("explorer.searchScopeFolder")}</option>
        <option value="drive">{t("explorer.searchScopeDrive")}</option>
      </select>
      <button type="submit" className="btn btn-primary btn-sm">
        {t("explorer.searchSubmit")}
      </button>
      {searching ? (
        <button type="button" className="btn btn-ghost btn-sm" onClick={onClear}>
          {t("explorer.clearSearch")}
        </button>
      ) : null}
    </form>
  );
}

function EntryTable({
  entries,
  locale,
  mount,
  selectedIds,
  onToggle,
  onToggleAll,
  onOpen,
  onShowDetail,
}: {
  entries: DriveFileEntry[];
  locale: string;
  mount: MountViewClient;
  selectedIds: ReadonlySet<string>;
  onToggle: (id: string, checked: boolean) => void;
  onToggleAll: (checked: boolean) => void;
  onOpen: (entry: DriveFileEntry) => void;
  onShowDetail: (entry: DriveFileEntry) => void;
}) {
  const { t } = useI18n();
  const allSelected =
    entries.length > 0 && entries.every((e) => selectedIds.has(e.id));
  return (
    <div className="table-wrap">
      <table className="entry-table">
        <thead>
          <tr>
            <th scope="col">
              <input
                type="checkbox"
                aria-label={t("explorer.selectAll")}
                checked={allSelected}
                onChange={(event) => onToggleAll(event.target.checked)}
              />
            </th>
            <th scope="col">{t("explorer.colName")}</th>
            <th scope="col">{t("explorer.colSize")}</th>
            <th scope="col">{t("explorer.colModified")}</th>
            <th scope="col">
              <span className="visually-hidden">{t("explorer.colActions")}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => (
            <tr key={entry.id}>
              <td>
                <input
                  type="checkbox"
                  aria-label={t("explorer.selectEntry", { name: entry.name })}
                  checked={selectedIds.has(entry.id)}
                  onChange={(event) => onToggle(entry.id, event.target.checked)}
                />
              </td>
              <td className="entry-name">
                <span aria-hidden="true">{kindIcon(entry)}</span>{" "}
                <button
                  type="button"
                  className="entry-link"
                  title={entry.name}
                  onClick={() => onOpen(entry)}
                >
                  {entry.name}
                </button>
                {entry.kind === "shortcut" ? (
                  <span className="badge">{kindLabel(t, entry)}</span>
                ) : null}
              </td>
              <td>
                {entry.kind === "folder"
                  ? "—"
                  : formatBytes(entry.size, locale)}
              </td>
              <td>{formatDateTime(entry.modifiedTime, locale)}</td>
              <td className="entry-actions">
                {/* Content endpoints take literal resolved file IDs and
                    reject shortcut IDs — only real files get a direct
                    download anchor; a shortcut is opened via detail, where
                    the catalog-resolved target ID drives its own anchor. */}
                {entry.kind === "file" ? (
                  <a
                    className="btn btn-ghost btn-sm"
                    href={contentUrl(mount.id, entry.id)}
                    download
                    aria-label={t("explorer.downloadEntry", { name: entry.name })}
                  >
                    {t("explorer.download")}
                  </a>
                ) : null}
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => onShowDetail(entry)}
                >
                  {t("explorer.details")}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function EntryGrid({
  entries,
  locale,
  mount,
  selectedIds,
  onToggle,
  onOpen,
}: {
  entries: DriveFileEntry[];
  locale: string;
  mount: MountViewClient;
  selectedIds: ReadonlySet<string>;
  onToggle: (id: string, checked: boolean) => void;
  onOpen: (entry: DriveFileEntry) => void;
}) {
  const { t } = useI18n();
  return (
    <ul className="entry-grid">
      {entries.map((entry) => (
        <li key={entry.id} className="entry-card card">
          <label className="entry-check">
            <input
              type="checkbox"
              aria-label={t("explorer.selectEntry", { name: entry.name })}
              checked={selectedIds.has(entry.id)}
              onChange={(event) => onToggle(entry.id, event.target.checked)}
            />
          </label>
          {entry.hasThumbnail ? (
            <img
              className="entry-thumb"
              src={thumbnailUrl(mount.id, entry.id)}
              alt=""
              loading="lazy"
              onError={(event) => {
                event.currentTarget.style.display = "none";
              }}
            />
          ) : (
            <span className="entry-thumb-icon" aria-hidden="true">
              {kindIcon(entry)}
            </span>
          )}
          <button
            type="button"
            className="entry-link entry-card-name"
            title={entry.name}
            onClick={() => onOpen(entry)}
          >
            {entry.name}
          </button>
          <span className="entry-card-meta">
            {entry.kind === "folder"
              ? kindLabel(t, entry)
              : formatBytes(entry.size, locale)}
            {" · "}
            {formatDateTime(entry.modifiedTime, locale)}
          </span>
        </li>
      ))}
    </ul>
  );
}

function FilePanel({
  mount,
  detail,
  siblings,
  onClose,
}: {
  mount: MountViewClient;
  detail:
    | { status: "loading"; id: string }
    | { status: "ready"; file: FileDetail }
    | { status: "error"; id: string; error: unknown };
  /** Currently displayed (sorted) listing for preview next/previous. */
  siblings: DriveFileEntry[];
  onClose: () => void;
}) {
  const { t, locale } = useI18n();
  const { state: session } = useSession();
  // Share creation is an admin-only API (B's share router); offering it to a
  // non-admin would surface a guaranteed FORBIDDEN, so the form stays hidden.
  const canShare =
    session.status === "signedIn" && session.user.role === "admin";
  const [readiness, setReadiness] = useState<
    "idle" | "checking" | { error: unknown } | { state: string }
  >("idle");
  const [shareExpiresAt, setShareExpiresAt] = useState("");
  const [shareResult, setShareResult] = useState<
    "idle" | "creating" | { error: unknown } | { token: string }
  >("idle");
  const [copied, setCopied] = useState(false);

  const file = detail.status === "ready" ? detail.file : null;
  const fileId = file?.id;

  // Reset per-file local state so a share token or probe result from a
  // previous file can never bleed into the next panel.
  useEffect(() => {
    setReadiness("idle");
    setShareExpiresAt("");
    setShareResult("idle");
    setCopied(false);
  }, [fileId]);

  const checkReadiness = () => {
    if (file === null) return;
    setReadiness("checking");
    void requestReadiness(mount.id, file.id)
      .then((res) =>
        setReadiness({ state: res.readerAccessState ?? "unchecked" }),
      )
      .catch((error: unknown) => setReadiness({ error }));
  };

  const submitShare = (event: React.FormEvent) => {
    event.preventDefault();
    if (file === null || shareExpiresAt.length === 0) return;
    const expiresAt = new Date(shareExpiresAt);
    if (Number.isNaN(expiresAt.getTime())) return;
    setShareResult("creating");
    void createShare({
      scope: { kind: "file", mountId: mount.id, fileId: file.id },
      expiresAt: expiresAt.toISOString(),
    })
      .then((res) => setShareResult({ token: res.token }))
      .catch((error: unknown) => setShareResult({ error }));
  };

  // A completed probe overrides the snapshot state that came with the
  // detail fetch — the point of the button is a fresher answer.
  const readinessState =
    typeof readiness === "object" && "state" in readiness
      ? readiness.state
      : (file?.readerAccessState ?? null);

  return (
    <aside className="card detail-panel" aria-label={t("explorer.detailTitle")}>
      <div className="detail-head">
        <h2>{t("explorer.detailTitle")}</h2>
        <button
          type="button"
          className="btn-icon"
          aria-label={t("explorer.closeDetail")}
          onClick={onClose}
        >
          ✕
        </button>
      </div>
      {detail.status === "loading" ? (
        <p role="status">{t("common.loading")}</p>
      ) : detail.status === "error" ? (
        <p className="alert alert-error" role="alert">
          {t(messageKeyForError(detail.error).key)}
        </p>
      ) : file !== null ? (
        <>
          <h3 className="detail-name" title={file.name}>
            {file.name}
          </h3>
          <dl className="detail-list">
            <dt>{t("explorer.colKind")}</dt>
            <dd>{kindLabel(t, file)}</dd>
            <dt>{t("explorer.colMime")}</dt>
            <dd className="detail-mono">{file.mimeType}</dd>
            <dt>{t("explorer.colSize")}</dt>
            <dd>{file.kind === "folder" ? "—" : formatBytes(file.size, locale)}</dd>
            <dt>{t("explorer.colModified")}</dt>
            <dd>{formatDateTime(file.modifiedTime, locale)}</dd>
            <dt>{t("explorer.readinessLabel")}</dt>
            <dd>
              {readinessState !== null ? (
                <span className="badge">
                  {t(
                    readinessState === "readable"
                      ? "explorer.readerReadable"
                      : readinessState === "blocked"
                        ? "explorer.readerBlocked"
                        : readinessState === "pending"
                          ? "explorer.readerPending"
                          : "explorer.readerUnchecked",
                  )}
                </span>
              ) : null}
              {file.kind !== "folder" ? (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  disabled={readiness === "checking"}
                  onClick={checkReadiness}
                >
                  {readiness === "checking"
                    ? t("explorer.checkingReadability")
                    : t("explorer.checkReadability")}
                </button>
              ) : null}
              {typeof readiness === "object" && "error" in readiness ? (
                <span className="field-error" role="alert">
                  {t(messageKeyForError(readiness.error).key)}
                </span>
              ) : null}
            </dd>
          </dl>
          {file.kind === "file" ? (
            <div className="detail-actions">
              <a
                className="btn btn-primary"
                href={contentUrl(mount.id, file.id)}
                download
              >
                {t("explorer.download")}
              </a>
              <PreviewLauncher
                mountId={mount.id}
                file={file}
                siblings={siblings}
              />
            </div>
          ) : null}
          {file.kind === "file" && canShare ? (
            <form className="share-form" onSubmit={submitShare}>
              <h3>{t("explorer.shareCreate")}</h3>
              <div className="field">
                <label htmlFor="share-expiry">{t("explorer.shareExpires")}</label>
                <input
                  id="share-expiry"
                  className="input"
                  type="datetime-local"
                  value={shareExpiresAt}
                  onChange={(event) => setShareExpiresAt(event.target.value)}
                  required
                />
              </div>
              <button
                type="submit"
                className="btn btn-ghost btn-sm"
                disabled={shareResult === "creating" || shareExpiresAt === ""}
              >
                {shareResult === "creating"
                  ? t("explorer.shareCreating")
                  : t("explorer.shareCreateSubmit")}
              </button>
              {typeof shareResult === "object" && "error" in shareResult ? (
                <p className="field-error" role="alert">
                  {t(messageKeyForError(shareResult.error).key)}
                </p>
              ) : null}
              {typeof shareResult === "object" && "token" in shareResult ? (
                <div className="alert alert-success">
                  <p>{t("explorer.shareTokenTitle")}</p>
                  <code className="share-token">{shareResult.token}</code>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => {
                      void navigator.clipboard
                        ?.writeText(shareResult.token)
                        .then(() => setCopied(true));
                    }}
                  >
                    {copied ? t("explorer.copied") : t("explorer.copy")}
                  </button>
                </div>
              ) : null}
            </form>
          ) : null}
        </>
      ) : null}
    </aside>
  );
}
