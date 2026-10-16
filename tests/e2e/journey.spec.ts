import { createHash, generateKeyPairSync, sign as signJwt } from "node:crypto";
import { expect, test } from "@playwright/test";
import type { APIRequestContext, APIRequest } from "@playwright/test";
import {
  CONTROL_ORIGIN,
  JOURNEY_ADMIN,
  JOURNEY_HEADERS,
  JOURNEY_ORIGIN,
  JOURNEY_UPLOADER,
  createFakeDrive,
  fakeRequests,
  fakeState,
  grantDriveMembership,
  journeySetup,
  journeySignIn,
  mintAuthCode,
  registerFakeServiceAccount,
} from "./journey-helpers";

/**
 * T15 journey: real browser -> built worker (Miniflare, dist/) -> fake
 * Google. Every Drive/auth call lands in the fake's request log; the spec
 * asserts the OAuth-vs-SA provider split and that the bytes the fake
 * received are exactly the bytes the browser uploaded (sha256).
 */

const DRIVE_ID = "journey-drive-1";
const CLIENT_ID = "102030405060-journey.apps.googleusercontent.com";
const SA_EMAIL = "journey-sa@journey-project.iam.gserviceaccount.com";

const UPLOAD_NAME = "journey-upload.txt";
const UPLOAD_CONTENT = `T15 journey bytes ${"x".repeat(4000)} — đúng nội dung ✓`;
const UPLOAD_SHA256 = createHash("sha256")
  .update(UPLOAD_CONTENT)
  .digest("hex");

const { privateKey: SA_PRIVATE_KEY, publicKey: SA_PUBLIC_KEY } =
  generateKeyPairSync("rsa", { modulusLength: 2048 });
const SA_PUBLIC_PEM = SA_PUBLIC_KEY.export({ format: "pem", type: "spki" }) as string;
const SA_PRIVATE_PEM = SA_PRIVATE_KEY.export({ format: "pem", type: "pkcs8" }) as string;
const SA_KEY_JSON = JSON.stringify({
  type: "service_account",
  project_id: "journey-project",
  private_key_id: "journeykey1",
  private_key: SA_PRIVATE_PEM,
  client_email: SA_EMAIL,
});

let adminState: Awaited<ReturnType<APIRequestContext["storageState"]>>;
let uploaderState: Awaited<ReturnType<APIRequestContext["storageState"]>>;
let connectionId = "";
let mountId = "";
let uploadedFileId = "";

async function adminApi(request: APIRequest): Promise<APIRequestContext> {
  return request.newContext({
    baseURL: JOURNEY_ORIGIN,
    storageState: adminState,
  });
}

test.beforeAll(async ({ playwright }) => {
  const rc = await playwright.request.newContext({ baseURL: JOURNEY_ORIGIN });
  await journeySetup(rc);
  await journeySignIn(rc, JOURNEY_ADMIN.email, JOURNEY_ADMIN.password);
  adminState = await rc.storageState();
  await rc.dispose();

  // Seed the Shared Drive and prove the OAuth principal (issued at code
  // exchange) is a writer member; the SA is deliberately NOT a member yet —
  // the journey asserts reader blocked, then fixes membership via the fake.
  const ctrl = await playwright.request.newContext();
  await createFakeDrive(ctrl, DRIVE_ID, "Journey Drive");
  await grantDriveMembership(ctrl, DRIVE_ID, "perm-fake-operator", "writer");
  await registerFakeServiceAccount(ctrl, {
    email: SA_EMAIL,
    projectId: "journey-project",
    publicKeyPem: SA_PUBLIC_PEM,
  });
  await ctrl.dispose();
});

test.describe.configure({ mode: "serial" });

test("journey: setup -> connect -> mount -> upload -> blocked -> fixed -> download -> share -> revoke", async ({
  browser,
  playwright,
}) => {
  const admin = await adminApi(playwright.request);
  const context = await browser.newContext({ storageState: adminState });
  const page = await context.newPage();
  page.on("console", (m) => {
    if (m.type() === "error") console.log(`[browser] ${m.text()}`);
  });

  // --- 1. Import OAuth client + SA (admin API = the real vault surface) ---
  const client = await admin.post("/api/v1/admin/google/clients", {
    data: {
      clientId: CLIENT_ID,
      clientSecret: "journey-client-secret",
    },
    headers: JOURNEY_HEADERS,
  });
  expect(client.status(), `client import ${await client.text()}`).toBe(200);
  const clientRowId = (
    (await client.json()) as { client: { id: string } }
  ).client.id;

  const sa = await admin.post("/api/v1/admin/service-accounts", {
    data: { keyJson: SA_KEY_JSON },
    headers: JOURNEY_HEADERS,
  });
  expect(sa.status(), `sa import ${await sa.text()}`).toBe(200);
  const saRowId = (
    (await sa.json()) as { serviceAccount: { id: string } }
  ).serviceAccount.id;

  // --- 2. OAuth connect through the fake consent ----------------------------
  const start = await admin.post("/api/v1/admin/google/oauth/start", {
    data: { purpose: "connect", oauthClientId: clientRowId },
    headers: JOURNEY_HEADERS,
  });
  expect(start.status(), `oauth/start ${await start.text()}`).toBe(200);
  const { authorizationUrl } = (await start.json()) as {
    authorizationUrl: string;
  };
  const authUrl = new URL(authorizationUrl);
  const state = authUrl.searchParams.get("state") ?? "";
  const redirectUri = authUrl.searchParams.get("redirect_uri") ?? "";
  expect(state).not.toBe("");
  const code = await mintAuthCode(admin, CLIENT_ID);

  // Browser navigation to Google consent is intercepted and returned with a
  // code, exactly the redirect Google would perform (frozen decision 1).
  const callbackUrl = `${redirectUri}?state=${encodeURIComponent(state)}&code=${encodeURIComponent(code)}`;
  await context.route("https://accounts.google.com/**", (route) =>
    route.fulfill({ status: 302, headers: { location: callbackUrl } }),
  );
  await page.goto(authorizationUrl);
  await page.waitForURL(/oauth\/callback/, { timeout: 15_000 });

  const connections = await admin.get("/api/v1/admin/google/connections");
  const connBody = (await connections.json()) as {
    connections: { id: string; state: string }[];
  };
  connectionId = connBody.connections.find((c) => c.state === "connected")?.id ?? "";
  expect(connectionId, "connected connection").not.toBe("");

  // --- 3. Mount (real validateMountTargets: oauth.files.get on the root) ---
  const mount = await admin.post("/api/v1/admin/mounts", {
    data: {
      label: "Journey Mount",
      driveId: DRIVE_ID,
      catalogConnectionId: connectionId,
      writeConnectionId: connectionId,
      serviceAccountIds: [saRowId],
      visibility: "private",
    },
    headers: JOURNEY_HEADERS,
  });
  expect(mount.status(), `mount create ${await mount.text()}`).toBe(200);
  mountId = ((await mount.json()) as { mount: { id: string } }).mount.id;

  // --- 4. Uploader user + uploader grant ------------------------------------
  const user = await admin.post("/api/v1/admin/users", {
    data: { ...JOURNEY_UPLOADER, role: "user" },
    headers: JOURNEY_HEADERS,
  });
  expect([200, 201], `user create ${await user.text()}`).toContain(
    user.status(),
  );
  const uploaderId = (
    (await user.json()) as { user: { id: string } }
  ).user.id;
  const grant = await admin.post(`/api/v1/admin/mounts/${mountId}/grants`, {
    data: { userId: uploaderId, role: "uploader" },
    headers: JOURNEY_HEADERS,
  });
  expect(grant.status(), `grant ${await grant.text()}`).toBe(200);

  const urc = await playwright.request.newContext({ baseURL: JOURNEY_ORIGIN });
  await journeySignIn(urc, JOURNEY_UPLOADER.email, JOURNEY_UPLOADER.password);
  uploaderState = await urc.storageState();
  await urc.dispose();

  // --- 5. Upload real bytes through the real browser -------------------------
  const uploaderCtx = await browser.newContext({ storageState: uploaderState });
  const upage = await uploaderCtx.newPage();
  await upage.goto("/explorer");
  await expect(
    upage.getByRole("heading", { name: "Explorer" }),
  ).toBeVisible({ timeout: 15_000 });
  await expect(upage.getByText("Journey Mount").first()).toBeVisible();

  await upage.setInputFiles('[data-testid="upload-input"]', {
    name: UPLOAD_NAME,
    mimeType: "text/plain",
    buffer: Buffer.from(UPLOAD_CONTENT, "utf8"),
  });
  const drawer = upage.getByTestId("transfer-drawer");
  await expect(drawer.getByText(UPLOAD_NAME)).toBeVisible();
  await expect(drawer.getByText("Hoàn tất")).toBeVisible({ timeout: 30_000 });

  // The fake received exactly the bytes the browser sent (sha256).
  const state1 = await fakeState(admin);
  const uploaded = state1.files.find((f) => f.name === UPLOAD_NAME);
  expect(uploaded, "file present in fake").toBeDefined();
  expect(uploaded?.sha256).toBe(UPLOAD_SHA256);
  uploadedFileId = uploaded?.id ?? "";
  expect(uploadedFileId).not.toBe("");

  // --- 6. Completed with reader blocked (SA is not a drive member) ----------
  const detail = await admin.get(
    `/api/v1/mounts/${mountId}/files/${uploadedFileId}`,
  );
  const detailBody = (await detail.json()) as {
    readerAccessState?: string;
  };
  expect(detailBody.readerAccessState).toBe("blocked");

  // --- 7. Membership fixed (fake permission change) --------------------------
  await grantDriveMembership(admin, DRIVE_ID, SA_EMAIL, "reader");
  const readiness = await admin.post(
    `/api/v1/mounts/${mountId}/files/${uploadedFileId}/readiness`,
    { data: {}, headers: JOURNEY_HEADERS },
  );
  const readyBody = (await readiness.json()) as {
    readerAccessState?: string;
  };
  expect(readyBody.readerAccessState).toBe("readable");

  // --- 8. Download through the browser session (SA bytes) --------------------
  const content = await upage.request.get(
    `/api/v1/mounts/${mountId}/files/${uploadedFileId}/content`,
  );
  expect(content.status()).toBe(200);
  const downloaded = await content.body();
  expect(downloaded.toString("utf8")).toBe(UPLOAD_CONTENT);
  expect(createHash("sha256").update(downloaded).digest("hex")).toBe(
    UPLOAD_SHA256,
  );

  // --- 9. Share -> anonymous download -> revoke -> denied --------------------
  const share = await admin.post("/api/v1/shares", {
    data: {
      scope: { kind: "file", mountId, fileId: uploadedFileId },
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    },
    headers: JOURNEY_HEADERS,
  });
  expect(share.status(), `share create ${await share.text()}`).toBe(201);
  const shareBody = (await share.json()) as { shareId: string; token: string };

  const anon = await playwright.request.newContext({ baseURL: JOURNEY_ORIGIN });
  const sharedRead = await anon.get(
    `/api/v1/mounts/${mountId}/files/${uploadedFileId}/content?share=${shareBody.token}`,
  );
  expect(sharedRead.status()).toBe(200);
  expect((await sharedRead.body()).toString("utf8")).toBe(UPLOAD_CONTENT);

  const revoke = await admin.delete(`/api/v1/shares/${shareBody.shareId}`, {
    headers: JOURNEY_HEADERS,
  });
  expect([200, 204], `share revoke ${await revoke.text()}`).toContain(
    revoke.status(),
  );
  const afterRevoke = await anon.get(
    `/api/v1/mounts/${mountId}/files/${uploadedFileId}/content?share=${shareBody.token}`,
  );
  expect(afterRevoke.status()).toBe(403);
  await anon.dispose();

  // --- 10. Provider split from the fake's request log ------------------------
  const requests = await fakeRequests(admin);
  const violations = requests.filter((r) => r.providerViolation !== undefined);
  expect(
    violations,
    `provider violations: ${JSON.stringify(violations)}`,
  ).toHaveLength(0);

  const writes = requests.filter((r) =>
    ["files.create", "files.update", "upload.start", "upload.chunk/probe"].includes(
      r.operation,
    ),
  );
  expect(writes.length).toBeGreaterThan(0);
  for (const w of writes) expect(w.provider).toBe("oauth");

  const catalog = requests.filter(
    (r) =>
      ["files.list", "files.generateIds", "about.get", "drives.list"].includes(
        r.operation,
      ) || (r.operation === "files.get" && r.provider === "oauth"),
  );
  expect(catalog.length).toBeGreaterThan(0);
  for (const c of catalog) expect(c.provider).toBe("oauth");

  const contentReads = requests.filter(
    (r) =>
      ["files.media", "revisions.media", "files.export", "thumbnail.fetch"].includes(
        r.operation,
      ),
  );
  expect(contentReads.length).toBeGreaterThan(0);
  for (const c of contentReads) expect(c.provider).toBe("service_account");

  const grants = requests.filter((r) => r.operation.startsWith("token:"));
  expect(grants.some((g) => g.provider === "oauth")).toBe(true);
  expect(grants.some((g) => g.provider === "service_account")).toBe(true);

  await uploaderCtx.close();
  await context.close();
  await admin.dispose();
});

test("negative: fake detects a provider violation (SA token on a write surface)", async ({
  playwright,
}) => {
  // A REAL request through the fake's data plane with an SA bearer on an
  // OAuth-only surface: identical dispatch/logging pipeline as the
  // worker-bound path. Proves the boundary detects cross-provider traffic.
  const ctrl = await playwright.request.newContext();

  const assertion = [
    Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url"),
    Buffer.from(
      JSON.stringify({
        iss: SA_EMAIL,
        scope: "https://www.googleapis.com/auth/drive.readonly",
        aud: "https://oauth2.googleapis.com/token",
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
      }),
    ).toString("base64url"),
  ].join(".");
  const signature = signJwt(
    "RSA-SHA256",
    Buffer.from(assertion),
    SA_PRIVATE_KEY,
  ).toString("base64url");

  const tokenRes = await ctrl.post(`${CONTROL_ORIGIN}/token`, {
    headers: { "content-type": "application/x-www-form-urlencoded" },
    data: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${assertion}.${signature}`,
    }).toString(),
  });
  expect(tokenRes.status()).toBe(200);
  const { access_token: saToken } = (await tokenRes.json()) as {
    access_token: string;
  };

  const violation = await ctrl.fetch(`${CONTROL_ORIGIN}/drive/v3/files`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${saToken}`,
      "content-type": "application/json",
    },
    data: JSON.stringify({
      name: "should-not-create.txt",
      parents: [DRIVE_ID],
    }),
  });
  expect(violation.status()).toBe(403);

  const requests = await fakeRequests(ctrl);
  const flagged = requests.filter((r) => r.providerViolation !== undefined);
  expect(flagged.length).toBeGreaterThan(0);
  expect(
    flagged.some(
      (r) => r.provider === "service_account" && r.operation === "files.create",
    ),
  ).toBe(true);
  await ctrl.dispose();
});
