import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";

const TEST_APP_MASTER_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const TEST_SETUP_TOKEN = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=";

export default defineConfig(async () => {
  // Canonical local-migration wiring: tests consume the TEST_MIGRATIONS
  // binding with applyD1Migrations() from "cloudflare:test", which applies the
  // checked-in migrations/*.sql in order and tracks state in d1_migrations.
  const testMigrations = await readD1Migrations("./migrations");

  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            APP_MASTER_KEY: TEST_APP_MASTER_KEY,
            SETUP_TOKEN: TEST_SETUP_TOKEN,
            TEST_MIGRATIONS: JSON.stringify(testMigrations),
          },
          // Scratch D1 for tests/integration/migration-0007.test.ts, which
          // must stop at 0006, seed, then apply 0007 (Review Focus #5).
          d1Databases: { MIGRATION_DB: "migration-test-db" },
          assets: {
            directory: "./tests/integration/assets",
            binding: "ASSETS",
            assetConfig: {
              not_found_handling: "single-page-application",
            },
          },
        },
      }),
    ],
    test: {
      include: ["tests/unit/**/*.test.ts", "tests/integration/**/*.test.ts"],
      // The plugin serves one shared D1 per project (deployment-faithful):
      // test files must run sequentially so per-file resets cannot race.
      fileParallelism: false,
    },
  };
});
