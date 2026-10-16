/**
 * T15 evidence capture: drives the same worker API surface the journey spec
 * drives from the browser (setup → connect → SA → mount → user → upload →
 * readiness → content → share → revoke) against the running journey server,
 * then prints the fake's request log. The API calls are exactly what the
 * browser issues — same worker code path. Run:
 *   npx tsx tests/e2e/journey-server.ts &   (wait for JOURNEY_READY)
 *   npx tsx tests/e2e/journey-log-capture.ts
 */
import { createHash, generateKeyPairSync } from "node:crypto";

const ORIGIN = "http://localhost:8878";
const CTRL = "http://127.0.0.1:8898";
const DRIVE = "capture-drive-1";
const CLIENT_ID = "102030405060-capture.apps.googleusercontent.com";
const SA_EMAIL = "capture-sa@capture.iam.gserviceaccount.com";
const CONTENT = `T15 capture bytes ${"z".repeat(3000)} ✓`;

class Session {
  cookie = "";
  async api(path: string, method = "GET", body?: unknown, headers: Record<string, string> = {}) {
    const raw = body instanceof Buffer || body instanceof Uint8Array || typeof body === "string";
    const res = await fetch(`${ORIGIN}${path}`, {
      method,
      headers: {
        origin: ORIGIN,
        ...(body === undefined || raw ? {} : { "content-type": "application/json" }),
        ...(this.cookie ? { cookie: this.cookie } : {}),
        ...headers,
      },
      body: (body === undefined
        ? undefined
        : raw
          ? (body as Uint8Array)
          : JSON.stringify(body)) as never,
      redirect: "manual",
    });
    const setCookie = res.headers.get("set-cookie");
    if (setCookie !== null) this.cookie = setCookie.split(";")[0] ?? this.cookie;
    const text = await res.text();
    let json: unknown = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, json, text };
  }
}

async function ctrl(path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${CTRL}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return res.json();
}

const ok = (cond: unknown, msg: string) => {
  if (!cond) throw new Error(`capture: ${msg}`);
  console.log("ok:", msg);
};

async function main(): Promise<void> {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const saKeyJson = JSON.stringify({
    type: "service_account",
    project_id: "capture",
    private_key_id: "cap1",
    private_key: privateKey.export({ format: "pem", type: "pkcs8" }),
    client_email: SA_EMAIL,
  });

  const admin = new Session();
  const setup = await admin.api("/api/v1/setup", "POST", {
    token: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=",
    name: "Capture Admin",
    email: "capture-admin@test.dev",
    password: "capture-admin-password-1!",
    canonicalOrigin: ORIGIN,
  });
  ok([200, 409].includes(setup.status), `setup ${setup.status}`);
  ok((await admin.api("/api/auth/sign-in/email", "POST", {
    email: "capture-admin@test.dev",
    password: "capture-admin-password-1!",
  })).status === 200, "admin sign-in");

  await ctrl("/__fake__/drives", { id: DRIVE, name: "Capture Drive" });
  await ctrl(`/__fake__/drives/${DRIVE}/members`, { principal: "perm-fake-operator", role: "writer" });
  await ctrl("/__fake__/service-accounts", {
    email: SA_EMAIL,
    projectId: "capture",
    publicKeyPem: publicKey.export({ format: "pem", type: "spki" }),
  });

  const client = await admin.api("/api/v1/admin/google/clients", "POST", {
    clientId: CLIENT_ID,
    clientSecret: "capture-secret",
  });
  ok(client.status === 200, `client ${client.status}`);
  const clientRowId = (client.json as { client: { id: string } }).client.id;

  const sa = await admin.api("/api/v1/admin/service-accounts", "POST", { keyJson: saKeyJson });
  ok(sa.status === 200, `sa ${sa.status}: ${sa.text.slice(0, 200)}`);
  const saRowId = (sa.json as { serviceAccount: { id: string } }).serviceAccount.id;

  const { code } = (await ctrl("/__fake__/auth-codes", { clientId: CLIENT_ID })) as { code: string };
  const start = await admin.api("/api/v1/admin/google/oauth/start", "POST", {
    purpose: "connect",
    oauthClientId: clientRowId,
  });
  ok(start.status === 200, `oauth/start ${start.status}`);
  const authUrl = new URL((start.json as { authorizationUrl: string }).authorizationUrl);
  const cbPath = `${new URL(authUrl.searchParams.get("redirect_uri") ?? "").pathname}?state=${encodeURIComponent(authUrl.searchParams.get("state") ?? "")}&code=${encodeURIComponent(code)}`;
  const cb = await admin.api(cbPath);
  ok(cb.status === 200, `oauth callback ${cb.status}: ${cb.text.slice(0, 200)}`);
  const connectionId = (cb.json as { connection: { id: string } }).connection.id;

  const mount = await admin.api("/api/v1/admin/mounts", "POST", {
    label: "Capture Mount",
    driveId: DRIVE,
    catalogConnectionId: connectionId,
    writeConnectionId: connectionId,
    serviceAccountIds: [saRowId],
    visibility: "private",
  });
  ok(mount.status === 200, `mount ${mount.status}: ${mount.text.slice(0, 300)}`);
  const mountId = (mount.json as { mount: { id: string } }).mount.id;

  const user = await admin.api("/api/v1/admin/users", "POST", {
    name: "Capture Uploader",
    email: "capture-uploader@test.dev",
    password: "capture-uploader-password-1!",
    role: "user",
  });
  ok([200, 201].includes(user.status), `user ${user.status}: ${user.text.slice(0, 200)}`);
  const uploaderId = (user.json as { user: { id: string } }).user.id;
  ok(
    (await admin.api(`/api/v1/admin/mounts/${mountId}/grants`, "POST", {
      userId: uploaderId,
      role: "uploader",
    })).status === 200,
    "uploader grant",
  );

  const uploader = new Session();
  ok((await uploader.api("/api/auth/sign-in/email", "POST", {
    email: "capture-uploader@test.dev",
    password: "capture-uploader-password-1!",
  })).status === 200, "uploader sign-in");

  const bytes = new TextEncoder().encode(CONTENT);
  const create = await uploader.api("/api/v1/uploads", "POST", {
    mountId,
    parentId: DRIVE,
    name: "capture-upload.txt",
    mimeType: "text/plain",
    totalBytes: String(bytes.byteLength),
    sha256: createHash("sha256").update(bytes).digest("hex"),
    md5: createHash("md5").update(bytes).digest("hex"),
  }, { "idempotency-key": crypto.randomUUID() });
  ok(create.status === 200 || create.status === 201, `upload create ${create.status}: ${create.text.slice(0, 300)}`);
  const view = create.json as { uploadId: string; sessionGeneration: number; confirmedOffset: string };
  const put = await uploader.api(
    `/api/v1/uploads/${view.uploadId}/chunks?generation=${view.sessionGeneration}&offset=0`,
    "PUT",
    Buffer.from(bytes),
    { "content-type": "application/octet-stream" },
  );
  ok(put.status === 200, `chunk ${put.status}: ${put.text.slice(0, 300)}`);
  let finalView = put.json as { state: string };
  for (let i = 0; i < 30 && finalView.state !== "completed"; i++) {
    await new Promise((r) => setTimeout(r, 300));
    const poll = await uploader.api(`/api/v1/uploads/${view.uploadId}`);
    finalView = poll.json as { state: string };
  }
  ok(finalView.state === "completed", `upload completed (state=${finalView.state})`);

  const fakeState = (await ctrl("/__fake__/state")) as { files: { id: string; name: string }[] };
  const fileId = fakeState.files.find((f) => f.name === "capture-upload.txt")?.id ?? "";
  ok(fileId !== "", "file visible in fake");

  const detail = await admin.api(`/api/v1/mounts/${mountId}/files/${fileId}`);
  ok(detail.status === 200, `detail ${detail.status}`);
  console.log("readerAccessState(before):", (detail.json as { readerAccessState: string }).readerAccessState);

  await ctrl(`/__fake__/drives/${DRIVE}/members`, { principal: SA_EMAIL, role: "reader" });
  const ready = await admin.api(`/api/v1/mounts/${mountId}/files/${fileId}/readiness`, "POST", {});
  ok(ready.status === 200, `readiness ${ready.status}: ${ready.text.slice(0, 200)}`);
  console.log("readiness:", (ready.json as { readerAccessState: string }).readerAccessState);

  const content = await uploader.api(`/api/v1/mounts/${mountId}/files/${fileId}/content`);
  ok(content.status === 200 && content.text === CONTENT, `content ${content.status}`);

  const share = await admin.api("/api/v1/shares", "POST", {
    scope: { kind: "file", mountId, fileId },
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  });
  ok(share.status === 201, `share ${share.status}: ${share.text.slice(0, 200)}`);
  const shareBody = share.json as { shareId: string; token: string };
  const anon = new Session();
  const shared = await anon.api(`/api/v1/mounts/${mountId}/files/${fileId}/content?share=${shareBody.token}`);
  ok(shared.status === 200, `anon share ${shared.status}`);
  const revoke = await admin.api(`/api/v1/shares/${shareBody.shareId}`, "DELETE");
  ok([200, 204].includes(revoke.status), `revoke ${revoke.status}`);
  const denied = await anon.api(`/api/v1/mounts/${mountId}/files/${fileId}/content?share=${shareBody.token}`);
  ok(denied.status === 403, `post-revoke ${denied.status}`);

  const log = (await ctrl("/__fake__/requests")) as {
    requests: { seq: number; provider: string; operation: string; method: string; path: string; status: number; requestBytes: number; responseBytes: number; providerViolation?: string }[];
  };
  console.log("\nseq | provider | operation | method path | status | reqBytes | resBytes | violation");
  for (const e of log.requests) {
    console.log(
      `${e.seq} | ${e.provider} | ${e.operation} | ${e.method} ${e.path} | ${e.status} | ${e.requestBytes} | ${e.responseBytes} | ${e.providerViolation ?? "-"}`,
    );
  }
  console.log("CAPTURE OK");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
