import { useRef } from "react";
import { useI18n, type MessagePath } from "../../lib/i18n";
import { getFolderUploader } from "./folder-runtime";
import type { FolderBatchItem, FolderBatchState } from "./folder-upload";
import type { FolderUploadFileInput } from "./folder-upload";
import type { BatchNodeView } from "../../../shared/contracts/uploads";

/**
 * Folder-upload batch card (T10): tree progress per node (indented by depth,
 * IDs identify — display names never keys), retry on failed nodes with a new
 * idempotency key, needs-reselect after reload, digest-mismatch refusal. No
 * automatic cleanup: completed siblings stay completed; terminal batches are
 * removed explicitly.
 */

const BATCH_STATE_BADGE: Record<FolderBatchState, string> = {
  planning: "badge-muted",
  sealing: "badge-muted",
  executing: "badge-accent",
  "needs-reselect": "badge-warning",
  "digest-mismatch": "badge-error",
  completed: "badge-success",
  failed: "badge-error",
};

const NODE_STATE_BADGE: Record<BatchNodeView["state"], string> = {
  pending: "badge-muted",
  in_progress: "badge-accent",
  completed: "badge-success",
  failed: "badge-error",
  cancelled: "badge-muted",
};

const BATCH_STATE_LABEL: Record<FolderBatchState, MessagePath> = {
  planning: "transfers.folderPlanning",
  sealing: "transfers.folderSealing",
  executing: "transfers.folderExecuting",
  "needs-reselect": "transfers.folderNeedsReselect",
  "digest-mismatch": "transfers.folderDigestMismatchState",
  completed: "transfers.stateCompleted",
  failed: "transfers.stateError",
};

const NODE_STATE_LABEL: Record<BatchNodeView["state"], MessagePath> = {
  pending: "transfers.nodePending",
  in_progress: "transfers.nodeInProgress",
  completed: "transfers.stateCompleted",
  failed: "transfers.stateError",
  cancelled: "transfers.stateCancelled",
};

export function FolderBatchCard({ batch }: { batch: FolderBatchItem }) {
  const { t } = useI18n();
  const uploader = getFolderUploader();
  const reselectRef = useRef<HTMLInputElement>(null);
  const done = batch.nodes.filter((n) => n.state === "completed").length;
  const failed = batch.nodes.filter((n) => n.state === "failed").length;
  const terminal =
    batch.state === "completed" ||
    batch.state === "failed" ||
    batch.state === "digest-mismatch";

  return (
    <li className="transfer-item transfer-folder" data-testid="folder-batch">
      <div className="transfer-row">
        <span className="transfer-name" title={batch.rootName}>
          {batch.rootName}
        </span>
        <span
          className={`badge ${BATCH_STATE_BADGE[batch.state]}`}
          data-testid="folder-batch-state"
        >
          {t(BATCH_STATE_LABEL[batch.state])}
        </span>
      </div>
      <p className="transfer-progress-text">
        {t("transfers.folderProgress", {
          done,
          total: batch.nodes.length,
          failed,
        })}
      </p>
      {batch.state === "digest-mismatch" ? (
        <p className="alert alert-error" role="alert">
          {t("transfers.folderDigestMismatch")}
        </p>
      ) : null}
      {batch.error !== null ? (
        <p className="alert alert-error" role="alert">
          {t("transfers.folderFailedDetail", { message: batch.error })}
        </p>
      ) : null}
      {batch.nodes.length > 0 ? (
        <ul className="folder-node-list">
          {batch.nodes.map((node) => (
            <li
              key={node.nodeId}
              className="folder-node"
              style={{ paddingInlineStart: `${node.depth * 16 + 4}px` }}
            >
              <span className="folder-node-icon" aria-hidden="true">
                {node.kind === "folder" ? "📁" : "📄"}
              </span>
              <span className="folder-node-name">{node.displayName}</span>
              <span className={`badge badge-sm ${NODE_STATE_BADGE[node.state]}`}>
                {t(NODE_STATE_LABEL[node.state])}
              </span>
              {node.state === "failed" ? (
                <button
                  type="button"
                  className="btn btn-ghost btn-xs"
                  onClick={() => void uploader.retryNode(batch.id, node.nodeId)}
                >
                  {t("transfers.retryNode")}
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      <div className="transfer-actions">
        {batch.state === "needs-reselect" ||
        batch.state === "digest-mismatch" ? (
          <>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => reselectRef.current?.click()}
            >
              {t("transfers.reselectFolder")}
            </button>
            <input
              ref={reselectRef}
              type="file"
              {...{ webkitdirectory: "" }}
              className="visually-hidden"
              data-testid="folder-reselect-input"
              aria-label={t("transfers.reselectFolder")}
              onChange={(event) => {
                // Build entries BEFORE clearing value — input.files is a
                // live FileList emptied by the reset.
                const entries: FolderUploadFileInput[] = [
                  ...(event.target.files ?? []),
                ].map((f) => ({
                  path:
                    f.webkitRelativePath !== undefined &&
                    f.webkitRelativePath !== ""
                      ? f.webkitRelativePath
                      : f.name,
                  file: f,
                }));
                event.target.value = "";
                if (entries.length === 0) return;
                void uploader.resumeWithFiles(batch.id, entries);
              }}
            />
          </>
        ) : null}
        {terminal ? (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => uploader.remove(batch.id)}
          >
            {t("transfers.removeAction")}
          </button>
        ) : null}
      </div>
    </li>
  );
}
