/**
 * Structured Google Drive error taxonomy and classification (spec §5.4,
 * §10.2). Every upstream failure lands in one `DriveError` carrying a
 * machine-readable reason, a bounded retry signal and sanitized details —
 * never credentials, request URLs or tokens.
 *
 * Two layers exist on purpose:
 *   - `classifyHttpError` / `classifyThrownError` build DriveError from raw
 *     HTTP responses and fetch failures;
 *   - `driveErrorToApiCode` maps a DriveError onto the public error-code
 *     vocabulary of `ApiErrorBody` for the route layer (T05+), provider-aware
 *     so an SA content failure can never masquerade as a catalog problem.
 */

import type { ApiErrorCode } from '../../shared/contracts/common';
import type {
  DriveProviderKind,
  TokenFailureKind,
  TokenResult,
} from './types';

/** Why a Google Drive operation failed, from the caller's perspective. */
export type DriveFailureReason =
  /** Upstream rejected the request shape (4xx not otherwise classified). */
  | 'invalid-request'
  /** 401 — the presented token was rejected; refresh once or give up. */
  | 'unauthorized'
  /** 403 permission class — credential lacks access to the resource. */
  | 'permission-denied'
  /** 404 — file, revision or upload session not found for this identity. */
  | 'not-found'
  /** 410 — resource or upload session permanently gone/expired. */
  | 'gone'
  /** 409 — e.g. create collided with the pinned generated file ID. */
  | 'conflict'
  /** 412 — precondition failed. */
  | 'precondition-failed'
  /** 429 or 403 rate-limit class — per-user/per-project rate limiting. */
  | 'rate-limited'
  /** 403 project/tenant quota class (dailyLimitExceeded, quotaExceeded). */
  | 'quota-exceeded'
  /** 403 write-side storage exhaustion (storageQuotaExceeded). */
  | 'storage-full'
  /** 403 file-level download restriction (download quota/virus policy). */
  | 'download-restricted'
  /** 5xx — Google-side transient failure. */
  | 'upstream-unavailable'
  /** 3xx received where the operation contract never expects a redirect. */
  | 'unexpected-redirect'
  /** Successful status but malformed body/missing required header. */
  | 'unexpected-response'
  /** fetch() threw before a response existed (DNS/TLS/reset/abort noise). */
  | 'transport-error'
  /** Local attempt deadline elapsed. */
  | 'timeout'
  /** Caller cancellation propagated (AbortSignal); not an upstream fault. */
  | 'aborted'
  /** Refused before fetch: destination outside the allowed host policy. */
  | 'destination-refused'
  /** Refused before fetch: operation not in the provider allowlist. */
  | 'operation-not-allowed'
  /** Refused before fetch: caller input failed provider-side validation. */
  | 'invalid-input'
  /** Coordinator refused admission: credential disabled/degraded (no fetch). */
  | 'credential-disabled'
  /** Coordinator refused admission: supplied version is stale (no fetch). */
  | 'credential-version-changed';

export class DriveError extends Error {
  readonly reason: DriveFailureReason;
  /** Upstream HTTP status when a response existed. */
  readonly status?: number;
  /** Google's `errors[].reason` tokens, when the error body supplied them. */
  readonly googleReasons: readonly string[];
  /** True only for classes where an immediate retry may legitimately help. */
  readonly retryable: boolean;
  /** Retry-After hint from upstream (ms), already parsed and bounded. */
  readonly retryAfterMs?: number;
  /** Internal operation name, for redacted diagnostics. */
  readonly operation?: string;

  constructor(
    reason: DriveFailureReason,
    message: string,
    options: {
      status?: number;
      googleReasons?: readonly string[];
      retryable?: boolean;
      retryAfterMs?: number;
      operation?: string;
      cause?: unknown;
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'DriveError';
    this.reason = reason;
    if (options.status !== undefined) this.status = options.status;
    this.googleReasons = options.googleReasons ?? [];
    this.retryable = options.retryable ?? false;
    if (options.retryAfterMs !== undefined) this.retryAfterMs = options.retryAfterMs;
    if (options.operation !== undefined) this.operation = options.operation;
  }
}

export function isDriveError(err: unknown): err is DriveError {
  return err instanceof DriveError;
}

// ---------------------------------------------------------------------------
// Google error-body parsing
// ---------------------------------------------------------------------------

/** Cap on upstream error-body reads: enough for the reasons, never more. */
const MAX_ERROR_BODY_BYTES = 16 * 1024;
/** Cap on captured upstream messages folded into DriveError.message. */
const MAX_UPSTREAM_MESSAGE_CHARS = 300;
/** Retry-After values above this are surfaced, never slept inline. */
const MAX_HONORED_RETRY_AFTER_MS = 5 * 60 * 1000;

interface GoogleErrorBody {
  error?: {
    code?: number;
    message?: string;
    errors?: Array<{ reason?: string; domain?: string; message?: string }>;
  };
}

/**
 * Google Drive error reasons that mean "slow down" rather than "denied".
 * Rate-limit classes are the only retryable 403s.
 */
const RATE_LIMIT_GOOGLE_REASONS = new Set([
  'rateLimitExceeded',
  'userRateLimitExceeded',
]);

/** Project/tenant quota exhaustion — cooldown scope is the whole project. */
const PROJECT_QUOTA_GOOGLE_REASONS = new Set([
  'dailyLimitExceeded',
  'quotaExceeded',
  'projectLimitExceeded',
]);

/** File-level download caps: cooldown the file, never rotate SAs (§5.4). */
const DOWNLOAD_RESTRICTION_GOOGLE_REASONS = new Set([
  'cannotDownloadFile',
  'downloadQuotaExceeded',
  'fileDownloadLimitExceeded',
]);

const RETRYABLE_REASONS = new Set<DriveFailureReason>([
  'rate-limited',
  'upstream-unavailable',
  'transport-error',
  'timeout',
]);

/** Read a bounded prefix of a response body as text; always terminates. */
export async function readBoundedBodyText(
  body: ReadableStream<Uint8Array> | null,
  maxBytes = MAX_ERROR_BODY_BYTES,
): Promise<string> {
  if (body === null) return '';
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
    }
  } catch {
    // A broken body still yields whatever prefix arrived.
  } finally {
    try {
      await reader.cancel();
    } catch {
      // Nothing to do; the stream is already broken.
    }
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

/** Parse `Retry-After` (delta-seconds or HTTP-date) into bounded ms. */
export function parseRetryAfterMs(header: string | null): number | undefined {
  if (header === null) return undefined;
  const seconds = /^[0-9]{1,7}$/.test(header.trim())
    ? Number.parseInt(header.trim(), 10)
    : undefined;
  let ms: number | undefined;
  if (seconds !== undefined) {
    ms = seconds * 1000;
  } else {
    const dateMs = Date.parse(header);
    if (!Number.isNaN(dateMs)) {
      ms = Math.max(0, dateMs - Date.now());
    }
  }
  if (ms === undefined) return undefined;
  return Math.min(ms, MAX_HONORED_RETRY_AFTER_MS);
}

function truncateMessage(message: string): string {
  const singleLine = message.replace(/[\r\n]+/g, ' ').trim();
  return singleLine.length > MAX_UPSTREAM_MESSAGE_CHARS
    ? `${singleLine.slice(0, MAX_UPSTREAM_MESSAGE_CHARS)}…`
    : singleLine;
}

interface ParsedUpstream {
  reasons: string[];
  message?: string;
}

async function parseUpstreamErrorBody(res: Response): Promise<ParsedUpstream> {
  const text = await readBoundedBodyText(res.body);
  if (text === '') return { reasons: [] };
  try {
    const parsed = JSON.parse(text) as GoogleErrorBody;
    const err = parsed?.error;
    if (typeof err !== 'object' || err === null) return { reasons: [] };
    const reasons = Array.isArray(err.errors)
      ? err.errors
          .map((entry) => entry?.reason)
          .filter((r): r is string => typeof r === 'string' && r !== '')
      : [];
    return {
      reasons,
      message: typeof err.message === 'string' ? err.message : undefined,
    };
  } catch {
    return { reasons: [] };
  }
}

/**
 * Consume an error (non-success) Response and classify it. Reads a bounded
 * body for Google reason tokens; callers own nothing afterwards.
 */
export async function classifyHttpError(
  res: Response,
  operation?: string,
): Promise<DriveError> {
  const retryAfterMs = parseRetryAfterMs(res.headers.get('retry-after'));
  const upstream = await parseUpstreamErrorBody(res);
  return classifyHttpStatus(res.status, {
    operation,
    googleReasons: upstream.reasons,
    upstreamMessage: upstream.message,
    retryAfterMs,
  });
}

/** Classify an HTTP status (+ optional Google reasons) into a DriveError. */
export function classifyHttpStatus(
  status: number,
  options: {
    operation?: string;
    googleReasons?: readonly string[];
    upstreamMessage?: string;
    retryAfterMs?: number;
  } = {},
): DriveError {
  const googleReasons = options.googleReasons ?? [];
  const reasonSet = new Set(googleReasons);

  let reason: DriveFailureReason;
  if (status === 400) {
    reason = 'invalid-request';
  } else if (status === 401) {
    reason = 'unauthorized';
  } else if (status === 403) {
    if (googleReasons.some((r) => RATE_LIMIT_GOOGLE_REASONS.has(r))) {
      reason = 'rate-limited';
    } else if (googleReasons.some((r) => PROJECT_QUOTA_GOOGLE_REASONS.has(r))) {
      reason = 'quota-exceeded';
    } else if (reasonSet.has('storageQuotaExceeded')) {
      reason = 'storage-full';
    } else if (
      googleReasons.some((r) => DOWNLOAD_RESTRICTION_GOOGLE_REASONS.has(r))
    ) {
      reason = 'download-restricted';
    } else {
      reason = 'permission-denied';
    }
  } else if (status === 404) {
    reason = 'not-found';
  } else if (status === 409) {
    reason = 'conflict';
  } else if (status === 410) {
    reason = 'gone';
  } else if (status === 412) {
    reason = 'precondition-failed';
  } else if (status === 429) {
    reason = 'rate-limited';
  } else if (status >= 500 && status <= 599) {
    reason = 'upstream-unavailable';
  } else if (status >= 300 && status < 400) {
    // Fetch runs redirect:'manual'; any 3xx an op did not whitelist lands here.
    reason = 'unexpected-redirect';
  } else if (status >= 400 && status < 500) {
    reason = 'invalid-request';
  } else {
    reason = 'unexpected-response';
  }

  const retryable = RETRYABLE_REASONS.has(reason);
  const detail = options.upstreamMessage
    ? `: ${truncateMessage(options.upstreamMessage)}`
    : '';
  const op = options.operation ? `${options.operation}: ` : '';
  return new DriveError(
    reason,
    `${op}Google Drive request failed with HTTP ${status} (${reason})${detail}`,
    {
      status,
      googleReasons,
      retryable,
      ...(options.retryAfterMs === undefined
        ? {}
        : { retryAfterMs: options.retryAfterMs }),
      ...(options.operation === undefined
        ? {}
        : { operation: options.operation }),
    },
  );
}

/**
 * Classify a fetch() rejection. Caller-cancellation maps to 'aborted'; an
 * elapsing local deadline maps to 'timeout'; everything else is an
 * undifferentiated transport failure (DNS, TLS, resets, stream errors).
 */
export function classifyThrownError(
  err: unknown,
  operation?: string,
  timedOut = false,
): DriveError {
  if (err instanceof DriveError) return err;
  const message =
    err instanceof Error && err.message !== ''
      ? truncateMessage(err.message)
      : 'no upstream message';
  const prefix = operation ? `${operation}: ` : '';
  if (timedOut) {
    return new DriveError('timeout', `${prefix}upstream request timed out`, {
      retryable: true,
      ...(operation === undefined ? {} : { operation }),
      cause: err,
    });
  }
  if (isAbortError(err)) {
    return new DriveError('aborted', `${prefix}request aborted`, {
      ...(operation === undefined ? {} : { operation }),
      cause: err,
    });
  }
  return new DriveError(
    'transport-error',
    `${prefix}upstream transport failed: ${message}`,
    {
      retryable: true,
      ...(operation === undefined ? {} : { operation }),
      cause: err,
    },
  );
}

function isAbortError(err: unknown): boolean {
  return (
    (err instanceof DOMException && err.name === 'AbortError') ||
    (err instanceof Error && err.name === 'AbortError')
  );
}

// ---------------------------------------------------------------------------
// Coordinator token-result mapping
// ---------------------------------------------------------------------------

/**
 * Translate a failed `TokenResult` (admission refused) into a DriveError.
 * No upstream request ever happened; `operation` records which provider
 * method asked for the token. OAUTH_NEEDS_REAUTH and UPSTREAM_AUTH_FAILED
 * both land on 'unauthorized' — the provider/surface mapping downstream
 * distinguishes re-auth from read-pool unavailability.
 */
export function tokenResultToDriveError(
  result: Extract<TokenResult, { ok: false }>,
  operation?: string,
): DriveError {
  const prefix = operation ? `${operation}: ` : '';
  const base = {
    ...(result.retryAfterMs === undefined
      ? {}
      : { retryAfterMs: result.retryAfterMs }),
    ...(operation === undefined ? {} : { operation }),
  };
  switch (result.code) {
    case 'CREDENTIAL_DISABLED':
      return new DriveError(
        'credential-disabled',
        `${prefix}credential is disabled at the coordinator`,
        base,
      );
    case 'CREDENTIAL_VERSION_CHANGED':
      return new DriveError(
        'credential-version-changed',
        `${prefix}credential version changed; caller must re-resolve identity`,
        base,
      );
    case 'OAUTH_NEEDS_REAUTH':
      return new DriveError(
        'unauthorized',
        `${prefix}OAuth connection requires re-authentication`,
        base,
      );
    case 'UPSTREAM_AUTH_FAILED':
      return new DriveError(
        'unauthorized',
        `${prefix}upstream authentication failed while issuing a token`,
        { ...base, retryable: false },
      );
    case 'UPSTREAM_UNAVAILABLE':
      return new DriveError(
        'upstream-unavailable',
        `${prefix}token issuance upstream is unavailable`,
        { ...base, retryable: true },
      );
    case 'COOLDOWN':
      return new DriveError(
        'rate-limited',
        `${prefix}credential is in coordinator cooldown`,
        { ...base, retryable: true },
      );
  }
}

/**
 * Which DriveError classes get reported back to the coordinator for
 * health/cooldown accounting, and under which `TokenFailureKind`. Returns
 * undefined for classes that carry no credential-health signal (caller
 * aborts, malformed input, unexpected shapes, refused destinations).
 */
export function failureKindForDriveError(
  err: DriveError,
): TokenFailureKind | undefined {
  switch (err.reason) {
    case 'unauthorized':
      return 'auth';
    case 'rate-limited':
    case 'quota-exceeded':
      return 'rate_limit';
    case 'download-restricted':
      return 'file_limited';
    case 'upstream-unavailable':
      return 'upstream_5xx';
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// Mapping onto the public API error vocabulary
// ---------------------------------------------------------------------------

/** Which product surface produced the failure; sharpens a few mappings. */
export type ApiErrorSurface =
  | 'catalog'
  | 'content'
  | 'upload'
  | 'upload-session';

export interface ApiErrorContext {
  readonly provider: DriveProviderKind;
  readonly surface: ApiErrorSurface;
}

/**
 * Map a DriveError onto `ApiErrorBody.error.code` (spec §10.2). This is the
 * only place provider/surface nuance enters: an SA unauthorized means the
 * read pool is unhealthy, while an OAuth unauthorized means the connection
 * needs re-authentication — callers never infer one from the other.
 */
export function driveErrorToApiCode(
  err: DriveError,
  context: ApiErrorContext,
): ApiErrorCode {
  const unavailable =
    context.provider === 'service_account'
      ? 'READ_PROVIDER_UNAVAILABLE'
      : 'DRIVE_UNAVAILABLE';

  switch (err.reason) {
    case 'unauthorized':
      return context.provider === 'google_oauth'
        ? 'GOOGLE_REAUTH_REQUIRED'
        : 'READ_PROVIDER_UNAVAILABLE';
    case 'permission-denied':
      return context.provider === 'service_account'
        ? 'FILE_NOT_READABLE_BY_POOL'
        : context.surface === 'content'
          ? 'FILE_NOT_ACCESSIBLE'
          : 'FORBIDDEN';
    case 'not-found':
      if (context.surface === 'upload-session') return 'UPLOAD_EXPIRED';
      return context.provider === 'service_account'
        ? 'FILE_NOT_READABLE_BY_POOL'
        : 'FILE_NOT_ACCESSIBLE';
    case 'gone':
      return context.surface === 'upload' || context.surface === 'upload-session'
        ? 'UPLOAD_EXPIRED'
        : 'FILE_NOT_ACCESSIBLE';
    case 'conflict':
    case 'precondition-failed':
      return 'FILE_CONFLICT';
    case 'rate-limited':
      return 'RATE_LIMITED';
    case 'quota-exceeded':
      return 'PROJECT_LIMITED';
    case 'storage-full':
      return 'STORAGE_FULL';
    case 'download-restricted':
      return 'FILE_NOT_READABLE_BY_POOL';
    case 'aborted':
      return context.surface === 'upload' || context.surface === 'upload-session'
        ? 'UPLOAD_NEEDS_RECONCILIATION'
        : unavailable;
    case 'unexpected-redirect':
    case 'unexpected-response':
    case 'transport-error':
    case 'timeout':
    case 'upstream-unavailable':
      return unavailable;
    case 'credential-disabled':
      return context.provider === 'google_oauth'
        ? 'GOOGLE_CONNECTION_DISABLED'
        : 'READ_PROVIDER_UNAVAILABLE';
    case 'invalid-request':
    case 'destination-refused':
    case 'operation-not-allowed':
    case 'invalid-input':
    case 'credential-version-changed':
      // Programming/policy failures surface as internal, never as a
      // user-actionable Drive error.
      return 'INTERNAL_ERROR';
  }
}
