import { z } from 'zod';
import { DecimalBytesSchema, IdSchema, IsoTimestampSchema } from './common';

// Public folder links (wave 8, Phase B2): anonymous, revocable links that
// expose one Drive folder subtree under /api/v1/p/<slug>. DTOs never carry
// password hashes, credential versions, connection ids or Drive-internal
// identity fields — the cookie is the only client-held credential and is
// HttpOnly + path-scoped, never part of a JSON body.

export const PUBLIC_LINK_STATUSES = [
  'active',
  'expired',
  'revoked',
  'invalidated',
] as const;
export const PublicLinkStatusSchema = z.enum(PUBLIC_LINK_STATUSES);
export type PublicLinkStatus = z.infer<typeof PublicLinkStatusSchema>;

// POST /api/v1/public-links (admin). password 4..128 or null for an open
// link; expiresAt ISO or null (capped installs reject/impose per policy).
export const CreatePublicLinkRequestSchema = z
  .object({
    mountId: IdSchema,
    folderId: IdSchema,
    password: z.string().min(4).max(128).nullable().default(null),
    expiresAt: IsoTimestampSchema.nullable().default(null),
    allowZip: z.boolean().default(false),
  })
  .strict();
export type CreatePublicLinkRequest = z.infer<
  typeof CreatePublicLinkRequestSchema
>;

// PATCH /api/v1/public-links/:id — omitted fields keep their value; an
// explicit null password removes password protection (and still bumps the
// credential version, invalidating issued unlock cookies).
export const UpdatePublicLinkRequestSchema = z
  .object({
    password: z.string().min(4).max(128).nullable().optional(),
    expiresAt: IsoTimestampSchema.nullable().optional(),
    allowZip: z.boolean().optional(),
  })
  .strict();
export type UpdatePublicLinkRequest = z.infer<
  typeof UpdatePublicLinkRequestSchema
>;

// Admin-facing link view. `path` is the public URL path; credentialVersion
// and password_hash stay server-side (hasPassword carries the boolean).
export const PublicFolderLinkViewSchema = z
  .object({
    id: IdSchema,
    slug: z.string().min(1).max(64),
    path: z.string().min(1).max(128),
    mountId: IdSchema,
    mountLabel: z.string().min(1).max(256),
    folderId: IdSchema,
    folderName: z.string().min(1).max(32768),
    hasPassword: z.boolean(),
    allowZip: z.boolean(),
    expiresAt: IsoTimestampSchema.nullable(),
    createdAt: IsoTimestampSchema,
    createdByEmail: z.string().email().nullable(),
    revokedAt: IsoTimestampSchema.nullable(),
    status: PublicLinkStatusSchema,
    viewCount: z.number().int().min(0),
    downloadCount: z.number().int().min(0),
  })
  .strict();
export type PublicFolderLinkView = z.infer<typeof PublicFolderLinkViewSchema>;

export const PublicLinkResponseSchema = z
  .object({ link: PublicFolderLinkViewSchema })
  .strict();
export type PublicLinkResponse = z.infer<typeof PublicLinkResponseSchema>;

export const PublicLinkListResponseSchema = z
  .object({ links: z.array(PublicFolderLinkViewSchema) })
  .strict();
export type PublicLinkListResponse = z.infer<
  typeof PublicLinkListResponseSchema
>;

// GET /api/v1/p/:slug (anonymous). `locked` tells the client to collect a
// password; rootFolderId lets it start browsing without a folderId guess.
export const PublicFolderMetaSchema = z
  .object({
    slug: z.string().min(1).max(64),
    folderName: z.string().min(1).max(32768),
    rootFolderId: IdSchema,
    sharedByName: z.string().min(1).max(256),
    expiresAt: IsoTimestampSchema.nullable(),
    allowZip: z.boolean(),
    locked: z.boolean(),
  })
  .strict();
export type PublicFolderMeta = z.infer<typeof PublicFolderMetaSchema>;

// POST /api/v1/p/:slug/unlock — returns 204 + the MACed unlock cookie.
export const UnlockPublicLinkRequestSchema = z
  .object({ password: z.string().min(1).max(128) })
  .strict();
export type UnlockPublicLinkRequest = z.infer<
  typeof UnlockPublicLinkRequestSchema
>;

// Public listing entry: shortcuts are hidden server-side, so kind is only
// 'file' | 'folder'. `size` is null for folders (Drive reports no size).
export const PublicFolderEntrySchema = z
  .object({
    id: IdSchema,
    kind: z.enum(['file', 'folder']),
    name: z.string().min(1).max(32768),
    mimeType: z.string().min(1).max(512),
    size: DecimalBytesSchema.nullable(),
    modifiedTime: IsoTimestampSchema,
    hasThumbnail: z.boolean(),
  })
  .strict();
export type PublicFolderEntry = z.infer<typeof PublicFolderEntrySchema>;

export const PublicBreadcrumbSchema = z
  .object({ id: IdSchema, name: z.string().min(1).max(32768) })
  .strict();
export type PublicBreadcrumb = z.infer<typeof PublicBreadcrumbSchema>;

// GET /api/v1/p/:slug/children — breadcrumbs run link-root first down to the
// listed folder; nextPageToken is the opaque continuation (echoed back as
// ?pageToken=).
export const PublicChildrenPageSchema = z
  .object({
    folderId: IdSchema,
    folderName: z.string().min(1).max(32768),
    breadcrumbs: z.array(PublicBreadcrumbSchema),
    entries: z.array(PublicFolderEntrySchema),
    nextPageToken: z.string().min(1).nullable(),
  })
  .strict();
export type PublicChildrenPage = z.infer<typeof PublicChildrenPageSchema>;
