import { generateKeyPairSync } from "node:crypto";
import { expect, test } from "@playwright/test";
import type { APIRequest, APIRequestContext, Browser, Page } from "@playwright/test";
import {
  JOURNEY_ADMIN,
  JOURNEY_HEADERS,
  JOURNEY_ORIGIN,
  fakeRequests,
  journeySetup,
  listPermissions,
  mintAuthCode,
  registerFakeServiceAccount,
  seedMyDriveFile,
  seedPermission,
  seedMyDriveFolder,
} from "./journey-helpers";

/**
 * Wave-7 My Drive folder mounts: browser -> built worker -> fake Google
 * (journey server). Runs under playwright.journey.config.ts only.
 * Fixture evidence, not live Google.
 */
const SA_COUNT = 3;
const CLIP = "my-drive clip — đúng nội dung ✓ 0123456789";
type State = Awaited<ReturnType<APIRequestContext["storageState"]>>;
type Folders = Record<
  "library" | "movies" | "sub" | "other" | "foreign" | "linked",
  string
>;

let tag = "";
let owner = "";
let clientId = "";
let adminState: State | undefined;
let connectionId = "";
let mountId = "";
let ids: Folders;
const files = { clip: "", deep: "", outside: "" };
const saEmails: string[] = [];

const adminApi = (request: APIRequest) =>
  request.newContext({ baseURL: JOURNEY_ORIGIN, storageState: adminState });

async function connectionIds(admin: APIRequestContext): Promise<string[]> {
  const res = await admin.get("/api/v1/admin/google/connections");
  return ((await res.json()) as { connections: { id: string }[] }).connections.map(
    (connection) => connection.id,
  );
}

/** Fake consent redirect, same mechanism as journey.spec.ts step 2. */
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
  const code = await mintAuthCode(admin, clientId, owner);
  const callback = `${url.searchParams.get("redirect_uri")}?state=${encodeURIComponent(
    url.searchParams.get("state") ?? "",
  )}&code=${encodeURIComponent(code)}`;
  const context = await browser.newContext({ storageState: adminState });
  try {
    await context.route("https://accounts.google.com/**", (route) =>
      route.fulfill({ status: 302, headers: { location: callback } }),
    );
    const page = await context.newPage();
    const exchange = page.waitForResponse(/oauth\/callback/, { timeout: 15_000 });
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

/** The create form (it alone contains #mount-label), ready with label and both connections. */
async function openCreateForm(page: Page, label: string) {
  await page.goto("/admin");
  await page.getByRole("button", { name: "Mounts", exact: true }).click();
  const form = page.locator("form.admin-form", {
    has: page.locator("#mount-label"),
  });
  await form.locator("#mount-label").fill(label);
  await form.locator("#mount-catalog-conn").selectOption(connectionId);
  await form.locator("#mount-write-conn").selectOption(connectionId);
  return form;
}

const readers = async (admin: APIRequestContext, folderId: string) =>
  (await listPermissions(admin, folderId))
    .filter((permission) => permission.type === "user" && permission.role === "reader")
    .map((permission) => permission.emailAddress)
    .sort();

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ browser, playwright }) => {
  tag = test.info().project.name.replace(/[^A-Za-z0-9]/g, "");
  owner = `perm-md-owner-${tag}`;
  clientId = `20304050-md${tag}.apps.googleusercontent.com`;
  ids = Object.fromEntries(
    (["library", "movies", "sub", "other", "foreign", "linked"] as const).map(
      (key) => [key, `md-${key}-${tag}`],
    ),
  ) as Folders;
  files.clip = `md-clip-${tag}`;
  files.deep = `md-deep-${tag}`;
  files.outside = `md-outside-${tag}`;

  const rc = await playwright.request.newContext({ baseURL: JOURNEY_ORIGIN });
  await journeySetup(rc);
  if (adminState === undefined) {
    for (let attempt = 0; attempt < 15; attempt += 1) {
      const signIn = await rc.post("/api/auth/sign-in/email", {
        data: {
          email: JOURNEY_ADMIN.email,
          password: JOURNEY_ADMIN.password,
        },
        headers: JOURNEY_HEADERS,
      });
      if (signIn.status() === 200) break;
      expect(signIn.status(), `sign-in ${await signIn.text()}`).toBe(429);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    adminState = await rc.storageState();
  }
  await rc.dispose();
  const admin = await adminApi(playwright.request);

  for (let index = 1; index <= SA_COUNT; index += 1) {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
    });
    const email = `md-sa-${index}-${tag}@md-project-${tag}.iam.gserviceaccount.com`;
    await registerFakeServiceAccount(admin, {
      email,
      projectId: `md-project-${tag}`,
      publicKeyPem: publicKey.export({ format: "pem", type: "spki" }) as string,
    });
    const imported = await admin.post("/api/v1/admin/service-accounts", {
      data: {
        keyJson: JSON.stringify({
          type: "service_account",
          project_id: `md-project-${tag}`,
          private_key_id: `mdkey${index}${tag}`,
          private_key: privateKey.export({
            format: "pem",
            type: "pkcs8",
          }) as string,
          client_email: email,
        }),
      },
      headers: JOURNEY_HEADERS,
    });
    expect(imported.status(), `sa import ${await imported.text()}`).toBe(200);
    saEmails.push(email);
  }

  const client = await admin.post("/api/v1/admin/google/clients", {
    data: { clientId, clientSecret: `md-client-secret-${tag}` },
    headers: JOURNEY_HEADERS,
  });
  expect(client.status(), `client import ${await client.text()}`).toBe(200);
  const clientRowId = ((await client.json()) as { client: { id: string } }).client.id;
  connectionId = await connectOperator(browser, admin, clientRowId);

  // Owner's My Drive: Library/Movies/Sub, Other, Linked; Foreign belongs to a stranger.
  const folder = (
    id: string,
    name: string,
    ownerPrincipal = owner,
    parentId?: string,
  ) =>
    seedMyDriveFolder(admin, name, {
      id,
      ownerPrincipal,
      ...(parentId === undefined ? {} : { parentId }),
    });
  await folder(ids.library, `Library ${tag}`);
  await folder(ids.movies, `Movies ${tag}`, owner, ids.library);
  await folder(ids.sub, `Sub ${tag}`, owner, ids.movies);
  await folder(ids.other, `Other ${tag}`);
  await folder(ids.linked, `Linked ${tag}`);
  await folder(ids.foreign, `Foreign ${tag}`, `perm-md-stranger-${tag}`);
  const file = (id: string, name: string, parentId: string, text: string) =>
    seedMyDriveFile(admin, name, {
      id,
      ownerPrincipal: owner,
      parentId,
      text,
    });
  await file(files.clip, `clip-${tag}.txt`, ids.movies, CLIP);
  await file(files.deep, `deep-${tag}.txt`, ids.sub, "deep file inside a sub-folder");
  await file(files.outside, `outside-${tag}.txt`, ids.other, "outside the mount");
  // SA-visible outside the mount: exercises OAuth containment, not SA 404.
  for (const email of saEmails) {
    await seedPermission(admin, files.outside, email, "reader");
  }
  await admin.dispose();
});

test("folder browser creates a My Drive mount and sync reaches N/N without notification", async ({
  browser,
  playwright,
}) => {
  const label = `MD Browser ${tag}`;
  const context = await browser.newContext({ storageState: adminState });
  const page = await context.newPage();
  const admin = await adminApi(playwright.request);
  try {
    const form = await openCreateForm(page, label);
    // The owner has zero Shared Drives, so the My Drive tab is the default.
    await expect(
      form.getByRole("tab", { name: "Thư mục My Drive" }),
    ).toHaveAttribute("aria-selected", "true");

    const picker = form.getByRole("group", { name: "Duyệt thư mục My Drive" });
    await expect(picker.getByText(`Library ${tag}`)).toBeVisible();
    await expect(picker.getByText(`Foreign ${tag}`)).toHaveCount(0); // 'me' in owners
    await picker
      .locator(".drive-row", { hasText: `Library ${tag}` })
      .getByRole("button", { name: "Mở" })
      .click();
    const movies = picker.locator(".drive-row", { hasText: `Movies ${tag}` });
    await expect(movies).toBeVisible();
    await movies.getByRole("button", { name: "Dùng thư mục này" }).click();
    await expect(
      form.getByText(`Đã chọn thư mục Movies ${tag}.`),
    ).toBeVisible();

    for (const email of saEmails) await form.getByLabel(email).check();
    await form.getByRole("button", { name: "Tạo mount" }).click();
    await expect(form.getByText("Đã tạo mount.")).toBeVisible();
    // Auto-sync after creation with a pool.
    await expect(page.getByTestId("read-grants-summary")).toContainText(
      `${SA_COUNT}/${SA_COUNT}`,
      { timeout: 30_000 },
    );
    const row = page.locator("tbody tr", { hasText: label });
    await expect(row.getByText("Thư mục My Drive")).toBeVisible();
    await expect(row.getByText(ids.movies)).toBeVisible();

    expect(await readers(admin, ids.movies)).toEqual([...saEmails].sort());
    // The fake rejects a create without sendNotificationEmail=false, so N OAuth 200s prove none was sent.
    const creates = (await fakeRequests(admin)).filter(
      (request) =>
        request.operation === "permissions.create" &&
        request.path.includes(ids.movies),
    );
    expect(creates).toHaveLength(SA_COUNT);
    for (const request of creates) {
      expect([request.provider, request.status, request.providerViolation]).toEqual([
        "oauth",
        200,
        undefined,
      ]);
      expect(request.queryKeys).toContain("sendNotificationEmail");
    }

    const list = (await (await admin.get("/api/v1/admin/mounts")).json()) as {
      mounts: {
        id: string;
        label: string;
        kind: string;
        driveId: string | null;
        rootFolderId: string;
        readGrants?: { ready: number; total: number };
      }[];
    };
    const created = list.mounts.find((mount) => mount.label === label);
    expect(created).toMatchObject({
      kind: "my_drive_folder",
      driveId: null,
      rootFolderId: ids.movies,
      readGrants: { ready: SA_COUNT, total: SA_COUNT },
    });
    mountId = created?.id ?? "";
    expect(mountId).not.toBe("");
  } finally {
    await admin.dispose();
    await context.close();
  }
});

test("pasted link creates a mount; saving the read pool syncs; probe sees the folder; a Docs link is refused", async ({
  browser,
  playwright,
}) => {
  const label = `MD Link ${tag}`;
  const context = await browser.newContext({ storageState: adminState });
  const page = await context.newPage();
  const admin = await adminApi(playwright.request);
  try {
    const form = await openCreateForm(page, label);
    await form.getByRole("tab", { name: "Thư mục My Drive" }).click();

    await form
      .locator("#mount-drive-link")
      .fill(`https://docs.google.com/document/d/${ids.library}/edit`);
    await expect(
      form.getByText("Không nhận ra thư mục trong liên kết này"),
    ).toBeVisible();
    await expect(
      form.getByRole("button", { name: "Dùng liên kết này" }),
    ).toBeDisabled();

    await form
      .locator("#mount-drive-link")
      .fill(
        `https://drive.google.com/drive/u/1/folders/${ids.linked}?usp=sharing`,
      );
    await form.getByRole("button", { name: "Dùng liên kết này" }).click();
    await expect(form.getByText(`(ID ${ids.linked})`)).toBeVisible();
    await form.getByRole("button", { name: "Tạo mount" }).click(); // no pool on purpose
    await expect(form.getByText("Đã tạo mount.")).toBeVisible();
    expect(await listPermissions(admin, ids.linked)).toHaveLength(0);

    const row = page.locator("tbody tr", { hasText: label });
    await expect(row.getByText("Thư mục My Drive")).toBeVisible();
    await row.getByRole("button", { name: "Sửa", exact: true }).click();
    const edit = page.locator(".admin-subsection", {
      has: page.getByRole("heading", { name: /^Sửa mount/ }),
    });
    for (const email of saEmails) await edit.getByLabel(email).check();
    await edit.getByRole("button", { name: "Lưu read pool" }).click(); // triggers the sync
    await expect(page.getByTestId("read-grants-summary")).toContainText(
      `${SA_COUNT}/${SA_COUNT}`,
      { timeout: 30_000 },
    );
    expect(await readers(admin, ids.linked)).toEqual([...saEmails].sort());

    await page.getByText("Kiểm tra từng service account").click();
    const saRow = page.locator(".read-grants .drive-row", {
      hasText: saEmails[0] ?? "",
    });
    await saRow.getByRole("button", { name: "Kiểm tra", exact: true }).click();
    await expect(saRow.getByText("Nhìn thấy thư mục")).toBeVisible();

    const list = (await (await admin.get("/api/v1/admin/mounts")).json()) as {
      mounts: { label: string }[];
    };
    expect(list.mounts.find((mount) => mount.label === label)).toMatchObject({
      kind: "my_drive_folder",
      driveId: null,
      rootFolderId: ids.linked,
    });
  } finally {
    await admin.dispose();
    await context.close();
  }
});

test("browses and streams a file through the SA pool", async ({
  browser,
  playwright,
}) => {
  expect(mountId, "mount from the first test").not.toBe("");
  const admin = await adminApi(playwright.request);
  const base = `/api/v1/mounts/${mountId}`;
  try {
    const children = (await (
      await admin.get(`${base}/folders/${ids.movies}/children`)
    ).json()) as { entries: { id: string; name: string; kind: string }[] };
    expect(children.entries.map((entry) => entry.name).sort()).toEqual(
      [`clip-${tag}.txt`, `Sub ${tag}`].sort(),
    );
    expect(children.entries.find((entry) => entry.id === ids.sub)?.kind).toBe(
      "folder",
    );
    const deep = (await (
      await admin.get(`${base}/folders/${ids.sub}/children`)
    ).json()) as { entries: { id: string }[] };
    expect(deep.entries.map((entry) => entry.id)).toEqual([files.deep]);

    const ready = await admin.post(`${base}/files/${files.clip}/readiness`, {
      data: {},
      headers: JOURNEY_HEADERS,
    });
    expect(
      ((await ready.json()) as { readerAccessState: string })
        .readerAccessState,
    ).toBe("readable");
    const content = await admin.get(`${base}/files/${files.clip}/content`);
    expect(content.status()).toBe(200);
    expect((await content.body()).toString("utf8")).toBe(CLIP);
    const ranged = await admin.get(`${base}/files/${files.clip}/content`, {
      headers: { range: "bytes=0-6" },
    });
    expect(ranged.status()).toBe(206);
    expect((await ranged.body()).toString("utf8")).toBe(CLIP.slice(0, 7));

    const reads = (await fakeRequests(admin)).filter(
      (request) =>
        request.operation === "files.media" && request.path.includes(files.clip),
    );
    expect(reads.length).toBeGreaterThan(0);
    for (const request of reads) expect(request.provider).toBe("service_account");

    const context = await browser.newContext({ storageState: adminState });
    const page = await context.newPage();
    try {
      await page.goto("/explorer");
      const select = page.locator("#mount-select");
      await expect(select).toBeVisible();
      await select.selectOption(mountId);
      await expect(page.locator(".breadcrumbs")).toContainText(
        `MD Browser ${tag}`,
      );
      await expect(page.getByText(`clip-${tag}.txt`)).toBeVisible();
      await expect(page.getByText(`Sub ${tag}`)).toBeVisible();
    } finally {
      await context.close();
    }
  } finally {
    await admin.dispose();
  }
});

test("a file outside the mounted folder is not accessible, exactly like a missing id", async ({
  playwright,
}) => {
  expect(mountId, "mount from the first test").not.toBe("");
  const admin = await adminApi(playwright.request);
  const base = `/api/v1/mounts/${mountId}`;
  const missing = `md-missing-${tag}-0000`;
  try {
    for (const [name, outside, gone, message, missingStatus, missingCode] of [
      [
        "detail",
        `files/${files.outside}`,
        `files/${missing}`,
        "File is not accessible.",
        404,
        "FILE_NOT_ACCESSIBLE",
      ],
      [
        "content",
        `files/${files.outside}/content`,
        `files/${missing}/content`,
        "The file is trashed or outside the mount drive.",
        502,
        "FILE_NOT_READABLE_BY_POOL",
      ],
      [
        "children",
        `folders/${ids.other}/children`,
        `folders/${missing}/children`,
        "File is not accessible.",
        404,
        "FILE_NOT_ACCESSIBLE",
      ],
    ] as const) {
      const a = await admin.get(`${base}/${outside}`);
      const b = await admin.get(`${base}/${gone}`);
      expect(a.status(), name).toBe(404);
      expect(b.status(), name).toBe(missingStatus);
      const ea = ((await a.json()) as { error: { code: string; message: string } })
        .error;
      const eb = ((await b.json()) as { error: { code: string; message: string } })
        .error;
      expect(ea.code, name).toBe("FILE_NOT_ACCESSIBLE");
      expect(ea.message, name).toBe(message);
      expect(eb.code, name).toBe(missingCode);
    }
  } finally {
    await admin.dispose();
  }
});

test("whole-mount search finds in-tree files and filters out-of-tree hits", async ({
  playwright,
}) => {
  expect(mountId, "mount from the first test").not.toBe("");
  const admin = await adminApi(playwright.request);
  const base = `/api/v1/mounts/${mountId}`;
  try {
    const hits = (await (
      await admin.get(
        `${base}/search?q=${encodeURIComponent(`${tag}.txt`)}&scope=drive`,
      )
    ).json()) as { entries: { id: string; name: string }[] };
    expect(hits.entries.map((entry) => entry.id).sort()).toEqual(
      [files.clip, files.deep].sort(),
    );
    const folderHits = (await (
      await admin.get(
        `${base}/search?q=${encodeURIComponent(`deep-${tag}`)}&scope=folder&folderId=${ids.sub}`,
      )
    ).json()) as { entries: { id: string }[] };
    expect(folderHits.entries.map((entry) => entry.id)).toEqual([files.deep]);
  } finally {
    await admin.dispose();
  }
});
