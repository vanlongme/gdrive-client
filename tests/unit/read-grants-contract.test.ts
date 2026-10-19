import { describe, expect, it } from 'vitest';
import {
  ApiErrorBodySchema,
  API_ERROR_CODES,
  READ_GRANT_ERROR_CODES,
  ReadGrantProbeResponseSchema,
  ReadGrantsSyncResponseSchema,
} from '../../src/shared/contracts';

describe('read-grants contracts', () => {
  const valid = {
    remaining: 70,
    ready: 20,
    total: 90,
    grants: [
      { serviceAccountId: 'sa-1', state: 'granted' },
      { serviceAccountId: 'sa-2', state: 'pending', errorCode: 'grant:rate_limited' },
      { serviceAccountId: 'sa-3', state: 'failed', errorCode: 'grant:invalid_principal' },
    ],
    retryAfterSeconds: 30,
  };

  it('accepts a sync response and the optional retryAfterSeconds', () => {
    expect(ReadGrantsSyncResponseSchema.parse(valid)).toEqual(valid);
    const { retryAfterSeconds: _unused, ...withoutRetry } = valid;
    expect(ReadGrantsSyncResponseSchema.safeParse(withoutRetry).success).toBe(true);
  });

  it('rejects unknown fields, states, error codes and bad numbers', () => {
    for (const bad of [
      { ...valid, extra: 1 },
      { ...valid, remaining: -1 },
      { ...valid, retryAfterSeconds: 0 },
      { ...valid, grants: [{ serviceAccountId: 'sa-1', state: 'done' }] },
      { ...valid, grants: [{ serviceAccountId: 'sa-1', state: 'failed', errorCode: 'grant:other' }] },
      { ...valid, grants: [{ serviceAccountId: 'sa-1', state: 'granted', emailAddress: 'x@y.example' }] },
    ]) {
      expect(ReadGrantsSyncResponseSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it('pins the stable grant error codes', () => {
    expect([...READ_GRANT_ERROR_CODES]).toEqual([
      'grant:rate_limited',
      'grant:forbidden',
      'grant:not_found',
      'grant:invalid_principal',
      'grant:upstream',
    ]);
  });

  it('accepts only ok and grant:not_visible as probe results', () => {
    for (const result of ['ok', 'grant:not_visible']) {
      expect(ReadGrantProbeResponseSchema.safeParse({ serviceAccountId: 'sa-1', result }).success).toBe(true);
    }
    expect(ReadGrantProbeResponseSchema.safeParse({ serviceAccountId: 'sa-1', result: 'maybe' }).success).toBe(false);
  });

  it('carries MOUNT_KIND_UNSUPPORTED as an API error code', () => {
    expect(API_ERROR_CODES).toContain('MOUNT_KIND_UNSUPPORTED');
    expect(
      ApiErrorBodySchema.safeParse({
        error: { code: 'MOUNT_KIND_UNSUPPORTED', message: 'm', requestId: 'r' },
      }).success,
    ).toBe(true);
  });
});
