import { z } from 'zod';
import {
  ContentModeSchema,
  IdSchema,
  IsoTimestampSchema,
  ReaderAccessStateSchema,
} from './common';

// Re-exported for wave-3 consumers that import readiness/media vocabulary
// from this module (A's catalog.ts).
export type { ReaderAccessState } from './common';

// Capability descriptor the PreviewRegistry consumes (plan file-map shape).
// `versionHint` is change detection only in current-content mode; strict
// resume/snapshot semantics exist solely for pinned-revision, which must
// name the pinned revision. Cross-field rules are enforced so the descriptor
// can never promise a snapshot it does not hold.
export const PreviewDescriptorSchema = z
  .object({
    contentMode: ContentModeSchema,
    revisionId: z.string().min(1).optional(),
    versionHint: z.string().min(1).optional(),
    strictResumeSupported: z.boolean(),
    readerAccessState: ReaderAccessStateSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.contentMode === 'pinned-revision' && !value.revisionId) {
      ctx.addIssue({
        code: 'custom',
        message: 'pinned-revision requires revisionId',
        path: ['revisionId'],
      });
    }
    if (value.contentMode === 'current-content' && value.strictResumeSupported) {
      ctx.addIssue({
        code: 'custom',
        message: 'current-content cannot claim strict resume',
        path: ['strictResumeSupported'],
      });
    }
  });
export type PreviewDescriptor = z.infer<typeof PreviewDescriptorSchema>;

export const SHARE_SCOPE_KINDS = ['mount', 'file', 'package'] as const;
export const ShareScopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('mount'), mountId: IdSchema }).strict(),
  z
    .object({
      kind: z.literal('file'),
      mountId: IdSchema,
      fileId: IdSchema,
      revisionId: z.string().min(1).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('package'),
      mountId: IdSchema,
      packageId: IdSchema,
      indexGeneration: z.number().int().min(0).optional(),
    })
    .strict(),
]);
export type ShareScope = z.infer<typeof ShareScopeSchema>;

// Shares carry an explicit expiry; the server validates it is in the future
// and within configured policy. Share lifetime is deliberately not capped by
// the 24 h external-player ticket limit (coordinator decision).
export const CreateShareRequestSchema = z
  .object({
    scope: ShareScopeSchema,
    expiresAt: IsoTimestampSchema,
  })
  .strict();
export type CreateShareRequest = z.infer<typeof CreateShareRequestSchema>;

// The opaque token is returned exactly once at creation.
export const ShareViewSchema = z
  .object({
    shareId: IdSchema,
    scope: ShareScopeSchema,
    expiresAt: IsoTimestampSchema,
    createdAt: IsoTimestampSchema,
    revokedAt: IsoTimestampSchema.optional(),
    policyVersion: z.number().int().min(1),
  })
  .strict();
export type ShareView = z.infer<typeof ShareViewSchema>;

export const CreateShareResponseSchema = ShareViewSchema.extend({
  token: z.string().min(1),
}).strict();
export type CreateShareResponse = z.infer<typeof CreateShareResponseSchema>;

export const ShareListResponseSchema = z
  .object({ shares: z.array(ShareViewSchema) })
  .strict();
export type ShareListResponse = z.infer<typeof ShareListResponseSchema>;

// Scoped playback/download ticket: an app-level bearer capability for GET/HEAD
// on the bound resource only. Never a Google token.
export const MediaTicketSchema = z
  .object({
    ticket: z.string().min(1),
    expiresAt: IsoTimestampSchema,
  })
  .strict();
export type MediaTicket = z.infer<typeof MediaTicketSchema>;

// POST /api/v1/mounts/:mountId/files/:fileId/tickets (wave-3 contract,
// published for worker D). Tickets are GET/HEAD-only bearer capabilities for
// external players: default TTL 60 minutes, server maximum 24 hours. An
// optional revisionId pins the ticket to that Drive revision only.
export const MEDIA_TICKET_DEFAULT_TTL_SECONDS = 3600;
export const MEDIA_TICKET_MAX_TTL_SECONDS = 86400;

export const CreateMediaTicketRequestSchema = z
  .object({
    ttlSeconds: z
      .number()
      .int()
      .min(1)
      .max(MEDIA_TICKET_MAX_TTL_SECONDS)
      .optional(),
    revisionId: z.string().min(1).max(256).optional(),
  })
  .strict();
export type CreateMediaTicketRequest = z.infer<
  typeof CreateMediaTicketRequestSchema
>;

export const MEDIA_PACKAGE_STATES = ['preparing', 'ready', 'failed'] as const;
export const MediaPackageStateSchema = z.enum(MEDIA_PACKAGE_STATES);
export type MediaPackageState = z.infer<typeof MediaPackageStateSchema>;

export const CreateMediaPackageRequestSchema = z
  .object({
    mountId: IdSchema,
    entryFileId: IdSchema,
  })
  .strict();
export type CreateMediaPackageRequest = z.infer<
  typeof CreateMediaPackageRequestSchema
>;

// playerUrl is emitted only when a complete generation is ready; preparing
// and failed generations can never look playable.
export const MediaPackageViewSchema = z
  .object({
    packageId: IdSchema,
    state: MediaPackageStateSchema,
    indexGeneration: z.number().int().min(0),
    readyGeneration: z.number().int().min(1).optional(),
    strictSnapshot: z.boolean(),
    playerUrl: z.string().min(1).optional(),
    failureReason: z.string().max(500).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.state === 'ready') {
      if (value.readyGeneration === undefined) {
        ctx.addIssue({
          code: 'custom',
          message: 'ready package requires readyGeneration',
          path: ['readyGeneration'],
        });
      }
      if (value.playerUrl === undefined) {
        ctx.addIssue({
          code: 'custom',
          message: 'ready package requires playerUrl',
          path: ['playerUrl'],
        });
      }
    } else if (value.playerUrl !== undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'non-ready package must not publish playerUrl',
        path: ['playerUrl'],
      });
    }
  });
export type MediaPackageView = z.infer<typeof MediaPackageViewSchema>;

export const AdvanceMediaPackageResponseSchema = z
  .object({
    packageId: IdSchema,
    state: MediaPackageStateSchema,
    indexGeneration: z.number().int().min(0),
    complete: z.boolean(),
    processedResources: z.number().int().min(0),
  })
  .strict();
export type AdvanceMediaPackageResponse = z.infer<
  typeof AdvanceMediaPackageResponseSchema
>;

export const ReadinessViewSchema = z
  .object({
    fileId: IdSchema,
    readerAccessState: ReaderAccessStateSchema,
    checkedAt: IsoTimestampSchema.optional(),
    reason: z.string().max(500).optional(),
  })
  .strict();
export type ReadinessView = z.infer<typeof ReadinessViewSchema>;
