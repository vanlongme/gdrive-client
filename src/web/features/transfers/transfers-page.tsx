import { useEffect, useRef, useState } from "react";
import { formatBytes } from "../../lib/format";
import { useI18n } from "../../lib/i18n";
import { useDocumentTitle } from "../../lib/site";
import { FolderBatchCard } from "./transfer-folder-item";
import { TransferItem } from "./transfer-item";
import { getUploadManager } from "./upload-runtime";
import type { TransferItemView } from "./upload-manager";
import type { FolderBatchState } from "./folder-upload";
import { useFolderBatches, useTransferSnapshot } from "./use-transfers";
import "./transfers.css";

/**
 * Transfers area (spec section 11.2): the full view of the same singleton
 * UploadManager queue the drawer shows. States distinguish preparing /
 * sending / confirming / paused / needs-reselect / completed / error, and
 * "uploaded but unreadable by the app" is a reader-access note on a
 * completed upload, never an upload failure.
 */

const ACTIVE_STATES: ReadonlySet<TransferItemView["state"]> = new Set([
  "queued",
  "preparing",
  "sending",
  "confirming",
]);
const ATTENTION_STATES: ReadonlySet<TransferItemView["state"]> = new Set([
  "needs-reselect",
  "error",
]);
const RUNNING_BATCH_STATES: ReadonlySet<FolderBatchState> = new Set([
  "planning",
  "sealing",
  "executing",
]);
const ATTENTION_BATCH_STATES: ReadonlySet<FolderBatchState> = new Set([
  "needs-reselect",
  "digest-mismatch",
  "failed",
]);

function sentBytesTotal(items: TransferItemView[]): bigint {
  let sum = 0n;
  for (const item of items) {
    if (!ACTIVE_STATES.has(item.state)) continue;
    try {
      sum += BigInt(item.sentBytes);
    } catch {
      // A malformed byte string must not break the meter; skip the item.
    }
  }
  return sum;
}

/**
 * Smoothed sent-bytes rate (B/s), sampled from the live queue once per
 * second while anything is active. Presentation only — the canonical
 * progress stays the confirmed offset on each item.
 */
function useTransferRate(active: boolean): number {
  const [rate, setRate] = useState(0);
  const last = useRef<{ at: number; bytes: bigint } | null>(null);
  useEffect(() => {
    if (!active) {
      last.current = null;
      setRate(0);
      return;
    }
    const timer = window.setInterval(() => {
      const bytes = sentBytesTotal(getUploadManager().getSnapshot().items);
      const now = Date.now();
      const prev = last.current;
      last.current = { at: now, bytes };
      if (prev === null) return;
      const dt = (now - prev.at) / 1000;
      const instant = dt > 0 ? Number(bytes - prev.bytes) / dt : 0;
      setRate((r) => Math.max(0, instant) * 0.5 + r * 0.5);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  return rate;
}

export function TransfersPage() {
  const { t, locale } = useI18n();
  useDocumentTitle(t("nav.transfers"));
  const snapshot = useTransferSnapshot();
  const batches = useFolderBatches();

  const running =
    snapshot.activeCount +
    batches.filter((b) => RUNNING_BATCH_STATES.has(b.state)).length;
  const queued = snapshot.items.filter((i) => i.state === "queued").length;
  const attention =
    snapshot.items.filter((i) => ATTENTION_STATES.has(i.state)).length +
    batches.filter((b) => ATTENTION_BATCH_STATES.has(b.state)).length;
  const rate = useTransferRate(running > 0);
  const hasItems = snapshot.items.length > 0 || batches.length > 0;

  return (
    <>
      <header className="page-header">
        <h1>{t("transfers.title")}</h1>
      </header>
      {!hasItems ? (
        <section className="card empty-state">
          <h2>{t("transfers.emptyTitle")}</h2>
          <p>{t("transfers.emptyBody")}</p>
        </section>
      ) : (
        <>
          <section
            className="transfer-stats"
            aria-label={t("transfers.statsTitle")}
          >
            <div className="transfer-stat">
              <span className="overline">{t("transfers.statsRunning")}</span>
              <span className="stat-value">{running}</span>
            </div>
            <div className="transfer-stat">
              <span className="overline">{t("transfers.statsSpeed")}</span>
              <span className="stat-value mono">
                {rate > 0
                  ? `${formatBytes(String(Math.round(rate)), locale)}/s`
                  : "—"}
              </span>
            </div>
            <div className="transfer-stat">
              <span className="overline">{t("transfers.statsQueued")}</span>
              <span className="stat-value">{queued}</span>
            </div>
            <div className="transfer-stat">
              <span className="overline">{t("transfers.statsAttention")}</span>
              <span className="stat-value">{attention}</span>
            </div>
          </section>
          <ul className="transfer-list">
            {batches.map((batch) => (
              <FolderBatchCard key={batch.id} batch={batch} />
            ))}
            {snapshot.items.map((item) => (
              <TransferItem key={item.id} item={item} />
            ))}
          </ul>
        </>
      )}
    </>
  );
}
