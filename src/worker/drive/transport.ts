/**
 * Google Drive transport (spec §5.1, §7.1, §9): the only path by which
 * providers talk to Google. Enforces three policies before any byte leaves:
 *
 *   1. Operation allowlist — every request names a closed `DriveOperation`;
 *      the operation's owning provider, HTTP method, destination class and
 *      expected statuses are fixed here, so a service-account transport
 *      cannot express a Drive mutation at all.
 *   2. Destination policy — URLs are built on the fixed googleapis.com host
 *      under /drive/v3/ or /upload/drive/v3/; the only absolute URLs allowed
 *      are resumable-session URIs and thumbnail hosts under
 *      *.googleusercontent.com, both re-validated per request. Redirects are
 *      never followed automatically, so bearer tokens cannot leak off-host.
 *   3. Bounded retries — replayable operations retry a small number of times
 *      on retryable classes with exponential backoff + jitter and a bounded
 *      Retry-After honour; streaming bodies are never retried, and long
 *      Retry-After values are surfaced to the coordinator instead of slept
 *      through (no quota evasion).
 *
 * Streaming request bodies cross to upstream through FixedLengthStream so
 * the runtime derives Content-Length and fetch/pipe run concurrently
 * (spec §6.3); response bodies are returned unconsumed.
 */

import {
  classifyHttpError,
  classifyThrownError,
  DriveError,
} from './errors';
import type { DriveProviderKind } from './types';

export const GOOGLE_API_ORIGIN = 'https://www.googleapis.com';
export const DRIVE_API_PATH_PREFIX = '/drive/v3/';
export const UPLOAD_API_PATH_PREFIX = '/upload/drive/v3/';
export const GOOGLE_USERCONTENT_HOST_SUFFIX = '.googleusercontent.com';

// ---------------------------------------------------------------------------
// Operation allowlist
// ---------------------------------------------------------------------------

type DriveDestination =
  /** Path forced under /drive/v3/ on www.googleapis.com. */
  | 'drive-api'
  /** Path forced under /upload/drive/v3/ on www.googleapis.com. */
  | 'upload-api'
  /** Absolute resumable-session URI (re-validated to upload path + host). */
  | 'session-uri'
  /** Absolute thumbnail URL under *.googleusercontent.com (https only). */
  | 'googleusercontent';

/**
 * Shape a JSON request body must have for an operation whose body carries
 * authority (a permission grant). The caller can choose only the e-mail
 * address; every other field is a fixed literal and no extra key is allowed.
 */
interface PinnedJsonBody {
  /** Exact key set of the JSON object (order-insensitive, no extras). */
  readonly keys: readonly string[];
  /** Keys whose value must equal this literal string. */
  readonly literals: Readonly<Record<string, string>>;
  /** Key holding an e-mail address: syntax-checked, otherwise caller-chosen. */
  readonly emailKey: string;
}

interface DriveOperationSpec {
  readonly provider: DriveProviderKind;
  readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  readonly destination: DriveDestination;
  /**
   * Required path shape on the allowlisted host. The operation name alone
   * is not enough: 'sa.files.get' on the bare collection path would be a
   * catalog list, and 'oauth.files.get' with alt=media would cross the
   * content boundary. The path must match and the query is constrained to
   * the operation's keys.
   */
  readonly pathPattern?: RegExp;
  /** Caller-supplied query keys allowed (undefined = unconstrained). */
  readonly queryKeys?: readonly string[];
  /** Query keys that must be present on the final URL. */
  readonly requiredQueryKeys?: readonly string[];
  /** Key=value pairs that must match exactly on the final URL. */
  readonly requiredQuery?: Record<string, string>;
  /** When set, the request must carry a JSON body of exactly this shape. */
  readonly pinnedBody?: PinnedJsonBody;
  /**
   * Request body is buffered/replayable, so the operation participates in
   * bounded retry. Streaming bodies are never retried.
   */
  readonly replayable: boolean;
  /** Statuses handed to the caller; anything else is classified as failure. */
  readonly passStatuses: readonly number[];
}

/**
 * The closed operation vocabulary. SA operations are reads by construction:
 * there is no `service_account` spec whose method could mutate Drive state.
 */
const DRIVE_OPERATIONS = {
  'oauth.files.list': {
    provider: 'google_oauth',
    method: 'GET',
    destination: 'drive-api',
    pathPattern: /^\/drive\/v3\/files$/,
    queryKeys: [
      'q',
      'corpora',
      'driveId',
      'includeItemsFromAllDrives',
      'supportsAllDrives',
      'fields',
      'pageSize',
      'pageToken',
      'orderBy',
      'spaces',
    ],
    replayable: true,
    passStatuses: [200],
  },
  'oauth.files.get': {
    provider: 'google_oauth',
    method: 'GET',
    destination: 'drive-api',
    pathPattern: /^\/drive\/v3\/files\/[^/]+$/,
    queryKeys: ['supportsAllDrives', 'fields'],
    replayable: true,
    passStatuses: [200],
  },
  'oauth.about.get': {
    provider: 'google_oauth',
    method: 'GET',
    destination: 'drive-api',
    pathPattern: /^\/drive\/v3\/about$/,
    queryKeys: ['fields'],
    replayable: true,
    passStatuses: [200],
  },
  // Shared Drive chooser (T11): only drives the operator identity can see.
  'oauth.drives.list': {
    provider: 'google_oauth',
    method: 'GET',
    destination: 'drive-api',
    pathPattern: /^\/drive\/v3\/drives$/,
    queryKeys: ['pageSize', 'pageToken', 'fields', 'useDomainAdminAccess'],
    requiredQuery: { useDomainAdminAccess: 'false' },
    replayable: true,
    passStatuses: [200],
  },
  'oauth.files.generateIds': {
    provider: 'google_oauth',
    method: 'GET',
    destination: 'drive-api',
    pathPattern: /^\/drive\/v3\/files\/generateIds$/,
    queryKeys: ['count', 'space', 'type', 'supportsAllDrives'],
    replayable: true,
    passStatuses: [200],
  },
  'oauth.files.create': {
    provider: 'google_oauth',
    method: 'POST',
    destination: 'drive-api',
    pathPattern: /^\/drive\/v3\/files$/,
    queryKeys: ['supportsAllDrives', 'fields'],
    replayable: true,
    passStatuses: [200],
  },
  'oauth.upload.start': {
    provider: 'google_oauth',
    method: 'POST',
    destination: 'upload-api',
    pathPattern: /^\/upload\/drive\/v3\/files$/,
    queryKeys: ['uploadType', 'supportsAllDrives'],
    requiredQuery: { uploadType: 'resumable' },
    replayable: true,
    passStatuses: [200],
  },
  'oauth.upload.chunk': {
    provider: 'google_oauth',
    method: 'PUT',
    destination: 'session-uri',
    pathPattern: /^\/upload\/drive\/v3\/files$/,
    queryKeys: ['uploadType', 'upload_id', 'upload_protocol'],
    requiredQuery: { uploadType: 'resumable' },
    replayable: false,
    passStatuses: [200, 201, 308],
  },
  'oauth.upload.probe': {
    provider: 'google_oauth',
    method: 'PUT',
    destination: 'session-uri',
    pathPattern: /^\/upload\/drive\/v3\/files$/,
    queryKeys: ['uploadType', 'upload_id', 'upload_protocol'],
    requiredQuery: { uploadType: 'resumable' },
    replayable: true,
    passStatuses: [200, 201, 308],
  },
  'oauth.files.update': {
    provider: 'google_oauth',
    method: 'PATCH',
    destination: 'drive-api',
    pathPattern: /^\/drive\/v3\/files\/[^/]+$/,
    queryKeys: ['supportsAllDrives', 'fields', 'addParents', 'removeParents'],
    replayable: true,
    passStatuses: [200],
  },
  // My Drive read-pool grants (wave 7): the app shares the mount root folder
  // with pool SAs. Always the mount's WRITE connection; the query pins
  // `supportsAllDrives=true` and (for create) `sendNotificationEmail=false`,
  // and the body is pinned to {type:'user', role:'reader', emailAddress}.
  'oauth.permissions.list': {
    provider: 'google_oauth',
    method: 'GET',
    destination: 'drive-api',
    pathPattern: /^\/drive\/v3\/files\/[^/]+\/permissions$/,
    queryKeys: ['supportsAllDrives', 'fields', 'pageSize', 'pageToken'],
    requiredQuery: {
      supportsAllDrives: 'true',
      fields: 'permissions(id,type,role,emailAddress),nextPageToken',
    },
    replayable: true,
    passStatuses: [200],
  },
  'oauth.permissions.create': {
    provider: 'google_oauth',
    method: 'POST',
    destination: 'drive-api',
    pathPattern: /^\/drive\/v3\/files\/[^/]+\/permissions$/,
    queryKeys: ['sendNotificationEmail', 'supportsAllDrives', 'fields'],
    requiredQuery: {
      sendNotificationEmail: 'false',
      supportsAllDrives: 'true',
      fields: 'id',
    },
    pinnedBody: {
      keys: ['type', 'role', 'emailAddress'],
      literals: { type: 'user', role: 'reader' },
      emailKey: 'emailAddress',
    },
    // Not replayed by the transport: the sync loop owns retry and rate-limit
    // pacing (a replayed grant would also burn the sharing quota twice).
    replayable: false,
    passStatuses: [200],
  },
  'oauth.permissions.delete': {
    provider: 'google_oauth',
    method: 'DELETE',
    destination: 'drive-api',
    pathPattern: /^\/drive\/v3\/files\/[^/]+\/permissions\/[^/]+$/,
    queryKeys: ['supportsAllDrives'],
    requiredQuery: { supportsAllDrives: 'true' },
    replayable: false,
    passStatuses: [200, 204],
  },
  'sa.files.get': {
    provider: 'service_account',
    method: 'GET',
    destination: 'drive-api',
    pathPattern: /^\/drive\/v3\/files\/[^/]+$/,
    queryKeys: ['supportsAllDrives', 'fields'],
    replayable: true,
    passStatuses: [200],
  },
  'sa.files.media': {
    provider: 'service_account',
    method: 'GET',
    destination: 'drive-api',
    pathPattern: /^\/drive\/v3\/files\/[^/]+$/,
    queryKeys: ['alt', 'supportsAllDrives'],
    requiredQuery: { alt: 'media' },
    replayable: false,
    passStatuses: [200, 206],
  },
  'sa.revisions.get': {
    provider: 'service_account',
    method: 'GET',
    destination: 'drive-api',
    pathPattern: /^\/drive\/v3\/files\/[^/]+\/revisions\/[^/]+$/,
    queryKeys: ['fields'],
    replayable: true,
    passStatuses: [200],
  },
  'sa.revisions.media': {
    provider: 'service_account',
    method: 'GET',
    destination: 'drive-api',
    pathPattern: /^\/drive\/v3\/files\/[^/]+\/revisions\/[^/]+$/,
    queryKeys: ['alt', 'supportsAllDrives'],
    requiredQuery: { alt: 'media' },
    replayable: false,
    passStatuses: [200, 206],
  },
  'sa.files.export': {
    provider: 'service_account',
    method: 'GET',
    destination: 'drive-api',
    pathPattern: /^\/drive\/v3\/files\/[^/]+\/export$/,
    queryKeys: ['mimeType'],
    requiredQueryKeys: ['mimeType'],
    replayable: false,
    passStatuses: [200],
  },
  'sa.thumbnail.fetch': {
    provider: 'service_account',
    method: 'GET',
    destination: 'googleusercontent',
    replayable: false,
    passStatuses: [200],
  },
} as const satisfies Record<string, DriveOperationSpec>;

export type DriveOperation = keyof typeof DRIVE_OPERATIONS;

// ---------------------------------------------------------------------------
// Request/response surface
// ---------------------------------------------------------------------------

export type TransportBody =
  | { readonly kind: 'none' }
  | { readonly kind: 'json'; readonly json: unknown }
  | {
      readonly kind: 'stream';
      /** Must produce exactly `bytes`; FixedLengthStream enforces it. */
      readonly stream: ReadableStream<Uint8Array>;
      readonly bytes: number;
    };

export interface TransportRequest {
  readonly operation: DriveOperation;
  /** Bearer token for Authorization; never logged or echoed. */
  readonly token: string;
  /** Required for 'drive-api'/'upload-api' destinations (path + prefix). */
  readonly path?: string;
  /** Required for 'session-uri'/'googleusercontent' destinations. */
  readonly absoluteUrl?: string;
  readonly query?: Record<string, string | number | boolean | undefined>;
  /** Extra headers merged over the defaults (no Authorization override). */
  readonly headers?: Record<string, string>;
  readonly body?: TransportBody;
  readonly signal?: AbortSignal;
}

export interface DriveTransport {
  /**
   * Perform the request. Resolves with the Response only when the status is
   * in the operation's pass list — body unconsumed. Any other outcome throws
   * a DriveError (error body already consumed and bounded).
   */
  send(request: TransportRequest): Promise<Response>;
}

export interface RetryPolicy {
  /** Total attempts including the first (stream bodies always get 1). */
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  /** Cap on inline-honoured Retry-After; larger hints surface instead. */
  readonly maxHonoredRetryAfterMs: number;
}

const DEFAULT_RETRY: RetryPolicy = {
  maxAttempts: 4,
  baseDelayMs: 250,
  maxDelayMs: 8000,
  maxHonoredRetryAfterMs: 30000,
};

/** Per-attempt connect deadline for non-streaming requests. */
const DEFAULT_REQUEST_TIMEOUT_MS = 30000;

/**
 * Grace period for a stream pipe to finish its abort shutdown. Longer waits
 * cannot help: the source has already been cancelled and a pending pump
 * promise is abandoned, not awaited, so send() never hangs on a fetch that
 * holds a locked body it will not read.
 */
const PUMP_DRAIN_BOUND_MS = 250;

export interface DriveTransportOptions {
  readonly fetchImpl?: typeof fetch;
  readonly retry?: Partial<RetryPolicy>;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
  readonly requestTimeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Destination policy
// ---------------------------------------------------------------------------

function assertGoogleApiUrl(url: URL, operation: DriveOperation): void {
  if (
    url.protocol !== 'https:' ||
    url.origin !== GOOGLE_API_ORIGIN ||
    url.username !== '' ||
    url.password !== '' ||
    (url.port !== '' && url.port !== '443')
  ) {
    throw new DriveError(
      'destination-refused',
      `${operation}: destination is outside the Google API host policy`,
      { operation },
    );
  }
}

function buildUrl(
  spec: DriveOperationSpec,
  operation: DriveOperation,
  request: TransportRequest,
): URL {
  let url: URL;
  switch (spec.destination) {
    case 'drive-api':
    case 'upload-api': {
      if (
        typeof request.path !== 'string' ||
        !request.path.startsWith('/') ||
        request.path.startsWith('//') ||
        /[\\?#%]/.test(request.path)
      ) {
        throw new DriveError(
          'invalid-input',
          `${operation}: a canonical API path is required`,
          { operation },
        );
      }
      url = new URL(request.path, GOOGLE_API_ORIGIN);
      // Protocol-relative and userinfo tricks would silently change the
      // origin — assert the concrete destination after construction.
      assertGoogleApiUrl(url, operation);
      const prefix =
        spec.destination === 'drive-api'
          ? DRIVE_API_PATH_PREFIX
          : UPLOAD_API_PATH_PREFIX;
      if (!url.pathname.startsWith(prefix)) {
        throw new DriveError(
          'destination-refused',
          `${operation}: path escapes the ${prefix} prefix`,
          { operation },
        );
      }
      break;
    }
    case 'session-uri': {
      url = parseAbsoluteDestination(request.absoluteUrl, operation);
      assertGoogleApiUrl(url, operation);
      if (!url.pathname.startsWith(UPLOAD_API_PATH_PREFIX)) {
        throw new DriveError(
          'destination-refused',
          `${operation}: upload session URI is outside ${UPLOAD_API_PATH_PREFIX}`,
          { operation },
        );
      }
      break;
    }
    case 'googleusercontent': {
      url = parseAbsoluteDestination(request.absoluteUrl, operation);
      if (
        url.protocol !== 'https:' ||
        url.username !== '' ||
        url.password !== '' ||
        (url.port !== '' && url.port !== '443') ||
        !(
          url.hostname === 'googleusercontent.com' ||
          url.hostname.endsWith(GOOGLE_USERCONTENT_HOST_SUFFIX)
        )
      ) {
        throw new DriveError(
          'destination-refused',
          `${operation}: URL is outside the *.googleusercontent.com policy`,
          { operation },
        );
      }
      break;
    }
  }

  for (const [key, value] of Object.entries(request.query ?? {})) {
    if (value === undefined) continue;
    if (spec.queryKeys !== undefined && !spec.queryKeys.includes(key)) {
      throw new DriveError(
        'destination-refused',
        `${operation}: query parameter '${key}' is not allowlisted for this operation`,
        { operation },
      );
    }
    url.searchParams.set(key, String(value));
  }
  if (spec.pathPattern !== undefined && !spec.pathPattern.test(url.pathname)) {
    throw new DriveError(
      'destination-refused',
      `${operation}: path does not match the operation's required shape`,
      { operation },
    );
  }
  if (operation === 'oauth.files.list') assertFilesListCorpora(url, operation);
  if (spec.requiredQueryKeys !== undefined) {
    for (const key of spec.requiredQueryKeys) {
      if (!url.searchParams.has(key)) {
        throw new DriveError(
          'destination-refused',
          `${operation}: required query parameter '${key}' is missing`,
          { operation },
        );
      }
    }
  }
  if (spec.requiredQuery !== undefined) {
    for (const [key, expected] of Object.entries(spec.requiredQuery)) {
      if (url.searchParams.get(key) !== expected) {
        throw new DriveError(
          'destination-refused',
          `${operation}: required query parameter '${key}' is missing or mismatched`,
          { operation },
        );
      }
    }
  }
  return url;
}

/**
 * `files.list` corpora rules (wave 7): the corpus is always explicit and is
 * either a Shared Drive (`drive`) or the owner's My Drive (`user`). `driveId`
 * and `includeItemsFromAllDrives` only make sense for `corpora=drive`; they
 * must never ride along on a My Drive listing, where they could silently
 * widen it to every Shared Drive the identity can see.
 */
function assertFilesListCorpora(url: URL, operation: DriveOperation): void {
  const corpora = url.searchParams.get('corpora');
  if (corpora !== 'drive' && corpora !== 'user') {
    throw new DriveError(
      'destination-refused',
      `${operation}: 'corpora' must be 'drive' or 'user'`,
      { operation },
    );
  }
  if (
    corpora !== 'drive' &&
    (url.searchParams.has('driveId') ||
      url.searchParams.has('includeItemsFromAllDrives'))
  ) {
    throw new DriveError(
      'destination-refused',
      `${operation}: 'driveId' and 'includeItemsFromAllDrives' require corpora=drive`,
      { operation },
    );
  }
  if (corpora === 'drive' && !url.searchParams.has('driveId')) {
    throw new DriveError(
      'destination-refused',
      `${operation}: corpora=drive requires a 'driveId'`,
      { operation },
    );
  }
}

function parseAbsoluteDestination(
  absoluteUrl: string | undefined,
  operation: DriveOperation,
): URL {
  if (typeof absoluteUrl !== 'string' || absoluteUrl === '') {
    throw new DriveError(
      'invalid-input',
      `${operation}: an absolute upstream URL is required`,
      { operation },
    );
  }
  try {
    return new URL(absoluteUrl);
  } catch {
    throw new DriveError(
      'destination-refused',
      `${operation}: upstream URL is not parseable`,
      { operation },
    );
  }
}

/** Validate a Google-issued resumable session URI before reuse (spec §6.2). */
export function assertUploadSessionUri(uri: string): string {
  const parsed = parseAbsoluteDestination(uri, 'oauth.upload.probe');
  assertGoogleApiUrl(parsed, 'oauth.upload.probe');
  if (!parsed.pathname.startsWith(UPLOAD_API_PATH_PREFIX)) {
    throw new DriveError(
      'destination-refused',
      'oauth.upload.probe: upload session URI is outside the upload prefix',
      { operation: 'oauth.upload.probe' },
    );
  }
  return uri;
}

/** Conservative e-mail syntax for a pinned grant body (no display names). */
const GRANT_EMAIL_PATTERN = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,63}$/;

/**
 * Reject a request body that does not match the operation's pinned shape, so
 * a caller can never widen a grant (another role/type, extra fields such as
 * `allowFileDiscovery`, or a non-e-mail principal) through this transport.
 */
function assertPinnedBody(
  pin: PinnedJsonBody,
  operation: DriveOperation,
  body: TransportBody | undefined,
): void {
  const refuse = (why: string): never => {
    throw new DriveError('invalid-input', `${operation}: ${why}`, { operation });
  };
  if (body?.kind !== 'json') refuse('a JSON body is required');
  const json = (body as Extract<TransportBody, { kind: 'json' }>).json;
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    refuse('the body must be a JSON object');
  }
  const record = json as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [...pin.keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    refuse('the body has a field set outside the pinned shape');
  }
  for (const [key, literal] of Object.entries(pin.literals)) {
    if (record[key] !== literal) refuse(`body field '${key}' is not the pinned value`);
  }
  const email = record[pin.emailKey];
  if (
    typeof email !== 'string' ||
    email.length > 320 ||
    !GRANT_EMAIL_PATTERN.test(email)
  ) {
    refuse(`body field '${pin.emailKey}' is not a plain e-mail address`);
  }
}

/** Drive file/drive/folder/revision ID charset accepted into API paths. */
const DRIVE_ID_PATTERN = /^[A-Za-z0-9_-]{1,256}$/;

/**
 * Validate one Drive identifier against the conservative charset Google
 * uses (letters, digits, dash, underscore). Anything else is rejected
 * before it can reach a URL or a `q` term.
 */
export function validateDriveId(id: string, operation: string): string {
  if (typeof id !== 'string' || !DRIVE_ID_PATTERN.test(id)) {
    throw new DriveError(
      'invalid-input',
      `${operation}: file or folder ID failed validation`,
      { operation },
    );
  }
  return id;
}

/** Validate and URL-encode one path segment (see validateDriveId). */
export function drivePathSegment(id: string, operation: string): string {
  return encodeURIComponent(validateDriveId(id, operation));
}

// ---------------------------------------------------------------------------
// Signal composition
// ---------------------------------------------------------------------------

function linkSignals(
  sources: readonly (AbortSignal | undefined)[],
  target: AbortController,
): () => void {
  const detach: Array<() => void> = [];
  for (const source of sources) {
    if (source === undefined) continue;
    if (source.aborted) {
      target.abort(source.reason);
      break;
    }
    const onAbort = () => target.abort(source.reason);
    source.addEventListener('abort', onAbort, { once: true });
    detach.push(() => source.removeEventListener('abort', onAbort));
  }
  return () => {
    for (const fn of detach) fn();
  };
}

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * For responses whose body is handed back to the caller (content streams),
 * keep the caller signal alive past the fetch promise: aborting after
 * headers arrived cancels the in-flight body, mirroring what an aborted
 * upstream connection does to a partially-read download.
 */
function linkCallerSignalToBody(
  res: Response,
  callerSignal: AbortSignal | undefined,
): Response {
  if (callerSignal === undefined || res.body === null) return res;
  if (callerSignal.aborted) {
    void res.body.cancel(callerSignal.reason).catch(() => undefined);
    return res;
  }
  const reader = res.body.getReader();
  const onAbort = () => {
    void reader.cancel(callerSignal.reason).catch(() => undefined);
  };
  callerSignal.addEventListener('abort', onAbort, { once: true });
  const detach = () => callerSignal.removeEventListener('abort', onAbort);
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          detach();
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (err) {
        detach();
        controller.error(err);
      }
    },
    async cancel(reason) {
      detach();
      await reader.cancel(reason);
    },
  });
  return new Response(body, res);
}

// ---------------------------------------------------------------------------
// Transport factory
// ---------------------------------------------------------------------------

export function createDriveTransport(
  provider: DriveProviderKind,
  options: DriveTransportOptions = {},
): DriveTransport {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  const retry: RetryPolicy = { ...DEFAULT_RETRY, ...options.retry };
  const requestTimeoutMs =
    options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

  function computeDelay(err: DriveError, attemptIndex: number): number {
    if (
      err.retryAfterMs !== undefined &&
      err.retryAfterMs <= retry.maxHonoredRetryAfterMs
    ) {
      return err.retryAfterMs;
    }
    const exponential = Math.min(
      retry.maxDelayMs,
      retry.baseDelayMs * 2 ** attemptIndex,
    );
    return exponential + exponential * 0.5 * random();
  }

  /**
   * Streamed request bodies: FixedLengthStream enforces the declared length
   * and the upstream fetch starts concurrently with the incoming→outgoing
   * pipe (spec §6.3). Whichever side fails first aborts the other; an early
   * upstream verdict stops the producer instead of hanging the pipe.
   */
  async function sendStreamBody(
    spec: DriveOperationSpec,
    operation: DriveOperation,
    url: URL,
    headers: Headers,
    body: Extract<TransportBody, { kind: 'stream' }>,
    callerSignal: AbortSignal | undefined,
  ): Promise<Response> {
    const framed = new FixedLengthStream(body.bytes);
    const controller = new AbortController();
    const unlink = linkSignals([callerSignal], controller);

    let pumpSettled = false;
    let pumpError: unknown;
    let fetchSettled = false;
    // Manual pump with owned reader/writer: pipeTo's own shutdown aborts the
    // destination BEFORE cancelling the source, and that abort waits on
    // writes that can never drain once fetch has answered — a guaranteed
    // deadlock. With an owned reader the producer can always be cancelled
    // directly; a blocked write only stalls the writable side, which is
    // bounded below instead of awaited.
    const reader = body.stream.getReader();
    const writer = framed.writable.getWriter();
    const pump = (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) {
            await writer.close();
            return;
          }
          await writer.write(value);
        }
      } catch (err) {
        // Propagate toward fetch best-effort — fired, not awaited, because a
        // pending write can stall writer.abort() indefinitely.
        void writer.abort(err).catch(() => undefined);
        throw err;
      }
    })();
    pump.then(
      () => {
        pumpSettled = true;
      },
      (err: unknown) => {
        pumpSettled = true;
        pumpError = err;
        // A failed producer must also take down a fetch still waiting for
        // its body — but never after a response has been handed back, where
        // the signal still governs the returned stream.
        if (!fetchSettled) {
          controller.abort(
            err instanceof Error ? err : new Error(String(err)),
          );
        }
      },
    );

    try {
      const res = await fetchImpl(url.toString(), {
        method: spec.method,
        headers,
        body: framed.readable,
        redirect: 'manual',
        signal: controller.signal,
      });
      fetchSettled = true;
      if (spec.passStatuses.includes(res.status)) return res;
      throw await classifyHttpError(res, operation);
    } catch (err) {
      fetchSettled = true;
      const cause = err instanceof DriveError ? err : (pumpError ?? err);
      throw classifyThrownError(cause, operation);
    } finally {
      unlink();
      if (!pumpSettled) {
        // Upstream answered (or failed) while the producer still had bytes:
        // cancel the source — we own the reader so this always lands. The
        // fetch has already settled here, so its signal must NOT be aborted:
        // in workerd it still governs the response body and would kill a
        // returned stream.
        const stop = new DriveError(
          'aborted',
          `${operation}: upstream answered before the request body completed`,
          { operation },
        );
        try {
          await reader.cancel(stop);
        } catch {
          // Source already closed/errored.
        }
        // writer.abort() can stall on a write that no readable will ever
        // drain (fetch holding a locked, unconsumed body) — bounded wait:
        // the producer is already cancelled either way.
        await Promise.race([
          (async () => {
            try {
              await writer.abort(stop);
            } catch {
              // Blocked or already aborted.
            }
            await pump.catch(() => undefined);
          })(),
          sleep(PUMP_DRAIN_BOUND_MS),
        ]);
      }
    }
  }

  async function sendOnce(
    spec: DriveOperationSpec,
    operation: DriveOperation,
    url: URL,
    headers: Headers,
    body: TransportBody | undefined,
    callerSignal: AbortSignal | undefined,
  ): Promise<Response> {
    if (body?.kind === 'stream') {
      return sendStreamBody(spec, operation, url, headers, body, callerSignal);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort(new DriveError('timeout', `${operation}: timed out`, { operation }));
    }, requestTimeoutMs);
    const unlink = linkSignals([callerSignal], controller);

    let initBody: BodyInit | undefined;
    if (body?.kind === 'json') initBody = JSON.stringify(body.json);

    try {
      const res = await fetchImpl(url.toString(), {
        method: spec.method,
        headers,
        ...(initBody === undefined ? {} : { body: initBody }),
        redirect: 'manual',
        signal: controller.signal,
      });
      if (spec.passStatuses.includes(res.status)) {
        return linkCallerSignalToBody(res, callerSignal);
      }
      throw await classifyHttpError(res, operation);
    } catch (err) {
      const timedOut =
        controller.signal.aborted &&
        controller.signal.reason instanceof DriveError &&
        controller.signal.reason.reason === 'timeout';
      const cause =
        err instanceof DriveError
          ? err
          : controller.signal.aborted
            ? (controller.signal.reason ?? err)
            : err;
      throw classifyThrownError(cause, operation, timedOut);
    } finally {
      clearTimeout(timer);
      unlink();
    }
  }

  return {
    async send(request) {
      const spec = DRIVE_OPERATIONS[request.operation];
      if (spec === undefined || spec.provider !== provider) {
        throw new DriveError(
          'operation-not-allowed',
          `${request.operation}: operation is not allowlisted for provider ${provider}`,
          { operation: request.operation },
        );
      }
      if (request.body?.kind === 'stream' && spec.replayable) {
        // A streamed body on a replayable op would retry a consumed stream.
        throw new DriveError(
          'invalid-input',
          `${request.operation}: streamed bodies are not replayable`,
          { operation: request.operation },
        );
      }

      if ('pinnedBody' in spec) {
        assertPinnedBody(spec.pinnedBody, request.operation, request.body);
      }
      const url = buildUrl(spec, request.operation, request);
      const headers = new Headers(request.headers ?? {});
      headers.set('Authorization', `Bearer ${request.token}`);
      if (request.body?.kind === 'json') {
        headers.set('Content-Type', 'application/json; charset=utf-8');
      }

      const replayable = spec.replayable && request.body?.kind !== 'stream';
      const maxAttempts = replayable ? Math.max(1, retry.maxAttempts) : 1;
      let lastError: DriveError | undefined;

      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
          return await sendOnce(
            spec,
            request.operation,
            url,
            headers,
            request.body,
            request.signal,
          );
        } catch (err) {
          const driveErr =
            err instanceof DriveError
              ? err
              : classifyThrownError(err, request.operation);
          lastError = driveErr;
          const retryWorthy =
            replayable && driveErr.retryable && attempt + 1 < maxAttempts;
          const bigRetryAfter =
            driveErr.retryAfterMs !== undefined &&
            driveErr.retryAfterMs > retry.maxHonoredRetryAfterMs;
          if (!retryWorthy || bigRetryAfter) throw driveErr;
          await sleep(computeDelay(driveErr, attempt));
        }
      }
      // Unreachable in practice; satisfies noImplicitReturns.
      throw lastError ?? new DriveError('unexpected-response', 'no attempt ran');
    },
  };
}
