import { ApiClientError } from "./api";
import type { MessagePath } from "./i18n";

/**
 * Maps an API failure to a localized, next-action message key (spec section
 * 11.3: every error needs a next action, not a collapsed "failed"). Falls
 * back to a generic message for undocumented codes.
 */
export function messageKeyForError(error: unknown): {
  key: MessagePath;
  requestId?: string;
  retryAfterSeconds?: number;
} {
  if (!(error instanceof ApiClientError)) {
    return { key: "errors.unknown" };
  }
  const base = {
    requestId: error.requestId,
    retryAfterSeconds: error.retryAfterSeconds,
  };
  switch (error.code) {
    case "NETWORK_ERROR":
      return { key: "errors.network", ...base };
    case "AUTH_REQUIRED":
      return { key: "errors.authRequired", ...base };
    case "FORBIDDEN":
      return { key: "errors.forbidden", ...base };
    case "RATE_LIMITED":
      return { key: "errors.rateLimited", ...base };
    case "VALIDATION_FAILED":
      return { key: "errors.validation", ...base };
    case "SETUP_TOKEN_INVALID":
      return { key: "errors.setupTokenInvalid", ...base };
    case "SETUP_ALREADY_COMPLETED":
      return { key: "errors.setupCompleted", ...base };
    case "NOT_FOUND":
      return { key: "errors.notFound", ...base };
    case "DRIVE_UNAVAILABLE":
      return { key: "errors.driveUnavailable", ...base };
    case "FILE_NOT_ACCESSIBLE":
      return { key: "errors.fileNotAccessible", ...base };
    case "FILE_NOT_READABLE_BY_POOL":
      return { key: "errors.fileNotReadableByPool", ...base };
    case "READ_PROVIDER_UNAVAILABLE":
      return { key: "errors.readProviderUnavailable", ...base };
    case "GOOGLE_REAUTH_REQUIRED":
      return { key: "errors.googleReauth", ...base };
    case "GOOGLE_CONNECTION_DISABLED":
      return { key: "errors.googleConnectionDisabled", ...base };
    case "PROJECT_LIMITED":
      return { key: "errors.projectLimited", ...base };
    case "STORAGE_FULL":
      return { key: "errors.storageFull", ...base };
    case "UPLOAD_EXPIRED":
      return { key: "errors.uploadExpired", ...base };
    case "UPLOAD_NEEDS_RECONCILIATION":
      return { key: "errors.uploadNeedsReconciliation", ...base };
    case "FILE_CONFLICT":
      return { key: "errors.fileConflict", ...base };
    case "SNAPSHOT_UNAVAILABLE":
      return { key: "errors.snapshotUnavailable", ...base };
    case "CONTENT_CHANGED":
      return { key: "errors.contentChanged", ...base };
    case "MEDIA_PACKAGE_NOT_READY":
      return { key: "errors.mediaPackageNotReady", ...base };
    case "PREVIEW_UNSUPPORTED":
      return { key: "errors.previewUnsupported", ...base };
    case "SETUP_REQUIRED":
      return { key: "errors.setupRequired", ...base };
    case "SETUP_IN_PROGRESS":
      return { key: "errors.setupInProgress", ...base };
    case "SETUP_STATUS_UNAVAILABLE":
      return { key: "errors.setupStatusUnavailable", ...base };
    case "SETUP_NOT_IMPLEMENTED":
    case "AUTH_NOT_IMPLEMENTED":
      return { key: "errors.notImplemented", ...base };
    case "AUTH_UNAVAILABLE":
      return { key: "errors.authUnavailable", ...base };
    case "ORIGIN_REJECTED":
      return { key: "errors.originRejected", ...base };
    case "BOOTSTRAP_SECRETS_INVALID":
      return { key: "errors.bootstrapSecrets", ...base };
    case "IDEMPOTENCY_CONFLICT":
      return { key: "errors.idempotencyConflict", ...base };
    case "READ_POOL_CONFLICT":
      return { key: "errors.readPoolConflict", ...base };
    case "INTERNAL_ERROR":
      return { key: "errors.internal", ...base };
    case "UNEXPECTED_RESPONSE":
      return { key: "errors.unexpectedResponse", ...base };
    case "MOUNT_ROOT_NOT_FOLDER":
      return { key: "errors.mountRootNotFolder", ...base };
    case "MOUNT_ROOT_NOT_OWNED":
      return { key: "errors.mountRootNotOwned", ...base };
    case "MOUNT_ROOT_IS_MY_DRIVE":
      return { key: "errors.mountRootIsMyDrive", ...base };
    case "MOUNT_ROOT_TRASHED":
      return { key: "errors.mountRootTrashed", ...base };
    case "MOUNT_ROOT_NOT_WRITABLE":
      return { key: "errors.mountRootNotWritable", ...base };
    case "MOUNT_WRITER_MISMATCH":
      return { key: "errors.mountWriterMismatch", ...base };
    case "MOUNT_KIND_UNSUPPORTED":
      return { key: "errors.mountKindUnsupported", ...base };
    // Wave-8 public-link codes: mapped to the closest existing message until
    // worker C adds dedicated strings (C6 owns the locale files).
    case "PUBLIC_LINK_EXPIRED":
      return { key: "errors.notFound", ...base };
    case "PUBLIC_LINK_PASSWORD_REQUIRED":
    case "PUBLIC_LINK_INVALID_PASSWORD":
    case "PUBLIC_LINK_ARCHIVE_DISABLED":
      return { key: "errors.forbidden", ...base };
    case "PUBLIC_LINK_CONFLICT":
      return { key: "errors.fileConflict", ...base };
    case "PUBLIC_LINK_TOO_LARGE":
      return { key: "errors.validation", ...base };
    default:
      return { key: "errors.unknown", ...base };
  }
}
