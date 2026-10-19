import {
  Component,
  Suspense,
  lazy,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";
import type { FileDetail } from "../../../shared/contracts/drive";
import type { PublicFolderEntry } from "../../../shared/contracts/public-links";
import { publicContentUrl } from "../../lib/api";
import { useI18n } from "../../lib/i18n";
import { resolvePreviewPlan } from "../preview/registry";
import { ViewerError } from "../preview/viewer-error";
import type { ViewerProps } from "../preview/viewer-types";
import "../preview/preview.css";

const LazyViewers = {
  image: lazy(() => import("../preview/viewers/image-viewer")),
  media: lazy(() => import("../preview/viewers/media-viewer")),
  pdf: lazy(() => import("../preview/viewers/pdf-viewer")),
  text: lazy(() => import("../preview/viewers/text-viewer")),
  markdown: lazy(() => import("../preview/viewers/markdown-viewer")),
  unsupported: lazy(() => import("../preview/viewers/unsupported-viewer")),
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
 * The viewers take a FileDetail; a public entry already carries every field
 * the viewers and the registry need, so the detail is synthesized locally —
 * no extra metadata round trip exists on the public surface.
 */
function detailOf(entry: PublicFolderEntry): FileDetail {
  return {
    id: entry.id,
    kind: entry.kind,
    name: entry.name,
    mimeType: entry.mimeType,
    size: entry.size ?? "0",
    modifiedTime: entry.modifiedTime,
    hasThumbnail: entry.hasThumbnail,
    readerAccessState: "readable",
  };
}

/**
 * Anonymous preview dialog (wave-8 C5): reuses the registry + viewers with a
 * public content URL — the path-scoped unlock cookie rides the same-origin
 * request, never a credential in the page. Google-native export and HLS
 * packages have no public endpoint, so those plans degrade to download-only.
 */
export function PublicPreviewDialog({
  slug,
  initialFile,
  siblings = [],
  onClose,
}: {
  slug: string;
  initialFile: PublicFolderEntry;
  siblings?: readonly PublicFolderEntry[];
  onClose: () => void;
}) {
  const { t } = useI18n();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [target, setTarget] = useState<PublicFolderEntry>(initialFile);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog !== null && !dialog.open) dialog.showModal();
  }, []);

  const controller = useMemo(() => new AbortController(), [target.id]);
  useEffect(() => () => controller.abort(), [controller]);

  const file = useMemo(() => detailOf(target), [target]);
  const plan = useMemo(() => {
    const resolved = resolvePreviewPlan(file);
    // No public Workspace-export or media-package endpoints exist.
    if (resolved.source === "export-pdf" || resolved.viewer === "hls") {
      return { viewer: "unsupported" as const, source: "content" as const, reason: "no-viewer" as const };
    }
    return resolved;
  }, [file]);
  const sourceUrl = useMemo(
    () => publicContentUrl(slug, target.id),
    [slug, target.id],
  );
  const downloadUrl = useMemo(
    () => publicContentUrl(slug, target.id, true),
    [slug, target.id],
  );

  const navigable = useMemo(
    () => siblings.filter((entry) => entry.kind === "file"),
    [siblings],
  );
  const index = navigable.findIndex((entry) => entry.id === target.id);
  const navigate = (direction: 1 | -1) => {
    const entry = navigable[index + direction];
    if (entry !== undefined) setTarget(entry);
  };

  const viewerProps: ViewerProps = {
    mountId: "",
    file,
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
          <LazyViewers.media
            {...viewerProps}
            mediaKind={plan.mediaKind ?? "video"}
          />
        );
      case "pdf":
        return <LazyViewers.pdf {...viewerProps} />;
      case "text":
        return (
          <LazyViewers.text
            {...viewerProps}
            textKind={plan.textKind ?? "text"}
          />
        );
      case "markdown":
        return <LazyViewers.markdown {...viewerProps} />;
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
                  disabled={index <= 0}
                  onClick={() => navigate(-1)}
                >
                  ←
                </button>
                <button
                  type="button"
                  className="btn btn-icon"
                  aria-label={t("preview.next")}
                  disabled={index < 0 || index >= navigable.length - 1}
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
