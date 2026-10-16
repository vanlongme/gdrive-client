import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  API_ERROR_CODES,
  ApiErrorBodySchema,
  AppendBatchNodesRequestSchema,
  BatchNodeViewSchema,
  ChunkAddressSchema,
  ConnectionViewSchema,
  CreateAdminUserRequestSchema,
  CreateMediaPackageRequestSchema,
  CreateMountRequestSchema,
  CreateShareRequestSchema,
  CreateUploadRequestSchema,
  DecimalBytesSchema,
  DriveFileEntrySchema,
  ImportOAuthClientRequestSchema,
  ImportServiceAccountRequestSchema,
  MediaPackageViewSchema,
  MediaTicketSchema,
  MountAdminViewSchema,
  MountGrantViewSchema,
  MountViewSchema,
  OAuthClientViewSchema,
  PreviewDescriptorSchema,
  ReadinessViewSchema,
  ServiceAccountViewSchema,
  SetReadPoolRequestSchema,
  SetupStatusViewSchema,
  ShareScopeSchema,
  SPEC_ERROR_CODES,
  UPLOAD_STATES,
  UpdateMountRequestSchema,
  UploadStateSchema,
  UploadViewSchema,
  UpsertMountGrantRequestSchema,
  decimalBytesFromBigInt,
  decimalBytesToBigInt,
} from '../../src/shared/contracts';

function expectReject(schema: z.ZodType, value: unknown) {
  const result = schema.safeParse(value);
  expect(result.success, `expected rejection of ${JSON.stringify(value)}`).toBe(
    false,
  );
}

const validUploadView = {
  uploadId: 'up_123',
  state: 'uploading',
  sessionGeneration: 2,
  confirmedOffset: '8388608',
  totalBytes: '18446744073709551617',
  chunkSize: 8388608,
  readerAccessState: 'readable',
};

describe('DecimalBytes', () => {
  it('accepts canonical non-negative decimal strings', () => {
    for (const v of ['0', '1', '42', '8388608', '9007199254740993', '18446744073709551616']) {
      expect(DecimalBytesSchema.safeParse(v).success, v).toBe(true);
    }
  });

  it('preserves values above Number.MAX_SAFE_INTEGER exactly via bigint', () => {
    const big = '18446744073709551617';
    const parsed = DecimalBytesSchema.parse(big);
    expect(decimalBytesToBigInt(parsed)).toBe(18446744073709551617n);
    expect(decimalBytesFromBigInt(decimalBytesToBigInt(parsed))).toBe(big);
    expect(decimalBytesFromBigInt(0n)).toBe('0');
  });

  it('decimalBytesFromBigInt enforces the same domain as the schema', () => {
    expect(() => decimalBytesFromBigInt(-1n)).toThrow(RangeError);
    expect(() => decimalBytesFromBigInt(10n ** 30n)).toThrow(RangeError);
    expect(decimalBytesFromBigInt(10n ** 30n - 1n)).toBe('9'.repeat(30));
  });

  it('rejects negatives, fractions, exponents, padding and non-strings', () => {
    for (const v of [
      '-1',
      '1.5',
      '1e5',
      '1E9',
      '0x10',
      '007',
      '01',
      '',
      ' ',
      ' 1',
      '1 ',
      '+1',
      '1_000',
      '١٢٣',
      42,
      1.5,
      -1,
      null,
      undefined,
      '9'.repeat(31),
    ]) {
      expectReject(DecimalBytesSchema, v);
    }
  });
});

describe('UploadState', () => {
  it('covers exactly the 13 spec states', () => {
    expect(UPLOAD_STATES).toHaveLength(13);
    for (const s of UPLOAD_STATES) {
      expect(UploadStateSchema.safeParse(s).success, s).toBe(true);
    }
    expectReject(UploadStateSchema, 'done');
    expectReject(UploadStateSchema, '');
  });
});

describe('UploadView', () => {
  it('parses the plan T02 shape including decimal strings', () => {
    const view = UploadViewSchema.parse(validUploadView);
    expect(view.confirmedOffset).toBe('8388608');
    expect(view.totalBytes).toBe('18446744073709551617');
    expect(decimalBytesToBigInt(view.totalBytes) > BigInt(Number.MAX_SAFE_INTEGER)).toBe(true);
  });

  it.each([
    'uploadUri',
    'refreshEnvelope',
    'pinnedPrincipalId',
    'pinnedOauthClientId',
    'pinnedOauthConnectionId',
    'pinnedProjectId',
    'oauthClientSecret',
    'attemptId',
    'leaseId',
    'serviceAccountId',
    'accessToken',
  ])('rejects internal field %s', (field) => {
    expectReject(UploadViewSchema, { ...validUploadView, [field]: 'x' });
  });

  it('catalog entries cannot promise download capability', () => {
    const entry = {
      id: 'f1',
      kind: 'file',
      name: 'a.bin',
      mimeType: 'application/octet-stream',
      size: '10',
      modifiedTime: '2026-10-12T00:00:00Z',
      hasThumbnail: false,
    };
    expect(DriveFileEntrySchema.safeParse(entry).success).toBe(true);
    expectReject(DriveFileEntrySchema, { ...entry, canDownload: true });
  });

  it('rejects bad state/generation/offset shapes', () => {
    expectReject(UploadViewSchema, { ...validUploadView, state: 'done' });
    expectReject(UploadViewSchema, { ...validUploadView, sessionGeneration: 0 });
    expectReject(UploadViewSchema, { ...validUploadView, sessionGeneration: 1.5 });
    expectReject(UploadViewSchema, { ...validUploadView, confirmedOffset: '-1' });
    expectReject(UploadViewSchema, { ...validUploadView, chunkSize: 0 });
    expectReject(UploadViewSchema, { ...validUploadView, readerAccessState: 'ok' });
  });
});

describe('PreviewDescriptor', () => {
  const base = {
    contentMode: 'current-content',
    strictResumeSupported: false,
    readerAccessState: 'unchecked',
  };

  it('accepts coherent mode combinations', () => {
    expect(PreviewDescriptorSchema.safeParse(base).success).toBe(true);
    expect(
      PreviewDescriptorSchema.safeParse({
        contentMode: 'pinned-revision',
        revisionId: 'rev1',
        versionHint: 'v9',
        strictResumeSupported: true,
        readerAccessState: 'readable',
      }).success,
    ).toBe(true);
  });

  it('rejects incoherent version promises', () => {
    expectReject(PreviewDescriptorSchema, {
      ...base,
      strictResumeSupported: true,
    });
    expectReject(PreviewDescriptorSchema, {
      contentMode: 'pinned-revision',
      strictResumeSupported: true,
      readerAccessState: 'readable',
    });
    expectReject(PreviewDescriptorSchema, {
      contentMode: 'pinned-revision',
      strictResumeSupported: false,
      readerAccessState: 'readable',
    });
  });

  it('rejects unknown modes and internal extras', () => {
    expectReject(PreviewDescriptorSchema, { ...base, contentMode: 'snapshot' });
    expectReject(PreviewDescriptorSchema, { ...base, strictResumeSupported: 'yes' });
    expectReject(PreviewDescriptorSchema, { ...base, internalManifestUrl: 'u' });
    expectReject(PreviewDescriptorSchema, { ...base, readerAccessState: 'good' });
  });
});

describe('ApiErrorBody', () => {
  it('contains every spec 10.2 code', () => {
    for (const code of [
      'AUTH_REQUIRED',
      'FORBIDDEN',
      'DRIVE_UNAVAILABLE',
      'FILE_NOT_ACCESSIBLE',
      'RATE_LIMITED',
      'PROJECT_LIMITED',
      'STORAGE_FULL',
      'GOOGLE_REAUTH_REQUIRED',
      'GOOGLE_CONNECTION_DISABLED',
      'READ_PROVIDER_UNAVAILABLE',
      'FILE_NOT_READABLE_BY_POOL',
      'UPLOAD_EXPIRED',
      'UPLOAD_NEEDS_RECONCILIATION',
      'FILE_CONFLICT',
      'SNAPSHOT_UNAVAILABLE',
      'CONTENT_CHANGED',
      'MEDIA_PACKAGE_NOT_READY',
      'PREVIEW_UNSUPPORTED',
    ]) {
      expect(SPEC_ERROR_CODES).toContain(code);
      const body = ApiErrorBodySchema.safeParse({
        error: { code, message: 'm', requestId: 'r1' },
      });
      expect(body.success, code).toBe(true);
    }
    expect(API_ERROR_CODES.length).toBeGreaterThan(SPEC_ERROR_CODES.length);
    for (const code of [
      'BOOTSTRAP_SECRETS_INVALID',
      'SETUP_STATUS_UNAVAILABLE',
      'SETUP_NOT_IMPLEMENTED',
      'AUTH_NOT_IMPLEMENTED',
    ]) {
      expect(API_ERROR_CODES).toContain(code);
    }
  });

  it('accepts retryAfterSeconds and rejects malformed bodies', () => {
    expect(
      ApiErrorBodySchema.safeParse({
        error: { code: 'RATE_LIMITED', message: 'm', requestId: 'r', retryAfterSeconds: 30 },
      }).success,
    ).toBe(true);
    expectReject(ApiErrorBodySchema, {
      error: { code: 'NOPE', message: 'm', requestId: 'r' },
    });
    expectReject(ApiErrorBodySchema, { error: { code: 'NOT_FOUND', message: 'm' } });
    expectReject(ApiErrorBodySchema, {
      error: { code: 'NOT_FOUND', message: 'm', requestId: 'r', retryAfterSeconds: -1 },
    });
    expectReject(ApiErrorBodySchema, {
      error: { code: 'NOT_FOUND', message: 'm', requestId: 'r' },
      trace: 'internal',
    });
  });
});

describe('admin DTOs never carry secrets or internal identity', () => {
  const conn = {
    id: 'c1',
    displayEmail: 'op@example.com',
    state: 'connected',
    enabled: true,
    grantedScopes: ['https://www.googleapis.com/auth/drive'],
    oauthClientId: 'oc1',
    connectedBy: 'u1',
    version: 1,
    createdAt: '2026-10-12T00:00:00Z',
  };
  const sa = {
    id: 'sa1',
    projectId: 'p',
    email: 'sa@p.iam.gserviceaccount.com',
    keyId: 'k1',
    enabled: true,
    version: 1,
    createdAt: '2026-10-12T00:00:00Z',
  };
  const client = {
    id: 'oc1',
    projectId: 'p',
    clientId: 'cid.apps.googleusercontent.com',
    redirectUri: 'https://app.example.com/cb',
    enabled: true,
    version: 1,
    createdAt: '2026-10-12T00:00:00Z',
  };

  it.each([
    [ConnectionViewSchema, conn, 'refreshEnvelope'],
    [ConnectionViewSchema, conn, 'principalId'],
    [ConnectionViewSchema, conn, 'accessToken'],
    [ServiceAccountViewSchema, sa, 'envelope'],
    [ServiceAccountViewSchema, sa, 'privateKey'],
    [OAuthClientViewSchema, client, 'secretEnvelope'],
    [OAuthClientViewSchema, client, 'clientSecret'],
  ])('%# rejects forbidden field %s', (schema, dto, field) => {
    expectReject(schema as z.ZodType, { ...(dto as object), [field]: 'x' });
  });

  it('parses safe admin shapes', () => {
    expect(ConnectionViewSchema.safeParse(conn).success).toBe(true);
    expect(ServiceAccountViewSchema.safeParse(sa).success).toBe(true);
    expect(OAuthClientViewSchema.safeParse(client).success).toBe(true);
    expect(
      MountAdminViewSchema.safeParse({
        id: 'm1',
        label: 'Team drive',
        driveId: '0ALxx',
        catalogConnectionId: 'c1',
        writeConnectionId: 'c1',
        readPoolVersion: 1,
        visibility: 'private',
        policyVersion: 1,
        readPool: [sa],
      }).success,
    ).toBe(true);
    expect(
      SetupStatusViewSchema.safeParse({
        setupState: 'in_progress',
        canonicalOrigin: null,
      }).success,
    ).toBe(true);
  });
});

describe('request DTOs', () => {
  it('CreateUploadRequest validates checksums and rejects extras', () => {
    const req = {
      mountId: 'm1',
      parentId: 'f1',
      name: 'a.bin',
      mimeType: 'application/octet-stream',
      totalBytes: '10737418240',
      sha256: 'a'.repeat(64),
      md5: 'b'.repeat(32),
    };
    expect(CreateUploadRequestSchema.safeParse(req).success).toBe(true);
    expect(
      CreateUploadRequestSchema.safeParse({ ...req, batchId: 'b1', nodeId: 'n1' }).success,
    ).toBe(true);
    expectReject(CreateUploadRequestSchema, { ...req, sha256: 'A'.repeat(64) });
    expectReject(CreateUploadRequestSchema, { ...req, sha256: 'a'.repeat(63) });
    expectReject(CreateUploadRequestSchema, { ...req, md5: 'b'.repeat(31) });
    expectReject(CreateUploadRequestSchema, { ...req, uploadSessionUri: 'x' });
    expectReject(CreateUploadRequestSchema, { ...req, totalBytes: '1e10' });
  });

  it('ChunkAddress requires generation and decimal offset', () => {
    expect(
      ChunkAddressSchema.safeParse({ generation: 1, offset: '0' }).success,
    ).toBe(true);
    expectReject(ChunkAddressSchema, { generation: 0, offset: '0' });
    expectReject(ChunkAddressSchema, { generation: 1, offset: '-8' });
  });

  it('ShareScope discriminates mount/file/package', () => {
    expect(
      ShareScopeSchema.safeParse({ kind: 'mount', mountId: 'm1' }).success,
    ).toBe(true);
    expect(
      ShareScopeSchema.safeParse({ kind: 'file', mountId: 'm1', fileId: 'f1' }).success,
    ).toBe(true);
    expect(
      ShareScopeSchema.safeParse({ kind: 'package', mountId: 'm1', packageId: 'p1' }).success,
    ).toBe(true);
    expectReject(ShareScopeSchema, { kind: 'drive', mountId: 'm1' });
    expectReject(ShareScopeSchema, { kind: 'file', mountId: 'm1' });
    expectReject(ShareScopeSchema, { kind: 'mount', mountId: 'm1', token: 'x' });
    expect(
      CreateShareRequestSchema.safeParse({
        scope: { kind: 'mount', mountId: 'm1' },
        expiresAt: '2026-10-13T00:00:00Z',
      }).success,
    ).toBe(true);
    expectReject(CreateShareRequestSchema, {
      scope: { kind: 'mount', mountId: 'm1' },
    });
    expectReject(CreateShareRequestSchema, {
      scope: { kind: 'mount', mountId: 'm1' },
      ttlSeconds: 3600,
    });
    expectReject(CreateShareRequestSchema, {
      scope: { kind: 'mount', mountId: 'm1' },
      expiresAt: 'not-a-date',
    });
  });

  it('batch node inputs carry opaque ids and decimal sizes', () => {
    const node = {
      nodeId: 'n1',
      parentNodeId: null,
      kind: 'folder',
      displayName: 'dir',
    };
    const req = { planVersion: 0, nodes: [node] };
    expect(AppendBatchNodesRequestSchema.safeParse(req).success).toBe(true);
    expect(
      BatchNodeViewSchema.safeParse({ ...node, state: 'completed', driveFileId: 'd1' })
        .success,
    ).toBe(true);
    expectReject(AppendBatchNodesRequestSchema, { planVersion: 0, nodes: [] });
    expectReject(AppendBatchNodesRequestSchema, {
      planVersion: -1,
      nodes: [node],
    });
  });

  it('media package view only publishes a playable URL when ready', () => {
    expect(
      MediaPackageViewSchema.safeParse({
        packageId: 'p1',
        state: 'ready',
        indexGeneration: 3,
        readyGeneration: 3,
        strictSnapshot: true,
        playerUrl: '/api/v1/media-packages/p1/player',
      }).success,
    ).toBe(true);
    expect(
      MediaPackageViewSchema.safeParse({
        packageId: 'p1',
        state: 'preparing',
        indexGeneration: 2,
        strictSnapshot: false,
      }).success,
    ).toBe(true);
    expectReject(MediaPackageViewSchema, {
      packageId: 'p1',
      state: 'ready',
      indexGeneration: 3,
      readyGeneration: 3,
      strictSnapshot: false,
    });
    expectReject(MediaPackageViewSchema, {
      packageId: 'p1',
      state: 'ready',
      indexGeneration: 3,
      strictSnapshot: false,
      playerUrl: '/x',
    });
    expectReject(MediaPackageViewSchema, {
      packageId: 'p1',
      state: 'preparing',
      indexGeneration: 2,
      strictSnapshot: false,
      playerUrl: '/x',
    });
    expectReject(MediaPackageViewSchema, {
      packageId: 'p1',
      state: 'failed',
      indexGeneration: 2,
      strictSnapshot: false,
      playerUrl: '/x',
    });
  });

  it('media package/ticket/readiness shapes stay safe', () => {
    expect(
      CreateMediaPackageRequestSchema.safeParse({ mountId: 'm', entryFileId: 'f' })
        .success,
    ).toBe(true);
    expect(
      MediaTicketSchema.safeParse({
        ticket: 't',
        expiresAt: '2026-10-12T01:00:00Z',
      }).success,
    ).toBe(true);
    expect(
      ReadinessViewSchema.safeParse({
        fileId: 'f',
        readerAccessState: 'blocked',
        reason: 'SA pool lacks membership',
      }).success,
    ).toBe(true);
    expectReject(ReadinessViewSchema, { fileId: 'f', readerAccessState: 'ok' });
    expectReject(MediaTicketSchema, { ticket: 't' });
  });
});

describe('wave-3 mount/admin contracts', () => {
  it('MountView carries rootFolderId and operations, never internal ids', () => {
    const view = {
      id: 'm1',
      label: 'Team Drive',
      visibility: 'private',
      rootFolderId: '0ALxx',
      operations: ['read', 'upload'],
    };
    expect(MountViewSchema.safeParse(view).success).toBe(true);
    expectReject(MountViewSchema, { ...view, driveId: '0ALxx' });
    expectReject(MountViewSchema, { ...view, catalogConnectionId: 'c1' });
    expectReject(MountViewSchema, { ...view, operations: ['read', 'impersonate'] });
    expectReject(MountViewSchema, { ...view, secret: 'x' });
  });

  it('MountGrantView carries the effective operations allowlist', () => {
    const grant = {
      userId: 'u1',
      mountId: 'm1',
      role: 'uploader',
      operations: ['read', 'upload'],
      grantedBy: 'admin-1',
      createdAt: '2026-10-12T00:00:00Z',
    };
    expect(MountGrantViewSchema.safeParse(grant).success).toBe(true);
    expectReject(MountGrantViewSchema, { ...grant, oauthClientId: 'oc1' });
  });

  it('ImportOAuthClientRequest accepts secret + optional project/redirect', () => {
    expect(
      ImportOAuthClientRequestSchema.safeParse({
        clientId: '123-a.apps.googleusercontent.com',
        clientSecret: 's3cret',
      }).success,
    ).toBe(true);
    expect(
      ImportOAuthClientRequestSchema.safeParse({
        clientId: 'c',
        clientSecret: 's',
        projectId: 'p',
        redirectUri: 'https://app/cb',
      }).success,
    ).toBe(true);
    expectReject(ImportOAuthClientRequestSchema, { clientId: 'c' });
    expectReject(ImportOAuthClientRequestSchema, {
      clientId: 'c',
      clientSecret: 's',
      refreshToken: 'rt',
    });
  });

  it('ImportServiceAccountRequest is keyJson-only (never envelopes)', () => {
    expect(
      ImportServiceAccountRequestSchema.safeParse({ keyJson: '{"a":1}' }).success,
    ).toBe(true);
    expectReject(ImportServiceAccountRequestSchema, {});
    expectReject(ImportServiceAccountRequestSchema, {
      keyJson: '{}',
      envelope: 'sealed',
    });
  });

  it('CreateMountRequest requires both connections and a shared drive id', () => {
    const req = {
      label: 'Team',
      driveId: '0ALxx',
      catalogConnectionId: 'c1',
      writeConnectionId: 'c2',
      serviceAccountIds: ['sa-1'],
      visibility: 'public_read',
    };
    expect(CreateMountRequestSchema.safeParse(req).success).toBe(true);
    expectReject(CreateMountRequestSchema, { ...req, writeConnectionId: undefined });
    expectReject(CreateMountRequestSchema, { ...req, visibility: 'friends' });
    expectReject(CreateMountRequestSchema, { ...req, principalId: 'p' });
    // serviceAccountIds/visibility default when omitted
    const minimal = CreateMountRequestSchema.parse({
      label: 'Team',
      driveId: '0ALxx',
      catalogConnectionId: 'c1',
      writeConnectionId: 'c2',
    });
    expect(minimal.serviceAccountIds).toEqual([]);
    expect(minimal.visibility).toBe('private');
  });

  it('UpdateMountRequest only accepts declared mount fields', () => {
    expect(UpdateMountRequestSchema.safeParse({ label: 'x' }).success).toBe(true);
    expect(UpdateMountRequestSchema.safeParse({}).success).toBe(true);
    expectReject(UpdateMountRequestSchema, { driveId: 'other' });
  });

  it('SetReadPoolRequest validates entry shapes', () => {
    expect(
      SetReadPoolRequestSchema.safeParse({
        entries: [{ serviceAccountId: 'sa1', priority: 5, weight: 2 }],
      }).success,
    ).toBe(true);
    expectReject(SetReadPoolRequestSchema, {
      entries: [{ serviceAccountId: 'sa1', priority: -1 }],
    });
    expectReject(SetReadPoolRequestSchema, { entries: [{}] });
  });

  it('UpsertMountGrantRequest bounds operations to the mount vocabulary', () => {
    expect(
      UpsertMountGrantRequestSchema.safeParse({ userId: 'u', role: 'viewer' })
        .success,
    ).toBe(true);
    expect(
      UpsertMountGrantRequestSchema.safeParse({
        userId: 'u',
        role: 'uploader',
        operations: ['read', 'upload'],
      }).success,
    ).toBe(true);
    expectReject(UpsertMountGrantRequestSchema, {
      userId: 'u',
      role: 'viewer',
      operations: ['read', 'admin', 'delete'],
    });
    expectReject(UpsertMountGrantRequestSchema, {
      userId: 'u',
      role: 'viewer',
      operations: [],
    });
  });

  it('CreateAdminUserRequest requires credentials and a valid role', () => {
    expect(
      CreateAdminUserRequestSchema.safeParse({
        name: 'A',
        email: 'a@b.test',
        password: 'long-enough-password',
        role: 'admin',
      }).success,
    ).toBe(true);
    expectReject(CreateAdminUserRequestSchema, {
      name: 'A',
      email: 'not-an-email',
      password: 'long-enough-password',
      role: 'user',
    });
    expectReject(CreateAdminUserRequestSchema, {
      name: 'A',
      email: 'a@b.test',
      password: 'short',
      role: 'user',
    });
    expectReject(CreateAdminUserRequestSchema, {
      name: 'A',
      email: 'a@b.test',
      password: 'long-enough-password',
      role: 'superadmin',
    });
  });
});
