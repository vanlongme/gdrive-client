/**
 * Direct (no-Miniflare) sanity check of the My Drive + permissions model of
 * the fake boundary, via fake.handle() exactly like self-check.ts: owner
 * access, inherited permissions, corpora=user listing, files.get('root'),
 * permissions.list/create/delete, the sendNotificationEmail guard and the
 * injectable sharingRateLimitExceeded counter.
 * Run: npx tsx tests/e2e/fake-google/self-check-my-drive.ts
 */

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { controlHandler } from "./control";
import { createFakeGoogle } from "./index";

const OWNER = "perm-md-owner";
const SA = "dw-sa-01@proj.iam.gserviceaccount.com";
const SA2 = "dw-sa-02@proj.iam.gserviceaccount.com";
const API = "https://www.googleapis.com";
const FOLDER = "application/vnd.google-apps.folder";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`self-check-my-drive failed: ${msg}`);
}

async function main(): Promise<void> {
  const fake = createFakeGoogle({ oauthPrincipal: OWNER });
  const now = Date.now();
  for (const [value, provider, principal] of [
    ["at-owner", "oauth", OWNER],
    ["at-sa", "service_account", SA],
    ["at-sa2", "service_account", SA2],
  ] as const) {
    fake.state.accessTokens.set(value, {
      value,
      provider,
      principal,
      scopes: ["https://www.googleapis.com/auth/drive"],
      expiresAtMs: now + 3_600_000,
      revoked: false,
    });
  }
  const as = (token: string) => ({ authorization: `Bearer ${token}` });
  const call = (
    token: string,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Response> =>
    fake.handle(
      new Request(`${API}${path}`, {
        method,
        headers: {
          ...as(token),
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );

  // Seed: root > mounted > (sub > deep.txt, a.txt); root > outside.txt
  const mounted = fake.seedMyDriveFolder({ id: "mounted", name: "Mounted" });
  const sub = fake.seedMyDriveFolder({ id: "sub", name: "Sub", parentId: mounted.id });
  fake.seedMyDriveFile({ id: "deep", name: "deep.txt", parentId: sub.id, content: new TextEncoder().encode("deep") });
  fake.seedMyDriveFile({ id: "a", name: "a.txt", parentId: mounted.id, content: new TextEncoder().encode("a") });
  fake.seedMyDriveFile({ id: "outside", name: "outside.txt", content: new TextEncoder().encode("o") });

  // files.get('root') resolves the caller's own root.
  const root = (await (await call("at-owner", "GET", "/drive/v3/files/root?fields=id")).json()) as { id: string };
  assert(root.id === fake.ensureMyDriveRoot(OWNER).id, "root alias");
  assert(root.id !== "root", "root alias returns the real id");

  // Owner metadata: ownedByMe, parents, capabilities, no driveId.
  const meta = (await (await call("at-owner", "GET", "/drive/v3/files/mounted")).json()) as {
    ownedByMe?: boolean; parents?: string[]; driveId?: string;
    capabilities?: { canAddChildren?: boolean };
  };
  assert(meta.ownedByMe === true, "ownedByMe");
  assert(meta.parents?.[0] === root.id, "parents");
  assert(meta.driveId === undefined, "My Drive file has no driveId");
  assert(meta.capabilities?.canAddChildren === true, "owner canAddChildren");

  // corpora=user listing: parents, name contains, mimeType, 'me' in owners.
  const list = async (q: string, extra = ""): Promise<{ files: { id: string }[]; nextPageToken?: string }> =>
    (await (await call("at-owner", "GET", `/drive/v3/files?corpora=user&supportsAllDrives=true&q=${encodeURIComponent(q)}${extra}`)).json()) as { files: { id: string }[]; nextPageToken?: string };
  const children = await list("'mounted' in parents and trashed = false");
  assert(children.files.map((f) => f.id).sort().join() === "a,sub", "children of mounted");
  const viaRoot = await list("'root' in parents and trashed = false");
  assert(viaRoot.files.map((f) => f.id).sort().join() === "mounted,outside", "'root' alias in q");
  assert((await list("name contains 'deep' and trashed = false")).files.map((f) => f.id).join() === "deep", "name contains");
  assert((await list(`'${root.id}' in parents and mimeType = '${FOLDER}' and 'me' in owners and trashed = false`)).files.map((f) => f.id).join() === "mounted", "folders owned by me");
  const bad = await call("at-owner", "GET", `/drive/v3/files?corpora=user&driveId=x&q=${encodeURIComponent("trashed = false")}`);
  assert(bad.status === 400, `driveId with corpora=user -> ${bad.status}`);

  // SA has no access until a permission exists.
  assert((await call("at-sa", "GET", "/drive/v3/files/mounted")).status === 404, "SA blind before grant");
  assert((await list("name contains 'a.txt'")).files.length === 1, "owner search");

  // permissions.create guards.
  const postPerm = (token: string, query: string, body: unknown) =>
    call(token, "POST", `/drive/v3/files/mounted/permissions?${query}`, body);
  const body = { type: "user", role: "reader", emailAddress: SA };
  assert((await postPerm("at-owner", "supportsAllDrives=true&fields=id", body)).status === 400, "missing sendNotificationEmail rejected");
  assert((await postPerm("at-owner", "sendNotificationEmail=true&supportsAllDrives=true", body)).status === 400, "sendNotificationEmail=true rejected");
  assert((await postPerm("at-sa", "sendNotificationEmail=false", body)).status === 404, "non-owner without access cannot share");

  // Injected sharing rate limit: first create throttled with Retry-After.
  fake.state.sharingRateLimitExceeded = { remaining: 1, retryAfterSeconds: 7 };
  const limited = await postPerm("at-owner", "sendNotificationEmail=false&supportsAllDrives=true&fields=id", body);
  assert(limited.status === 403, `rate limited status ${limited.status}`);
  assert(limited.headers.get("retry-after") === "7", "retry-after header");
  const limitedBody = (await limited.json()) as { error: { errors: { reason: string }[] } };
  assert(limitedBody.error.errors[0]?.reason === "sharingRateLimitExceeded", "rate limit reason");
  assert(fake.state.sharingRateLimitExceeded.remaining === 0, "counter decremented");

  // Real create, then inheritance to the SA.
  const created = await postPerm("at-owner", "sendNotificationEmail=false&supportsAllDrives=true&fields=id", body);
  assert(created.status === 200, `create ${created.status}`);
  const perm = (await created.json()) as { id: string };
  assert(perm.id !== "", "permission id");
  assert((await call("at-sa", "GET", "/drive/v3/files/mounted")).status === 200, "SA sees folder after grant");
  assert((await call("at-sa", "GET", "/drive/v3/files/deep?alt=media")).status === 200, "SA reads descendant (inherited)");
  assert((await call("at-sa", "GET", "/drive/v3/files/outside?alt=media")).status === 404, "SA cannot read outside the grant");
  assert((await call("at-sa2", "GET", "/drive/v3/files/mounted")).status === 404, "other SA still blind");
  const saMeta = (await (await call("at-sa", "GET", "/drive/v3/files/mounted")).json()) as { ownedByMe?: boolean; capabilities?: { canAddChildren?: boolean } };
  assert(saMeta.ownedByMe === false && saMeta.capabilities?.canAddChildren !== true, "reader SA is not owner and cannot add children");

  // Repeat create is idempotent (one grant per user).
  const again = (await (await postPerm("at-owner", "sendNotificationEmail=false", body)).json()) as { id: string };
  assert(again.id === perm.id, "repeat create keeps the permission id");

  // permissions.list: owner row + the SA grant, paged.
  const permList = (await (await call("at-owner", "GET", "/drive/v3/files/mounted/permissions?supportsAllDrives=true&pageSize=1")).json()) as { permissions: { emailAddress: string; role: string }[]; nextPageToken?: string };
  assert(permList.permissions.length === 1 && permList.nextPageToken === "1", "permissions.list pages");
  const page2 = (await (await call("at-owner", "GET", `/drive/v3/files/mounted/permissions?supportsAllDrives=true&pageSize=1&pageToken=1`)).json()) as { permissions: { emailAddress: string; role: string }[]; nextPageToken?: string };
  assert(page2.permissions[0]?.emailAddress === SA && page2.permissions[0]?.role === "reader" && page2.nextPageToken === undefined, "second permissions page");

  // delete: unknown id 404, owner row 403, real id 204 then SA blind again.
  assert((await call("at-owner", "DELETE", "/drive/v3/files/mounted/permissions/nope?supportsAllDrives=true")).status === 404, "delete unknown");
  assert((await call("at-owner", "DELETE", "/drive/v3/files/mounted/permissions/owner-mounted?supportsAllDrives=true")).status === 403, "owner row is permanent");
  assert((await call("at-owner", "DELETE", `/drive/v3/files/mounted/permissions/${perm.id}?supportsAllDrives=true`)).status === 204, "delete permission");
  assert((await call("at-sa", "GET", "/drive/v3/files/mounted")).status === 404, "SA blind after revoke");

  // Request log: stable operation names, no provider violations.
  const ops = fake.log.map((e) => e.operation);
  for (const op of ["permissions.list", "permissions.create", "permissions.delete"]) {
    assert(ops.includes(op), `log has ${op}`);
  }
  // The only permissions.* violation is the deliberate SA-token share attempt.
  const permViolations = fake.log.filter((e) => e.providerViolation !== undefined && e.operation.startsWith("permissions."));
  assert(permViolations.length === 1 && permViolations[0]?.provider === "service_account", "SA token on permissions.create is flagged, OAuth is not");

  // Control API: the endpoints journey-helpers.ts wraps.
  const server = createServer(controlHandler(fake));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  interface ControlReply {
    file?: { parentId: string | null };
    sharingRateLimitExceeded?: { remaining: number };
  }
  const post = async (path: string, data: unknown): Promise<{ status: number; json: ControlReply }> => {
    const r = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) });
    return { status: r.status, json: (await r.json()) as ControlReply };
  };
  try {
    const f = await post("/__fake__/my-drive/folders", { id: "ctl-folder", name: "Ctl", parentId: "mounted" });
    assert(f.status === 200 && f.json.file?.parentId === "mounted", "control seeds a folder");
    const file = await post("/__fake__/my-drive/files", { id: "ctl-file", name: "c.txt", parentId: "ctl-folder", text: "hello" });
    assert(file.status === 200 && fake.state.files.get("ctl-file")?.content?.byteLength === 5, "control seeds a file");
    assert((await post("/__fake__/my-drive/folders", { name: "X", parentId: "missing" })).status === 400, "control rejects an unknown parent");
    assert((await post("/__fake__/files/mounted/permissions", { emailAddress: SA2, role: "reader" })).status === 200, "control grants a permission");
    const perms = (await (await fetch(`${base}/__fake__/files/mounted/permissions`)).json()) as { permissions: { emailAddress: string }[] };
    assert(perms.permissions.some((p) => p.emailAddress === SA2), "control lists permissions");
    assert((await post("/__fake__/permissions/rate-limit", { count: 2, retryAfterSeconds: 3 })).json.sharingRateLimitExceeded?.remaining === 2, "control sets the rate limit");
    assert((await post("/__fake__/files/ctl-file/flags", { parents: ["sub"] })).status === 200 && fake.state.files.get("ctl-file")?.parents[0] === "sub", "control simulates an external move");
    const st = (await (await fetch(`${base}/__fake__/state`)).json()) as { files: { id: string; driveId: string | null; ownerPrincipal: string | null }[] };
    const entry = st.files.find((e) => e.id === "ctl-file");
    assert(entry?.driveId === null && entry.ownerPrincipal === OWNER, "state reports My Drive files with a null driveId");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  console.log(`SELF-CHECK-MY-DRIVE OK: ${fake.log.length} requests`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
