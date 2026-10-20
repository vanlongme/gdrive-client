import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent, DragEvent, FormEvent } from "react";
import { useSearchParams } from "react-router";
import {
  getServiceAccountsOverview,
  importServiceAccount,
  listAdminMounts,
  setServiceAccountEnabled,
  type MountAdminView,
} from "../../lib/admin-api";
import type {
  ServiceAccountImportOutcome,
  ServiceAccountOverviewEntry,
} from "../../../shared/contracts/admin";
import { messageKeyForError } from "../../lib/error-message";
import { formatDateTime } from "../../lib/format";
import { useI18n } from "../../lib/i18n";
import type { MessagePath } from "../../lib/i18n";
import { ConfirmAction } from "../../components/confirm-action";
import {
  applySaFilter,
  clampSaPage,
  parseSaFilter,
  pruneSaSelection,
  saDrainedMountIds,
  saFilterToParams,
  saPageCount,
  saPageSlice,
  saSelectAllState,
  summarizeAccounts,
  toggleSaSelectAll,
} from "./service-accounts-filter";
import { runSaBulkAction, runSaPoolAction } from "./service-accounts-actions";
import {
  saFileResult,
  saRotatedResult,
  type SaFileResult,
} from "./service-accounts-import";
import "./service-accounts.css";

/**
 * Read-only service accounts (spec section 11.3 step 5; wave 10 UX): the
 * overview projection feeds a summary strip, URL-backed filters, a
 * selectable table and bulk pool/enable actions. Key material only ever
 * travels into the vault — file/paste contents are dropped from state right
 * after each upload and never touch client storage.
 */

type LoadState<T> =
  | { status: "loading" }
  | { status: "error"; error: unknown }
  | { status: "ready"; value: T };

type Notice = { kind: "success" | "error" | "info"; text: string };

/** A key JSON file is the same size the server accepts (65536 chars). */
const MAX_KEY_FILE_BYTES = 64 * 1024;

type FileResult = SaFileResult;

const GRANT_BADGE: Record<string, string> = {
  granted: "badge badge-ok",
  pending: "badge badge-caution",
  revoking: "badge badge-caution",
  failed: "badge badge-warn",
  none: "badge badge-muted",
};

const GRANT_TEXT: Record<string, MessagePath> = {
  granted: "admin.grantStateGranted",
  pending: "admin.grantStatePending",
  revoking: "admin.grantStateRevoking",
  failed: "admin.grantStateFailed",
  none: "admin.saGrantNone",
} as const;

export function ServiceAccountsSection({
  onShowMountGrants,
}: {
  onShowMountGrants?: (mountId: string) => void;
}) {
  const { t, locale } = useI18n();
  const [searchParams, setSearchParams] = useSearchParams();
  const filter = useMemo(() => parseSaFilter(searchParams), [searchParams]);

  const [accounts, setAccounts] = useState<
    LoadState<ServiceAccountOverviewEntry[]>
  >({ status: "loading" });
  const [mounts, setMounts] = useState<MountAdminView[]>([]);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [poolMountId, setPoolMountId] = useState("");
  const [grantHint, setGrantHint] = useState<{
    mountId: string;
    label: string;
  } | null>(null);

  const [keyJson, setKeyJson] = useState("");
  const [submit, setSubmit] = useState<
    "idle" | "submitting" | { error: unknown } | "done"
  >("idle");
  const [importOutcome, setImportOutcome] =
    useState<ServiceAccountImportOutcome | null>(null);
  const [fileResults, setFileResults] = useState<FileResult[]>([]);
  const [importing, setImporting] = useState<{
    done: number;
    total: number;
  } | null>(null);
  const [rotating, setRotating] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const selectAllRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setAccounts({ status: "loading" });
    try {
      const [overviewRes, mountsRes] = await Promise.all([
        getServiceAccountsOverview(),
        listAdminMounts(),
      ]);
      setAccounts({ status: "ready", value: overviewRes.serviceAccounts });
      setMounts(mountsRes.mounts);
      setSelected((prev) =>
        pruneSaSelection(
          prev,
          new Set(overviewRes.serviceAccounts.map((sa) => sa.id)),
        ),
      );
    } catch (error) {
      setAccounts({ status: "error", error });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const patchFilter = useCallback(
    (patch: Partial<typeof filter>) => {
      const next = { ...filter, page: 1, ...patch };
      setSearchParams(saFilterToParams(next), { replace: true });
    },
    [filter, setSearchParams],
  );

  const allAccounts = accounts.status === "ready" ? accounts.value : [];
  const filtered = useMemo(
    () => applySaFilter(allAccounts, filter),
    [allAccounts, filter],
  );
  const summary = useMemo(() => summarizeAccounts(allAccounts), [allAccounts]);
  const pageCount = saPageCount(filtered.length);
  const page = clampSaPage(filter.page, filtered.length);
  const pageItems = useMemo(() => saPageSlice(filtered, page), [filtered, page]);
  const filteredIds = useMemo(() => filtered.map((sa) => sa.id), [filtered]);
  const selectState = saSelectAllState(selected, filteredIds);

  useEffect(() => {
    if (selectAllRef.current !== null) {
      selectAllRef.current.indeterminate = selectState === "some";
    }
  }, [selectState]);

  const projects = useMemo(
    () => [...new Set(allAccounts.map((sa) => sa.projectId))].sort(),
    [allAccounts],
  );
  const mountLabel = useCallback(
    (id: string) => mounts.find((m) => m.id === id)?.label ?? id,
    [mounts],
  );

  // Mounts a bulk disable or pool remove would leave with ZERO enabled SAs —
  // surfaced inside the confirm before the action runs (review L5).
  const drainOnDisable = useMemo(
    () => saDrainedMountIds(mounts, selected),
    [mounts, selected],
  );
  const drainOnPoolRemove = useMemo(
    () =>
      poolMountId === ""
        ? []
        : saDrainedMountIds(mounts, selected, poolMountId),
    [mounts, selected, poolMountId],
  );

  const runBulk = async (action: "enable" | "disable") => {
    const ids = [...selected];
    setBusy(true);
    setNotice(null);
    try {
      // Chunked (200/request, sequential): select-all can span pages.
      const outcome = await runSaBulkAction(action, ids);
      setNotice({
        kind: outcome.failed === 0 ? "success" : "error",
        text: t("admin.saBulkResult", {
          count: outcome.ok,
          failed: outcome.failed,
        }),
      });
      setSelected(new Set());
      await load();
    } catch (error) {
      setNotice({ kind: "error", text: t(messageKeyForError(error).key) });
    } finally {
      setBusy(false);
    }
  };

  const runPool = async (op: "add" | "remove") => {
    if (poolMountId === "") return;
    const ids = [...selected];
    const mountName = mountLabel(poolMountId);
    setBusy(true);
    setNotice(null);
    setGrantHint(null);
    try {
      // Chunked (100/request, sequential): the same cap the server enforces.
      const outcome = await runSaPoolAction(op, poolMountId, ids);
      if (outcome.failed === 0) {
        setNotice({
          kind: "success",
          text:
            op === "add"
              ? t("admin.saPoolAddDone", {
                  count: ids.length,
                  mount: mountName,
                })
              : t("admin.saPoolRemoveDone", {
                  count: ids.length,
                  mount: mountName,
                }),
        });
        if (op === "add" && outcome.mount?.kind === "my_drive_folder") {
          setGrantHint({ mountId: outcome.mount.id, label: mountName });
        }
      } else {
        setNotice({
          kind: "error",
          text: t("admin.saPoolResultPartial", {
            ok: outcome.ok,
            total: ids.length,
            failed: outcome.failed,
            mount: mountName,
          }),
        });
      }
      setSelected(new Set());
      await load();
    } catch (error) {
      setNotice({ kind: "error", text: t(messageKeyForError(error).key) });
    } finally {
      setBusy(false);
    }
  };

  const toggleOne = async (account: ServiceAccountOverviewEntry) => {
    setBusy(true);
    setNotice(null);
    try {
      await setServiceAccountEnabled(account.id, !account.enabled);
      await load();
    } catch (error) {
      setNotice({ kind: "error", text: t(messageKeyForError(error).key) });
    } finally {
      setBusy(false);
    }
  };

  const copyEmails = async () => {
    const emails = allAccounts
      .filter((sa) => selected.has(sa.id))
      .map((sa) => sa.email);
    try {
      await navigator.clipboard.writeText(emails.join("\n"));
      setNotice({
        kind: "success",
        text: t("admin.saCopied", { count: emails.length }),
      });
    } catch {
      setNotice({ kind: "error", text: t("admin.saCopyFailed") });
    }
  };

  const submitKeyJson = (json: string, rotate: boolean) => {
    setSubmit("submitting");
    setImportOutcome(null);
    void importServiceAccount({
      keyJson: json,
      duplicatePolicy: rotate ? "rotate" : "skip",
    })
      .then((res) => {
        setSubmit("done");
        setImportOutcome(res.outcome);
        // A conflict keeps the pasted JSON so the explicit rotate action can
        // resubmit it; every other outcome clears the field.
        if (res.outcome !== "conflict") setKeyJson("");
        void load();
      })
      .catch((error: unknown) => setSubmit({ error }));
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    submitKeyJson(keyJson, false);
  };

  const importFiles = async (files: readonly File[]) => {
    if (files.length === 0) return;
    setImporting({ done: 0, total: files.length });
    setFileResults([]);
    let done = 0;
    // `importing` always resets — a read error must not strand the progress
    // indicator or swallow the file's own result row (review L3).
    try {
      for (const file of files) {
        let outcome: FileResult["outcome"];
        if (file.size > MAX_KEY_FILE_BYTES) {
          // Rejected before reading: the server caps keyJson at 64 KiB.
          outcome = "too_large";
        } else {
          let text = "";
          let readError = false;
          try {
            text = await file.text();
          } catch {
            readError = true;
          }
          if (readError || text === "") {
            outcome = "error";
          } else {
            try {
              const res = await importServiceAccount({
                keyJson: text,
                duplicatePolicy: "skip",
              });
              outcome = res.outcome;
            } catch {
              outcome = "error";
            } finally {
              // Key material never persists client-side: the read text
              // leaves memory as soon as the upload attempt settles.
              text = "";
            }
          }
        }
        done += 1;
        setFileResults((prev) => [
          ...prev,
          saFileResult(file.name, outcome, file),
        ]);
        setImporting({ done, total: files.length });
      }
    } finally {
      setImporting(null);
    }
    void load();
  };

  /** Explicit key rotation for a conflicted file: re-read and resubmit with
   * duplicatePolicy 'rotate' — the only path that can rotate (review M3). */
  const rotateFile = async (index: number) => {
    const target = fileResults[index];
    // The handle exists only on un-rotated conflict rows.
    if (target?.file === undefined) return;
    setRotating(index);
    let outcome: FileResult["outcome"] = "error";
    try {
      const text = await target.file.text();
      try {
        const res = await importServiceAccount({
          keyJson: text,
          duplicatePolicy: "rotate",
        });
        outcome = res.outcome;
      } catch {
        outcome = "error";
      }
    } catch {
      outcome = "error";
    } finally {
      setRotating(null);
    }
    // Settled rotate attempts release the File handle — success or failure.
    setFileResults((prev) =>
      prev.map((r, i) => (i === index ? saRotatedResult(r, outcome) : r)),
    );
    void load();
  };

  const onFileInput = (event: ChangeEvent<HTMLInputElement>) => {
    const files = [...(event.target.files ?? [])];
    event.target.value = "";
    void importFiles(files);
  };

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setDragging(false);
    const files = [...event.dataTransfer.files].filter(
      (file) => file.name.toLowerCase().endsWith(".json") || file.type === "application/json",
    );
    void importFiles(files);
  };

  const fileOutcomeText = (outcome: FileResult["outcome"]) =>
    outcome === "imported"
      ? t("admin.saFileImported")
      : outcome === "rotated"
        ? t("admin.saFileRotated")
        : outcome === "duplicate"
          ? t("admin.saFileDuplicate")
          : outcome === "conflict"
            ? t("admin.saFileConflict")
            : outcome === "too_large"
              ? t("admin.saFileTooLarge")
              : t("admin.saFileFailed");

  return (
    <section
      className="card admin-section"
      aria-label={t("admin.serviceAccountsTitle")}
    >
      <h2>{t("admin.serviceAccountsTitle")}</h2>
      <p className="section-note">{t("admin.saIntro")}</p>

      {accounts.status === "loading" ? (
        <p role="status">{t("common.loading")}</p>
      ) : accounts.status === "error" ? (
        <p className="alert alert-error" role="alert">
          {t(messageKeyForError(accounts.error).key)}
        </p>
      ) : accounts.value.length === 0 ? (
        <p>{t("admin.saEmpty")}</p>
      ) : (
        <>
          <div
            className="sa-summary"
            role="group"
            aria-label={t("admin.saStatus")}
          >
            <button
              type="button"
              className="sa-chip"
              aria-pressed={filter.status === "all" && filter.mount === "all"}
              onClick={() =>
                patchFilter({ status: "all", mount: "all", project: "", q: "" })
              }
            >
              {t("admin.saSummaryTotal", { count: summary.total })}
            </button>
            <button
              type="button"
              className="sa-chip"
              aria-pressed={filter.status === "enabled"}
              onClick={() => patchFilter({ status: "enabled" })}
            >
              {t("admin.saSummaryEnabled", { count: summary.enabled })}
            </button>
            <button
              type="button"
              className="sa-chip"
              aria-pressed={filter.status === "disabled"}
              onClick={() => patchFilter({ status: "disabled" })}
            >
              {t("admin.saSummaryDisabled", { count: summary.disabled })}
            </button>
            <button
              type="button"
              className="sa-chip"
              aria-pressed={filter.status === "cooldown"}
              onClick={() => patchFilter({ status: "cooldown" })}
            >
              {t("admin.saSummaryCooling", { count: summary.coolingDown })}
            </button>
            <button
              type="button"
              className="sa-chip"
              aria-pressed={filter.mount === "none"}
              onClick={() => patchFilter({ mount: "none" })}
            >
              {t("admin.saSummaryNoPool", { count: summary.noPool })}
            </button>
          </div>

          <div className="sa-filters">
            <input
              type="search"
              className="input sa-search"
              value={filter.q}
              placeholder={t("admin.saSearchPlaceholder")}
              aria-label={t("admin.saSearchLabel")}
              onChange={(event) => patchFilter({ q: event.target.value })}
            />
            <select
              className="input"
              value={filter.status}
              aria-label={t("admin.saFilterStatus")}
              onChange={(event) =>
                patchFilter({
                  status: event.target.value as typeof filter.status,
                })
              }
            >
              <option value="all">{t("admin.saStatusAll")}</option>
              <option value="enabled">{t("admin.saEnabled")}</option>
              <option value="disabled">{t("admin.saDisabled")}</option>
              <option value="cooldown">{t("admin.saCoolingDown")}</option>
            </select>
            <select
              className="input"
              value={filter.project}
              aria-label={t("admin.saFilterProject")}
              onChange={(event) => patchFilter({ project: event.target.value })}
            >
              <option value="">{t("admin.saProjectAll")}</option>
              {projects.map((project) => (
                <option key={project} value={project}>
                  {project}
                </option>
              ))}
            </select>
            <select
              className="input"
              value={filter.mount}
              aria-label={t("admin.saFilterMount")}
              onChange={(event) => patchFilter({ mount: event.target.value })}
            >
              <option value="all">{t("admin.saMountAll")}</option>
              <option value="none">{t("admin.saMountNone")}</option>
              {mounts.map((mount) => (
                <option key={mount.id} value={mount.id}>
                  {mount.label}
                </option>
              ))}
            </select>
            <select
              className="input"
              value={filter.sort}
              aria-label={t("admin.saSortLabel")}
              onChange={(event) =>
                patchFilter({ sort: event.target.value as typeof filter.sort })
              }
            >
              <option value="email">{t("admin.saSortEmail")}</option>
              <option value="created">{t("admin.saSortCreated")}</option>
              <option value="status">{t("admin.saSortStatus")}</option>
            </select>
            <select
              className="input"
              value={filter.dir}
              aria-label={t("admin.saSortDirLabel")}
              onChange={(event) =>
                patchFilter({ dir: event.target.value as typeof filter.dir })
              }
            >
              <option value="asc">{t("admin.saSortAsc")}</option>
              <option value="desc">{t("admin.saSortDesc")}</option>
            </select>
          </div>

          {selected.size > 0 ? (
            <div className="selection-bar sa-action-bar" role="status">
              <span>{t("admin.saSelected", { count: selected.size })}</span>
              <ConfirmAction
                label={t("admin.saEnable")}
                confirmTitle={t("admin.saBulkEnableConfirmTitle", {
                  count: selected.size,
                })}
                confirmBody={t("admin.saBulkEnableConfirmBody", {
                  count: selected.size,
                })}
                confirmLabel={t("admin.saEnable")}
                busy={busy}
                onConfirm={() => void runBulk("enable")}
              />
              <ConfirmAction
                label={t("admin.saDisable")}
                confirmTitle={t("admin.saBulkDisableConfirmTitle", {
                  count: selected.size,
                })}
                confirmBody={
                  <>
                    {t("admin.saBulkDisableConfirmBody", {
                      count: selected.size,
                    })}
                    {drainOnDisable.length > 0 ? (
                      <p className="confirm-warning">
                        {t("admin.saDrainWarn", {
                          mounts: drainOnDisable.map(mountLabel).join(", "),
                        })}
                      </p>
                    ) : null}
                  </>
                }
                confirmLabel={t("admin.saDisable")}
                busy={busy}
                danger
                onConfirm={() => void runBulk("disable")}
              />
              <select
                className="input input-sm sa-pool-pick"
                value={poolMountId}
                aria-label={t("admin.saPoolPick")}
                onChange={(event) => setPoolMountId(event.target.value)}
              >
                <option value="">{t("admin.saPoolPick")}</option>
                {mounts.map((mount) => (
                  <option key={mount.id} value={mount.id}>
                    {mount.label}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={busy || poolMountId === ""}
                onClick={() => void runPool("add")}
              >
                {t("admin.saAddToPool")}
              </button>
              <ConfirmAction
                label={t("admin.saRemoveFromPool")}
                confirmTitle={t("admin.saPoolRemoveConfirmTitle", {
                  count: selected.size,
                })}
                confirmBody={
                  <>
                    {t("admin.saPoolRemoveConfirmBody", {
                      count: selected.size,
                      mount: mountLabel(poolMountId),
                    })}
                    {drainOnPoolRemove.length > 0 ? (
                      <p className="confirm-warning">
                        {t("admin.saDrainWarn", {
                          mounts: drainOnPoolRemove
                            .map(mountLabel)
                            .join(", "),
                        })}
                      </p>
                    ) : null}
                  </>
                }
                confirmLabel={t("admin.saRemoveFromPool")}
                busy={busy}
                disabled={poolMountId === ""}
                danger
                onConfirm={() => void runPool("remove")}
              />
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={busy}
                onClick={() => void copyEmails()}
              >
                {t("admin.saCopyEmails")}
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => setSelected(new Set())}
              >
                {t("explorer.clearSelection")}
              </button>
            </div>
          ) : null}

          {notice !== null ? (
            <p
              className={`alert ${notice.kind === "error" ? "alert-error" : notice.kind === "success" ? "alert-success" : "alert-info"}`}
              role={notice.kind === "error" ? "alert" : "status"}
            >
              {notice.text}
            </p>
          ) : null}
          {grantHint !== null ? (
            <p className="alert alert-info" role="status">
              {t("admin.saPoolGrantsHint")}{" "}
              {onShowMountGrants !== undefined ? (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => onShowMountGrants(grantHint.mountId)}
                >
                  {t("admin.saPoolGrantsLink")}
                </button>
              ) : null}
            </p>
          ) : null}

          <div className="table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th scope="col" className="sa-col-check">
                    <input
                      ref={selectAllRef}
                      type="checkbox"
                      aria-label={t("admin.saSelectAll")}
                      checked={selectState === "all"}
                      onChange={() =>
                        setSelected((prev) =>
                          toggleSaSelectAll(prev, filteredIds),
                        )
                      }
                    />
                  </th>
                  <th scope="col">{t("admin.saStatus")}</th>
                  <th scope="col">{t("admin.saEmail")}</th>
                  <th scope="col">{t("admin.saProject")}</th>
                  <th scope="col">{t("admin.saKeyId")}</th>
                  <th scope="col">{t("admin.saMounts")}</th>
                  <th scope="col">{t("admin.saGrants")}</th>
                  <th scope="col">{t("admin.saCreated")}</th>
                  <th scope="col">
                    <span className="visually-hidden">
                      {t("explorer.colActions")}
                    </span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {pageItems.map((account) => {
                  const drained = account.enabled
                    ? saDrainedMountIds(mounts, new Set([account.id]))
                    : [];
                  return (
                    <tr key={account.id}>
                      <td className="sa-col-check">
                        <input
                          type="checkbox"
                          aria-label={t("admin.saSelectRow")}
                          checked={selected.has(account.id)}
                          onChange={(event) =>
                            setSelected((prev) => {
                              const next = new Set(prev);
                              if (event.target.checked) next.add(account.id);
                              else next.delete(account.id);
                              return next;
                            })
                          }
                        />
                      </td>
                      <td>
                        <span
                          className={
                            account.enabled
                              ? "badge badge-ok"
                              : "badge badge-muted"
                          }
                        >
                          {account.enabled
                            ? t("admin.saEnabled")
                            : t("admin.saDisabled")}
                        </span>
                        {account.coolingDown === true ? (
                          <span className="badge badge-caution">
                            {t("admin.saCoolingDown")}
                          </span>
                        ) : account.coolingDown === null ? (
                          <span className="badge badge-muted">
                            {t("admin.saCooldownUnknown")}
                          </span>
                        ) : null}
                      </td>
                      <td className="detail-mono">{account.email}</td>
                      <td className="detail-mono">{account.projectId}</td>
                      <td className="detail-mono sa-keyid">
                        {account.keyId === "" ? "—" : account.keyId}
                      </td>
                      <td>
                        {account.mounts.length === 0
                          ? "—"
                          : account.mounts
                              .map((mount) => mountLabel(mount.id))
                              .join(", ")}
                      </td>
                      <td>
                        {account.grants.length === 0
                          ? "—"
                          : account.grants.map((grant) => (
                              <span
                                key={grant.mountId}
                                className={GRANT_BADGE[grant.state] ?? "badge"}
                                title={mountLabel(grant.mountId)}
                              >
                                {t(
                                  GRANT_TEXT[grant.state] ?? "admin.saGrantNone",
                                )}
                              </span>
                            ))}
                      </td>
                      <td>{formatDateTime(account.createdAt, locale)}</td>
                      <td className="entry-actions">
                        <ConfirmAction
                          label={
                            account.enabled
                              ? t("admin.saDisable")
                              : t("admin.saEnable")
                          }
                          confirmTitle={
                            account.enabled
                              ? t("admin.saDisableConfirmTitle")
                              : t("admin.saEnableConfirmTitle")
                          }
                          confirmBody={
                            <>
                              {account.enabled
                                ? t("admin.saDisableConfirmBody")
                                : t("admin.saEnableConfirmBody")}
                              {drained.length > 0 ? (
                                <p className="confirm-warning">
                                  {t("admin.saDrainWarn", {
                                    mounts: drained.map(mountLabel).join(", "),
                                  })}
                                </p>
                              ) : null}
                            </>
                          }
                          confirmLabel={
                            account.enabled
                              ? t("admin.saDisable")
                              : t("admin.saEnable")
                          }
                          busy={busy}
                          danger={account.enabled}
                          onConfirm={() => void toggleOne(account)}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="sa-pager">
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={page <= 1}
              onClick={() => patchFilter({ page: page - 1 })}
            >
              {t("admin.saPagePrev")}
            </button>
            <span className="sa-pager-info">
              {t("admin.saPageInfo", { page, pages: pageCount })} ·{" "}
              {t("admin.saPageTotal", { count: filtered.length })}
            </span>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={page >= pageCount}
              onClick={() => patchFilter({ page: page + 1 })}
            >
              {t("admin.saPageNext")}
            </button>
          </div>
        </>
      )}

      <form className="admin-form" onSubmit={onSubmit}>
        <h3>{t("admin.saImportTitle")}</h3>
        <div
          className={`sa-dropzone${dragging ? " sa-dropzone-active" : ""}`}
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
        >
          <p className="hint">{t("admin.saDropzone")}</p>
          <input
            ref={fileInputRef}
            type="file"
            id="sa-key-files"
            className="input"
            accept=".json,application/json"
            multiple
            disabled={importing !== null}
            onChange={onFileInput}
          />
        </div>
        {importing !== null ? (
          <p role="status">
            {t("admin.saImportingFiles", {
              done: importing.done,
              total: importing.total,
            })}
          </p>
        ) : null}
        {fileResults.length > 0 ? (
          <ul className="sa-file-results">
            {fileResults.map((result, index) => (
              <li key={`${result.name}-${index}`}>
                <span className="detail-mono">{result.name}</span>{" "}
                <span
                  className={
                    result.outcome === "error" ||
                    result.outcome === "too_large" ||
                    result.outcome === "conflict" ||
                    result.outcome === "duplicate"
                      ? "badge badge-warn"
                      : "badge badge-ok"
                  }
                >
                  {fileOutcomeText(result.outcome)}
                </span>{" "}
                {result.outcome === "conflict" && result.file !== undefined ? (
                  <ConfirmAction
                    label={t("admin.saRotateKey")}
                    confirmTitle={t("admin.saRotateConfirmTitle")}
                    confirmBody={t("admin.saRotateConfirmBody")}
                    confirmLabel={t("admin.saRotateKey")}
                    busy={rotating === index}
                    disabled={rotating !== null || importing !== null}
                    danger
                    onConfirm={() => void rotateFile(index)}
                  />
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
        <div className="field">
          <label htmlFor="sa-key-json">{t("admin.saKeyLabel")}</label>
          <textarea
            id="sa-key-json"
            className="input input-secret"
            rows={4}
            value={keyJson}
            onChange={(event) => setKeyJson(event.target.value)}
            autoComplete="off"
            spellCheck={false}
            required
          />
          <p className="hint">{t("admin.saKeyHint")}</p>
        </div>
        <button
          type="submit"
          className="btn btn-primary"
          disabled={submit === "submitting" || keyJson.trim() === ""}
        >
          {submit === "submitting" ? t("common.working") : t("admin.importSubmit")}
        </button>
        {submit === "done" ? (
          importOutcome === "conflict" ? (
            <p className="alert alert-error" role="alert">
              {t("admin.saFileConflict")}{" "}
              <ConfirmAction
                label={t("admin.saRotateKey")}
                confirmTitle={t("admin.saRotateConfirmTitle")}
                confirmBody={t("admin.saRotateConfirmBody")}
                confirmLabel={t("admin.saRotateKey")}
                danger
                onConfirm={() => submitKeyJson(keyJson, true)}
              />
            </p>
          ) : (
            <p className="alert alert-success" role="status">
              {importOutcome === "duplicate"
                ? t("admin.saFileDuplicate")
                : importOutcome === "rotated"
                  ? t("admin.saFileRotated")
                  : t("admin.importDone")}
            </p>
          )
        ) : null}
        {typeof submit === "object" ? (
          <p className="alert alert-error" role="alert">
            {t(messageKeyForError(submit.error).key)}
          </p>
        ) : null}
      </form>
    </section>
  );
}
