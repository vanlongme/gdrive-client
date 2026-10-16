import { readFileSync } from "node:fs";
import type { Page } from "@playwright/test";

/**
 * HLS preview E2E fixtures (T13 UI). The mounts/catalog surface reuses the
 * T12 routePreview mount; this module adds page.route fixtures for the
 * media-package API. Playlist responses carry ALREADY-rewritten URIs (r<N>
 * resource ids, exactly what the real route emits) and segment/audio/vtt
 * bytes are real ffmpeg-produced media under tests/fixtures/hls/e2e/.
 */

export const HLS_ENTRY = {
  id: "pv-hls",
  kind: "file" as const,
  name: "stream.m3u8",
  mimeType: "application/vnd.apple.mpegurl",
  size: "320",
  modifiedTime: "2026-10-01T09:00:00Z",
  hasThumbnail: false,
};

export const HLS_PACKAGE = "pkg-e2e";

const dir = "tests/fixtures/hls/e2e";
const read = (name: string) => readFileSync(`${dir}/${name}`);

const MASTER = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",LANGUAGE="en",DEFAULT=YES,AUTOSELECT=YES,URI="r2"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="Français",LANGUAGE="fr",DEFAULT=NO,AUTOSELECT=YES,URI="r3"
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="Vietnamese",LANGUAGE="vi",URI="r4"
#EXT-X-STREAM-INF:BANDWIDTH=300000,RESOLUTION=320x240,AUDIO="aud",SUBTITLES="subs"
r5
`;

const mediaPlaylist = (ids: string[]) =>
  `#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-PLAYLIST-TYPE:VOD\n${ids
    .map((id) => `#EXTINF:2.0,\n${id}`)
    .join("\n")}\n#EXT-X-ENDLIST\n`;

const SUBS_PLAYLIST = `#EXTM3U
#EXT-X-TARGETDURATION:10
#EXTINF:10.0,
r17
#EXT-X-ENDLIST
`;

const RESOURCES: Record<string, { body: Buffer | string; type: string }> = {
  r1: { body: MASTER, type: "application/vnd.apple.mpegurl" },
  r2: { body: mediaPlaylist(["r6", "r7", "r8", "r9"]), type: "application/vnd.apple.mpegurl" },
  r3: { body: mediaPlaylist(["r10", "r11", "r12", "r13"]), type: "application/vnd.apple.mpegurl" },
  r4: { body: SUBS_PLAYLIST, type: "application/vnd.apple.mpegurl" },
  r5: { body: mediaPlaylist(["r14", "r15", "r16"]), type: "application/vnd.apple.mpegurl" },
  r6: { body: read("a-en-0.aac"), type: "audio/aac" },
  r7: { body: read("a-en-1.aac"), type: "audio/aac" },
  r8: { body: read("a-en-2.aac"), type: "audio/aac" },
  r9: { body: read("a-en-3.aac"), type: "audio/aac" },
  r10: { body: read("a-fr-0.aac"), type: "audio/aac" },
  r11: { body: read("a-fr-1.aac"), type: "audio/aac" },
  r12: { body: read("a-fr-2.aac"), type: "audio/aac" },
  r13: { body: read("a-fr-3.aac"), type: "audio/aac" },
  r14: { body: read("seg0.tsbin"), type: "video/mp2t" },
  r15: { body: read("seg1.tsbin"), type: "video/mp2t" },
  r16: { body: read("seg2.tsbin"), type: "video/mp2t" },
  r17: { body: read("vi.vtt"), type: "text/vtt" },
};

export interface HlsCalls {
  creates: number;
  advances: number;
  views: number;
  resources: string[];
}

export interface HlsRouteOptions {
  /** Advance calls that return "preparing" before the ready one. */
  advancesBeforeReady?: number;
  /** Resource ids that answer with this error envelope status. */
  staleResources?: Set<string>;
  /** If set, POST advance always fails with this code/status. */
  advanceError?: { status: number; code: string; message: string };
  /** Package state for POST create / GET view overrides. */
  neverReady?: boolean;
}

/**
 * Routes /api/v1/media-packages** with a stateful fixture: create →
 * N×advance(preparing) → ready → view exposes playerUrl → resources serve
 * the rewritten playlists and real media bytes. All package traffic is
 * API fixture-routed — nothing here is live Drive evidence.
 */
export function routeHlsPackage(page: Page, options: HlsRouteOptions = {}): HlsCalls {
  const calls: HlsCalls = { creates: 0, advances: 0, views: 0, resources: [] };
  const playerUrl = `/api/v1/media-packages/${HLS_PACKAGE}/resources/r1`;
  const view = (state: string) => ({
    packageId: HLS_PACKAGE,
    state,
    indexGeneration: 1,
    strictSnapshot: false,
    ...(state === "ready" ? { readyGeneration: 1, playerUrl } : {}),
    ...(state === "failed"
      ? { failureReason: "ADVANCE fixture failure" }
      : {}),
  });
  const json = (route: Parameters<Parameters<Page["route"]>[1]>[0], body: unknown, status = 200) =>
    route.fulfill({ status, json: body });
  const apiError = (code: string, message: string) => ({
    error: { code, message, requestId: "e2e-hls" },
  });

  void page.route("**/api/v1/media-packages**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const method = route.request().method();
    const resMatch = path.match(
      /^\/api\/v1\/media-packages\/([^/]+)\/resources\/([^/]+)$/,
    );
    if (resMatch !== null && (method === "GET" || method === "HEAD")) {
      const rid = decodeURIComponent(resMatch[2] ?? "");
      calls.resources.push(rid);
      if (options.staleResources?.has(rid)) {
        await json(route, apiError("CONTENT_CHANGED", "Stale generation."), 409);
        return;
      }
      const res = RESOURCES[rid];
      if (res === undefined) {
        await json(route, apiError("NOT_FOUND", "No resource."), 404);
        return;
      }
      await route.fulfill({
        status: 200,
        headers: { "content-type": res.type },
        body: res.body,
      });
      return;
    }
    const advanceMatch = path.match(
      /^\/api\/v1\/media-packages\/([^/]+)\/advance$/,
    );
    if (advanceMatch !== null && method === "POST") {
      calls.advances += 1;
      if (options.advanceError !== undefined) {
        await json(
          route,
          apiError(options.advanceError.code, options.advanceError.message),
          options.advanceError.status,
        );
        return;
      }
      const ready = calls.advances > (options.advancesBeforeReady ?? 0);
      await json(route, {
        packageId: HLS_PACKAGE,
        state: ready && !options.neverReady ? "ready" : "preparing",
        indexGeneration: 1,
        complete: ready && !options.neverReady,
        processedResources: calls.advances * 3,
      });
      return;
    }
    const viewMatch = path.match(/^\/api\/v1\/media-packages\/([^/]+)$/);
    if (viewMatch !== null && method === "GET") {
      calls.views += 1;
      const ready =
        calls.advances > (options.advancesBeforeReady ?? 0) &&
        !options.neverReady;
      await json(route, view(ready ? "ready" : "preparing"));
      return;
    }
    if (path === "/api/v1/media-packages" && method === "POST") {
      calls.creates += 1;
      await json(route, view("preparing"), 201);
      return;
    }
    await route.fallback();
  });
  return calls;
}
