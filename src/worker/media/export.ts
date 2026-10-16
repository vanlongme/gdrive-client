/**
 * Workspace export route (architecture §7.1/§7.2, plan T06; wave-3 track B).
 *
 * GET /api/v1/mounts/:mountId/files/:fileId/export?format=pdf
 *
 * Exports a Google-native document through the SA read provider — same
 * identity and admission pipeline as content. Google exports do not support
 * partial download, so no Range is offered or fabricated; `format` is
 * restricted to the provider's allowlist (currently only 'pdf'). Files that
 * are not Google-native documents answer PREVIEW_UNSUPPORTED instead of an
 * upstream call that cannot succeed.
 */

import { ApiRequestError } from '../drive/mounts';
import type { ExportFormat } from '../drive/types';
import { EXPORT_FORMATS } from '../drive/types';
import {
  admitFileRead,
  assertQueryParams,
  contentErrorResponse,
  downstreamAbortableBody,
  linkRequestSignal,
  openWithFailover,
  providerFor,
  requireDriveId,
  requireParam,
  type ContentRouteDeps,
  type RouterContext,
} from '../transfers/content-access';
import {
  buildContentDisposition,
  resolveDisposition,
  type DispositionMode,
} from '../transfers/content-disposition';

const EXPORT_QUERY_PARAMS = ['format', 'disposition', 'share', 'ticket'] as const;

const GOOGLE_NATIVE_PREFIX = 'application/vnd.google-apps.';

function parseFormat(c: RouterContext): ExportFormat {
  const raw = c.req.query('format');
  const format = raw === undefined ? 'pdf' : raw;
  if (!(EXPORT_FORMATS as readonly string[]).includes(format)) {
    throw new ApiRequestError(
      400,
      'VALIDATION_FAILED',
      `Export format '${format}' is not supported.`,
    );
  }
  return format as ExportFormat;
}

function parseDisposition(c: RouterContext): DispositionMode | undefined {
  const raw = c.req.query('disposition');
  if (raw === undefined) return undefined;
  if (raw === 'attachment' || raw === 'inline') return raw;
  throw new ApiRequestError(
    400,
    'VALIDATION_FAILED',
    "The 'disposition' parameter must be 'attachment' or 'inline'.",
  );
}

/** Exported filename: the document name plus the format extension. */
function exportFilename(name: string, format: ExportFormat): string {
  const suffix = `.${format}`;
  return name.toLowerCase().endsWith(suffix) ? name : `${name}${suffix}`;
}

export async function handleExport(
  c: RouterContext,
  deps: ContentRouteDeps,
): Promise<Response> {
  try {
    assertQueryParams(c, EXPORT_QUERY_PARAMS);
    const format = parseFormat(c);
    const disposition = parseDisposition(c);
    const admitted = await admitFileRead(c, deps);
    const { meta } = admitted.verified;

    if (!meta.mimeType.startsWith(GOOGLE_NATIVE_PREFIX)) {
      throw new ApiRequestError(
        415,
        'PREVIEW_UNSUPPORTED',
        'Only Google Workspace documents can be exported.',
      );
    }

    const provider = providerFor(c, deps);
    const fileId = requireDriveId(requireParam(c, 'fileId'), 'fileId');
    const controller = new AbortController();
    linkRequestSignal(c.req.raw, controller);
    const upstream = await openWithFailover(
      provider,
      admitted.mount,
      fileId,
      admitted.verified,
      controller.signal,
      (identity, ref) =>
        provider.exportDocument({
          identity,
          ref,
          format,
          signal: controller.signal,
        }),
    );

    const contentType = upstream.contentType ?? 'application/pdf';
    const headers = new Headers();
    headers.set('Content-Type', contentType);
    headers.set(
      'Content-Disposition',
      buildContentDisposition(
        resolveDisposition(contentType, disposition),
        exportFilename(meta.name, format),
      ),
    );
    if (upstream.contentLength !== undefined) {
      headers.set('Content-Length', upstream.contentLength.toString(10));
    }
    // Exports are private and must not be cached publicly (spec §7.2).
    headers.set('Cache-Control', 'private, no-store');

    const body = downstreamAbortableBody(upstream.body, () =>
      controller.abort(),
    );
    return new Response(body, { status: upstream.status, headers });
  } catch (err) {
    return contentErrorResponse(c, err);
  }
}
