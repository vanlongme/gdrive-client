import { z } from 'zod';

// Byte counts and offsets crossing the public API are decimal strings
// (spec section 10.1, plan T02). Bigint arithmetic only; a bounded length
// keeps hostile inputs small while covering any realistic file size.
export const DECIMAL_BYTES_PATTERN = /^(0|[1-9][0-9]*)$/;
export const DecimalBytesSchema = z
  .string()
  .regex(DECIMAL_BYTES_PATTERN, 'expected a base-10 non-negative integer')
  .max(30);
export type DecimalBytes = z.infer<typeof DecimalBytesSchema>;

export function decimalBytesToBigInt(value: DecimalBytes): bigint {
  return BigInt(value);
}

export function decimalBytesFromBigInt(value: bigint): DecimalBytes {
  const text = value.toString(10);
  const parsed = DecimalBytesSchema.safeParse(text);
  if (!parsed.success) throw new RangeError('not a valid DecimalBytes value');
  return parsed.data;
}

export const IdSchema = z.string().min(1).max(256);

export const IsoTimestampSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/);
export type IsoTimestamp = z.infer<typeof IsoTimestampSchema>;

export const CONTENT_MODES = ['current-content', 'pinned-revision'] as const;
export const ContentModeSchema = z.enum(CONTENT_MODES);
export type ContentMode = z.infer<typeof ContentModeSchema>;

export const READER_ACCESS_STATES = [
  'unchecked',
  'pending',
  'readable',
  'blocked',
] as const;
export const ReaderAccessStateSchema = z.enum(READER_ACCESS_STATES);
export type ReaderAccessState = z.infer<typeof ReaderAccessStateSchema>;

// Error codes from spec section 10.2.
export const SPEC_ERROR_CODES = [
  'AUTH_REQUIRED',
  'FORBIDDEN',
  'DRIVE_UNAVAILABLE',
  'FILE_NOT_ACCESSIBLE',
  'RATE_LIMITED',
  'PROJECT_LIMITED',
  'STORAGE_FULL',
  'GOOGLE_REAUTH_REQUIRED',
  'GOOGLE_CONNECTION_DISABLED',
  'READ_PROVIDER_UNAVAILABLE',
  'FILE_NOT_READABLE_BY_POOL',
  'UPLOAD_EXPIRED',
  'UPLOAD_NEEDS_RECONCILIATION',
  'FILE_CONFLICT',
  'SNAPSHOT_UNAVAILABLE',
  'CONTENT_CHANGED',
  'MEDIA_PACKAGE_NOT_READY',
  'PREVIEW_UNSUPPORTED',
] as const;

// Internal codes added by this contract layer (documented in
// docs/evidence/W1-B.md): request validation, setup lifecycle, bootstrap
// secret and not-yet-implemented surfaces (emitted by the runtime worker),
// idempotency replay conflicts and generic routing/internal failures.
export const INTERNAL_ERROR_CODES = [
  'VALIDATION_FAILED',
  'NOT_FOUND',
  'SETUP_REQUIRED',
  'SETUP_TOKEN_INVALID',
  'SETUP_ALREADY_COMPLETED',
  'SETUP_IN_PROGRESS',
  'SETUP_STATUS_UNAVAILABLE',
  'SETUP_NOT_IMPLEMENTED',
  'AUTH_NOT_IMPLEMENTED',
  'AUTH_UNAVAILABLE',
  'ORIGIN_REJECTED',
  'BOOTSTRAP_SECRETS_INVALID',
  'IDEMPOTENCY_CONFLICT',
  'MOUNT_KIND_UNSUPPORTED',
  'INTERNAL_ERROR',
] as const;

// Mount target validation (wave 7, spec 2026-10-18 §6). All HTTP 400;
// the SPA localizes each code (src/web/lib/error-message.ts).
export const MOUNT_ERROR_CODES = [
  'MOUNT_ROOT_NOT_FOLDER',
  'MOUNT_ROOT_NOT_OWNED',
  'MOUNT_ROOT_IS_MY_DRIVE',
  'MOUNT_ROOT_TRASHED',
  'MOUNT_ROOT_NOT_WRITABLE',
  'MOUNT_WRITER_MISMATCH',
] as const;

// Public folder links (wave 8 Phase B2): link lifecycle and access surface
// under /api/v1/p plus admin conflict/limit failures on /api/v1/public-links.
export const PUBLIC_LINK_ERROR_CODES = [
  'PUBLIC_LINK_EXPIRED',
  'PUBLIC_LINK_PASSWORD_REQUIRED',
  'PUBLIC_LINK_INVALID_PASSWORD',
  'PUBLIC_LINK_CONFLICT',
  'PUBLIC_LINK_ARCHIVE_DISABLED',
  'PUBLIC_LINK_TOO_LARGE',
] as const;

export const API_ERROR_CODES = [
  ...SPEC_ERROR_CODES,
  ...INTERNAL_ERROR_CODES,
  ...MOUNT_ERROR_CODES,
  ...PUBLIC_LINK_ERROR_CODES,
] as const;
export const ApiErrorCodeSchema = z.enum(API_ERROR_CODES);
export type ApiErrorCode = z.infer<typeof ApiErrorCodeSchema>;

export const ApiErrorBodySchema = z
  .object({
    error: z
      .object({
        code: ApiErrorCodeSchema,
        message: z.string().min(1).max(1000),
        requestId: z.string().min(1).max(128),
        retryAfterSeconds: z.number().int().min(0).max(86400).optional(),
      })
      .strict(),
  })
  .strict();
export type ApiErrorBody = z.infer<typeof ApiErrorBodySchema>;

export function apiError(
  code: ApiErrorCode,
  message: string,
  requestId: string,
  retryAfterSeconds?: number,
): ApiErrorBody {
  return {
    error: { code, message, requestId, ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }) },
  };
}
