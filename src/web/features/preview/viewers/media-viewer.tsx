import { useEffect, useRef, useState } from "react";
import { useI18n } from "../../../lib/i18n";
import type { MediaKind } from "../registry";
import type { ViewerProps } from "../viewer-types";
import "../preview.css";

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2] as const;

/**
 * Native audio/video playback (architecture §8.1): the browser's own
 * controls carry seek; the toolbar adds playback speed and fullscreen
 * (video). A real codec/container failure surfaces as a clear fallback —
 * never a dead player.
 */
export default function MediaViewer({
  file,
  sourceUrl,
  signal,
  mediaKind,
}: ViewerProps & { mediaKind: MediaKind }) {
  const { t } = useI18n();
  const mediaRef = useRef<HTMLVideoElement | HTMLAudioElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const [codecError, setCodecError] = useState(false);
  const [speed, setSpeed] = useState(1);

  // Cleanup (plan T12): pause, drop the source and force a reload so the
  // element releases the stream; the same runs when the abort signal fires.
  useEffect(() => {
    const destroy = () => {
      const media = mediaRef.current;
      if (media === null) return;
      media.pause();
      media.removeAttribute("src");
      media.load();
    };
    signal.addEventListener("abort", destroy);
    return () => {
      signal.removeEventListener("abort", destroy);
      destroy();
    };
  }, [signal]);

  useEffect(() => {
    const media = mediaRef.current;
    if (media !== null) media.playbackRate = speed;
  }, [speed]);

  // Native listener: React's onError is unreliable on media elements since
  // the event does not bubble. Poll media.error too — a codec/container
  // failure can land before effects attach, and a stalled source that never
  // reaches loadedmetadata gets the same honest fallback after a bound.
  useEffect(() => {
    const media = mediaRef.current;
    if (media === null) return;
    const check = () => {
      if (
        media.error !== null ||
        media.networkState === HTMLMediaElement.NETWORK_NO_SOURCE
      ) {
        setCodecError(true);
      }
    };
    media.addEventListener("error", check);
    check();
    const poll = window.setInterval(check, 400);
    const bound = window.setTimeout(() => {
      if (media.readyState === 0 && media.error === null) check();
      if (media.readyState === 0 && media.networkState !== 0) {
        setCodecError(true);
      }
    }, 10_000);
    return () => {
      media.removeEventListener("error", check);
      window.clearInterval(poll);
      window.clearTimeout(bound);
    };
  }, [sourceUrl]);

  if (codecError) {
    return (
      <div className="preview-center">
        <div className="preview-center-stack">
          <p className="alert alert-error" role="alert">
            {t("preview.codecError")}
          </p>
          <a className="btn btn-primary" href={sourceUrl} download>
            {t("preview.download")}
          </a>
        </div>
      </div>
    );
  }

  const toggleFullscreen = () => {
    const stage = stageRef.current;
    if (stage === null) return;
    if (document.fullscreenElement === stage) {
      void document.exitFullscreen();
    } else {
      void stage.requestFullscreen();
    }
  };

  return (
    <div className="preview-viewer">
      <div
        className="preview-toolbar"
        role="toolbar"
        aria-label={t("preview.mediaControls")}
      >
        <label className="preview-toolbar-label" htmlFor="preview-speed">
          {t("preview.speed")}
        </label>
        <select
          id="preview-speed"
          className="preview-search-input"
          value={String(speed)}
          onChange={(event) => setSpeed(Number(event.target.value))}
        >
          {SPEEDS.map((value) => (
            <option key={value} value={String(value)}>
              {value}×
            </option>
          ))}
        </select>
        {mediaKind === "video" ? (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={toggleFullscreen}
          >
            {t("preview.fullscreen")}
          </button>
        ) : null}
      </div>
      <div
        ref={stageRef}
        className={`preview-stage ${
          mediaKind === "video" ? "preview-stage-video" : "preview-stage-audio"
        }`}
      >
        {mediaKind === "video" ? (
          <video
            ref={mediaRef as React.RefObject<HTMLVideoElement>}
            controls
            preload="metadata"
            src={sourceUrl}
            aria-label={file.name}
          />
        ) : (
          <audio
            ref={mediaRef as React.RefObject<HTMLAudioElement>}
            controls
            preload="metadata"
            src={sourceUrl}
            aria-label={file.name}
          />
        )}
      </div>
    </div>
  );
}
