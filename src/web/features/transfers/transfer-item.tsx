import { useRef } from "react";
import { formatBytes } from "../../lib/format";
import { useI18n, type MessagePath } from "../../lib/i18n";
import { getUploadManager } from "./upload-runtime";
import { useReselectFile } from "./use-transfers";
import type { TransferItemView } from "./upload-manager";
import "./transfers.css";

/**
 * One transfer row, shared by the persistent drawer and the /transfers page.
 * Progress shows confirmed (server-canonical) bytes solid and sent-but-
 * unconfirmed bytes lighter — never presented as stored data (spec 6.4).
 */

const STATE_KEYS: Record<TransferItemView["state"], MessagePath> = {
  queued: "transfers.stateQueued",
  preparing: "transfers.statePreparing",
  sending: "transfers.stateSending",
  confirming: "transfers.stateConfirming",
  paused: "transfers.statePaused",
  "needs-reselect": "transfers.stateReselect",
  completed: "transfers.stateCompleted",
  cancelled: "transfers.stateCancelled",
  error: "transfers.stateError",
};

function percent(done: string, total: string): number {
  try {
    const t = BigInt(total);
    if (t <= 0n) return 100;
    return Number((BigInt(done) * 100n) / t);
  } catch {
    return 0;
  }
}

export function TransferItem({ item }: { item: TransferItemView }) {
  const { t, locale } = useI18n();
  const manager = getUploadManager();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const reselect = useReselectFile(item, fileInputRef);

  const confirmedPct = percent(item.confirmedBytes, item.totalBytes);
  const sentPct = percent(item.sentBytes, item.totalBytes);
  const active =
    item.state === "queued" ||
    item.state === "preparing" ||
    item.state === "sending" ||
    item.state === "confirming";

  return (
    <li className="transfer-item" data-state={item.state}>
      <div className="transfer-item-head">
        <span className="transfer-name">{item.name}</span>
        <span className="badge">{t(STATE_KEYS[item.state])}</span>
      </div>
      <div
        className="transfer-progress"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={confirmedPct}
        aria-label={t("transfers.progressLabel", { name: item.name })}
      >
        <span className="fill-sent" style={{ width: `${sentPct}%` }} />
        <span
          className="fill-confirmed"
          style={{ width: `${confirmedPct}%` }}
        />
      </div>
      <div className="transfer-meta">
        {item.state === "preparing"
          ? t("transfers.preparedBytes", {
              done: formatBytes(item.preparedBytes, locale),
              total: formatBytes(item.totalBytes, locale),
            })
          : t("transfers.confirmedBytes", {
              confirmed: formatBytes(item.confirmedBytes, locale),
              total: formatBytes(item.totalBytes, locale),
            })}
      </div>
      {item.state === "completed" &&
      (item.readerAccessState === "blocked" ||
        item.readerAccessState === "unchecked" ||
        item.readerAccessState === "pending") ? (
        <p className="transfer-note" role="status">
          {item.readerAccessState === "blocked"
            ? t("transfers.readerUnavailable")
            : t("transfers.readerChecking")}
        </p>
      ) : null}
      {item.state === "needs-reselect" ? (
        <p className="transfer-note">{t("transfers.reselectHelp")}</p>
      ) : null}
      {item.error !== null ? (
        <p className="transfer-error" role="alert">
          {item.error.code === "RESELECT_MISMATCH"
            ? t("transfers.reselectMismatch")
            : item.blockReason === "upload:quota_exceeded"
              ? t("errors.uploadQuotaExceeded")
              : item.error.message}
          {item.error.requestId !== undefined
            ? ` (${t("common.requestId")}: ${item.error.requestId})`
            : ""}
        </p>
      ) : null}
      <div className="transfer-actions">
        {item.state === "needs-reselect" ? (
          <>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => void reselect()}
            >
              {t("transfers.reselectAction")}
            </button>
            <input
              ref={fileInputRef}
              type="file"
              className="visually-hidden"
              data-testid="reselect-input"
              aria-label={t("transfers.reselectAction")}
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (file !== undefined) manager.resume(item.id, file);
              }}
            />
          </>
        ) : null}
        {active ? (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => manager.pause(item.id)}
          >
            {t("transfers.pause")}
          </button>
        ) : null}
        {item.state === "paused" ||
        (item.state === "error" && item.hasFile) ? (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => manager.resume(item.id)}
          >
            {t("transfers.resume")}
          </button>
        ) : null}
        {item.state === "error" && !item.hasFile ? (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => void reselect()}
          >
            {t("transfers.reselectAction")}
          </button>
        ) : null}
        {active || item.state === "paused" ? (
          <button
            type="button"
            className="btn btn-danger btn-sm"
            onClick={() => manager.cancel(item.id)}
          >
            {t("transfers.cancel")}
          </button>
        ) : null}
        {item.state === "completed" ||
        item.state === "cancelled" ||
        item.state === "error" ||
        item.state === "needs-reselect" ? (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => manager.remove(item.id)}
          >
            {t("transfers.remove")}
          </button>
        ) : null}
      </div>
    </li>
  );
}
