import type { FileDetail } from "../../../shared/contracts/drive";

/** Common contract every lazily-loaded viewer component receives. */
export interface ViewerProps {
  mountId: string;
  file: FileDetail;
  /** Same-origin SA content or Workspace export URL. */
  sourceUrl: string;
  /** Download URL for the raw file (content route, attachment). */
  downloadUrl: string;
  /** Aborted when the dialog closes or navigates to a sibling. */
  signal: AbortSignal;
}
