import { z } from 'zod';
import { IdSchema, IsoTimestampSchema } from './common';
import {
  MountKindSchema,
  MountOperationSchema,
  MountVisibilitySchema,
} from './drive';

export const SETUP_STATES = ['uninitialized', 'in_progress', 'complete'] as const;
export const SetupStateSchema = z.enum(SETUP_STATES);
export type SetupState = z.infer<typeof SetupStateSchema>;

// Minimal pre-auth surface (spec section 9.1): exposes only what the setup
// wizard needs before any session exists. canonicalOrigin stays null until
// setup completes.
export const SetupStatusViewSchema = z
  .object({
    setupState: SetupStateSchema,
    canonicalOrigin: z.string().nullable(),
  })
  .strict();
export type SetupStatusView = z.infer<typeof SetupStatusViewSchema>;

// POST /api/v1/setup body (wave-2 contract). `token` is the base64 SETUP_TOKEN
// bootstrap secret; canonicalOrigin is pinned into app_settings and becomes the
// trusted origin. Password bounds match the pinned Better Auth defaults.
export const SetupRequestSchema = z
  .object({
    token: z.string().min(1).max(1024),
    name: z.string().min(1).max(256),
    email: z.string().email().max(320),
    password: z.string().min(8).max(128),
    canonicalOrigin: z.string().min(1).max(2048),
  })
  .strict();
export type SetupRequest = z.infer<typeof SetupRequestSchema>;

export const GOOGLE_CONNECTION_STATES = [
  'connected',
  'degraded',
  'needs_reauth',
  'disabled',
] as const;
export const GoogleConnectionStateSchema = z.enum(GOOGLE_CONNECTION_STATES);
export type GoogleConnectionState = z.infer<typeof GoogleConnectionStateSchema>;

// Admin-facing OAuth client metadata. Never carries secretEnvelope.
export const OAuthClientViewSchema = z
  .object({
    id: IdSchema,
    projectId: z.string().min(1),
    clientId: z.string().min(1),
    redirectUri: z.string().min(1),
    enabled: z.boolean(),
    version: z.number().int().min(1),
    createdAt: IsoTimestampSchema,
  })
  .strict();
export type OAuthClientView = z.infer<typeof OAuthClientViewSchema>;

// Admin-facing connection metadata. Excludes principalId, refreshEnvelope and
// every token handle; internal pinned writer identity stays server-only.
export const ConnectionViewSchema = z
  .object({
    id: IdSchema,
    displayEmail: z.string().nullable(),
    state: GoogleConnectionStateSchema,
    enabled: z.boolean(),
    grantedScopes: z.array(z.string()),
    oauthClientId: IdSchema,
    connectedBy: IdSchema.nullable(),
    version: z.number().int().min(1),
    createdAt: IsoTimestampSchema,
  })
  .strict();
export type ConnectionView = z.infer<typeof ConnectionViewSchema>;

export const OAuthStartResponseSchema = z
  .object({ authorizationUrl: z.string().min(1) })
  .strict();
export type OAuthStartResponse = z.infer<typeof OAuthStartResponseSchema>;

// Admin-facing SA metadata. envelope/key material never leaves the server.
export const ServiceAccountViewSchema = z
  .object({
    id: IdSchema,
    projectId: z.string().min(1),
    email: z.string().min(1),
    keyId: z.string().min(1),
    enabled: z.boolean(),
    version: z.number().int().min(1),
    createdAt: IsoTimestampSchema,
  })
  .strict();
export type ServiceAccountView = z.infer<typeof ServiceAccountViewSchema>;

// Pool read access on a My Drive mount: rows in 'granted' state over the
// number of SAs in the read pool (spec 2026-10-18 §5 Readiness).
export const MountReadGrantsSummarySchema = z
  .object({ ready: z.number().int().min(0), total: z.number().int().min(0) })
  .strict();
export type MountReadGrantsSummary = z.infer<typeof MountReadGrantsSummarySchema>;

export const MountAdminViewSchema = z
  .object({
    id: IdSchema,
    label: z.string().min(1).max(256),
    kind: MountKindSchema,
    rootFolderId: IdSchema,
    /** null for a My Drive folder mount. */
    driveId: z.string().min(1).nullable(),
    catalogConnectionId: IdSchema,
    writeConnectionId: IdSchema,
    readPoolVersion: z.number().int().min(1),
    visibility: MountVisibilitySchema,
    policyVersion: z.number().int().min(1),
    readPool: z.array(ServiceAccountViewSchema),
    /** My Drive folder mounts only. */
    readGrants: MountReadGrantsSummarySchema.optional(),
  })
  .strict();
export type MountAdminView = z.infer<typeof MountAdminViewSchema>;

export const MOUNT_GRANT_ROLES = ['viewer', 'uploader'] as const;
export const MountGrantRoleSchema = z.enum(MOUNT_GRANT_ROLES);
export type MountGrantRole = z.infer<typeof MountGrantRoleSchema>;

export const MountGrantViewSchema = z
  .object({
    userId: IdSchema,
    mountId: IdSchema,
    role: MountGrantRoleSchema,
    operations: z.array(MountOperationSchema),
    grantedBy: IdSchema.nullable(),
    createdAt: IsoTimestampSchema,
  })
  .strict();
export type MountGrantView = z.infer<typeof MountGrantViewSchema>;

// Application-level role (wave-2 contract): Better Auth admin plugin assigns
// 'admin' to the operator account created at setup; everyone else is 'user'.
// Mount-level capabilities are mount_grants roles (viewer/uploader), separate
// from this field.
export const APP_ROLES = ['admin', 'user'] as const;
export const AppRoleSchema = z.enum(APP_ROLES);
export type AppRole = z.infer<typeof AppRoleSchema>;

export const UserViewSchema = z
  .object({
    id: IdSchema,
    name: z.string().min(1),
    email: z.string().min(1),
    role: AppRoleSchema,
    disabled: z.boolean(),
    createdAt: IsoTimestampSchema,
  })
  .strict();
export type UserView = z.infer<typeof UserViewSchema>;

// GET /api/v1/session response when the caller holds a valid app session.
// Deliberately contains no session token, credential or Google identity — the
// cookie is the credential and never appears in a DTO.
export const SessionViewSchema = z
  .object({
    user: UserViewSchema,
    expiresAt: IsoTimestampSchema,
  })
  .strict();
export type SessionView = z.infer<typeof SessionViewSchema>;

export const ProviderHealthViewSchema = z
  .object({
    oauthConnections: z.array(
      z
        .object({
          connectionId: IdSchema,
          state: GoogleConnectionStateSchema,
          enabled: z.boolean(),
        })
        .strict(),
    ),
    serviceAccounts: z.array(
      z
        .object({
          serviceAccountId: IdSchema,
          enabled: z.boolean(),
          coolingDown: z.boolean(),
        })
        .strict(),
    ),
  })
  .strict();
export type ProviderHealthView = z.infer<typeof ProviderHealthViewSchema>;

// ---------------------------------------------------------------------------
// Wave-3 admin API (worker A): credential import/lifecycle, mount CRUD with
// read-pool mapping, grants, users and provider health. Response bodies never
// carry secret material — envelopes, refresh tokens and SA private keys stay
// server-side by construction of the view schemas above.
// ---------------------------------------------------------------------------

// POST /api/v1/admin/google/clients — register an OAuth Web client. The
// secret is sealed in the vault; projectId is derived from the client ID
// prefix (<project-number>-...apps.googleusercontent.com) when omitted.
// redirectUri defaults to the installation's canonical OAuth callback and a
// supplied value must match it exactly.
export const ImportOAuthClientRequestSchema = z
  .object({
    clientId: z.string().min(1).max(512),
    clientSecret: z.string().min(1).max(4096),
    projectId: z.string().min(1).max(256).optional(),
    redirectUri: z.string().min(1).max(2048).optional(),
  })
  .strict();
export type ImportOAuthClientRequest = z.infer<
  typeof ImportOAuthClientRequestSchema
>;

// POST /api/v1/admin/service-accounts — raw Google service-account key JSON.
// Private material is sealed; the response only carries public metadata.
export const ImportServiceAccountRequestSchema = z
  .object({ keyJson: z.string().min(1).max(65536) })
  .strict();
export type ImportServiceAccountRequest = z.infer<
  typeof ImportServiceAccountRequestSchema
>;

// POST /api/v1/admin/mounts — create a mount over a Shared Drive or a folder
// in the owner's My Drive, with separate catalog/write OAuth connections and
// an SA read pool. `rootFolderId` names the root; the legacy `driveId` is an
// alias for it (both present and different => 400). The server, not the
// client, decides the kind (spec 2026-10-18 §2.3).
export const CreateMountRequestSchema = z
  .object({
    label: z.string().min(1).max(256),
    rootFolderId: IdSchema.optional(),
    driveId: IdSchema.optional(),
    catalogConnectionId: IdSchema,
    writeConnectionId: IdSchema,
    serviceAccountIds: z.array(IdSchema).max(100).default([]),
    visibility: MountVisibilitySchema.default('private'),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.rootFolderId === undefined && value.driveId === undefined) {
      ctx.addIssue({ code: 'custom', path: ['rootFolderId'], message: 'rootFolderId is required' });
    }
    if (value.rootFolderId !== undefined && value.driveId !== undefined && value.rootFolderId !== value.driveId) {
      ctx.addIssue({ code: 'custom', path: ['driveId'], message: 'driveId must equal rootFolderId when both are sent' });
    }
  })
  .transform(({ rootFolderId, driveId, ...rest }) => ({
    ...rest,
    rootFolderId: rootFolderId ?? driveId ?? '',
  }));
/** Wire shape a client sends. */
export type CreateMountRequest = z.input<typeof CreateMountRequestSchema>;
/** Normalized server input: the alias is folded into rootFolderId. */
export type CreateMountInput = z.output<typeof CreateMountRequestSchema>;

// PATCH /api/v1/admin/mounts/:id — update display/policy fields; the root
// folder, drive id and kind are immutable. Changing visibility or either
// connection bumps policyVersion, which restarts signed pagination.
export const UpdateMountRequestSchema = z
  .object({
    label: z.string().min(1).max(256).optional(),
    visibility: MountVisibilitySchema.optional(),
    catalogConnectionId: IdSchema.optional(),
    writeConnectionId: IdSchema.optional(),
  })
  .strict();
export type UpdateMountRequest = z.infer<typeof UpdateMountRequestSchema>;

// PUT /api/v1/admin/mounts/:id/read-pool — replace the SA read-pool mapping;
// bumps readPoolVersion so readiness projections re-check.
export const ReadPoolEntrySchema = z
  .object({
    serviceAccountId: IdSchema,
    priority: z.number().int().min(0).max(1_000_000).default(0),
    weight: z.number().int().min(1).max(10_000).default(1),
  })
  .strict();
export type ReadPoolEntry = z.infer<typeof ReadPoolEntrySchema>;

export const SetReadPoolRequestSchema = z
  .object({ entries: z.array(ReadPoolEntrySchema).max(100) })
  .strict();
export type SetReadPoolRequest = z.infer<typeof SetReadPoolRequestSchema>;

// POST /api/v1/admin/mounts/:id/grants — upsert a mount grant. operations
// defaults to the role ceiling and can only narrow it.
export const UpsertMountGrantRequestSchema = z
  .object({
    userId: IdSchema,
    role: MountGrantRoleSchema,
    operations: z.array(MountOperationSchema).min(1).max(3).optional(),
  })
  .strict();
export type UpsertMountGrantRequest = z.infer<
  typeof UpsertMountGrantRequestSchema
>;

// POST /api/v1/admin/users — admin-provisioned app user (Better Auth).
export const CreateAdminUserRequestSchema = z
  .object({
    name: z.string().min(1).max(256),
    email: z.string().email().max(320),
    password: z.string().min(8).max(128),
    role: AppRoleSchema,
  })
  .strict();
export type CreateAdminUserRequest = z.infer<
  typeof CreateAdminUserRequestSchema
>;

export const OAuthClientResponseSchema = z
  .object({ client: OAuthClientViewSchema })
  .strict();
export const ServiceAccountResponseSchema = z
  .object({ serviceAccount: ServiceAccountViewSchema })
  .strict();
export const ServiceAccountListResponseSchema = z
  .object({ serviceAccounts: z.array(ServiceAccountViewSchema) })
  .strict();
export const MountAdminResponseSchema = z
  .object({ mount: MountAdminViewSchema })
  .strict();
export const MountAdminListResponseSchema = z
  .object({ mounts: z.array(MountAdminViewSchema) })
  .strict();
export const MountGrantListResponseSchema = z
  .object({ grants: z.array(MountGrantViewSchema) })
  .strict();
export const UserResponseSchema = z
  .object({ user: UserViewSchema })
  .strict();
export const UserListResponseSchema = z
  .object({ users: z.array(UserViewSchema) })
  .strict();

// GET /api/v1/admin/drive-folders (wave 7): the folders a connected account
// owns in its personal My Drive, one level at a time, for the mount picker.
// nextPageToken is Google's opaque token, echoed back for the next page
// (admin-only surface, same as the Shared Drive chooser).
export const DriveFolderEntrySchema = z
  .object({
    id: IdSchema,
    name: z.string().min(1).max(32768),
  })
  .strict();
export type DriveFolderEntry = z.infer<typeof DriveFolderEntrySchema>;

export const DriveFolderListResponseSchema = z
  .object({
    folders: z.array(DriveFolderEntrySchema),
    nextPageToken: z.string().min(1).optional(),
  })
  .strict();
export type DriveFolderListResponse = z.infer<
  typeof DriveFolderListResponseSchema
>;
