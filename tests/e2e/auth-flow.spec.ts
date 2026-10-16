import { mkdirSync } from "node:fs";
import { expect, test } from "@playwright/test";
import type { APIRequestContext, Page } from "@playwright/test";

/**
 * Real browser journey (wave-2 D acceptance): setup claim -> explicit sign-in
 * -> authenticated navigation -> sign-out. The setup token comes from the
 * deterministic runner plumbing owned by track A (tests/e2e/e2e-env.ts);
 * specs never read .dev.vars.
 *
 * Sign-in endpoints are rate-limited for real (Better Auth: 3/10s), so both
 * sign-in helpers retry through a declared window instead of asserting on a
 * throttle artefact.
 */

import { E2E_ORIGIN, E2E_SETUP_TOKEN } from "./e2e-env";

const ADMIN = {
  name: "E2E Admin",
  email: "e2e-admin@gdrive-client.test",
  password: "e2e-admin-password-1!",
};
const VIEWER = {
  name: "E2E Viewer",
  email: "e2e-viewer@gdrive-client.test",
  password: "e2e-viewer-password-1!",
};
const EVIDENCE_DIR = "docs/evidence/private";

const AUTH_HEADERS = { origin: E2E_ORIGIN };
const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

async function readSetupState(request: APIRequestContext): Promise<string> {
  const res = await request.get("/api/v1/setup/status");
  expect(res.status()).toBe(200);
  return ((await res.json()) as { setupState: string }).setupState;
}

/**
 * Idempotent setup: claims the installation when needed and tolerates the
 * 409 replay from a previous run. Retries through the setup throttle window
 * when the bad-token probe above left a short lock.
 */
async function ensureSetupComplete(request: APIRequestContext): Promise<void> {
  const state = await readSetupState(request);
  if (state === "complete") return;
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await request.post("/api/v1/setup", {
      data: {
        token: E2E_SETUP_TOKEN,
        name: ADMIN.name,
        email: ADMIN.email,
        password: ADMIN.password,
        canonicalOrigin: E2E_ORIGIN,
      },
    });
    if (res.status() === 429) {
      const body = (await res.json()) as {
        error?: { retryAfterSeconds?: number };
      };
      await sleep(((body.error?.retryAfterSeconds ?? 5) + 1) * 1000);
      continue;
    }
    expect([200, 409], `setup POST returned ${res.status()}`).toContain(
      res.status(),
    );
    return;
  }
  throw new Error("setup stayed rate-limited across retries");
}

/** API sign-in with retry through the real rate-limit window. */
async function apiSignIn(
  request: APIRequestContext,
  email: string,
  password: string,
): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await request.post("/api/auth/sign-in/email", {
      data: { email, password },
      headers: AUTH_HEADERS,
    });
    if (res.status() === 200) return;
    if (res.status() === 429) {
      await sleep(11_000);
      continue;
    }
    throw new Error(`sign-in failed with ${res.status()}: ${await res.text()}`);
  }
  throw new Error("sign-in stayed rate-limited");
}

/**
 * Signs in through the real form (Vietnamese default locale). Stays on the
 * current /login page when already there so router state (the post-login
 * destination) is preserved, and retries through the sign-in rate limit.
 */
async function signInThroughUi(
  page: Page,
  credentials: { email: string; password: string } = ADMIN,
  expectedTarget: RegExp = /\/explorer/,
): Promise<void> {
  if (!page.url().includes("/login")) await page.goto("/login");
  await page.getByLabel("Email").fill(credentials.email);
  await page.getByLabel("Mật khẩu").fill(credentials.password);
  const submit = page.getByRole("button", { name: "Đăng nhập" });
  for (let attempt = 0; attempt < 3; attempt++) {
    await submit.click();
    try {
      await page.waitForURL(expectedTarget, { timeout: 8_000 });
      return;
    } catch {
      const alert = page.getByRole("alert");
      const alertText = (await alert.isVisible())
        ? await alert.innerText()
        : "";
      if (/nhiều lần thử/i.test(alertText)) {
        await page.waitForTimeout(11_000);
        continue;
      }
      throw new Error(
        `sign-in did not reach ${expectedTarget}; alert=${alertText}`,
      );
    }
  }
  throw new Error("sign-in stayed rate-limited");
}

test("setup rejects a wrong token; a closed claim never reopens", async ({
  page,
  request,
}) => {
  const state = await readSetupState(request);
  const WRONG_TOKEN = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

  if (state === "uninitialized") {
    // Fresh persistence: the real form path must surface the rejection.
    await page.goto("/setup");
    const tokenField = page.getByLabel("Mã thiết lập");
    await tokenField.waitFor({ state: "visible" });
    mkdirSync(EVIDENCE_DIR, { recursive: true });
    await page.screenshot({
      path: `${EVIDENCE_DIR}/w2d-desktop-setup.png`,
      fullPage: true,
    });
    await tokenField.fill(WRONG_TOKEN);
    await page.getByLabel("Tên hiển thị").fill(ADMIN.name);
    await page.getByLabel("Email", { exact: true }).fill(ADMIN.email);
    await page.getByLabel("Mật khẩu", { exact: true }).fill(ADMIN.password);
    await page.getByLabel("Nhập lại mật khẩu").fill(ADMIN.password);
    await page.getByRole("button", { name: "Hoàn tất thiết lập" }).click();

    const alert = page.getByRole("alert");
    await expect(alert).toBeVisible();
    await expect(alert).toContainText(/mã thiết lập|SETUP_TOKEN/i);
    await expect(tokenField).toHaveAttribute("aria-invalid", "true");
    // The bad claim consumed nothing.
    expect(await readSetupState(request)).not.toBe("complete");
    return;
  }

  // Claim already owned or completed: a wrong token is rejected before any
  // state can change (completed short-circuits 409; an in-progress claim
  // fails the token check at 403).
  const res = await request.post("/api/v1/setup", {
    data: {
      token: WRONG_TOKEN,
      name: ADMIN.name,
      email: ADMIN.email,
      password: ADMIN.password,
      canonicalOrigin: E2E_ORIGIN,
    },
  });
  expect(res.status()).toBe(state === "complete" ? 409 : 403);
  const body = (await res.json()) as { error?: { code?: string } };
  expect(["SETUP_ALREADY_COMPLETED", "SETUP_TOKEN_INVALID"]).toContain(
    body.error?.code,
  );
  if (state === "complete") {
    await page.goto("/setup");
    await expect(page.getByText(/đã được thiết lập/)).toBeVisible();
  }
});

test("admin journey: setup, sign-in, navigation, sign-out", async ({
  page,
  request,
}) => {
  test.setTimeout(90_000);
  await ensureSetupComplete(request);
  mkdirSync(EVIDENCE_DIR, { recursive: true });

  // Unauthenticated entry routes to sign-in; signing in returns to Explorer.
  await page.goto("/");
  await page.waitForURL(/\/login/);
  await signInThroughUi(page);

  // The session is real server-side, not just a UI state: the frozen
  // credential-free contract reports the admin role.
  const sessionNow = await page.context().request.get("/api/v1/session");
  expect(sessionNow.status()).toBe(200);
  const sessionBody = (await sessionNow.json()) as {
    user?: { email?: string; role?: string };
  };
  expect(sessionBody.user?.email).toBe(ADMIN.email);
  expect(sessionBody.user?.role).toBe("admin");

  // Shell navigation with the real session: admin sees all three areas.
  const nav = page.getByRole("navigation", { name: "Điều hướng chính" }).first();
  await expect(nav.getByRole("link", { name: "Explorer" })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Truyền tệp" })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Quản trị" })).toBeVisible();
  await expect(page.getByText(ADMIN.email).first()).toBeVisible();
  await expect(
    page.getByText("Quản trị viên", { exact: true }).first(),
  ).toBeVisible();

  // Explorer reports an honest state (feature pending or empty mounts).
  await expect(
    page.getByText(/chưa sẵn sàng|Chưa có Drive nào/i).first(),
  ).toBeVisible();
  await page.screenshot({
    path: `${EVIDENCE_DIR}/w2d-desktop-explorer.png`,
    fullPage: true,
  });

  await nav.getByRole("link", { name: "Truyền tệp" }).click();
  await expect(page).toHaveURL(/\/transfers/);
  // Wave 4 (T09) replaced the pending placeholder with the real transfers
  // page; a fresh admin has an honest empty queue.
  await expect(
    page.getByRole("heading", { name: "Chưa có truyền tệp nào" }),
  ).toBeVisible();

  await nav.getByRole("link", { name: "Quản trị" }).click();
  await expect(page).toHaveURL(/\/admin/);
  await expect(page.getByText(ADMIN.email).first()).toBeVisible();
  // Wave-3 admin is tabbed: the health section sits behind its tab.
  await page
    .getByRole("button", { name: "Trạng thái", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Trạng thái dịch vụ" }),
  ).toBeVisible();
  await page.screenshot({
    path: `${EVIDENCE_DIR}/w2d-desktop-admin.png`,
    fullPage: true,
  });

  // Sign out for real: the session must be gone server-side, not just locally.
  // The context-bound request shares the browser's cookie jar.
  await page.getByRole("button", { name: "Đăng xuất" }).first().click();
  await page.waitForURL(/\/login/);
  const session = await page.context().request.get("/api/auth/get-session");
  expect(session.status()).toBe(200);
  expect(await session.json()).toBeNull();
  const appSession = await page.context().request.get("/api/v1/session");
  expect(appSession.status()).toBe(401);
  const denied = (await appSession.json()) as { error?: { code?: string } };
  expect(denied.error?.code).toBe("AUTH_REQUIRED");

  // The protected route now redirects to sign-in again.
  await page.goto("/explorer");
  await page.waitForURL(/\/login/);
});

test("sign-in failure shows an accessible error and stays on the page", async ({
  page,
  request,
}) => {
  await ensureSetupComplete(request);
  await page.goto("/login");
  await page.getByLabel("Email").fill(ADMIN.email);
  await page.getByLabel("Mật khẩu").fill("definitely-wrong-password");
  await page.getByRole("button", { name: "Đăng nhập" }).click();
  const alert = page.getByRole("alert");
  await expect(alert).toBeVisible();
  await expect(alert).toContainText(/Email hoặc mật khẩu không đúng/);
  await expect(page).toHaveURL(/\/login/);
});

test("unauthenticated deep link returns to the target after sign-in", async ({
  page,
  request,
}) => {
  test.setTimeout(90_000);
  await ensureSetupComplete(request);
  await page.goto("/transfers");
  await page.waitForURL(/\/login/);
  await signInThroughUi(page, ADMIN, /\/transfers/);
  // The preserved destination wins over the default /explorer landing.
  await expect(page).toHaveURL(/\/transfers/);
});

test("viewer role hides admin navigation and is refused by the admin page", async ({
  request,
  browser,
}) => {
  test.setTimeout(90_000);
  await ensureSetupComplete(request);

  // Create the user-role account through the admin-only auth API with the
  // real admin session (public sign-up stays disabled). Better Auth requires
  // an Origin header on mutations.
  await apiSignIn(request, ADMIN.email, ADMIN.password);
  const create = await request.post("/api/auth/admin/create-user", {
    data: {
      email: VIEWER.email,
      password: VIEWER.password,
      name: VIEWER.name,
      role: "user",
    },
    headers: AUTH_HEADERS,
  });
  if (create.status() !== 200) {
    // Reruns reuse persisted state: the viewer may already exist; the account
    // must still sign in for the rest of this scenario to be meaningful.
    const check = await request.post("/api/auth/sign-in/email", {
      data: { email: VIEWER.email, password: VIEWER.password },
      headers: AUTH_HEADERS,
    });
    expect(
      check.status(),
      `create-user ${create.status()} and viewer sign-in ${check.status()}`,
    ).toBe(200);
  }

  // Sign in as the viewer through the real form in a fresh browser context.
  const context = await browser.newContext();
  try {
    const viewerPage = await context.newPage();
    await signInThroughUi(viewerPage, VIEWER);

    const session = await viewerPage
      .context()
      .request.get("/api/v1/session");
    expect(session.status()).toBe(200);
    const body = (await session.json()) as { user?: { role?: string } };
    expect(body.user?.role).toBe("user");

    const nav = viewerPage
      .getByRole("navigation", { name: "Điều hướng chính" })
      .first();
    await expect(nav.getByRole("link", { name: "Explorer" })).toBeVisible();
    await expect(nav.getByRole("link", { name: "Truyền tệp" })).toBeVisible();
    await expect(nav.getByRole("link", { name: "Quản trị" })).toBeHidden();
    await expect(
      viewerPage.getByText("Người dùng", { exact: true }).first(),
    ).toBeVisible();

    // A direct URL still refuses the role on the client side; the server-side
    // admin API denies it independently of the UI.
    await viewerPage.goto("/admin");
    await expect(
      viewerPage.getByRole("heading", {
        name: "Khu vực chỉ dành cho quản trị viên",
      }),
    ).toBeVisible();
  } finally {
    await context.close();
  }
});
