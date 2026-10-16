import {
  Component,
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";
import type {
  DriveFileEntry,
  FileDetail,
} from "../../../shared/contracts/drive";
import { contentUrl, getFileDetail } from "../../lib/api";
import { useI18n } from "../../lib/i18n";
import {
  previewSourceUrl,
  workspaceExportUrl,
} from "./content-source";
import { resolvePreviewPlan } from "./registry";
import { ViewerError } from "./viewer-error";
import type { ViewerProps } from "./viewer-types";
import "./preview.css";

const LazyViewers = {
  image: lazy(() => import("./viewers/image-viewer")),
  media: lazy(() => import("./viewers/media-viewer")),
  pdf: lazy(() => import("./viewers/pdf-viewer")),
  text: lazy(() => import("./viewers/text-viewer")),
  markdown: lazy(() => import("./viewers/markdown-viewer")),
  hls: lazy(() => import("./viewers/hls-viewer")),
  unsupported: lazy(() => import("./viewers/unsupported-viewer")),
} as const;

/** Error boundary: a crashing viewer falls back to metadata + download. */
class ViewerBoundary extends Component<
  {
    resetKey: string;
    fallback: (error: unknown) => ReactNode;
    children: ReactNode;
  },
  { error: unknown | null }
> {
  state = { error: null as unknown | null };

  static getDerivedStateFromError(error: unknown) {
    return { error };
  }

  componentDidUpdate(prev: { resetKey: string }) {
    if (prev.resetKey !== this.props.resetKey && this.state.error !== null) {
      this.setState({ error: null });
    }
  }

  render() {
    if (this.state.error !== null) return this.props.fallback(this.state.error);
    return this.props.children;
  }
}

/**
 * Modal preview surface (architecture §8.1, plan T12). Native <dialog> gives
 * modal semantics, Escape and focus restoration. Navigation between sibling
 * files refetches each target's FileDetail so a pinned-revision descriptor
 * is honored per file. Closing aborts every in-flight viewer request.
 */
export function PreviewDialog({
  mountId,
  initialFile,
  siblings = [],
  onClose,
}: {
  mountId: string;
  initialFile: FileDetail;
  siblings?: readonly DriveFileEntry[];
  onClose: () => void;
}) {
  const { t } = useI18n();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [target, setTarget] = useState<FileDetail>(initialFile);
  const [navState, setNavState] = useState<
    "idle" | "navigating" | { error: unknown }
  >("idle");

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog !== null && !dialog.open) dialog.showModal();
  }, []);

  // One AbortController per preview target: viewer requests, sibling
  // navigation and PDF cleanup all hang off it, and it is aborted both when
  // the target changes and when the dialog unmounts.
  const controller = useMemo(
    () => new AbortController(),
    [target.id, target.preview?.revisionId],
  );
  useEffect(() => () => controller.abort(), [controller]);

  const plan = useMemo(() => resolvePreviewPlan(target), [target]);
  const downloadUrl = useMemo(() => contentUrl(mountId, target.id), [
    mountId,
    target.id,
  ]);
  const sourceUrl = useMemo(
    () =>
      plan.source === "export-pdf"
        ? workspaceExportUrl(mountId, target.id)
        : previewSourceUrl(mountId, target, target.preview),
    [mountId, target, plan.source],
  );

  const navigable = useMemo(
    () => siblings.filter((entry) => entry.kind === "file"),
    [siblings],
  );
  const index = navigable.findIndex((entry) => entry.id === target.id);

  const navigate = (direction: 1 | -1) => {
    const entry = navigable[index + direction];
    if (entry === undefined) return;
    setNavState("navigating");
    getFileDetail(mountId, entry.id, controller.signal)
      .then((detail) => {
        setTarget(detail);
        setNavState("idle");
      })
      .catch((error: unknown) => setNavState({ error }));
  };

  const viewerProps: ViewerProps = {
    mountId,
    file: target,
    sourceUrl,
    downloadUrl,
    signal: controller.signal,
  };

  const viewer = (() => {
    switch (plan.viewer) {
      case "image":
        return <LazyViewers.image {...viewerProps} />;
      case "media":
        return (
          <LazyViewers.media {...viewerProps} mediaKind={plan.mediaKind ?? "video"} />
        );
      case "pdf":
        return (
          <LazyViewers.pdf
            {...viewerProps}
            exportFallback={plan.source === "export-pdf"}
          />
        );
      case "text":
        return (
          <LazyViewers.text
            {...viewerProps}
            textKind={plan.textKind ?? "text"}
          />
        );
      case "markdown":
        return <LazyViewers.markdown {...viewerProps} />;
      case "hls":
        return <LazyViewers.hls {...viewerProps} />;
      default:
        return (
          <LazyViewers.unsupported {...viewerProps} reason={plan.reason} />
        );
    }
  })();

  return (
    <dialog
      ref={dialogRef}
      className="preview-dialog"
      onClose={onClose}
      aria-label={t("preview.title")}
    >
      <div className="preview-shell">
        <header className="preview-header">
          <h2 className="preview-title" title={target.name}>
            {target.name}
          </h2>
          <div className="preview-header-actions">
            {index >= 0 ? (
              <>
                <button
                  type="button"
                  className="btn btn-icon"
                  aria-label={t("preview.previous")}
                  disabled={index <= 0 || navState === "navigating"}
                  onClick={() => navigate(-1)}
                >
                  ←
                </button>
                <button
                  type="button"
                  className="btn btn-icon"
                  aria-label={t("preview.next")}
                  disabled={
                    index < 0 ||
                    index >= navigable.length - 1 ||
                    navState === "navigating"
                  }
                  onClick={() => navigate(1)}
                >
                  →
                </button>
              </>
            ) : null}
            <a className="btn btn-ghost btn-sm" href={downloadUrl} download>
              {t("preview.download")}
            </a>
            <button
              type="button"
              className="btn btn-icon"
              aria-label={t("preview.close")}
              onClick={() => dialogRef.current?.close()}
            >
              ✕
            </button>
          </div>
        </header>
        {typeof navState === "object" && "error" in navState ? (
          <p className="preview-banner preview-banner-warn" role="alert">
            {t("preview.navFailed")}
          </p>
        ) : null}
        <div className="preview-body">
          <ViewerBoundary
            resetKey={target.id}
            fallback={(error) => <ViewerError error={error} />}
          >
            <Suspense
              fallback={
                <div className="preview-center">
                  <p>{t("preview.loadingViewer")}</p>
                </div>
              }
            >
              {viewer}
            </Suspense>
          </ViewerBoundary>
        </div>
      </div>
    </dialog>
  );
}
