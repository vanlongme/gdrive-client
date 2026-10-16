import { z } from 'zod';
import {
  DecimalBytesSchema,
  IdSchema,
  IsoTimestampSchema,
  ReaderAccessStateSchema,
} from './common';
import { PreviewDescriptorSchema } from './media';

export const MOUNT_VISIBILITIES = ['private', 'public_read'] as const;
export const MountVisibilitySchema = z.enum(MOUNT_VISIBILITIES);
export type MountVisibility = z.infer<typeof MountVisibilitySchema>;

// Operations an app actor may hold on a mount (mirrors the server-side
// MountOperation vocabulary; 'admin' means mount administration, not the
// app-wide admin role).
export const MOUNT_OPERATIONS = ['read', 'upload', 'admin'] as const;
export const MountOperationSchema = z.enum(MOUNT_OPERATIONS);
export type MountOperationName = z.infer<typeof MountOperationSchema>;

// Safe mount shape for end users: no internal connection/SA IDs. rootFolderId
// is the Shared Drive root — equal to driveId and safe to expose because it
// is the browse entry point, not a credential. operations lists the actor's
// permitted operations on this mount so the UI can render honest actions.
export const MountViewSchema = z
  .object({
    id: IdSchema,
    label: z.string().min(1).max(256),
    visibility: MountVisibilitySchema,
    rootFolderId: IdSchema,
    operations: z.array(MountOperationSchema),
  })
  .strict();
export type MountView = z.infer<typeof MountViewSchema>;

export const MountListResponseSchema = z
  .object({ mounts: z.array(MountViewSchema) })
  .strict();
export type MountListResponse = z.infer<typeof MountListResponseSchema>;

export const DRIVE_ENTRY_KINDS = ['file', 'folder', 'shortcut'] as const;
export const DriveEntryKindSchema = z.enum(DRIVE_ENTRY_KINDS);
export type DriveEntryKind = z.infer<typeof DriveEntryKindSchema>;

// Catalog entry. `id` is the Drive file ID; names are display-only and never
// used as lookup keys. `size` stays a decimal string even for folders ("0").
export const DriveFileEntrySchema = z
  .object({
    id: IdSchema,
    kind: DriveEntryKindSchema,
    name: z.string().min(1).max(32768),
    mimeType: z.string().min(1).max(512),
    size: DecimalBytesSchema,
    modifiedTime: IsoTimestampSchema,
    shortcutTargetId: IdSchema.optional(),
    hasThumbnail: z.boolean(),
  })
  .strict();
export type DriveFileEntry = z.infer<typeof DriveFileEntrySchema>;

export const FileChildrenPageSchema = z
  .object({
    entries: z.array(DriveFileEntrySchema),
    nextCursor: z.string().min(1).optional(),
  })
  .strict();
export type FileChildrenPage = z.infer<typeof FileChildrenPageSchema>;

// File detail combines OAuth catalog metadata with the SA-readiness
// projection and preview descriptor; the two axes stay independent so a
// readable-looking listing can never imply readable content.
export const FileDetailSchema = DriveFileEntrySchema.extend({
  readerAccessState: ReaderAccessStateSchema,
  preview: PreviewDescriptorSchema.optional(),
}).strict();
export type FileDetail = z.infer<typeof FileDetailSchema>;

export const SEARCH_SCOPES = ['folder', 'drive'] as const;
export const SearchScopeSchema = z.enum(SEARCH_SCOPES);
export type SearchScope = z.infer<typeof SearchScopeSchema>;

export const SearchPageSchema = z
  .object({
    entries: z.array(DriveFileEntrySchema),
    nextCursor: z.string().min(1).optional(),
    scope: SearchScopeSchema,
  })
  .strict();
export type SearchPage = z.infer<typeof SearchPageSchema>;
