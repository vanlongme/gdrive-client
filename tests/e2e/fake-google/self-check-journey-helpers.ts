/**
 * Exercises the journey-helpers.ts My Drive wrappers against a real fake
 * control server bound to the journey control port (127.0.0.1:8898), using
 * Playwright's APIRequestContext exactly as journey.spec.ts does.
 * Run only while no journey server is listening on 8898:
 *   npx tsx tests/e2e/fake-google/self-check-journey-helpers.ts
 */

import { request } from "@playwright/test";
import { createServer } from "node:http";
import { controlHandler } from "./control";
import { createFakeGoogle } from "./index";
import {
  CONTROL_ORIGIN,
  fakeState,
  injectSharingRateLimit,
  listPermissions,
  moveFakeFile,
  seedMyDriveFile,
  seedMyDriveFolder,
  seedPermission,
} from "../journey-helpers";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`self-check-journey-helpers failed: ${msg}`);
}

async function main(): Promise<void> {
  const fake = createFakeGoogle();
  const port = Number(new URL(CONTROL_ORIGIN).port);
  const server = createServer(controlHandler(fake));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const api = await request.newContext();
  try {
    const folder = await seedMyDriveFolder(api, "Mounted", { id: "h-folder" });
    assert(folder.id === "h-folder" && folder.ownerPrincipal === "perm-fake-operator", "folder seeded for the default owner");
    const sub = await seedMyDriveFolder(api, "Sub", { parentId: folder.id });
    assert(sub.parentId === folder.id, "nested folder");
    const file = await seedMyDriveFile(api, "a.txt", { id: "h-file", parentId: sub.id, text: "hello" });
    assert(file.parentId === sub.id, "file seeded under the subfolder");

    await seedPermission(api, folder.id, "dw-sa-01@proj.iam.gserviceaccount.com");
    const perms = await listPermissions(api, folder.id);
    assert(perms.length === 1 && perms[0]?.role === "reader", "listPermissions returns the seeded grant");

    await injectSharingRateLimit(api, 2, 5);
    assert(fake.state.sharingRateLimitExceeded.remaining === 2 && fake.state.sharingRateLimitExceeded.retryAfterSeconds === 5, "rate limit injected");

    await moveFakeFile(api, file.id, [folder.id]);
    const state = await fakeState(api);
    const seen = state.files.find((f) => f.id === file.id);
    assert(seen?.driveId === null && seen.parents[0] === folder.id, "state shows the moved My Drive file with a null driveId");
  } finally {
    await api.dispose();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  console.log("SELF-CHECK-JOURNEY-HELPERS OK");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
