/**
 * Thumbnail route (architecture §7.1, plan T06; wave-3 track B).
 *
 * GET /api/v1/mounts/:mountId/files/:fileId/thumbnail
 *
 * Thumbnail bytes come from the SA read provider only: the provider reads
 * the Drive `thumbnailLink` from SA-side metadata and fetches it under the
 * same allowlisted transport — the browser never receives the Google URL,
 * and no OAuth credential is involved (spec §7.1, §9.4). Admission is the
 * shared content pipeline, so session users, scoped shares and scoped
 * tickets all see identical checks.
 */

import {
  admitFileRead,
  assertQueryParams,
  contentErrorResponse,
  downstreamAbortableBody,
  linkRequestSignal,
  mediaDenialError,
  openWithFailover,
  providerFor,
  requireParam,
  type ContentRouteDeps,
  type RouterContext,
} from '../transfers/content-access';
import type { UpstreamContent } from '../drive/types';
import {
  buildContentDisposition,
  resolveDisposition,
} from '../transfers/content-disposition';

const THUMBNAIL_QUERY_PARAMS = ['share', 'ticket'] as const;

export async function handleThumbnail(
  c: RouterContext,
  deps: ContentRouteDeps,
): Promise<Response> {
  try {
    assertQueryParams(c, THUMBNAIL_QUERY_PARAMS);
    const admitted = await admitFileRead(c, deps);
    const provider = providerFor(c, deps);
    const fileId = requireParam(c, 'fileId');

    const controller = new AbortController();
    linkRequestSignal(c.req.raw, controller);
    let upstream: UpstreamContent;
    try {
      upstream = await openWithFailover(
        provider,
        admitted.mount,
        fileId,
        admitted.verified,
        controller.signal,
        (identity, ref) =>
          provider.openThumbnail({
            identity,
            ref,
            // A metadata-cache hit carries no thumbnailLink — that is not
            // "known absent": fall back to the provider's legacy files.get
            // (which also re-proves capabilities.canDownload; review M3).
            thumbnailLink:
              admitted.verified.meta.thumbnailLink ??
              (admitted.verified.fromCache === true ? undefined : null),
            ...(admitted.verified.fromCache === true &&
            identity.serviceAccountId ===
              admitted.verified.identity.serviceAccountId
              ? { metaFromCache: true }
              : {}),
            signal: controller.signal,
          }),
      );
    } catch (err) {
      throw await mediaDenialError(c, deps, {
        mount: admitted.mount,
        fileId,
        verified: admitted.verified,
        err,
      });
    }

    const headers = new Headers();
    // Disposition is computed against the DELIVERED type (reviewer F3) — an
    // upstream error page or SVG must not be inlined as active content.
    const deliveredType = upstream.contentType ?? 'image/jpeg';
    headers.set('Content-Type', deliveredType);
    headers.set(
      'Content-Disposition',
      buildContentDisposition(
        resolveDisposition(deliveredType),
        `thumb-${admitted.verified.meta.name}`,
      ),
    );
    if (upstream.contentLength !== undefined) {
      headers.set('Content-Length', upstream.contentLength.toString(10));
    }
    // Wave-9 step 2c: a short private cache — thumbnails are the hot repeat
    // fetch on the explorer grid and spec §9.4 permits it.
    headers.set('Cache-Control', 'private, max-age=300');

    const body = downstreamAbortableBody(upstream.body, () =>
      controller.abort(),
    );
    return new Response(body, { status: upstream.status, headers });
  } catch (err) {
    return contentErrorResponse(c, err);
  }
}
