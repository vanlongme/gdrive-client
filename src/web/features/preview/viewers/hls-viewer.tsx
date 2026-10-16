/**
 * HLS VOD player viewer (plan T13, wave-4 D2). The .m3u8 file becomes a
 * media package: POST create-or-lookup, bounded POST advance calls until a
 * ready generation publishes, then ONLY that generation's playerUrl is
 * played — never a preparing generation, never the raw file bytes.
 *
 * Playback uses native HLS where the browser supports it (Safari) and
 * hls.js + MSE otherwise. hls.js is bundled and served same-origin — the
 * CSP stays 'self'; no remote origin is ever contacted. Track selectors
 * appear only when the manifest exposes alternate audio/subtitles.
 */

import { useEffect, useRef, useState } from "react";
import { ApiClientError, apiFetch } from "../../../lib/api";
import { useI18n } from "../../../lib/i18n";
import { ViewerError } from "../viewer-error";
import type { ViewerProps } from "../viewer-types";

const ADVANCE_POLL_MS = 350;
const MAX_ADVANCE_CALLS = 200;

interface PackageView {
  packageId: string;
  state: "preparing" | "ready" | "failed";
  indexGeneration: number;
  readyGeneration?: number;
  playerUrl?: string;
  failureReason?: string;
}

interface AdvanceView {
  state: "preparing" | "ready" | "failed";
  complete: boolean;
}

async function readJson<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

async function getPackage(packageId: string, signal: AbortSignal): Promise<PackageView> {
  return readJson(
    await apiFetch(`/api/v1/media-packages/${encodeURIComponent(packageId)}`, {
      signal,
    }),
  );
}

/** Drive the index until a ready generation publishes or fails. */
async function ensurePackage(
  mountId: string,
  entryFileId: string,
  signal: AbortSignal,
  onProgress: (view: PackageView) => void,
): Promise<string> {
  const created = await readJson<PackageView>(
    await apiFetch("/api/v1/media-packages", {
      method: "POST",
      jsonBody: { mountId, entryFileId },
      signal,
    }),
  );
  let view = created;
  for (let i = 0; i < MAX_ADVANCE_CALLS; i++) {
    if (view.state === "ready" && view.playerUrl !== undefined) {
      return view.playerUrl;
    }
    if (view.state === "failed") {
      throw new ApiClientError(
        view.failureReason ?? "The media package could not be indexed.",
        { status: 409, code: "MEDIA_PACKAGE_NOT_READY" },
      );
    }
    const advance = await readJson<AdvanceView>(
      await apiFetch(
        `/api/v1/media-packages/${encodeURIComponent(view.packageId)}/advance`,
        { method: "POST", jsonBody: {}, signal },
      ),
    );
    if (advance.state !== "ready" && !advance.complete) {
      // Yield between batches; the cursor is durable so closing just pauses.
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, ADVANCE_POLL_MS);
        signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(new DOMException("aborted", "AbortError"));
          },
          { once: true },
        );
      });
    }
    view = await getPackage(view.packageId, signal);
    onProgress(view);
  }
  throw new ApiClientError("The media package preparation timed out.", {
    status: 409,
    code: "MEDIA_PACKAGE_NOT_READY",
  });
}

interface TrackOption {
  id: number;
  label: string;
}

export default function HlsViewer({ mountId, file, signal }: ViewerProps) {
  const { t } = useI18n();
  const videoRef = useRef<HTMLVideoElement>(null);
  const [phase, setPhase] = useState<
    | { kind: "preparing"; packageId?: string }
    | { kind: "error"; error: unknown }
    | { kind: "playing" }
  >({ kind: "preparing" });
  const [audioTracks, setAudioTracks] = useState<TrackOption[]>([]);
  const [subtitleTracks, setSubtitleTracks] = useState<TrackOption[]>([]);
  const [audioSel, setAudioSel] = useState(0);
  const [subSel, setSubSel] = useState(-1);
  const hlsRef = useRef<{ destroy(): void } | null>(null);

  useEffect(() => {
    let cancelled = false;
    const video = videoRef.current;
    if (video === null) return;
    (async () => {
      const playerUrl = await ensurePackage(mountId, file.id, signal, (v) =>
        setPhase({ kind: "preparing", packageId: v.packageId }),
      );
      if (cancelled) return;
      // hls.js + MSE is preferred whenever supported: it gives uniform
      // track switching and surfaces upstream 409/401 failures through the
      // error panel. Native HLS (Safari, iOS — no MSE) is the fallback.
      const { default: Hls } = await import("hls.js");
      if (!Hls.isSupported()) {
        const canNative =
          video.canPlayType("application/vnd.apple.mpegurl") !== "" ||
          video.canPlayType("application/x-mpegURL") !== "";
        if (!canNative) {
          throw new ApiClientError(
            "This browser cannot play HLS (no MSE support).",
            { status: 415, code: "PREVIEW_UNSUPPORTED" },
          );
        }
        video.src = playerUrl;
        video.addEventListener(
          "error",
          () =>
            setPhase({
              kind: "error",
              error: new ApiClientError("The playlist failed to load.", {
                status: 409,
                code: "MEDIA_PACKAGE_NOT_READY",
              }),
            }),
          { once: true },
        );
        await video.play().catch(() => undefined);
        setPhase({ kind: "playing" });
        return;
      }
      const noRetry = {
        default: {
          maxTimeToFirstByteMs: 8_000,
          maxLoadTimeMs: 10_000,
          timeoutRetry: null,
          errorRetry: null,
        },
      };
      const hls = new Hls({
        enableWorker: true,
        // Render captions into hls.js's own overlay: the native path injects
        // a data:URL track source, which the CSP media-src 'self' blob:
        // would (correctly) block. Overlay rendering needs no new directive.
        renderTextTracksNatively: false,
        // Auth failures (401/403/409) must surface immediately — hls.js's
        // default exponential retries would mask them for minutes.
        manifestLoadPolicy: noRetry,
        playlistLoadPolicy: noRetry,
      });
      hlsRef.current = hls;
      const syncTracks = () => {
        setAudioTracks(
          hls.audioTracks.map((tr, i) => ({
            id: i,
            label: tr.name || tr.lang || `Audio ${i + 1}`,
          })),
        );
        setSubtitleTracks(
          hls.subtitleTracks.map((tr, i) => ({
            id: i,
            label: tr.name || tr.lang || `Subtitle ${i + 1}`,
          })),
        );
      };
      hls.on(Hls.Events.MANIFEST_PARSED, syncTracks);
      hls.on(Hls.Events.LEVEL_LOADED, syncTracks);
      hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, syncTracks);
      hls.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, syncTracks);
      hls.on(Hls.Events.ERROR, (_e, data) => {
        if (data.fatal) {
          setPhase({
            kind: "error",
            error: new ApiClientError(
              `HLS playback failed: ${data.details}`,
              { status: 409, code: "MEDIA_PACKAGE_NOT_READY" },
            ),
          });
        }
      });
      hls.loadSource(playerUrl);
      hls.attachMedia(video);
      if (cancelled) {
        hls.destroy();
        return;
      }
      setPhase({ kind: "playing" });
    })().catch((error: unknown) => {
      if (cancelled) return;
      if (error instanceof DOMException && error.name === "AbortError") return;
      setPhase({ kind: "error", error });
    });
    return () => {
      cancelled = true;
      const hls = hlsRef.current;
      hlsRef.current = null;
      if (hls !== null) hls.destroy();
      video.pause();
      video.removeAttribute("src");
      video.load();
    };
  }, [mountId, file.id, signal]);

  const switchAudio = (id: number) => {
    setAudioSel(id);
    const hls = hlsRef.current as { audioTrack?: number } | null;
    if (hls !== null && hls.audioTrack !== undefined) hls.audioTrack = id;
  };
  const switchSubtitle = (id: number) => {
    setSubSel(id);
    const hls = hlsRef.current as { subtitleTrack?: number } | null;
    if (hls !== null && hls.subtitleTrack !== undefined) hls.subtitleTrack = id;
  };

  if (phase.kind === "error") {
    return <ViewerError error={phase.error} />;
  }

  return (
    <div className="preview-media" data-testid="hls-viewer">
      {phase.kind === "preparing" ? (
        <div className="preview-center" role="status">
          <p>{t("preview.hlsPreparing")}</p>
        </div>
      ) : null}
      <video
        ref={videoRef}
        className="preview-video"
        controls
        playsInline
        data-testid="hls-video"
        hidden={phase.kind !== "playing"}
      />
      {phase.kind === "playing" && audioTracks.length > 1 ? (
        <label className="preview-field">
          {t("preview.hlsAudioTrack")}
          <select
            value={audioSel}
            onChange={(e) => switchAudio(Number(e.target.value))}
            data-testid="hls-audio-track"
          >
            {audioTracks.map((tr) => (
              <option key={tr.id} value={tr.id}>
                {tr.label}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {phase.kind === "playing" && subtitleTracks.length > 0 ? (
        <label className="preview-field">
          {t("preview.hlsSubtitles")}
          <select
            value={subSel}
            onChange={(e) => switchSubtitle(Number(e.target.value))}
            data-testid="hls-subtitle-track"
          >
            <option value={-1}>{t("preview.hlsSubtitlesOff")}</option>
            {subtitleTracks.map((tr) => (
              <option key={tr.id} value={tr.id}>
                {tr.label}
              </option>
            ))}
          </select>
        </label>
      ) : null}
    </div>
  );
}
