/**
 * Wave-8 worker C evidence capture: spins up the journey server (built
 * worker + fake Google on :8878), provisions a real public-link fixture and
 * screenshots the Phase C surfaces into docs/evidence/W8-C/.
 *
 *   npx tsx tests/e2e/capture-w8c.ts
 *
 * Run AFTER `npm run build` (the journey server serves dist/). Never runs
 * under either playwright config — file does not end in .spec.ts.
 */
import { generateKeyPairSync } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { chromium, request as playwrightRequest } from "@playwright/test";
import type { APIRequestContext, Browser, Page } from "@playwright/test";
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

const OUT = "docs/evidence/W8-C";
const TAG = "pl";
const OWNER = "perm-fake-operator";
const CLIENT_ID = `20304050-${TAG}.apps.googleusercontent.com`;
const SA_EMAIL = `${TAG}-sa@${TAG}-project.iam.gserviceaccount.com`;
const SA_PROJECT = `${TAG}-project`;
const ROOT = `${TAG}-root`;
const SHARED = `${TAG}-shared`;
const LOCKED_DIR = `${TAG}-locked`;
const EXPIRED_DIR = `${TAG}-expired`;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitForHealth(): Promise<void> {
  for (let i = 0; i < 90; i += 1) {
    try {
      const res = await fetch(`${JOURNEY_ORIGIN}/api/v1/health`);
      if (res.ok) return;
    } catch {
      /* retry */
    }
    await wait(1000);
  }
  throw new Error("journey server did not come up");
}

async function connectOperator(
  browser: Browser,
  admin: APIRequestContext,
  clientRowId: string,
  adminState: Awaited<ReturnType<APIRequestContext["storageState"]>>,
): Promise<string> {
  const list = async () =>
    (
      (await (await admin.get("/api/v1/admin/google/connections")).json()) as {
        connections: { id: string }[];
      }
    ).connections.map((c) => c.id);
  const before = new Set(await list());
  const start = await admin.post("/api/v1/admin/google/oauth/start", {
    data: { purpose: "connect", oauthClientId: clientRowId },
    headers: JOURNEY_HEADERS,
  });
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
  for (let i = 0; i < 30; i += 1) {
    const created = (await list()).find((id) => !before.has(id));
    if (created !== undefined) return created;
    await wait(500);
  }
  throw new Error("connection never appeared");
}

async function shot(
  page: Page,
  name: string,
  opts?: { dark?: boolean; mobile?: boolean },
): Promise<void> {
  if (opts?.dark) await page.emulateMedia({ colorScheme: "dark" });
  else await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize(
    opts?.mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 },
  );
  await wait(350);
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: false });
}

async function main(): Promise<void> {
  await mkdir(OUT, { recursive: true });
  const server = spawn("npx", ["tsx", "tests/e2e/journey-server.ts"], {
    stdio: "inherit",
    env: { ...process.env },
  });
  try {
    await waitForHealth();
    const rc = await playwrightRequest.newContext({
      baseURL: JOURNEY_ORIGIN,
    });
    await journeySetup(rc);
    await rc.post("/api/auth/sign-in/email", {
      data: {
        email: JOURNEY_ADMIN.email,
        password: JOURNEY_ADMIN.password,
      },
      headers: JOURNEY_HEADERS,
    });
    const adminState = await rc.storageState();
    const admin = await playwrightRequest.newContext({
      baseURL: JOURNEY_ORIGIN,
      storageState: adminState,
    });

    const { privateKey, publicKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
    });
    await registerFakeServiceAccount(admin, {
      email: SA_EMAIL,
      projectId: SA_PROJECT,
      publicKeyPem: publicKey.export({ format: "pem", type: "spki" }) as string,
    });
    const saRes = await admin.post("/api/v1/admin/service-accounts", {
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
    const saRowId = (
      (await saRes.json()) as { serviceAccount: { id: string } }
    ).serviceAccount.id;

    const clientRes = await admin.post("/api/v1/admin/google/clients", {
      data: { clientId: CLIENT_ID, clientSecret: `${TAG}-client-secret` },
      headers: JOURNEY_HEADERS,
    });
    const clientRowId = (
      (await clientRes.json()) as { client: { id: string } }
    ).client.id;

    const browser = await chromium.launch();
    const connectionId = await connectOperator(
      browser,
      admin,
      clientRowId,
      adminState,
    );

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
    await seedMyDriveFile(admin, `note-${TAG}.txt`, {
      id: `${TAG}-note`,
      ownerPrincipal: OWNER,
      parentId: SHARED,
      text: `public link bytes ${"z".repeat(120)}`,
    });
    await seedMyDriveFile(admin, `inside-${TAG}.txt`, {
      ownerPrincipal: OWNER,
      parentId: LOCKED_DIR,
      text: "locked content",
    });

    const mountRes = await admin.post("/api/v1/admin/mounts", {
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
    const mountId = ((await mountRes.json()) as { mount: { id: string } })
      .mount.id;
    for (let round = 0; round < 10; round += 1) {
      const sync = await admin.post(
        `/api/v1/admin/mounts/${mountId}/read-grants/sync`,
        { data: {}, headers: JOURNEY_HEADERS },
      );
      if (((await sync.json()) as { remaining: number }).remaining === 0)
        break;
    }

    // Real public links: open, locked, already-expired.
    const open = (
      (await (
        await admin.post("/api/v1/public-links", {
          data: {
            mountId,
            folderId: SHARED,
            password: null,
            expiresAt: null,
            allowZip: true,
          },
          headers: JOURNEY_HEADERS,
        })
      ).json()) as { link: { path: string } }
    ).link;
    const locked = (
      (await (
        await admin.post("/api/v1/public-links", {
          data: {
            mountId,
            folderId: LOCKED_DIR,
            password: "orbit-gate-42",
            expiresAt: null,
            allowZip: false,
          },
          headers: JOURNEY_HEADERS,
        })
      ).json()) as { link: { path: string } }
    ).link;
    const expired = (
      (await (
        await admin.post("/api/v1/public-links", {
          data: {
            mountId,
            folderId: EXPIRED_DIR,
            password: null,
            expiresAt: new Date(Date.now() + 1200).toISOString(),
            allowZip: false,
          },
          headers: JOURNEY_HEADERS,
        })
      ).json()) as { link: { path: string } }
    ).link;
    await wait(1600);

    // --- Admin surfaces --------------------------------------------------
    const adminCtx = await browser.newContext({ storageState: adminState });
    const adminPage = await adminCtx.newPage();
    await adminPage.goto(`${JOURNEY_ORIGIN}/admin`);
    await adminPage
      .getByRole("button", { name: "Thông tin trang" })
      .first()
      .click();
    await adminPage
      .locator("#site-title")
      .fill("Điểm đến tài liệu Orbit");
    await adminPage.waitForTimeout(200);
    await shot(adminPage, "admin-site-1440-light");
    await shot(adminPage, "admin-site-1440-dark", { dark: true });
    await shot(adminPage, "admin-site-390-light", { mobile: true });

    // Explorer share dialog with a live link inside it.
    await adminPage.goto(`${JOURNEY_ORIGIN}/explorer`);
    await adminPage
      .getByRole("button", { name: `Shared ${TAG}`, exact: true })
      .click();
    await adminPage.getByTestId("share-public-button").click();
    await adminPage
      .locator("#public-link-url")
      .waitFor({ timeout: 10_000 });
    await shot(adminPage, "share-dialog-1440-light");
    await shot(adminPage, "share-dialog-390-light", { mobile: true });
    await adminPage.keyboard.press("Escape");

    // Admin shares filter.
    await adminPage.goto(`${JOURNEY_ORIGIN}/admin`);
    await adminPage
      .getByRole("button", { name: "Chia sẻ", exact: true })
      .first()
      .click();
    await adminPage
      .getByText("Liên kết thư mục công khai")
      .waitFor({ timeout: 10_000 });
    await shot(adminPage, "admin-shares-1440-light");
    await shot(adminPage, "admin-shares-390-light", { mobile: true });
    await adminCtx.close();

    // --- Anonymous surfaces ----------------------------------------------
    const anon = await browser.newContext();
    const pub = await anon.newPage();
    await pub.goto(`${JOURNEY_ORIGIN}${open.path}`);
    await pub.getByText(`note-${TAG}.txt`).waitFor({ timeout: 15_000 });
    await shot(pub, "public-open-1440-light");
    await shot(pub, "public-open-1440-dark", { dark: true });
    await shot(pub, "public-open-390-light", { mobile: true });

    await pub.goto(`${JOURNEY_ORIGIN}${locked.path}`);
    await pub.locator("#public-password").waitFor({ timeout: 15_000 });
    await shot(pub, "public-locked-1440-light");
    await shot(pub, "public-locked-390-light", { mobile: true });

    await pub.goto(`${JOURNEY_ORIGIN}${expired.path}`);
    await pub.getByText("Liên kết đã hết hạn").waitFor({ timeout: 15_000 });
    await shot(pub, "public-expired-1440-light");
    await shot(pub, "public-expired-390-light", { mobile: true });

    await anon.close();
    await browser.close();
    console.log("screenshots written to", OUT);
  } finally {
    server.kill("SIGTERM");
  }
}

void main();
