import { env, applyD1Migrations, type D1Migration } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';

// Review Focus #5: 0007 rebuilds `mounts` on a populated database. This file
// uses its own MIGRATION_DB binding (vitest.config.ts) so it can stop at
// 0006, seed a Shared Drive mount plus one row in each of the seven tables
// that reference mounts(id), and only then apply 0007 — the shared DB used
// by every other file is already fully migrated.
const db = (env as unknown as { MIGRATION_DB: D1Database }).MIGRATION_DB;
const rawMigrations = (env as unknown as { TEST_MIGRATIONS: unknown }).TEST_MIGRATIONS;
const migrations = (typeof rawMigrations === 'string' ? JSON.parse(rawMigrations) : rawMigrations) as D1Migration[];

const MIGRATION_0007 = '0007_my_drive_mounts.sql';
const DRIVE = '0AAAsharedDrive0007';
const NOW = 1_760_000_000_000;
const CHILD_TABLES = [
  'mount_read_credentials', 'mount_grants', 'upload_batches', 'upload_operations',
  'file_readiness', 'share_links', 'media_packages',
] as const;

const sql = (text: string, ...args: unknown[]) => db.prepare(text).bind(...args);

function pre0007(): D1Migration[] {
  const index = migrations.findIndex((m) => m.name === MIGRATION_0007);
  expect(index, '0007 is present in migrations/').toBeGreaterThan(0);
  return migrations.slice(0, index);
}

/** Drop every table so a re-run (watch mode) starts from an empty DB. */
async function resetMigrationDb(): Promise<void> {
  const { results } = await db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'")
    .all<{ name: string }>();
  if (results.length === 0) return;
  await db.batch([
    db.prepare('PRAGMA defer_foreign_keys = on'),
    ...results.map((r) => db.prepare(`DROP TABLE IF EXISTS "${r.name.replace(/"/g, '""')}"`)),
    db.prepare('PRAGMA defer_foreign_keys = off'),
  ]);
}

async function seedPre0007(): Promise<void> {
  await db.batch([
    sql(`INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
         VALUES ('u-1', 'U', 'u-1@example.com', 0, '2026-10-18T00:00:00.000Z', '2026-10-18T00:00:00.000Z')`),
    sql(`INSERT INTO google_oauth_clients (id, project_id, client_id, secret_envelope, redirect_uri, created_at, updated_at)
         VALUES ('oc-1', 'proj', 'oc-1.apps.googleusercontent.com', 'env', 'https://app.example.com/cb', ?, ?)`, NOW, NOW),
    sql(`INSERT INTO google_connections (id, oauth_client_id, principal_id, display_email, granted_scopes, connected_by, created_at, updated_at)
         VALUES ('conn-1', 'oc-1', 'principal-1', 'op@example.com', 'scope', 'u-1', ?, ?)`, NOW, NOW),
    sql(`INSERT INTO service_accounts (id, project_id, email, key_id, envelope, created_at, updated_at)
         VALUES ('sa-1', 'proj', 'sa-1@proj.iam.gserviceaccount.com', 'k1', 'env', ?, ?)`, NOW, NOW),
    sql(`INSERT INTO mounts (id, label, drive_id, catalog_connection_id, write_connection_id,
                             read_pool_version, visibility, policy_version, created_at, updated_at)
         VALUES ('m-1', 'Team', ?, 'conn-1', 'conn-1', 4, 'public_read', 3, ?, ?)`, DRIVE, NOW, NOW + 1),
    sql(`INSERT INTO mount_read_credentials (mount_id, service_account_id, priority, weight, created_at)
         VALUES ('m-1', 'sa-1', 2, 3, ?)`, NOW),
    sql(`INSERT INTO mount_grants (user_id, mount_id, role, operations, created_at, updated_at)
         VALUES ('u-1', 'm-1', 'uploader', '["read","upload"]', ?, ?)`, NOW, NOW),
    sql(`INSERT INTO upload_batches (id, owner_id, mount_id, root_parent_id, created_at, updated_at)
         VALUES ('b-1', 'u-1', 'm-1', ?, ?, ?)`, DRIVE, NOW, NOW),
    sql(`INSERT INTO upload_operations (id, owner_id, mount_id, batch_id, kind, idempotency_hash, input_hash,
           pinned_oauth_connection_id, pinned_principal_id, pinned_oauth_client_id, pinned_project_id, created_at, updated_at)
         VALUES ('op-1', 'u-1', 'm-1', 'b-1', 'file', 'idem-1', 'in-1', 'conn-1', 'principal-1', 'oc-1', 'proj', ?, ?)`, NOW, NOW),
    sql(`INSERT INTO file_readiness (mount_id, file_id, reader_access_state, read_pool_version, policy_version, updated_at)
         VALUES ('m-1', 'f-1', 'readable', 4, 3, ?)`, NOW),
    sql(`INSERT INTO share_links (id, token_hash, created_by, scope_kind, mount_id, expires_at, policy_version, created_at)
         VALUES ('s-1', 'hash-1', 'u-1', 'mount', 'm-1', ?, 3, ?)`, NOW + 60_000, NOW),
    sql(`INSERT INTO media_packages (id, mount_id, entry_file_id, created_by, created_at, updated_at)
         VALUES ('p-1', 'm-1', 'f-1', 'u-1', ?, ?)`, NOW, NOW),
  ]);
}

/** INSERT INTO mounts with an explicit column list (NOW for both timestamps). */
function insertMount(columns: string, values: string) {
  return sql(`INSERT INTO mounts (${columns}, created_at, updated_at) VALUES (${values}, ?, ?)`, NOW, NOW).run();
}

beforeAll(async () => {
  await resetMigrationDb();
  await applyD1Migrations(db, pre0007());
  await seedPre0007();
  await applyD1Migrations(db, migrations.filter((m) => m.name === MIGRATION_0007));
});

describe('migration 0007 on a populated database', () => {
  it('records 0007 in the d1_migrations ledger', async () => {
    const row = await sql('SELECT name FROM d1_migrations WHERE name = ?', MIGRATION_0007).first<{ name: string }>();
    expect(row?.name).toBe(MIGRATION_0007);
  });

  it('keeps every foreign key resolvable', async () => {
    expect((await db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
  });

  it('keeps the Shared Drive mount intact with root_folder_id = drive_id', async () => {
    expect(await sql('SELECT * FROM mounts WHERE id = ?', 'm-1').first()).toEqual({
      id: 'm-1', label: 'Team', drive_id: DRIVE, root_folder_id: DRIVE,
      catalog_connection_id: 'conn-1', write_connection_id: 'conn-1', read_pool_version: 4,
      visibility: 'public_read', policy_version: 3, created_at: NOW, updated_at: NOW + 1,
    });
  });

  it('keeps one row in each of the seven child tables', async () => {
    for (const table of CHILD_TABLES) {
      const row = await sql(`SELECT COUNT(*) AS n FROM ${table} WHERE mount_id = 'm-1'`).first<{ n: number }>();
      expect(row?.n, table).toBe(1);
    }
  });

  it('still enforces child foreign keys against the rebuilt table', async () => {
    await expect(
      sql(`INSERT INTO file_readiness (mount_id, file_id, read_pool_version, policy_version, updated_at)
           VALUES ('m-missing', 'f-2', 1, 1, ?)`, NOW).run(),
    ).rejects.toThrow(/FOREIGN KEY/);
  });

  it('recreates mounts_drive_id_idx and adds mounts_root_folder_id_idx', async () => {
    const { results } = await db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'mounts'")
      .all<{ name: string }>();
    expect(results.map((r) => r.name)).toEqual(expect.arrayContaining(['mounts_drive_id_idx', 'mounts_root_folder_id_idx']));
  });

  it('rejects a Shared Drive row whose root differs from drive_id', async () => {
    await expect(
      insertMount(
        'id, label, drive_id, root_folder_id, catalog_connection_id, write_connection_id',
        "'m-bad', 'Bad', '0AAAdrive', 'folder-x', 'conn-1', 'conn-1'",
      ),
    ).rejects.toThrow(/CHECK/);
  });

  it('rejects a mount without root_folder_id', async () => {
    await expect(
      insertMount(
        'id, label, drive_id, catalog_connection_id, write_connection_id',
        "'m-noroot', 'No root', '0AAAdrive', 'conn-1', 'conn-1'",
      ),
    ).rejects.toThrow(/NOT NULL/);
  });

  it('accepts a My Drive folder mount with NULL drive_id', async () => {
    await insertMount(
      'id, label, drive_id, root_folder_id, catalog_connection_id, write_connection_id',
      "'m-my', 'Mine', NULL, '1FolderMyDrive', 'conn-1', 'conn-1'",
    );
    expect(await sql('SELECT drive_id, root_folder_id FROM mounts WHERE id = ?', 'm-my').first()).toEqual({
      drive_id: null,
      root_folder_id: '1FolderMyDrive',
    });
  });

  it('creates mount_drive_permissions with its state CHECK and FKs', async () => {
    const grant = (mountId: string, state: string) =>
      sql(`INSERT INTO mount_drive_permissions (mount_id, service_account_id, permission_id, state, updated_at)
           VALUES (?, 'sa-1', NULL, ?, ?)`, mountId, state, NOW).run();
    await grant('m-my', 'pending');
    await expect(grant('m-1', 'bogus')).rejects.toThrow(/CHECK/);
    await expect(grant('m-missing', 'pending')).rejects.toThrow(/FOREIGN KEY/);
    expect((await db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
  });
});
