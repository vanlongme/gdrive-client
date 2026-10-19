import { z } from 'zod';
import { IdSchema } from './common';

/**
 * My Drive read-pool grants (wave 7, spec §5): the app shares a mount's root
 * folder with the pool service accounts. These DTOs carry service-account
 * ids, states and stable error codes only: never an address, permission id,
 * token or upstream message.
 */

export const READ_GRANT_STATES = [
  'pending',
  'granted',
  'revoking',
  'failed',
] as const;
export const ReadGrantStateSchema = z.enum(READ_GRANT_STATES);
export type ReadGrantState = z.infer<typeof ReadGrantStateSchema>;

export const READ_GRANT_ERROR_CODES = [
  'grant:rate_limited',
  'grant:forbidden',
  'grant:not_found',
  'grant:invalid_principal',
  'grant:upstream',
] as const;
export const ReadGrantErrorCodeSchema = z.enum(READ_GRANT_ERROR_CODES);
export type ReadGrantErrorCode = z.infer<typeof ReadGrantErrorCodeSchema>;

export const ReadGrantEntrySchema = z
  .object({
    serviceAccountId: IdSchema,
    state: ReadGrantStateSchema,
    errorCode: ReadGrantErrorCodeSchema.optional(),
  })
  .strict();
export type ReadGrantEntry = z.infer<typeof ReadGrantEntrySchema>;

/** POST /api/v1/admin/mounts/:id/read-grants/sync */
export const ReadGrantsSyncResponseSchema = z
  .object({
    /** Outstanding Drive mutations; the client calls again until 0. */
    remaining: z.number().int().min(0),
    /** Pool service accounts whose grant is confirmed. */
    ready: z.number().int().min(0),
    /** Pool size. */
    total: z.number().int().min(0),
    grants: z.array(ReadGrantEntrySchema),
    /** Present when the call stopped on a rate limit. */
    retryAfterSeconds: z.number().int().min(1).max(86400).optional(),
  })
  .strict();
export type ReadGrantsSyncResponse = z.infer<typeof ReadGrantsSyncResponseSchema>;

export const READ_GRANT_PROBE_RESULTS = ['ok', 'grant:not_visible'] as const;
export const ReadGrantProbeResultSchema = z.enum(READ_GRANT_PROBE_RESULTS);

/** POST /api/v1/admin/mounts/:id/read-grants/:serviceAccountId/probe */
export const ReadGrantProbeResponseSchema = z
  .object({
    serviceAccountId: IdSchema,
    result: ReadGrantProbeResultSchema,
  })
  .strict();
export type ReadGrantProbeResponse = z.infer<typeof ReadGrantProbeResponseSchema>;
