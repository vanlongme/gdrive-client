import {
  MountAdminListResponseSchema,
  MountAdminResponseSchema,
  MountGrantListResponseSchema,
  OAuthClientResponseSchema,
  ServiceAccountListResponseSchema,
  ServiceAccountResponseSchema,
  UserListResponseSchema,
  UserResponseSchema,
  ConnectionViewSchema,
  OAuthClientViewSchema,
  ProviderHealthViewSchema,
  SetReadPoolRequestSchema,
  type ImportOAuthClientRequest,
  type ImportServiceAccountRequest,
  type CreateMountRequest,
  type UpdateMountRequest,
  type UpsertMountGrantRequest,
  type CreateAdminUserRequest,
} from "../../shared/contracts/admin";
import { z } from "zod";
import { apiFetch, parseJson } from "./api";

/**
 * Admin endpoints (spec section 10.2; A's confirmed wave-3 route map):
 *   GET/POST /api/v1/admin/google/clients; POST /:id/disable|enable -> {client}
 *   GET/POST /api/v1/admin/service-accounts; POST /:id/disable|enable -> {serviceAccount}
 *   GET/POST /api/v1/admin/mounts; GET/PATCH /:id -> {mount}
 *   PUT      /api/v1/admin/mounts/:id/read-pool {entries:[{serviceAccountId,priority?,weight?}]} -> {mount}
 *   GET/POST /api/v1/admin/mounts/:id/grants; DELETE /:userId -> {grants}
 *   GET/POST /api/v1/admin/users; POST /:id/disable|enable -> {user}
 *   GET      /api/v1/admin/provider-health
 * The Google OAuth lifecycle routes (oauth/start, callback, connections
 * disconnect/revoke) are the real wave-2 surface under /api/v1/admin/google.
 */

export type { ConnectionView, ProviderHealthView } from "../../shared/contracts/admin";
export type {
  CreateMountRequest,
  ImportOAuthClientRequest,
  ImportServiceAccountRequest,
  UpdateMountRequest,
  UpsertMountGrantRequest,
  CreateAdminUserRequest,
  MountAdminView,
  MountGrantView,
  OAuthClientView,
  ServiceAccountView,
  UserView,
} from "../../shared/contracts/admin";

const ConnectionsResponseSchema = z.looseObject({
  connections: z.array(ConnectionViewSchema),
});
const ConnectionResponseSchema = z.looseObject({
  connection: ConnectionViewSchema,
});
const OAuthStartResponseSchema = z.looseObject({
  authorizationUrl: z.string(),
});
const RevokeResponseSchema = z.looseObject({
  revokedUpstream: z.boolean(),
  connection: ConnectionViewSchema,
});

function enc(value: string): string {
  return encodeURIComponent(value);
}

/** Fixed OAuth callback path; the full URI is canonicalOrigin + this. */
export const OAUTH_CALLBACK_PATH = "/api/v1/admin/google/oauth/callback";

// --- OAuth clients ---

export function listOAuthClients(signal?: AbortSignal) {
  return apiFetch("/api/v1/admin/google/clients", { signal }).then((res) =>
    parseJson(
      res,
      z.looseObject({ clients: z.array(OAuthClientViewSchema) }),
    ),
  );
}

export function importOAuthClient(body: ImportOAuthClientRequest) {
  return apiFetch("/api/v1/admin/google/clients", {
    method: "POST",
    jsonBody: body,
  }).then((res) => parseJson(res, OAuthClientResponseSchema));
}

export function setOAuthClientEnabled(id: string, enabled: boolean) {
  return apiFetch(
    `/api/v1/admin/google/clients/${enc(id)}/${enabled ? "enable" : "disable"}`,
    { method: "POST", jsonBody: {} },
  ).then((res) => parseJson(res, OAuthClientResponseSchema));
}

// --- Connections (wave-2 real surface) ---

export function listConnections(signal?: AbortSignal) {
  return apiFetch("/api/v1/admin/google/connections", { signal }).then((res) =>
    parseJson(res, ConnectionsResponseSchema),
  );
}

export interface OAuthStartBodyConnect {
  purpose: "connect";
  oauthClientId: string;
}
export interface OAuthStartBodyReconnect {
  purpose: "reconnect";
  connectionId: string;
}

export function startOAuthFlow(
  body: OAuthStartBodyConnect | OAuthStartBodyReconnect,
) {
  return apiFetch("/api/v1/admin/google/oauth/start", {
    method: "POST",
    jsonBody: body,
  }).then((res) => parseJson(res, OAuthStartResponseSchema));
}

export function disconnectConnection(connectionId: string) {
  return apiFetch(
    `/api/v1/admin/google/connections/${enc(connectionId)}/disconnect`,
    { method: "POST", jsonBody: {} },
  ).then((res) => parseJson(res, ConnectionResponseSchema));
}

export function revokeConnection(connectionId: string) {
  return apiFetch(
    `/api/v1/admin/google/connections/${enc(connectionId)}/revoke`,
    { method: "POST", jsonBody: {} },
  ).then((res) => parseJson(res, RevokeResponseSchema));
}

// --- Service accounts ---

export function listServiceAccounts(signal?: AbortSignal) {
  return apiFetch("/api/v1/admin/service-accounts", { signal }).then((res) =>
    parseJson(res, ServiceAccountListResponseSchema),
  );
}

export function importServiceAccount(body: ImportServiceAccountRequest) {
  return apiFetch("/api/v1/admin/service-accounts", {
    method: "POST",
    jsonBody: body,
  }).then((res) => parseJson(res, ServiceAccountResponseSchema));
}

export function setServiceAccountEnabled(id: string, enabled: boolean) {
  return apiFetch(
    `/api/v1/admin/service-accounts/${enc(id)}/${enabled ? "enable" : "disable"}`,
    { method: "POST", jsonBody: {} },
  ).then((res) => parseJson(res, ServiceAccountResponseSchema));
}

// --- Mounts ---

export function listAdminMounts(signal?: AbortSignal) {
  return apiFetch("/api/v1/admin/mounts", { signal }).then((res) =>
    parseJson(res, MountAdminListResponseSchema),
  );
}

export function createMount(body: CreateMountRequest) {
  return apiFetch("/api/v1/admin/mounts", {
    method: "POST",
    jsonBody: body,
  }).then((res) => parseJson(res, MountAdminResponseSchema));
}

export function updateMount(mountId: string, body: UpdateMountRequest) {
  return apiFetch(`/api/v1/admin/mounts/${enc(mountId)}`, {
    method: "PATCH",
    jsonBody: body,
  }).then((res) => parseJson(res, MountAdminResponseSchema));
}

export function setReadPool(
  mountId: string,
  body: z.input<typeof SetReadPoolRequestSchema>,
) {
  return apiFetch(`/api/v1/admin/mounts/${enc(mountId)}/read-pool`, {
    method: "PUT",
    jsonBody: body,
  }).then((res) => parseJson(res, MountAdminResponseSchema));
}

// --- Shared Drive chooser (T11) --------------------------------------------
// GET /api/v1/admin/shared-drives?connectionId=... — paged listing of the
// Shared Drives visible to ONE OAuth catalog connection. OAuth catalog
// identity only; the response carries id/name and an opaque page token.

export interface SharedDriveEntry {
  id: string;
  name: string;
}

const SharedDriveListResponseSchema = z.looseObject({
  drives: z.array(z.looseObject({ id: z.string(), name: z.string() })),
  nextPageToken: z.string().optional(),
});

export function listSharedDrives(
  connectionId: string,
  params?: { pageToken?: string; pageSize?: number },
  signal?: AbortSignal,
) {
  const query = new URLSearchParams({ connectionId });
  if (params?.pageToken !== undefined) query.set("pageToken", params.pageToken);
  if (params?.pageSize !== undefined)
    query.set("pageSize", String(params.pageSize));
  return apiFetch(`/api/v1/admin/shared-drives?${query.toString()}`, {
    signal,
  }).then((res) => parseJson(res, SharedDriveListResponseSchema));
}

// --- Grants ---

export function listGrants(mountId: string, signal?: AbortSignal) {
  return apiFetch(`/api/v1/admin/mounts/${enc(mountId)}/grants`, {
    signal,
  }).then((res) => parseJson(res, MountGrantListResponseSchema));
}

export function createGrant(mountId: string, body: UpsertMountGrantRequest) {
  return apiFetch(`/api/v1/admin/mounts/${enc(mountId)}/grants`, {
    method: "POST",
    jsonBody: body,
  }).then((res) => parseJson(res, MountGrantListResponseSchema));
}

export function revokeGrant(mountId: string, userId: string) {
  return apiFetch(
    `/api/v1/admin/mounts/${enc(mountId)}/grants/${enc(userId)}`,
    { method: "DELETE" },
  ).then((res) => parseJson(res, MountGrantListResponseSchema));
}

// --- Users ---

export function listAdminUsers(signal?: AbortSignal) {
  return apiFetch("/api/v1/admin/users", { signal }).then((res) =>
    parseJson(res, UserListResponseSchema),
  );
}

export function createAdminUser(body: CreateAdminUserRequest) {
  return apiFetch("/api/v1/admin/users", {
    method: "POST",
    jsonBody: body,
  }).then((res) => parseJson(res, UserResponseSchema));
}

export function setUserDisabled(userId: string, disabled: boolean) {
  return apiFetch(
    `/api/v1/admin/users/${enc(userId)}/${disabled ? "disable" : "enable"}`,
    { method: "POST", jsonBody: {} },
  ).then((res) => parseJson(res, UserResponseSchema));
}

// --- Provider health ---

export function getProviderHealth(signal?: AbortSignal) {
  return apiFetch("/api/v1/admin/provider-health", { signal }).then((res) =>
    parseJson(res, ProviderHealthViewSchema),
  );
}

// --- Diagnostics (T14) ---------------------------------------------------
// GET /api/v1/admin/diagnostics — redacted counters only: ids, enums and
// counts; the server never returns envelopes, tokens, keys or URIs.

const DiagnosticsConnectionSchema = z.looseObject({
  connectionId: z.string(),
  state: z.string(),
  enabled: z.boolean(),
  coolingDown: z.boolean(),
  recentFailures: z.number(),
});
const DiagnosticsSaSchema = z.looseObject({
  serviceAccountId: z.string(),
  projectId: z.string(),
  enabled: z.boolean(),
  coolingDown: z.boolean(),
  recentFailures: z.number(),
});
const DiagnosticsSchema = z.looseObject({
  generatedAt: z.string(),
  oauth: z.looseObject({
    connections: z.array(DiagnosticsConnectionSchema),
    totals: z.looseObject({
      connections: z.number(),
      needsReauth: z.number(),
      disabled: z.number(),
      coolingDown: z.number(),
    }),
  }),
  serviceAccounts: z.looseObject({
    accounts: z.array(DiagnosticsSaSchema),
    totals: z.looseObject({
      accounts: z.number(),
      disabled: z.number(),
      coolingDown: z.number(),
    }),
  }),
  uploads: z.looseObject({
    byState: z.record(z.string(), z.number()),
    confirmedBytes: z.string(),
    confirmedBytesTruncated: z.boolean(),
    completedWithBlockedReader: z.number(),
  }),
  readers: z.record(z.string(), z.number()),
  auditErrors24h: z.record(z.string(), z.number()),
  cooldowns: z.array(
    z.looseObject({
      scope: z.string(),
      provider: z.string(),
      credentialId: z.string(),
      fileId: z.string().optional(),
      reason: z.string(),
      failures: z.number(),
      retryAfterMs: z.number(),
    }),
  ),
  maintenance: z.looseObject({
    mode: z.string(),
    phase: z.string(),
    toKeyLabel: z.string().nullable(),
    processedCount: z.number(),
    verifiedCount: z.number(),
  }),
});

export type DiagnosticsView = z.infer<typeof DiagnosticsSchema>;

export function getDiagnostics(signal?: AbortSignal) {
  return apiFetch("/api/v1/admin/diagnostics", { signal }).then((res) =>
    parseJson(res, DiagnosticsSchema),
  );
}

// --- Maintenance (T14) ---------------------------------------------------
// GET /api/v1/admin/maintenance/status and the POST verbs for mode,
// cleanup and the key-rotation lifecycle. Mutations are never fired on
// render — callers invoke them from explicit confirmed actions only.

export const MAINTENANCE_MODES = ["off", "drain", "key-rotation"] as const;
export const ROTATION_PHASES = [
  "idle",
  "reencrypting",
  "verifying",
  "verified",
  "done",
  "failed",
] as const;

const RotationStatusSchema = z.looseObject({
  mode: z.enum(MAINTENANCE_MODES),
  phase: z.enum(ROTATION_PHASES),
  fromKeyLabel: z.string().nullable(),
  toKeyLabel: z.string().nullable(),
  processedCount: z.number(),
  verifiedCount: z.number(),
  envelopeTotals: z.record(z.string(), z.number()),
  lastError: z.string().nullable(),
  startedAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
});
const CleanupResultSchema = z.looseObject({
  dryRun: z.boolean(),
  auditEvents: z.looseObject({
    eligible: z.number(),
    deleted: z.number(),
  }),
  uploadDetails: z.looseObject({
    eligible: z.number(),
    purged: z.number(),
    keptWithoutTombstone: z.number(),
  }),
  truncated: z.boolean(),
});
const RotationStepSchema = z.looseObject({
  phase: z.enum(ROTATION_PHASES),
  source: z.string().nullable(),
  processed: z.number(),
  remaining: z.boolean(),
});
const RotationVerifySchema = z.looseObject({
  ok: z.boolean(),
  verified: z.number(),
  failed: z.number(),
  failures: z.record(z.string(), z.array(z.string())),
});
const RotationCompleteSchema = z.looseObject({
  sessionsRevoked: z.number(),
  completedAt: z.number(),
});

export type RotationStatusView = z.infer<typeof RotationStatusSchema>;
export type CleanupResultView = z.infer<typeof CleanupResultSchema>;
export type RotationStepView = z.infer<typeof RotationStepSchema>;
export type RotationVerifyView = z.infer<typeof RotationVerifySchema>;
export type RotationCompleteView = z.infer<typeof RotationCompleteSchema>;

export function getMaintenanceStatus(signal?: AbortSignal) {
  return apiFetch("/api/v1/admin/maintenance/status", { signal }).then(
    (res) =>
      parseJson(res, z.looseObject({ rotation: RotationStatusSchema })),
  );
}

export function setMaintenanceMode(enabled: boolean) {
  return apiFetch("/api/v1/admin/maintenance/mode", {
    method: "POST",
    jsonBody: { enabled },
  }).then((res) =>
    parseJson(res, z.looseObject({ mode: z.string(), active: z.boolean() })),
  );
}

export function runCleanup(dryRun: boolean) {
  return apiFetch("/api/v1/admin/maintenance/cleanup", {
    method: "POST",
    jsonBody: { dryRun },
  }).then((res) =>
    parseJson(res, z.looseObject({ cleanup: CleanupResultSchema })),
  );
}

export function rotationStart() {
  return apiFetch("/api/v1/admin/maintenance/rotation/start", {
    method: "POST",
    jsonBody: {},
  }).then((res) =>
    parseJson(res, z.looseObject({ rotation: RotationStatusSchema })),
  );
}

export function rotationStep(batchSize?: number) {
  return apiFetch("/api/v1/admin/maintenance/rotation/step", {
    method: "POST",
    jsonBody: batchSize === undefined ? {} : { batchSize },
  }).then((res) =>
    parseJson(res, z.looseObject({ step: RotationStepSchema })),
  );
}

export function rotationVerify() {
  return apiFetch("/api/v1/admin/maintenance/rotation/verify", {
    method: "POST",
    jsonBody: {},
  }).then((res) =>
    parseJson(res, z.looseObject({ verify: RotationVerifySchema })),
  );
}

export function rotationComplete() {
  return apiFetch("/api/v1/admin/maintenance/rotation/complete", {
    method: "POST",
    jsonBody: {},
  }).then((res) =>
    parseJson(res, z.looseObject({ complete: RotationCompleteSchema })),
  );
}

export function rotationAbort() {
  return apiFetch("/api/v1/admin/maintenance/rotation/abort", {
    method: "POST",
    jsonBody: {},
  }).then((res) =>
    parseJson(res, z.looseObject({ aborted: z.boolean() })),
  );
}
