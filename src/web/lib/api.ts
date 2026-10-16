import { z } from "zod";
import {
  ApiErrorBodySchema,
  type ApiErrorCode,
} from "../../shared/contracts/common";
import {
  SessionViewSchema,
  SetupStatusViewSchema,
  type AppRole,
  type SetupStatusView,
} from "../../shared/contracts/admin";
import {
  FileChildrenPageSchema,
  FileDetailSchema,
  MountVisibilitySchema,
  SearchPageSchema,
  type FileChildrenPage,
  type FileDetail,
  type SearchPage,
  type SearchScope,
} from "../../shared/contracts/drive";
import {
  CreateShareResponseSchema,
  ShareListResponseSchema,
  type CreateShareRequest,
  type CreateShareResponse,
  type ShareListResponse,
} from "../../shared/contracts/media";

/**
 * Client-side failure for any non-2xx API response or network error. `code`
 * carries the server's documented error code when the body matches
 * ApiErrorBody, otherwise a local sentinel.
 */
export class ApiClientError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode | "NETWORK_ERROR" | "UNEXPECTED_RESPONSE";
  readonly requestId: string | undefined;
  readonly retryAfterSeconds: number | undefined;

  constructor(
    message: string,
    init: {
      status: number;
      code: ApiClientError["code"];
      requestId?: string;
      retryAfterSeconds?: number;
    },
  ) {
    super(message);
    this.name = "ApiClientError";
    this.status = init.status;
    this.code = init.code;
    this.requestId = init.requestId;
    this.retryAfterSeconds = init.retryAfterSeconds;
  }
}

export async function apiFetch(
  path: string,
  init?: RequestInit & { jsonBody?: unknown },
): Promise<Response> {
  const { jsonBody, ...rest } = init ?? {};
  const headers = new Headers(rest.headers);
  headers.set("Accept", "application/json");
  let body = rest.body;
  if (jsonBody !== undefined) {
    headers.set("Content-Type", "application/json");
    body = JSON.stringify(jsonBody);
  }
  let res: Response;
  try {
    res = await fetch(path, { ...rest, headers, body });
  } catch {
    throw new ApiClientError("Network request failed.", {
      status: 0,
      code: "NETWORK_ERROR",
    });
  }
  if (res.ok) return res;

  let code: ApiClientError["code"] = "INTERNAL_ERROR";
  let message = `Request failed with status ${res.status}.`;
  let requestId: string | undefined;
  let retryAfterSeconds: number | undefined;
  try {
    const parsed = ApiErrorBodySchema.safeParse(await res.json());
    if (parsed.success) {
      code = parsed.data.error.code;
      message = parsed.data.error.message;
      requestId = parsed.data.error.requestId;
      retryAfterSeconds = parsed.data.error.retryAfterSeconds;
    }
  } catch {
    // Non-JSON error body: keep the generic failure above.
  }
  throw new ApiClientError(message, {
    status: res.status,
    code,
    requestId,
    retryAfterSeconds,
  });
}

export async function parseJson<T>(res: Response, schema: z.ZodType<T>): Promise<T> {
  const parsed = schema.safeParse(await res.json());
  if (!parsed.success) {
    throw new ApiClientError("Unexpected response body.", {
      status: res.status,
      code: "UNEXPECTED_RESPONSE",
    });
  }
  return parsed.data;
}

// --- Setup (spec section 9.1, wave-2 contract) ---

export interface SetupRequestBody {
  token: string;
  name: string;
  email: string;
  password: string;
  canonicalOrigin: string;
}

export function getSetupStatus(): Promise<SetupStatusView> {
  return apiFetch("/api/v1/setup/status").then((res) =>
    parseJson(res, SetupStatusViewSchema),
  );
}

export function submitSetup(body: SetupRequestBody): Promise<SetupStatusView> {
  return apiFetch("/api/v1/setup", { method: "POST", jsonBody: body }).then(
    (res) => parseJson(res, SetupStatusViewSchema),
  );
}

// --- Session ---
// GET /api/v1/session is the credential-free application surface (frozen
// wave-2 contract): UserView + expiry, no token material. Better Auth's own
// /api/auth/* endpoints are used only for sign-in/sign-out mutations.

export interface SessionUser {
  id: string;
  name: string;
  email: string;
  role: AppRole;
}

/**
 * Returns null only for a canonical unauthenticated answer (401/403). Any
 * other failure throws so callers can distinguish "unavailable" from
 * "signed out".
 */
export async function getSession(): Promise<SessionUser | null> {
  try {
    const res = await apiFetch("/api/v1/session");
    const view = await parseJson(res, SessionViewSchema);
    return {
      id: view.user.id,
      name: view.user.name,
      email: view.user.email,
      role: view.user.role,
    };
  } catch (error) {
    if (
      error instanceof ApiClientError &&
      (error.status === 401 || error.status === 403)
    ) {
      return null;
    }
    throw error;
  }
}

/**
 * Sign-in success is confirmed by reading get-session afterwards rather than
 * trusting the sign-in response body shape.
 */
export async function signInWithPassword(
  email: string,
  password: string,
): Promise<SessionUser> {
  await apiFetch("/api/auth/sign-in/email", {
    method: "POST",
    jsonBody: { email, password },
  });
  const user = await getSession();
  if (user === null) {
    throw new ApiClientError("Sign-in succeeded but no session is readable.", {
      status: 200,
      code: "UNEXPECTED_RESPONSE",
    });
  }
  return user;
}

export async function signOutRequest(): Promise<void> {
  await apiFetch("/api/auth/sign-out", { method: "POST", jsonBody: {} });
}

// --- Mounts and catalog (T05 frozen wave-3 contract) ---
// MountView gains rootFolderId and operations per the coordinator's wave-3
// decision; both fields stay optional in parsing until A's router lands so a
// partially deployed backend degrades honestly instead of failing hard.

export const MOUNT_OPERATIONS = ["read", "upload", "admin"] as const;
export type MountOperation = (typeof MOUNT_OPERATIONS)[number];

const MountViewClientSchema = z
  .looseObject({
    id: z.string().min(1).max(256),
    label: z.string().min(1),
    visibility: MountVisibilitySchema.optional(),
    rootFolderId: z.string().min(1).optional(),
    operations: z.array(z.enum(MOUNT_OPERATIONS)).optional(),
  })
  .transform((view) => ({
    id: view.id,
    label: view.label,
    visibility: view.visibility ?? "private",
    // Shared Drive root is the Drive id itself when the backend has not yet
    // published rootFolderId (frozen wave-3 contract).
    rootFolderId: view.rootFolderId ?? view.id,
    operations: view.operations ?? (["read"] as MountOperation[]),
  }));

export interface MountViewClient {
  id: string;
  label: string;
  visibility: string;
  rootFolderId: string;
  operations: MountOperation[];
}

const MountListResponseSchema = z.looseObject({
  mounts: z.array(MountViewClientSchema),
});
export type MountList = { mounts: MountViewClient[] };

export function getMounts(signal?: AbortSignal): Promise<MountList> {
  return apiFetch("/api/v1/mounts", { signal }).then((res) =>
    parseJson(res, MountListResponseSchema),
  );
}

function enc(value: string): string {
  return encodeURIComponent(value);
}

/** GET /mounts/:m/folders/:f/children — cursor pagination (frozen contract). */
export function listChildren(
  mountId: string,
  folderId: string,
  cursor?: string,
  signal?: AbortSignal,
): Promise<FileChildrenPage> {
  const query = cursor !== undefined ? `?cursor=${enc(cursor)}` : "";
  return apiFetch(
    `/api/v1/mounts/${enc(mountId)}/folders/${enc(folderId)}/children${query}`,
    { signal },
  ).then((res) => parseJson(res, FileChildrenPageSchema));
}

export interface SearchParams {
  q: string;
  scope: SearchScope;
  /** Required when scope is "folder". */
  folderId?: string;
  cursor?: string;
}

/** GET /mounts/:m/search — q + scope=folder|drive, signed cursor paging. */
export function searchEntries(
  mountId: string,
  params: SearchParams,
  signal?: AbortSignal,
): Promise<SearchPage> {
  const query = new URLSearchParams({ q: params.q, scope: params.scope });
  if (params.scope === "folder" && params.folderId !== undefined) {
    query.set("folderId", params.folderId);
  }
  if (params.cursor !== undefined) query.set("cursor", params.cursor);
  return apiFetch(
    `/api/v1/mounts/${enc(mountId)}/search?${query.toString()}`,
    { signal },
  ).then((res) => parseJson(res, SearchPageSchema));
}

/** GET /mounts/:m/files/:f — catalog metadata + independent SA readiness. */
export function getFileDetail(
  mountId: string,
  fileId: string,
  signal?: AbortSignal,
): Promise<FileDetail> {
  return apiFetch(
    `/api/v1/mounts/${enc(mountId)}/files/${enc(fileId)}`,
    { signal },
  ).then((res) => parseJson(res, FileDetailSchema));
}

/**
 * Direct content URL for plain anchor downloads: the browser sends the
 * session cookie on this same-origin GET and the server answers with the
 * SA-streamed body plus Content-Disposition. No fetch/blob buffering of the
 * file body ever happens in the SPA.
 */
export function contentUrl(
  mountId: string,
  fileId: string,
  revisionId?: string,
): string {
  const base = `/api/v1/mounts/${enc(mountId)}/files/${enc(fileId)}/content`;
  return revisionId === undefined
    ? base
    : `${base}?mode=revision&revision=${enc(revisionId)}`;
}

/** GET /mounts/:m/files/:f/thumbnail — lazy thumbnail bytes via SA. */
export function thumbnailUrl(mountId: string, fileId: string): string {
  return `/api/v1/mounts/${enc(mountId)}/files/${enc(fileId)}/thumbnail`;
}

const ReadinessResponseSchema = z.looseObject({
  readerAccessState: z
    .enum(["unchecked", "pending", "readable", "blocked"])
    .optional(),
});

/** POST /mounts/:m/files/:f/readiness — bounded SA probe, never a Drive write. */
export function requestReadiness(
  mountId: string,
  fileId: string,
): Promise<z.infer<typeof ReadinessResponseSchema>> {
  return apiFetch(
    `/api/v1/mounts/${enc(mountId)}/files/${enc(fileId)}/readiness`,
    { method: "POST", jsonBody: {} },
  ).then((res) => parseJson(res, ReadinessResponseSchema));
}

// --- Shares (T06 frozen wave-3 contract; paths under /api/v1/shares) ---

export function listShares(
  mountId?: string,
  signal?: AbortSignal,
): Promise<ShareListResponse> {
  const query = mountId !== undefined ? `?mountId=${enc(mountId)}` : "";
  return apiFetch(`/api/v1/shares${query}`, { signal }).then((res) =>
    parseJson(res, ShareListResponseSchema),
  );
}

export function createShare(
  body: CreateShareRequest,
): Promise<CreateShareResponse> {
  return apiFetch("/api/v1/shares", { method: "POST", jsonBody: body }).then(
    (res) => parseJson(res, CreateShareResponseSchema),
  );
}

/** Revoke returns 2xx with an empty or share-shaped body; tolerate both. */
export function revokeShare(shareId: string): Promise<void> {
  return apiFetch(`/api/v1/shares/${enc(shareId)}`, {
    method: "DELETE",
  }).then(() => undefined);
}

export function getHealth(): Promise<{ status: string }> {
  return apiFetch("/api/v1/health").then((res) =>
    parseJson(res, z.looseObject({ status: z.string() })),
  );
}
