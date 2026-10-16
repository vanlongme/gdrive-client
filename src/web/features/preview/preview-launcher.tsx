import { useState } from "react";
import type {
  DriveFileEntry,
  FileDetail,
} from "../../../shared/contracts";
import { useI18n } from "../../lib/i18n";
import { PreviewDialog } from "./preview-dialog";

/**
 * Explorer integration slot for the preview feature (T12). The Explorer file
 * panel renders this next to the download action; the button opens the modal
 * preview dialog. `siblings` is the current folder listing — when provided,
 * the dialog offers previous/next navigation across its files.
 */
export function PreviewLauncher({
  mountId,
  file,
  siblings,
}: {
  mountId: string;
  file: FileDetail;
  siblings?: readonly DriveFileEntry[];
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  if (file.kind !== "file") return null;
  return (
    <>
      <button
        type="button"
        className="btn btn-ghost"
        onClick={() => setOpen(true)}
      >
        {t("preview.open")}
      </button>
      {open ? (
        <PreviewDialog
          mountId={mountId}
          initialFile={file}
          siblings={siblings}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}
