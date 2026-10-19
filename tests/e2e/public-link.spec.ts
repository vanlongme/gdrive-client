import { generateKeyPairSync } from "node:crypto";
import { expect, test } from "@playwright/test";
import type { APIRequest, APIRequestContext, Browser } from "@playwright/test";
import {
  JOURNEY_ADMIN,
  JOURNEY_HEADERS,
  JOURNEY_ORIGIN,
  journeySetup,
  mintAuthCode,
  registerFakeServiceAccount,
  seedMyDriveFile,
  seedMyDriveFolder,
} from "./journey-helpers";

/**
 * Wave-8 C7 public folder links: browser -> built worker -> fake Google
 * (journey server, port 8878). The admin creates a link through the real
 * Explorer UI; an anonymous fresh context opens /p/<slug>, lists and
 * downloads — with zero session/admin API calls. Locked, expired and 429
 * states run through the real unlock/throttle surface.
 *
 * Fixture evidence, not live Google.
 */

type State = Awaited<ReturnType<APIRequestContext["storageState"]>>;

const TAG = "pl";
const OWNER = "perm-fake-operator";
const CLIENT_ID = `20304050-${TAG}.apps.googleusercontent.com`;
const SA_EMAIL = `${TAG}-sa@${TAG}-project.iam.gserviceaccount.com`;
const SA_PROJECT = `${TAG}-project`;

const ROOT = `${TAG}-root`;
const SHARED = `${TAG}-shared`;
const LOCKED_DIR = `${TAG}-locked`;
const EXPIRED_DIR = `${TAG}-expired`;
const FILE_ID = `${TAG}-note`;
const FILE_NAME = `note-${TAG}.txt`;
const FILE_TEXT = `public link bytes ${"z".repeat(120)} — nội dung ✓`;
const LINK_PASSWORD = "orbit-gate-42";

let adminState: State | undefined;
let connectionId = "";
let saRowId = "";
let mountId = "";
let openSlug = "";
let openPath = "";

const adminApi = (request: APIRequest) =>
  request.newContext({ baseURL: JOURNEY_ORIGIN, storageState: adminState });

async function signInAdmin(
  request: APIRequestContext,
): Promise<void> {
  for (let attempt = 0; attempt < 15; attempt += 1) {
    const res = await request.post("/api/auth/sign-in/email", {
      data: {
        email: JOURNEY_ADMIN.email,
        password: JOURNEY_ADMIN.password,
      },
      headers: JOURNEY_HEADERS,
    });
    if (res.status() === 200) return;
    expect(res.status(), `sign-in ${await res.text()}`).toBe(429);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error("admin sign-in stayed rate-limited");
}

async function connectionIds(admin: APIRequestContext): Promise<string[]> {
  const res = await admin.get("/api/v1/admin/google/connections");
  return (
    (await res.json()) as { connections: { id: string }[] }
  ).connections.map((connection) => connection.id);
}

async function connectOperator(
  browser: Browser,
  admin: APIRequestContext,
  clientRowId: string,
): Promise<string> {
  const before = new Set(await connectionIds(admin));
  const start = await admin.post("/api/v1/admin/google/oauth/start", {
    data: { purpose: "connect", oauthClientId: clientRowId },
    headers: JOURNEY_HEADERS,
  });
  expect(start.status(), `oauth/start ${await start.text()}`).toBe(200);
  const { authorizationUrl } = (await start.json()) as {
    authorizationUrl: string;
  };
  const url = new URL(authorizationUrl);
  const code = await mintAuthCode(admin, CLIENT_ID, OWNER);
  const callback = `${url.searchParams.get("redirect_uri")}?state=${encodeURIComponent(
    url.searchParams.get("state") ?? "",
  )}&code=${encodeURIComponent(code)}`;
  const context = await browser.newContext({ storageState: adminState });
  try {
    await context.route("https://accounts.google.com/**", (route) =>
      route.fulfill({ status: 302, headers: { location: callback } }),
    );
    const page = await context.newPage();
    const exchange = page.waitForResponse(/oauth\/callback/, {
      timeout: 15_000,
    });
    await page.goto(authorizationUrl);
    await exchange;
  } finally {
    await context.close();
  }
  let created: string | undefined;
  await expect
    .poll(async () => {
      created = (await connectionIds(admin)).find((id) => !before.has(id));
      return created;
    })
    .not.toBeUndefined();
  return created ?? "";
}

async function createLink(
  admin: APIRequestContext,
  body: Record<string, unknown>,
): Promise<{ id: string; slug: string; path: string }> {
  const res = await admin.post("/api/v1/public-links", {
    data: body,
    headers: JOURNEY_HEADERS,
  });
  expect(res.status(), `link create ${await res.text()}`).toBe(201);
  return ((await res.json()) as { link: { id: string; slug: string; path: string } })
    .link;
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ browser, playwright }) => {
  const rc = await playwright.request.newContext({ baseURL: JOURNEY_ORIGIN });
  await journeySetup(rc);
  if (adminState === undefined) {
    await signInAdmin(rc);
    adminState = await rc.storageState();
  }
  await rc.dispose();
  const admin = await adminApi(playwright.request);

  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  await registerFakeServiceAccount(admin, {
    email: SA_EMAIL,
    projectId: SA_PROJECT,
    publicKeyPem: publicKey.export({ format: "pem", type: "spki" }) as string,
  });
  const sa = await admin.post("/api/v1/admin/service-accounts", {
    data: {
      keyJson: JSON.stringify({
        type: "service_account",
        project_id: SA_PROJECT,
        private_key_id: `${TAG}key1`,
        private_key: privateKey.export({
          format: "pem",
          type: "pkcs8",
        }) as string,
        client_email: SA_EMAIL,
      }),
    },
    headers: JOURNEY_HEADERS,
  });
  expect(sa.status(), `sa import ${await sa.text()}`).toBe(200);
  saRowId = (
    (await sa.json()) as { serviceAccount: { id: string } }
  ).serviceAccount.id;

  const client = await admin.post("/api/v1/admin/google/clients", {
    data: { clientId: CLIENT_ID, clientSecret: `${TAG}-client-secret` },
    headers: JOURNEY_HEADERS,
  });
  expect(client.status(), `client import ${await client.text()}`).toBe(200);
  const clientRowId = (
    (await client.json()) as { client: { id: string } }
  ).client.id;
  connectionId = await connectOperator(browser, admin, clientRowId);

  // Folder tree owned by the operator's My Drive:
  //   root/            (the mount root)
  //   root/shared/     note-pl.txt            <- open public link target
  //   root/locked/                             <- password link target
  //   root/expired/                            <- expiring link target
  await seedMyDriveFolder(admin, `Root ${TAG}`, {
    id: ROOT,
    ownerPrincipal: OWNER,
  });
  await seedMyDriveFolder(admin, `Shared ${TAG}`, {
    id: SHARED,
    ownerPrincipal: OWNER,
    parentId: ROOT,
  });
  await seedMyDriveFolder(admin, `Locked ${TAG}`, {
    id: LOCKED_DIR,
    ownerPrincipal: OWNER,
    parentId: ROOT,
  });
  await seedMyDriveFolder(admin, `Expired ${TAG}`, {
    id: EXPIRED_DIR,
    ownerPrincipal: OWNER,
    parentId: ROOT,
  });
  await seedMyDriveFile(admin, FILE_NAME, {
    id: FILE_ID,
    ownerPrincipal: OWNER,
    parentId: SHARED,
    text: FILE_TEXT,
  });
  await seedMyDriveFile(admin, `inside-${TAG}.txt`, {
    ownerPrincipal: OWNER,
    parentId: LOCKED_DIR,
    text: "locked content",
  });

  const mount = await admin.post("/api/v1/admin/mounts", {
    data: {
      label: `Public Link Mount ${TAG}`,
      rootFolderId: ROOT,
      catalogConnectionId: connectionId,
      writeConnectionId: connectionId,
      serviceAccountIds: [saRowId],
      visibility: "private",
    },
    headers: JOURNEY_HEADERS,
  });
  expect(mount.status(), `mount create ${await mount.text()}`).toBe(200);
  mountId = ((await mount.json()) as { mount: { id: string } }).mount.id;

  // Sync the SA read pool onto the root folder (inherited by descendants).
  let remaining = 1;
  for (let round = 0; round < 10 && remaining > 0; round += 1) {
    const sync = await admin.post(
      `/api/v1/admin/mounts/${mountId}/read-grants/sync`,
      { data: {}, headers: JOURNEY_HEADERS },
    );
    expect(sync.status(), `sync ${await sync.text()}`).toBe(200);
    remaining = ((await sync.json()) as { remaining: number }).remaining;
  }
  expect(remaining).toBe(0);
  await admin.dispose();
});

test("happy path: create from Explorer UI, anonymous list + download, no session calls", async ({
  browser,
  playwright,
}) => {
  const admin = await adminApi(playwright.request);
  const context = await browser.newContext({ storageState: adminState });
  const page = await context.newPage();

  // --- Admin creates the link through the Explorer share dialog ---------
  await page.goto("/explorer");
  await expect(
    page.getByRole("heading", { name: "Explorer" }),
  ).toBeVisible({ timeout: 15_000 });
  // Other journey specs create their own mounts first — pick ours when the
  // picker is present (it only renders with >1 mount, after mounts load).
  const mountPicker = page.locator("#mount-select");
  await mountPicker.waitFor({ timeout: 8000 }).catch(() => undefined);
  if (await mountPicker.isVisible()) {
    await mountPicker.selectOption({ label: `Public Link Mount ${TAG}` });
  }
  await expect(
    page.getByRole("button", { name: `Shared ${TAG}`, exact: true }),
  ).toBeVisible();
  // Navigate into the shared folder, then open the dialog from the header
  // button so the link covers exactly this folder's subtree.
  await page
    .getByRole("button", { name: `Shared ${TAG}`, exact: true })
    .click();
  await expect(page.getByText(FILE_NAME)).toBeVisible();
  await page.getByTestId("share-public-button").click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByText("Cho phép tải cả thư mục").click();
  await dialog.getByRole("button", { name: "Tạo liên kết" }).click();
  await expect(page.locator("#public-link-url")).toHaveValue(/\/public\//, {
    timeout: 10_000,
  });
  const absoluteUrl = await page.locator("#public-link-url").inputValue();
  openPath = new URL(absoluteUrl).pathname;
  openSlug = openPath.split("/").pop() ?? "";
  expect(openSlug).not.toBe("");
  await dialog.getByRole("button", { name: "Đóng" }).click();
  // The header action now reflects the active link; back at the mount root
  // (its crumb carries the mount label) the folder row shows the public tag.
  await expect(page.getByTestId("share-public-button")).toContainText(
    "Đang công khai",
  );
  await page
    .getByRole("button", { name: `Public Link Mount ${TAG}` })
    .click();
  await expect(page.locator(".tag-public").first()).toContainText("Công khai");

  // --- Anonymous fresh context: open, list, download --------------------
  const anon = await browser.newContext();
  const calls: string[] = [];
  const pub = await anon.newPage();
  pub.on("request", (req) => calls.push(req.url()));
  await pub.goto(openPath);
  await expect(
    pub.getByRole("heading", { name: `Shared ${TAG}` }),
  ).toBeVisible({ timeout: 15_000 });
  await expect(pub.getByText(FILE_NAME)).toBeVisible();
  // Breadcrumbs render and the file row offers the public download URL.
  const download = pub.getByRole("link", {
    name: `Tải xuống ${FILE_NAME}`,
  });
  await expect(download).toHaveAttribute(
    "href",
    `/api/v1/p/${openSlug}/files/${FILE_ID}/content?download=1`,
  );
  const bytes = await pub.request.get(
    `/api/v1/p/${openSlug}/files/${FILE_ID}/content?download=1`,
  );
  expect(bytes.status()).toBe(200);
  expect((await bytes.body()).toString("utf8")).toBe(FILE_TEXT);
  // noindex meta is present while the public page is mounted.
  await expect(pub.locator('meta[name="robots"]')).toHaveAttribute(
    "content",
    "noindex",
  );
  // The public surface never touched session or admin APIs.
  const leaked = calls.filter((url) =>
    /\/api\/v1\/(session|admin)\b|\/api\/auth\//.test(url),
  );
  expect(leaked, `session/admin calls from /p: ${leaked.join(", ")}`).toEqual(
    [],
  );
  await anon.close();
  await context.close();
  await admin.dispose();
});

test("locked path: wrong password rejected, correct password unlocks the listing", async ({
  browser,
  playwright,
}) => {
  const admin = await adminApi(playwright.request);
  const link = await createLink(admin, {
    mountId,
    folderId: LOCKED_DIR,
    password: LINK_PASSWORD,
    expiresAt: null,
    allowZip: false,
  });

  const anon = await browser.newContext();
  const page = await anon.newPage();
  // Links shared before the rename used /p/<slug>; they land on /public/<slug>.
  expect(link.path).toBe(`/public/${link.slug}`);
  await page.goto(`/p/${link.slug}`);
  await expect(page).toHaveURL(new RegExp(`/public/${link.slug}$`));
  await expect(page.locator("#public-password")).toBeVisible({
    timeout: 15_000,
  });
  await page.locator("#public-password").fill("wrong-password");
  await page.getByRole("button", { name: "Mở khóa" }).click();
  await expect(page.getByText("Mật khẩu không đúng.")).toBeVisible();
  await page.locator("#public-password").fill(LINK_PASSWORD);
  await page.getByRole("button", { name: "Mở khóa" }).click();
  await expect(page.getByText(`inside-${TAG}.txt`)).toBeVisible({
    timeout: 15_000,
  });
  await anon.close();
  await admin.dispose();
});

test("expired link renders the expired state", async ({
  page,
  playwright,
}) => {
  const admin = await adminApi(playwright.request);
  const link = await createLink(admin, {
    mountId,
    folderId: EXPIRED_DIR,
    password: null,
    expiresAt: new Date(Date.now() + 1500).toISOString(),
    allowZip: false,
  });
  await page.waitForTimeout(2500);
  await page.goto(link.path);
  await expect(page.getByText("Liên kết đã hết hạn")).toBeVisible({
    timeout: 15_000,
  });
  await admin.dispose();
});

test("unlock throttle: repeated wrong passwords hit 429 with a retry hint", async ({
  browser,
  playwright,
}) => {
  const admin = await adminApi(playwright.request);
  const lockedFolder = await seedMyDriveFolder(admin, `Throttle ${TAG}`, {
    ownerPrincipal: OWNER,
    parentId: ROOT,
  });
  const link = await createLink(admin, {
    mountId,
    folderId: lockedFolder.id,
    password: LINK_PASSWORD,
    expiresAt: null,
    allowZip: false,
  });

  const anon = await browser.newContext();
  const page = await anon.newPage();
  await page.goto(link.path);
  await expect(page.locator("#public-password")).toBeVisible({
    timeout: 15_000,
  });
  // Every submission reserves an attempt; >5 inside the rolling 60s window
  // trips 429 + retryAfterSeconds. Keep submitting until the 429 message
  // appears (the exact trip point is an implementation detail).
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await page.locator("#public-password").fill(`bad-${attempt}`);
    await page.getByRole("button", { name: "Mở khóa" }).click();
    await expect(
      page.getByText(/Mật khẩu không đúng\.|Quá nhiều lần thử/),
    ).toBeVisible({ timeout: 10_000 });
    if (await page.getByText(/Quá nhiều lần thử/).isVisible()) break;
  }
  await expect(page.getByText(/Quá nhiều lần thử/)).toBeVisible({
    timeout: 15_000,
  });
  await anon.close();
  await admin.dispose();
});
