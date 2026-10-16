/**
 * Cancel cleanup (spec §6.5, plan T08): only the pinned OAuth writer may
 * trash, only the pinned generated file ID, and only when the operation
 * and remote capabilities allow it. The parked metadata is never enough:
 * before mutating, the pinned writer re-reads the file and must affirm
 * the exact generated ID, the pinned drive, a non-trashed state and an
 * explicit canTrash=true. A bare 404/410 can mask a lost permission just
 * as easily as a deleted file, so only a fresh read proving
 * trashed===true counts as "already gone"; every ambiguity lands on
 * cleanup_pending for an administrator — the app never invents a
 * session-DELETE and never escalates to another identity for cleanup.
 */

import { isDriveError } from '../drive/errors';
import type { DriveFileMeta, OAuthCatalogWriteProvider } from '../drive/types';
import type { UploadDirective, UploadSessionEvent } from './upload-internal';

export type TrashDirective = Extract<UploadDirective, { kind: 'trash' }>;
export type CheckWriterDirective = Extract<
  UploadDirective,
  { kind: 'check-writer' }
>;

const DONE: UploadSessionEvent = { type: 'trash-result', outcome: 'done' };

function failed(reason: string): UploadSessionEvent {
  return { type: 'trash-result', outcome: 'failed', reason };
}

type MetaRead =
  | { readonly ok: true; readonly meta: DriveFileMeta }
  | { readonly ok: false; readonly reason: string };

/** Fresh files.get through the pinned writer — the only evidence source. */
async function readCurrentMeta(
  args: {
    provider: OAuthCatalogWriteProvider;
    directive: TrashDirective;
    signal?: AbortSignal;
  },
  fileId: string,
): Promise<MetaRead> {
  try {
    const meta = await args.provider.getMetadata({
      writer: args.directive.writer,
      ref: {
        id: fileId,
        ...(args.directive.file.resourceKey === undefined
          ? {}
          : { resourceKey: args.directive.file.resourceKey }),
      },
      ...(args.signal === undefined ? {} : { signal: args.signal }),
    });
    return { ok: true, meta };
  } catch (err) {
    return {
      ok: false,
      reason: isDriveError(err) ? err.reason : 'transport-error',
    };
  }
}

/** Same object, on the pinned drive, affirmatively in the trash. */
function provesTrashed(
  meta: DriveFileMeta,
  directive: TrashDirective,
): boolean {
  return (
    meta.id === directive.file.id &&
    meta.driveId === directive.driveId &&
    meta.trashed === true
  );
}

/**
 * Trash the pinned generated file. A fresh metadata read must first prove
 * scope (exact id + pinned drive) and capability (affirmative canTrash);
 * a read that already shows trashed===true satisfies the cleanup intent
 * without a mutation. A 404/410 from the trash call is confirmed by one
 * more read — only affirmative trashed evidence ends 'done'; every other
 * outcome is cleanup_pending, because a lost permission can mask the file
 * exactly the same way.
 */
export async function runTrash(args: {
  provider: OAuthCatalogWriteProvider;
  directive: TrashDirective;
  signal?: AbortSignal;
}): Promise<UploadSessionEvent> {
  const { directive } = args;
  const fileId = directive.file.id;
  if (fileId === '' || directive.driveId === '') {
    return failed('unpinned-file');
  }

  const current = await readCurrentMeta(args, fileId);
  if (!current.ok) {
    // Missing/not-found/permission ambiguity cannot prove the file is
    // already trashed — park for an administrator, never guess.
    return failed(`precheck:${current.reason}`);
  }
  const meta = current.meta;
  if (meta.id !== fileId) {
    return failed('precheck:id-mismatch');
  }
  if (meta.driveId !== directive.driveId) {
    return failed('precheck:drive-mismatch');
  }
  if (meta.trashed === true) {
    // Fresh evidence proves the pinned file is already trashed.
    return DONE;
  }
  if (meta.capabilities?.canTrash !== true) {
    // Require an affirmative capability — absent is not permission.
    return failed('precheck:canTrash-unproven');
  }

  try {
    await args.provider.trashFile({
      writer: directive.writer,
      ref: {
        id: fileId,
        ...(directive.file.resourceKey === undefined
          ? {}
          : { resourceKey: directive.file.resourceKey }),
      },
      ...(args.signal === undefined ? {} : { signal: args.signal }),
    });
    return DONE;
  } catch (err) {
    if (!isDriveError(err)) {
      return failed('transport-error');
    }
    if (err.reason === 'not-found' || err.reason === 'gone') {
      // Ambiguous: the file may be gone, or the writer lost sight of it.
      // Only a fresh affirmative trashed read satisfies the intent.
      const confirm = await readCurrentMeta(args, fileId);
      if (confirm.ok && provesTrashed(confirm.meta, directive)) {
        return DONE;
      }
      return failed(`trash-ambiguous:${err.reason}`);
    }
    return failed(err.reason);
  }
}
