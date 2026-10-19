import { useCallback, useEffect, useRef, useState } from "react";
import {
  probeReadGrant,
  syncReadGrants,
  type MountAdminView,
  type ProbeReadGrantResult,
  type ReadGrantRow,
  type SyncReadGrantsResponse,
} from "../../lib/admin-api";
import { messageKeyForError } from "../../lib/error-message";
import { useI18n } from "../../lib/i18n";
import type { MessagePath } from "../../lib/i18n";
import { runSyncLoop, waitSeconds } from "../../lib/read-grant-sync";
import "./admin-ops.css";

/**
 * "Pool read access N/M" for My Drive folder mounts (spec sections 5 and 7):
 * drives the resumable sync, shows per-SA failures from the last response and
 * offers a per-SA visibility probe (an SA metadata read). Only stable codes
 * and SA e-mail addresses are rendered.
 */
type Phase =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "done" }
  | { kind: "stalled" }
  | { kind: "error"; error: unknown };

type ProbeState =
  | { kind: "checking" }
  | { kind: "result"; result: ProbeReadGrantResult }
  | { kind: "error"; error: unknown };

const STATE_KEYS: Record<ReadGrantRow["state"], MessagePath> = {
  pending: "admin.grantStatePending",
  granted: "admin.grantStateGranted",
  revoking: "admin.grantStateRevoking",
  failed: "admin.grantStateFailed",
};

const ERROR_KEYS: Record<string, MessagePath> = {
  "grant:rate_limited": "admin.grantErrRateLimited",
  "grant:forbidden": "admin.grantErrForbidden",
  "grant:not_found": "admin.grantErrNotFound",
  "grant:invalid_principal": "admin.grantErrInvalidPrincipal",
  "grant:upstream": "admin.grantErrUpstream",
  "grant:not_visible": "admin.grantErrNotVisible",
};

export function ReadGrantsPanel({
  mount,
  autoSyncNonce,
  onAutoSyncConsumed,
  onChanged,
}: {
  mount: MountAdminView;
  autoSyncNonce: number;
  onAutoSyncConsumed: () => void;
  onChanged: () => void;
}) {
  const { t } = useI18n();
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [last, setLast] = useState<SyncReadGrantsResponse | null>(null);
  const [waiting, setWaiting] = useState(0);
  const [probes, setProbes] = useState<Record<string, ProbeState>>({});
  const abortRef = useRef<AbortController | null>(null);

  const emailOf = (id: string) =>
    mount.readPool.find((sa) => sa.id === id)?.email ?? id;

  const start = useCallback(() => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setPhase({ kind: "running" });
    setWaiting(0);
    void runSyncLoop({
      signal: controller.signal,
      call: (signal) => syncReadGrants(mount.id, signal),
      wait: (seconds, signal) => waitSeconds(seconds, setWaiting, signal),
      onStep: (result) => {
        setLast(result);
        if (result.retryAfterSeconds === undefined) setWaiting(0);
      },
    })
      .then((outcome) => {
        if (outcome === "aborted") return;
        setWaiting(0);
        setPhase({ kind: outcome });
        onChanged();
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setWaiting(0);
        setPhase({ kind: "error", error });
        onChanged();
      });
  }, [mount.id, onChanged]);

  const cancel = () => {
    abortRef.current?.abort();
    setWaiting(0);
    setPhase({ kind: "idle" });
    onChanged();
  };

  // Unmount-only: navigating away cancels the loop and its countdown.
  useEffect(() => () => abortRef.current?.abort(), []);

  // Parent-requested sync (after create / read-pool save). No cleanup: the
  // parent clears the nonce right after, which must not abort this sync.
  useEffect(() => {
    if (autoSyncNonce === 0) return;
    start();
    onAutoSyncConsumed();
  }, [autoSyncNonce]);

  const probe = (serviceAccountId: string) => {
    const set = (state: ProbeState) =>
      setProbes((prev) => ({ ...prev, [serviceAccountId]: state }));
    set({ kind: "checking" });
    void probeReadGrant(mount.id, serviceAccountId)
      .then((res) => set({ kind: "result", result: res.result }))
      .catch((error: unknown) => set({ kind: "error", error }));
  };

  const ready = last?.ready ?? mount.readGrants?.ready ?? 0;
  const total = last?.total ?? mount.readGrants?.total ?? mount.readPool.length;
  const running = phase.kind === "running";
  const failures = (last?.grants ?? []).filter(
    (row) => row.state === "failed" || (row.errorCode ?? "") !== "",
  );
  const phaseError =
    phase.kind === "error" ? messageKeyForError(phase.error) : null;

  return (
    <div className="admin-subsection read-grants">
      <h3>{t("admin.readGrantsTitle")}</h3>
      <p className="hint">{t("admin.readGrantsIntro")}</p>
      <p role="status" data-testid="read-grants-summary">
        {t("admin.readGrantsSummary", { ready, total })}
      </p>
      <progress
        className="read-grants-progress"
        max={Math.max(total, 1)}
        value={ready}
        aria-label={t("admin.readGrantsTitle")}
      />
      {total === 0 && mount.readPool.length === 0 ? (
        <p className="hint">{t("admin.readGrantsNoPool")}</p>
      ) : null}

      <div className="entry-actions">
        <button
          type="button"
          className="btn btn-primary btn-sm"
          disabled={running}
          onClick={start}
        >
          {running ? t("admin.readGrantsSyncing") : t("admin.readGrantsSync")}
        </button>
        {running ? (
          <button type="button" className="btn btn-ghost btn-sm" onClick={cancel}>
            {t("common.cancel")}
          </button>
        ) : null}
      </div>

      {running && last !== null ? (
        <p role="status">
          {t("admin.readGrantsRemaining", { remaining: last.remaining })}
          {waiting > 0
            ? ` ${t("admin.readGrantsWaiting", { seconds: waiting })}`
            : ""}
        </p>
      ) : null}
      {phase.kind === "done" ? (
        <p className="alert alert-success" role="status">
          {t("admin.readGrantsDone")}
        </p>
      ) : null}
      {phase.kind === "stalled" ? (
        <p className="alert alert-info" role="status">
          {t("admin.readGrantsStalled")}
        </p>
      ) : null}
      {phaseError !== null ? (
        <p className="alert alert-error" role="alert">
          {t(phaseError.key, { seconds: phaseError.retryAfterSeconds ?? 0 })}
          {phaseError.requestId !== undefined
            ? ` (${phaseError.requestId})`
            : ""}
        </p>
      ) : null}

      {failures.length > 0 ? (
        <>
          <h4>{t("admin.readGrantsFailuresTitle")}</h4>
          <ul className="read-grants-failures">
            {failures.map((row) => (
              <li key={row.serviceAccountId}>
                <span className="detail-mono">
                  {emailOf(row.serviceAccountId)}
                </span>{" "}
                <span className="badge badge-warn">
                  {t(STATE_KEYS[row.state])}
                </span>{" "}
                {row.errorCode
                  ? t(ERROR_KEYS[row.errorCode] ?? "admin.grantErrUnknown")
                  : null}
              </li>
            ))}
          </ul>
        </>
      ) : null}

      <details>
        <summary>{t("admin.readGrantsChecksTitle")}</summary>
        <ul className="drive-list">
          {mount.readPool.map((sa) => {
            const row = last?.grants.find(
              (grant) => grant.serviceAccountId === sa.id,
            );
            const state = probes[sa.id];
            return (
              <li key={sa.id} className="drive-row">
                <span className="detail-mono">{sa.email}</span>
                {row !== undefined ? (
                  <span className="badge">{t(STATE_KEYS[row.state])}</span>
                ) : null}
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  disabled={state?.kind === "checking"}
                  onClick={() => probe(sa.id)}
                >
                  {state?.kind === "checking"
                    ? t("admin.readGrantsChecking")
                    : t("admin.readGrantsCheck")}
                </button>
                {state?.kind === "result" ? (
                  <span role="status">
                    {state.result === "ok"
                      ? t("admin.readGrantsProbeOk")
                      : t("admin.readGrantsProbeNotVisible")}
                  </span>
                ) : null}
                {state?.kind === "error" ? (
                  <span role="alert">
                    {t(messageKeyForError(state.error).key)}
                  </span>
                ) : null}
              </li>
            );
          })}
        </ul>
      </details>
    </div>
  );
}
