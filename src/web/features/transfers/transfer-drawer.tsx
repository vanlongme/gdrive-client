import { useState } from "react";
import { Link } from "react-router";
import { useI18n } from "../../lib/i18n";
import { MinusIcon, PlusIcon } from "../../components/icons";
import { FolderBatchCard } from "./transfer-folder-item";
import { TransferItem } from "./transfer-item";
import { useFolderBatches, useTransferSnapshot } from "./use-transfers";
import "./transfers.css";

/**
 * Persistent transfer drawer (spec section 11.2): rendered once inside the
 * authenticated AppShell, outside every route, so navigating or closing a
 * preview never cancels queued work. Collapses to a small status pill.
 */
export function TransferDrawer() {
  const { t } = useI18n();
  const snapshot = useTransferSnapshot();
  const batches = useFolderBatches();
  const [open, setOpen] = useState(true);

  if (snapshot.items.length === 0 && batches.length === 0) return null;

  return (
    <section
      className="transfer-drawer"
      aria-label={t("transfers.drawerTitle")}
      data-testid="transfer-drawer"
    >
      <div className="transfer-drawer-head">
        <h2>
          {t("transfers.drawerTitle")}
          {snapshot.activeCount > 0
            ? ` (${t("transfers.activeCount", { count: snapshot.activeCount })})`
            : ""}
        </h2>
        {open ? (
          <Link className="btn btn-ghost btn-sm" to="/transfers">
            {t("transfers.openPage")}
          </Link>
        ) : null}
        <button
          type="button"
          className="btn-icon"
          aria-expanded={open}
          aria-label={
            open ? t("transfers.collapse") : t("transfers.expand")
          }
          onClick={() => setOpen((prev) => !prev)}
        >
          {open ? <MinusIcon /> : <PlusIcon />}
        </button>
      </div>
      {open ? (
        <div className="transfer-drawer-body">
          <ul className="transfer-list">
            {batches.map((batch) => (
              <FolderBatchCard key={batch.id} batch={batch} />
            ))}
            {snapshot.items.map((item) => (
              <TransferItem key={item.id} item={item} />
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
