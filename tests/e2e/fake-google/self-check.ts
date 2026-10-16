/**
 * Direct (no-Miniflare) sanity check of the fake boundary: token grants,
 * drive membership, resumable upload protocol, listing and provider
 * violation flagging — all via fake.handle(), the exact function the
 * worker's outboundService calls. Run: npx tsx tests/e2e/fake-google/self-check.ts
 */

import { createHash } from "node:crypto";
import { createFakeGoogle } from "./index";

const DRIVE = "drive-self-check";
const OAUTH = "perm-checker";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`self-check failed: ${msg}`);
}

async function main(): Promise<void> {
  const fake = createFakeGoogle({
    drives: [{ id: DRIVE, name: "Self Check Drive" }],
    members: [{ driveId: DRIVE, principal: OAUTH, role: "writer" }],
  });
  const api = "https://www.googleapis.com";

  // OAuth token via refresh grant.
  fake.state.refreshTokens.set("rt-1", {
    token: "rt-1",
    provider: "oauth",
    clientId: "c",
    principal: OAUTH,
    scopes: ["https://www.googleapis.com/auth/drive"],
    revoked: false,
  });
  const tok = await fake.handle(
    new Request("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: "rt-1",
        client_id: "c",
        client_secret: "s",
      }).toString(),
    }),
  );
  assert(tok.status === 200, `refresh grant ${tok.status}`);
  const at = ((await tok.json()) as { access_token: string }).access_token;
  const bearer = { authorization: `Bearer ${at}` };

  // generateIds -> upload.start -> chunk -> probe -> verify.
  const gen = await fake.handle(
    new Request(`${api}/drive/v3/files/generateIds?count=1&space=drive&type=file&supportsAllDrives=true`, { headers: bearer }),
  );
  const fileId = ((await gen.json()) as { ids: string[] }).ids[0] ?? "";
  assert(fileId !== "", "generateIds");

  const content = new TextEncoder().encode("self-check payload 1234567890");
  const start = await fake.handle(
    new Request(`${api}/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true`, {
      method: "POST",
      headers: {
        ...bearer,
        "content-type": "application/json; charset=utf-8",
        "x-upload-content-type": "text/plain",
        "x-upload-content-length": String(content.byteLength),
      },
      body: JSON.stringify({
        id: fileId,
        name: "check.txt",
        mimeType: "text/plain",
        parents: [DRIVE],
      }),
    }),
  );
  assert(start.status === 200, `upload.start ${start.status}`);
  const sessionUri = start.headers.get("location") ?? "";
  assert(sessionUri.includes("upload_id="), "session uri");

  const chunk = await fake.handle(
    new Request(sessionUri, {
      method: "PUT",
      headers: {
        ...bearer,
        "content-range": `bytes 0-${content.byteLength - 1}/${content.byteLength}`,
      },
      body: content,
    }),
  );
  assert(chunk.status === 200 || chunk.status === 201, `chunk ${chunk.status}`);

  // Probe of the finalized session must return the file (idempotent).
  const probe = await fake.handle(
    new Request(sessionUri, {
      method: "PUT",
      headers: { ...bearer, "content-range": `bytes */${content.byteLength}` },
    }),
  );
  assert(probe.status === 200, `probe-after-final ${probe.status}`);

  const get = await fake.handle(
    new Request(`${api}/drive/v3/files/${fileId}?supportsAllDrives=true&fields=*`, { headers: bearer }),
  );
  const meta = (await get.json()) as { sha256Checksum?: string; size?: string };
  assert(
    meta.sha256Checksum === createHash("sha256").update(content).digest("hex"),
    "sha256 of received bytes",
  );

  // files.list sees the uploaded file under the drive root.
  const list = await fake.handle(
    new Request(
      `${api}/drive/v3/files?q=${encodeURIComponent(`'${DRIVE}' in parents and trashed = false`)}&corpora=drive&driveId=${DRIVE}&includeItemsFromAllDrives=true&supportsAllDrives=true`,
      { headers: bearer },
    ),
  );
  const listing = (await list.json()) as { files: { id: string }[] };
  assert(listing.files.some((f) => f.id === fileId), "list contains upload");

  // Provider violation: OAuth bearer must never serve alt=media.
  const media = await fake.handle(
    new Request(`${api}/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true`, { headers: bearer }),
  );
  assert(
    fake.log.some(
      (e) => e.providerViolation !== undefined && e.operation === "files.media",
    ),
    `media via oauth logged a violation (status ${media.status})`,
  );

  console.log(
    `SELF-CHECK OK: ${fake.log.length} requests, ${fake.log.filter((e) => e.providerViolation).length} violation(s)`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
