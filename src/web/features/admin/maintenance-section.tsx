import { useCallback, useEffect, useState } from "react";
import {
  getMaintenanceStatus,
  rotationAbort,
  rotationComplete,
  rotationStart,
  rotationStep,
  rotationVerify,
  runCleanup,
  setMaintenanceMode,
  type CleanupResultView,
  type RotationCompleteView,
  type RotationStatusView,
  type RotationStepView,
  type RotationVerifyView,
} from "../../lib/admin-api";
import { ApiClientError } from "../../lib/api";
import { messageKeyForError } from "../../lib/error-message";
import { useI18n } from "../../lib/i18n";
import type { MessagePath } from "../../lib/i18n";
import { ConfirmAction } from "../../components/confirm-action";
import "./admin-ops.css";

/**
 * Operations tab (T14): maintenance mode, retention cleanup and the
 * master-key rotation stepper. Every mutation sits behind an explicit
 * ConfirmAction panel that explains real impact — nothing fires on render;
 * only GET /status runs automatically. Recovery-token claim is deliberately
 * absent (owner runbook only, per the wave contract).
 */

type LoadState<T> =
  | { status: "loading" }
  | { status: "error"; error: unknown }
  | { status: "ready"; value: T };

type BusyAction =
  | "mode"
  | "cleanup"
  | "rotation-start"
  | "rotation-step"
  | "rotation-verify"
  | "rotation-complete"
  | "rotation-abort";

const PHASE_ORDER = [
  "idle",
  "reencrypting",
  "verifying",
  "verified",
  "done",
] as const;

function ErrorBlock({ error, hint }: { error: unknown; hint?: string }) {
  const { t } = useI18n();
  return (
    <>
      <p className="alert alert-error" role="alert">
        {t(messageKeyForError(error).key)}
      </p>
      {hint !== undefined ? (
        <p className="alert alert-info admin-ops-hint" role="status">
          {t("adminOps.nextAction")}: {hint}
        </p>
      ) : null}
    </>
  );
}

/** Maps a rotation API failure to a concrete localized next action. */
function rotationHint(
  error: unknown,
  t: (key: MessagePath) => string,
): string | undefined {
  if (!(error instanceof ApiClientError)) return undefined;
  if (error.message.includes("APP_MASTER_KEY_NEXT")) {
    return t("adminOps.hintNextKey");
  }
  if (error.message.includes("session envelope")) {
    return t("adminOps.hintBlockedUploads");
  }
  if (error.status === 409) return t("adminOps.hintPhaseConflict");
  return undefined;
}

export function MaintenanceSection() {
  const { t } = useI18n();
  const [status, setStatus] = useState<LoadState<RotationStatusView>>({
    status: "loading",
  });
  const [busy, setBusy] = useState<BusyAction | null>(null);
  const [actionError, setActionError] = useState<unknown>(null);
  const [actionHint, setActionHint] = useState<string | undefined>();
  const [cleanupResult, setCleanupResult] =
    useState<CleanupResultView | null>(null);
  const [stepResult, setStepResult] = useState<RotationStepView | null>(null);
  const [verifyResult, setVerifyResult] =
    useState<RotationVerifyView | null>(null);
  const [completeResult, setCompleteResult] =
    useState<RotationCompleteView | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await getMaintenanceStatus();
      setStatus({ status: "ready", value: res.rotation });
    } catch (error) {
      setStatus({ status: "error", error });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const run = useCallback(
    async (action: BusyAction, fn: () => Promise<unknown>) => {
      setBusy(action);
      setActionError(null);
      setActionHint(undefined);
      try {
        await fn();
      } catch (error) {
        setActionError(error);
      } finally {
        setBusy(null);
        await load();
      }
    },
    [load],
  );

  const onSetMode = (enabled: boolean) =>
    void run("mode", async () => {
      try {
        await setMaintenanceMode(enabled);
      } catch (error) {
        if (
          !enabled &&
          error instanceof ApiClientError &&
          error.status === 409
        ) {
          setActionHint(t("adminOps.modeLiftBlocked"));
        }
        throw error;
      }
    });

  const onCleanupDryRun = () =>
    void run("cleanup", async () => {
      const res = await runCleanup(true);
      setCleanupResult(res.cleanup);
    });

  const onCleanupRun = () =>
    void run("cleanup", async () => {
      const res = await runCleanup(false);
      setCleanupResult(res.cleanup);
    });

  const onRotationStart = () =>
    void run("rotation-start", async () => {
      setStepResult(null);
      setVerifyResult(null);
      setCompleteResult(null);
      try {
        await rotationStart();
      } catch (error) {
        setActionHint(rotationHint(error, t));
        throw error;
      }
    });

  const onRotationStep = () =>
    void run("rotation-step", async () => {
      try {
        const res = await rotationStep();
        setStepResult(res.step);
      } catch (error) {
        setActionHint(rotationHint(error, t));
        throw error;
      }
    });

  const onRotationVerify = () =>
    void run("rotation-verify", async () => {
      try {
        const res = await rotationVerify();
        setVerifyResult(res.verify);
      } catch (error) {
        setActionHint(rotationHint(error, t));
        throw error;
      }
    });

  const onRotationComplete = () =>
    void run("rotation-complete", async () => {
      try {
        const res = await rotationComplete();
        setCompleteResult(res.complete);
      } catch (error) {
        setActionHint(rotationHint(error, t));
        throw error;
      }
    });

  const onRotationAbort = () =>
    void run("rotation-abort", async () => {
      try {
        await rotationAbort();
        setStepResult(null);
        setVerifyResult(null);
        setCompleteResult(null);
      } catch (error) {
        setActionHint(
          error instanceof ApiClientError && error.status === 409
            ? t("adminOps.hintAbortLate")
            : rotationHint(error, t),
        );
        throw error;
      }
    });

  if (status.status === "loading") {
    return (
      <section className="card admin-section" aria-label={t("adminOps.title")}>
        <h2>{t("adminOps.title")}</h2>
        <p role="status">{t("common.loading")}</p>
      </section>
    );
  }
  if (status.status === "error") {
    return (
      <section className="card admin-section" aria-label={t("adminOps.title")}>
        <h2>{t("adminOps.title")}</h2>
        <ErrorBlock error={status.error} />
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => void load()}
        >
          {t("common.retry")}
        </button>
      </section>
    );
  }

  const rotation = status.value;
  const rotationActive = rotation.mode === "key-rotation";
  const maintenanceOn = rotation.mode !== "off";
  const phaseIndex = PHASE_ORDER.indexOf(
    rotation.phase as (typeof PHASE_ORDER)[number],
  );

  return (
    <section className="card admin-section" aria-label={t("adminOps.title")}>
      <div className="admin-ops-head">
        <h2>{t("adminOps.title")}</h2>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => void load()}
        >
          {t("adminOps.refresh")}
        </button>
      </div>

      {actionError !== null ? (
        <ErrorBlock error={actionError} hint={actionHint} />
      ) : null}

      {rotationActive ? (
        <p className="alert alert-info" role="status">
          {t("adminOps.rotationActiveNote")}
        </p>
      ) : null}

      {/* ---- Maintenance mode ---- */}
      <h3>{t("adminOps.modeTitle")}</h3>
      <p className="admin-ops-note">{t("adminOps.modeExplain")}</p>
      <p>
        {t("adminOps.modeStatus")}:{" "}
        <span
          className={`badge ${maintenanceOn ? "badge-warn" : "badge-ok"}`}
        >
          {rotation.mode === "off"
            ? t("adminOps.mode_off")
            : rotation.mode === "drain"
              ? t("adminOps.mode_drain")
              : t("adminOps.mode_keyRotation")}
        </span>
      </p>
      {maintenanceOn ? (
        <ConfirmAction
          label={t("adminOps.modeDisable")}
          confirmTitle={t("adminOps.modeConfirmDisableTitle")}
          confirmBody={t("adminOps.modeConfirmDisableBody")}
          confirmLabel={t("adminOps.modeDisable")}
          onConfirm={() => onSetMode(false)}
          busy={busy === "mode"}
        />
      ) : (
        <ConfirmAction
          label={t("adminOps.modeEnable")}
          confirmTitle={t("adminOps.modeConfirmEnableTitle")}
          confirmBody={t("adminOps.modeConfirmEnableBody")}
          confirmLabel={t("adminOps.modeEnable")}
          onConfirm={() => onSetMode(true)}
          busy={busy === "mode"}
          danger
        />
      )}

      {/* ---- Retention cleanup ---- */}
      <h3>{t("adminOps.cleanupTitle")}</h3>
      <p className="admin-ops-note">{t("adminOps.cleanupExplain")}</p>
      <div className="admin-ops-row">
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          disabled={busy !== null}
          onClick={onCleanupDryRun}
        >
          {busy === "cleanup" ? t("common.working") : t("adminOps.cleanupDryRun")}
        </button>
        {cleanupResult !== null && cleanupResult.dryRun ? (
          <ConfirmAction
            label={t("adminOps.cleanupRun")}
            confirmTitle={t("adminOps.cleanupConfirmTitle")}
            confirmBody={t("adminOps.cleanupConfirmBody")}
            confirmLabel={t("adminOps.cleanupRun")}
            onConfirm={onCleanupRun}
            busy={busy === "cleanup"}
            danger
          />
        ) : null}
      </div>
      {cleanupResult !== null ? (
        <div className="admin-ops-result" role="status">
          <p className="admin-ops-note">
            {cleanupResult.dryRun
              ? t("adminOps.cleanupPreviewDone")
              : t("adminOps.cleanupDone")}
          </p>
          <dl className="admin-ops-grid">
            <div className="admin-ops-kv">
              <dt>{t("adminOps.cleanupAuditEligible")}</dt>
              <dd>{cleanupResult.auditEvents.eligible}</dd>
            </div>
            <div className="admin-ops-kv">
              <dt>{t("adminOps.cleanupAuditDeleted")}</dt>
              <dd>{cleanupResult.auditEvents.deleted}</dd>
            </div>
            <div className="admin-ops-kv">
              <dt>{t("adminOps.cleanupDetailEligible")}</dt>
              <dd>{cleanupResult.uploadDetails.eligible}</dd>
            </div>
            <div className="admin-ops-kv">
              <dt>{t("adminOps.cleanupDetailPurged")}</dt>
              <dd>{cleanupResult.uploadDetails.purged}</dd>
            </div>
            <div className="admin-ops-kv">
              <dt>{t("adminOps.cleanupKept")}</dt>
              <dd>{cleanupResult.uploadDetails.keptWithoutTombstone}</dd>
            </div>
          </dl>
          {cleanupResult.truncated ? (
            <p className="alert alert-info" role="status">
              {t("adminOps.cleanupTruncated")}
            </p>
          ) : null}
        </div>
      ) : null}

      {/* ---- Key rotation stepper ---- */}
      <h3>{t("adminOps.rotationTitle")}</h3>
      <p className="admin-ops-note">{t("adminOps.rotationExplain")}</p>

      <ol className="admin-ops-steps" aria-label={t("adminOps.rotationTitle")}>
        {PHASE_ORDER.map((phase, index) => {
          const state =
            rotation.phase === "failed"
              ? index <= phaseIndex
                ? "done"
                : "pending"
              : index < phaseIndex
                ? "done"
                : index === phaseIndex
                  ? "current"
                  : "pending";
          return (
            <li
              key={phase}
              className={`admin-ops-step admin-ops-step-${state}`}
              aria-current={state === "current" ? "step" : undefined}
            >
              {t(`adminOps.phase_${phase}`)}
            </li>
          );
        })}
        {rotation.phase === "failed" ? (
          <li className="admin-ops-step admin-ops-step-failed">
            {t("adminOps.phase_failed")}
          </li>
        ) : null}
      </ol>

      <dl className="admin-ops-grid">
        <div className="admin-ops-kv">
          <dt>{t("adminOps.modeStatus")}</dt>
          <dd>{rotation.mode}</dd>
        </div>
        <div className="admin-ops-kv">
          <dt>Phase</dt>
          <dd>{t(`adminOps.phase_${rotation.phase}`)}</dd>
        </div>
        <div className="admin-ops-kv">
          <dt>{t("adminOps.rotationStepProcessed")}</dt>
          <dd>{rotation.processedCount}</dd>
        </div>
        <div className="admin-ops-kv">
          <dt>{t("adminOps.rotationVerifiedCount")}</dt>
          <dd>{rotation.verifiedCount}</dd>
        </div>
        {rotation.toKeyLabel !== null ? (
          <div className="admin-ops-kv">
            <dt>→</dt>
            <dd className="detail-mono">{rotation.toKeyLabel}</dd>
          </div>
        ) : null}
      </dl>
      {Object.keys(rotation.envelopeTotals).length > 0 ? (
        <p className="admin-ops-note">
          {t("adminOps.rotationEnvelopeTotals")}:{" "}
          {Object.entries(rotation.envelopeTotals)
            .map(([source, n]) => `${source}: ${n}`)
            .join(" · ")}
        </p>
      ) : null}
      {rotation.lastError !== null ? (
        <p className="alert alert-error" role="alert">
          {rotation.lastError}
        </p>
      ) : null}

      <div className="admin-ops-row">
        {!rotationActive && rotation.phase === "idle" ? (
          <ConfirmAction
            label={t("adminOps.rotationStart")}
            confirmTitle={t("adminOps.rotationStartConfirmTitle")}
            confirmBody={t("adminOps.rotationStartConfirmBody")}
            confirmLabel={t("adminOps.rotationStart")}
            onConfirm={onRotationStart}
            busy={busy === "rotation-start"}
            danger
          />
        ) : null}
        {rotation.phase === "reencrypting" ? (
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={busy !== null}
            onClick={onRotationStep}
          >
            {busy === "rotation-step"
              ? t("common.working")
              : t("adminOps.rotationStep")}
          </button>
        ) : null}
        {rotation.phase === "verifying" || rotation.phase === "verified" ? (
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={busy !== null}
            onClick={onRotationVerify}
          >
            {busy === "rotation-verify"
              ? t("common.working")
              : t("adminOps.rotationVerify")}
          </button>
        ) : null}
        {rotation.phase === "verified" ? (
          <ConfirmAction
            label={t("adminOps.rotationComplete")}
            confirmTitle={t("adminOps.rotationCompleteConfirmTitle")}
            confirmBody={t("adminOps.rotationCompleteConfirmBody")}
            confirmLabel={t("adminOps.rotationComplete")}
            onConfirm={onRotationComplete}
            busy={busy === "rotation-complete"}
            danger
          />
        ) : null}
        {rotationActive && rotation.phase !== "done" ? (
          <ConfirmAction
            label={t("adminOps.rotationAbort")}
            confirmTitle={t("adminOps.rotationAbortConfirmTitle")}
            confirmBody={
              <>
                {t("adminOps.rotationAbortConfirmBody")}{" "}
                <em>{t("adminOps.abortHint")}</em>
              </>
            }
            confirmLabel={t("adminOps.rotationAbort")}
            onConfirm={onRotationAbort}
            busy={busy === "rotation-abort"}
            danger
          />
        ) : null}
      </div>

      {stepResult !== null ? (
        <p className="admin-ops-note" role="status">
          {stepResult.processed} {t("adminOps.rotationStepProcessed")}
          {stepResult.source !== null ? ` (${stepResult.source})` : ""} —{" "}
          {stepResult.remaining
            ? t("adminOps.rotationStepRemaining")
            : t("adminOps.rotationStepDone")}
        </p>
      ) : null}

      {verifyResult !== null ? (
        <div className="admin-ops-result" role="status">
          {verifyResult.ok && verifyResult.failed === 0 ? (
            <p className="alert alert-success">
              {t("adminOps.rotationVerifyOk")}
            </p>
          ) : (
            <p className="alert alert-error" role="alert">
              {t("adminOps.rotationVerifyFailed")}{" "}
              {t("adminOps.hintVerifyRetry")}
            </p>
          )}
          <p className="admin-ops-note">
            {verifyResult.verified} {t("adminOps.rotationVerifiedCount")} ·{" "}
            {verifyResult.failed} {t("adminOps.rotationFailedCount")}
          </p>
          {Object.entries(verifyResult.failures).map(([source, ids]) =>
            ids.length > 0 ? (
              <p key={source} className="admin-ops-note">
                {source}: {ids.length} {t("adminOps.rotationFailedCount")}
              </p>
            ) : null,
          )}
        </div>
      ) : null}

      {completeResult !== null ? (
        <div className="admin-ops-result" role="status">
          <p className="alert alert-success">
            {t("adminOps.phase_done")} — {completeResult.sessionsRevoked}{" "}
            {t("adminOps.rotationSessionsRevoked")}
          </p>
          <p className="alert alert-info" role="status">
            {t("adminOps.rotationCompleteNext")}
          </p>
        </div>
      ) : null}
    </section>
  );
}
