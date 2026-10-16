import { useI18n } from "../../lib/i18n";
import { FolderBatchCard } from "./transfer-folder-item";
import { TransferItem } from "./transfer-item";
import { useFolderBatches, useTransferSnapshot } from "./use-transfers";
import "./transfers.css";

/**
 * Transfers area (spec section 11.2): the full view of the same singleton
 * UploadManager queue the drawer shows. States distinguish preparing /
 * sending / confirming / paused / needs-reselect / completed / error, and
 * "uploaded but unreadable by the app" is a reader-access note on a
 * completed upload, never an upload failure.
 */
export function TransfersPage() {
  const { t } = useI18n();
  const snapshot = useTransferSnapshot();
  const batches = useFolderBatches();

  return (
    <>
      <header className="page-header">
        <h1>{t("transfers.title")}</h1>
      </header>
      {snapshot.items.length === 0 && batches.length === 0 ? (
        <section className="card empty-state">
          <h2>{t("transfers.emptyTitle")}</h2>
          <p>{t("transfers.emptyBody")}</p>
        </section>
      ) : (
        <ul className="transfer-list">
          {batches.map((batch) => (
            <FolderBatchCard key={batch.id} batch={batch} />
          ))}
          {snapshot.items.map((item) => (
            <TransferItem key={item.id} item={item} />
          ))}
        </ul>
      )}
    </>
  );
}
