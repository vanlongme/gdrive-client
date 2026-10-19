import { env, applyD1Migrations, type D1Migration } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';

// Runs against a real local D1 (miniflare/workerd). Wrangler D1 migrations are
// the single migration authority: the checked-in files under migrations/ are
// fed to the test binding as TEST_MIGRATIONS (wired in vitest.config.ts) and
// applied with the official applyD1Migrations helper, which records progress
// in the same d1_migrations table wrangler uses. Tests share one database and
// use distinct ids.
const db = env.DB;
const rawMigrations = (env as unknown as { TEST_MIGRATIONS: unknown })
  .TEST_MIGRATIONS;
const migrations = (
  typeof rawMigrations === 'string' ? JSON.parse(rawMigrations) : rawMigrations
) as D1Migration[];

const NOW = Date.now();
const PREP = (sql: string, ...args: unknown[]) => db.prepare(sql).bind(...args);

async function insertUser(id: string) {
  await PREP(
    `INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
     VALUES (?, ?, ?, 0, ?, ?)`,
    id,
    `User ${id}`,
    `${id}@example.com`,
    '2026-10-12T00:00:00.000Z',
    '2026-10-12T00:00:00.000Z',
  ).run();
}

async function insertConnectionChain(ids: {
  client: string;
  connection: string;
  user: string;
}) {
  await insertUser(ids.user);
  await PREP(
    `INSERT INTO google_oauth_clients
       (id, project_id, client_id, secret_envelope, redirect_uri, created_at, updated_at)
     VALUES (?, 'proj', ?, 'env', 'https://app.example.com/cb', ?, ?)`,
    ids.client,
    `${ids.client}.apps.googleusercontent.com`,
    NOW,
    NOW,
  ).run();
  await PREP(
    `INSERT INTO google_connections
       (id, oauth_client_id, principal_id, display_email, granted_scopes,
        connected_by, created_at, updated_at)
     VALUES (?, ?, 'principal-1', 'op@example.com', 'scope', ?, ?, ?)`,
    ids.connection,
    ids.client,
    ids.user,
    NOW,
    NOW,
  ).run();
}

async function insertMount(
  id: string,
  ids: { client: string; connection: string; user: string },
) {
  await insertConnectionChain(ids);
  await PREP(
    `INSERT INTO mounts
       (id, label, drive_id, root_folder_id, catalog_connection_id,
        write_connection_id, created_at, updated_at)
     VALUES (?, 'Mount', 'drive-1', 'drive-1', ?, ?, ?, ?)`,
    id,
    ids.connection,
    ids.connection,
    NOW,
    NOW,
  ).run();
}

async function insertOperation(ids: {
  op: string;
  user: string;
  mount: string;
  idem: string;
  input?: string;
}) {
  await PREP(
    `INSERT INTO upload_operations
       (id, owner_id, mount_id, kind, idempotency_hash, input_hash,
        pinned_oauth_connection_id, pinned_principal_id,
        pinned_oauth_client_id, pinned_project_id, created_at, updated_at)
     VALUES (?, ?, ?, 'file', ?, ?, 'conn-1', 'principal-1', 'client-1', 'proj', ?, ?)`,
    ids.op,
    ids.user,
    ids.mount,
    ids.idem,
    ids.input ?? 'input-hash',
    NOW,
    NOW,
  ).run();
}

beforeAll(async () => {
  await applyD1Migrations(db, migrations);
});

describe('migration authority', () => {
  it('feeds the checked-in migrations/*.sql as D1Migration entries', () => {
    expect(migrations.length).toBeGreaterThanOrEqual(1);
    expect(migrations[0]!.name).toMatch(/0001.*\.sql/);
    for (const m of migrations) {
      expect(m.queries.length).toBeGreaterThan(0);
    }
  });

  it('creates every spec 10.1 table on an empty database', async () => {
    const { results } = await db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
      .all<{ name: string }>();
    const tables = new Set(results.map((r) => r.name));
    for (const name of [
      'user',
      'session',
      'account',
      'verification',
      'app_settings',
      'service_accounts',
      'google_oauth_clients',
      'google_connections',
      'oauth_transactions',
      'containment_verdicts',
    'mounts',
      'mount_read_credentials',
      'mount_grants',
      'upload_batches',
      'upload_operations',
      'upload_batch_nodes',
      'file_readiness',
      'share_links',
      'media_packages',
      'media_package_resources',
      'audit_events',
      'd1_migrations',
    ]) {
      expect(tables.has(name), `missing table ${name}`).toBe(true);
    }
  });

  it('is idempotent: reapply does not touch existing data', async () => {
    await PREP(
      `INSERT INTO service_accounts (id, project_id, email, key_id, envelope, created_at, updated_at)
       VALUES ('sa-reapply', 'proj-r', 'sa@r.iam.gserviceaccount.com', 'k1', 'env', ?, ?)`,
      NOW,
      NOW,
    ).run();
    await applyD1Migrations(db, migrations);
    const row = await db
      .prepare(`SELECT email FROM service_accounts WHERE id = 'sa-reapply'`)
      .first<{ email: string }>();
    expect(row?.email).toBe('sa@r.iam.gserviceaccount.com');
    const { results } = await db
      .prepare(`SELECT name FROM d1_migrations`)
      .all<{ name: string }>();
    expect(results.map((r) => r.name)).toContain('0001_initial.sql');
  });
});

describe('app_settings singleton', () => {
  it('rejects ids other than 1 and invalid setup states', async () => {
    await expect(
      PREP(
        `INSERT INTO app_settings (id, created_at, updated_at) VALUES (2, ?, ?)`,
        NOW,
        NOW,
      ).run(),
    ).rejects.toThrow();
    await expect(
      PREP(
        `INSERT INTO app_settings (id, setup_state, created_at, updated_at) VALUES (1, 'bogus', ?, ?)`,
        NOW,
        NOW,
      ).run(),
    ).rejects.toThrow();
    await expect(
      PREP(
        `INSERT INTO app_settings (id, setup_state, created_at, updated_at) VALUES (0, 'uninitialized', ?, ?)`,
        NOW,
        NOW,
      ).run(),
    ).rejects.toThrow();
  });

  it('accepts a single id=1 row and cleans up after itself', async () => {
    const insert = await PREP(
      `INSERT OR IGNORE INTO app_settings (id, setup_state, canonical_origin, version, created_at, updated_at)
       VALUES (1, 'in_progress', NULL, 1, ?, ?)`,
      NOW,
      NOW,
    ).run();
    const row = await db
      .prepare(`SELECT setup_state FROM app_settings WHERE id = 1`)
      .first<{ setup_state: string }>();
    expect(row?.setup_state).toBeDefined();
    // Only delete when this test created the row; another suite may own it.
    if ((insert.meta?.changes ?? 0) === 1) {
      await PREP(`DELETE FROM app_settings WHERE id = 1`).run();
    }
  });
});

describe('upload_operations uniqueness and tombstones', () => {
  it('enforces UNIQUE(owner_id, idempotency_hash)', async () => {
    const ids = { client: 'c-u1', connection: 'conn-u1', user: 'user-u1' };
    await insertMount('mount-u1', ids);
    await insertOperation({ op: 'op-1', user: ids.user, mount: 'mount-u1', idem: 'h1' });
    await expect(
      insertOperation({ op: 'op-2', user: ids.user, mount: 'mount-u1', idem: 'h1' }),
    ).rejects.toThrow();
    await insertOperation({ op: 'op-3', user: ids.user, mount: 'mount-u1', idem: 'h2' });
    const other = 'user-u2';
    await insertUser(other);
    await insertOperation({ op: 'op-4', user: other, mount: 'mount-u1', idem: 'h1' });
  });

  it('keeps the final result in the tombstone after detail purge', async () => {
    await PREP(
      `UPDATE upload_operations
         SET state='completed',
             result='{"fileId":"file-xyz","sha256Verified":true}',
             summary=NULL, generated_file_id='file-xyz',
             detail_purged_at=?, completed_at=?
       WHERE id='op-1'`,
      NOW,
      NOW,
    ).run();
    const row = await db
      .prepare(
        `SELECT id, state, result, generated_file_id, pinned_oauth_connection_id,
                pinned_principal_id, pinned_oauth_client_id, pinned_project_id
         FROM upload_operations WHERE owner_id='user-u1' AND idempotency_hash='h1'`,
      )
      .first<Record<string, string>>();
    expect(row?.id).toBe('op-1');
    expect(row?.state).toBe('completed');
    expect(row?.result).toContain('file-xyz');
    expect(row?.generated_file_id).toBe('file-xyz');
    expect(row?.pinned_oauth_connection_id).toBe('conn-1');
    expect(row?.pinned_principal_id).toBe('principal-1');
  });

  it('rejects invalid operation states via CHECK', async () => {
    await expect(
      PREP(
        `INSERT INTO upload_operations
           (id, owner_id, mount_id, kind, idempotency_hash, input_hash,
            pinned_oauth_connection_id, pinned_principal_id,
            pinned_oauth_client_id, pinned_project_id, state, created_at, updated_at)
         VALUES ('op-bad','user-u1','mount-u1','file','h9','i','c','p','cl','pr','bogus',?,?)`,
        NOW,
        NOW,
      ).run(),
    ).rejects.toThrow();
  });
});

describe('batches and nodes', () => {
  it('enforces (batch_id, node_id) uniqueness and self-referencing parent FK', async () => {
    const ids = { client: 'c-b1', connection: 'conn-b1', user: 'user-b1' };
    await insertMount('mount-b1', ids);
    await PREP(
      `INSERT INTO upload_batches (id, owner_id, mount_id, root_parent_id, created_at, updated_at)
       VALUES ('batch-1', 'user-b1', 'mount-b1', 'root-f', ?, ?)`,
      NOW,
      NOW,
    ).run();
    const node = (n: string, parent: string | null, name: string) =>
      PREP(
        `INSERT INTO upload_batch_nodes
           (batch_id, node_id, parent_node_id, kind, display_name, created_at, updated_at)
         VALUES ('batch-1', ?, ?, 'folder', ?, ?, ?)`,
        n,
        parent,
        name,
        NOW,
        NOW,
      ).run();
    await node('root', null, 'root');
    await node('a', 'root', 'same-name');
    await node('b', 'root', 'same-name');
    await expect(node('a', 'root', 'dup')).rejects.toThrow();
    await expect(node('orphan', 'missing-parent', 'x')).rejects.toThrow();
  });

  it('preserves decimal-string sizes above Number.MAX_SAFE_INTEGER', async () => {
    const big = '18446744073709551617';
    await PREP(
      `INSERT INTO upload_batch_nodes
         (batch_id, node_id, parent_node_id, kind, display_name, total_bytes, created_at, updated_at)
       VALUES ('batch-1', 'big-file', 'root', 'file', 'big.bin', ?, ?, ?)`,
      big,
      NOW,
      NOW,
    ).run();
    const row = await db
      .prepare(
        `SELECT total_bytes FROM upload_batch_nodes WHERE batch_id='batch-1' AND node_id='big-file'`,
      )
      .first<{ total_bytes: string }>();
    expect(row?.total_bytes).toBe(big);
    expect(BigInt(row!.total_bytes)).toBe(18446744073709551617n);
  });
});

describe('foreign keys and uniqueness', () => {
  it('rejects read-pool rows pointing at missing mounts or SAs', async () => {
    await expect(
      PREP(
        `INSERT INTO mount_read_credentials (mount_id, service_account_id, created_at)
         VALUES ('no-mount', 'no-sa', ?)`,
        NOW,
      ).run(),
    ).rejects.toThrow();
  });

  it('enforces SA identity and oauth state-hash uniqueness', async () => {
    await PREP(
      `INSERT INTO service_accounts (id, project_id, email, key_id, envelope, created_at, updated_at)
       VALUES ('sa-1', 'proj-1', 'sa@proj.iam.gserviceaccount.com', 'k1', 'env', ?, ?)`,
      NOW,
      NOW,
    ).run();
    await expect(
      PREP(
        `INSERT INTO service_accounts (id, project_id, email, key_id, envelope, created_at, updated_at)
         VALUES ('sa-2', 'proj-1', 'sa@proj.iam.gserviceaccount.com', 'k2', 'env2', ?, ?)`,
        NOW,
        NOW,
      ).run(),
    ).rejects.toThrow();

    const ids = { client: 'c-t1', connection: 'conn-t1', user: 'user-t1' };
    await insertConnectionChain(ids);
    const tx = (id: string, hash: string) =>
      PREP(
        `INSERT INTO oauth_transactions
           (id, state_hash, admin_session_id, installation_id, oauth_client_id,
            client_version, purpose, expires_at, created_at)
         VALUES (?, ?, 'sess', 'inst', ?, 1, 'connect', ?, ?)`,
        id,
        hash,
        ids.client,
        NOW + 600000,
        NOW,
      ).run();
    await tx('tx-1', 'state-hash-1');
    await expect(tx('tx-2', 'state-hash-1')).rejects.toThrow();
  });

  it('enforces media package resource identity per generation', async () => {
    const ids = { client: 'c-m1', connection: 'conn-m1', user: 'user-m1' };
    await insertMount('mount-m1', ids);
    await PREP(
      `INSERT INTO media_packages (id, mount_id, entry_file_id, created_by, created_at, updated_at)
       VALUES ('pkg-1', 'mount-m1', 'entry-1', 'user-m1', ?, ?)`,
      NOW,
      NOW,
    ).run();
    const res = (rid: string, gen: number, path: string) =>
      PREP(
        `INSERT INTO media_package_resources
           (package_id, index_generation, resource_id, path, file_id, created_at)
         VALUES ('pkg-1', ?, ?, ?, 'file-1', ?)`,
        gen,
        rid,
        path,
        NOW,
      ).run();
    await res('r1', 1, 'index.m3u8');
    await expect(res('r1', 1, 'other.m3u8')).rejects.toThrow();
    await expect(res('r2', 1, 'index.m3u8')).rejects.toThrow();
    await res('r1', 2, 'index.m3u8');
  });

  it('enforces share token-hash uniqueness and audit FK shape', async () => {
    const ids = { client: 'c-s1', connection: 'conn-s1', user: 'user-s1' };
    await insertMount('mount-s1', ids);
    const share = (id: string, hash: string) =>
      PREP(
        `INSERT INTO share_links
           (id, token_hash, created_by, scope_kind, mount_id, expires_at,
            policy_version, created_at)
         VALUES (?, ?, 'user-s1', 'mount', 'mount-s1', ?, 1, ?)`,
        id,
        hash,
        NOW + 3600000,
        NOW,
      ).run();
    await share('sh-1', 'hash-1');
    await expect(share('sh-2', 'hash-1')).rejects.toThrow();

    await PREP(
      `INSERT INTO audit_events
         (id, actor_kind, actor_user_id, provider, operation, target_type,
          target_id, result, request_id, created_at)
       VALUES ('ev-1', 'user', 'user-s1', 'service_account', 'content.get',
               'file', 'file-1', 'ok', 'req-1', ?)`,
      NOW,
    ).run();
    await expect(
      PREP(
        `INSERT INTO audit_events
           (id, actor_kind, operation, result, request_id, created_at)
         VALUES ('ev-2', 'ghost', 'x', 'ok', 'r', ?)`,
        NOW,
      ).run(),
    ).rejects.toThrow();
  });
});
