import { mkdirSync } from "node:fs";
import { expect, test } from "@playwright/test";
import type {
  APIRequestContext,
  Browser,
  BrowserContext,
  Page,
} from "@playwright/test";

/**
 * Responsive shell, theme and locale behavior (wave-2 D acceptance):
 * - desktop shows the ~240px sidebar; mobile shows a top bar + drawer;
 * - theme light/dark/system applies to the document and persists;
 * - locale switches vi <-> en and persists; vi stays the default.
 *
 * Sign-in happens once per file (API, admin session) and is replayed through
 * storageState — repeated UI sign-ins would trip the real sign-in rate limit
 * (3 per 10s) without adding coverage.
 */

import { E2E_ORIGIN, E2E_SETUP_TOKEN } from "./e2e-env";

const ADMIN = {
  name: "E2E Admin",
  email: "e2e-admin@gdrive-client.test",
  password: "e2e-admin-password-1!",
};
const EVIDENCE_DIR = "docs/evidence/private";
const MOBILE = { width: 390, height: 844 };

async function ensureSetupComplete(request: APIRequestContext): Promise<void> {
  const res = await request.get("/api/v1/setup/status");
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { setupState: string };
  if (body.setupState === "complete") return;
  for (let attempt = 0; attempt < 3; attempt++) {
    const setup = await request.post("/api/v1/setup", {
      data: {
        token: E2E_SETUP_TOKEN,
        name: ADMIN.name,
        email: ADMIN.email,
        password: ADMIN.password,
        canonicalOrigin: E2E_ORIGIN,
      },
    });
    if (setup.status() === 429) {
      const err = (await setup.json()) as {
        error?: { retryAfterSeconds?: number };
      };
      await new Promise((resolve) =>
        setTimeout(resolve, ((err.error?.retryAfterSeconds ?? 5) + 1) * 1000),
      );
      continue;
    }
    expect([200, 409]).toContain(setup.status());
    return;
  }
  throw new Error("setup stayed rate-limited across retries");
}

type AdminStorage = Awaited<ReturnType<APIRequestContext["storageState"]>>;
let adminStorage: AdminStorage;

test.beforeAll(async ({ playwright }) => {
  const rc = await playwright.request.newContext({ baseURL: E2E_ORIGIN });
  await ensureSetupComplete(rc);
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await rc.post("/api/auth/sign-in/email", {
      data: { email: ADMIN.email, password: ADMIN.password },
      headers: { origin: E2E_ORIGIN },
    });
    if (res.status() === 200) {
      adminStorage = await rc.storageState();
      await rc.dispose();
      return;
    }
    if (res.status() === 429) {
      await new Promise((resolve) => setTimeout(resolve, 11_000));
      continue;
    }
    throw new Error(`admin sign-in failed with ${res.status()}`);
  }
  throw new Error("admin sign-in stayed rate-limited");
});

async function adminPage(
  browser: Browser,
  viewport?: { width: number; height: number },
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    storageState: adminStorage,
    ...(viewport === undefined ? {} : { viewport }),
  });
  const page = await context.newPage();
  return { context, page };
}

test("desktop shows the sidebar navigation without a menu button", async ({
  browser,
}) => {
  const { context, page } = await adminPage(browser);
  try {
    mkdirSync(EVIDENCE_DIR, { recursive: true });
    await page.goto("/explorer");

    await expect(page.locator(".shell-sidebar")).toBeVisible();
    await expect(
      page.locator('button[aria-controls="nav-drawer"]'),
    ).toBeHidden();

    const sidebar = page.locator(".shell-sidebar");
    const box = await sidebar.boundingBox();
    expect(box?.width).toBe(240);
    await expect(
      sidebar.getByRole("link", { name: "Explorer" }),
    ).toHaveAttribute("aria-current", "page");
    await page.screenshot({
      path: `${EVIDENCE_DIR}/w2d-desktop-shell.png`,
      fullPage: true,
    });
  } finally {
    await context.close();
  }
});

test("mobile collapses navigation into an accessible drawer", async ({
  browser,
}) => {
  const { context, page } = await adminPage(browser, MOBILE);
  try {
    mkdirSync(EVIDENCE_DIR, { recursive: true });
    await page.goto("/explorer");

    const sidebar = page.locator(".shell-sidebar");
    await expect(sidebar).toBeHidden();

    // The toggle's accessible name flips between open/close; its
    // aria-controls handle is stable across states.
    const menuButton = page.locator('button[aria-controls="nav-drawer"]');
    await expect(menuButton).toBeVisible();
    await expect(menuButton).toHaveAttribute("aria-expanded", "false");
    await menuButton.click();
    await expect(menuButton).toHaveAttribute("aria-expanded", "true");

    const drawer = page.getByRole("dialog", { name: "Điều hướng chính" });
    await expect(drawer).toBeVisible();

    // Modal keyboard behavior: Tab stays trapped inside the open drawer.
    for (let i = 0; i < 8; i++) await page.keyboard.press("Tab");
    await expect(
      page.locator("#nav-drawer:focus, #nav-drawer :focus"),
    ).toHaveCount(1);
    await page.screenshot({ path: `${EVIDENCE_DIR}/w2d-mobile-drawer.png` });

    // Escape closes the drawer and restores the button state.
    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden();
    await expect(menuButton).toHaveAttribute("aria-expanded", "false");

    // Drawer navigation works and closes itself after choosing a target.
    await menuButton.click();
    await drawer.getByRole("link", { name: "Truyền tệp" }).click();
    await expect(page).toHaveURL(/\/transfers/);
    await expect(menuButton).toHaveAttribute("aria-expanded", "false");
    await page.screenshot({
      path: `${EVIDENCE_DIR}/w2d-mobile-transfers.png`,
      fullPage: true,
    });
  } finally {
    await context.close();
  }
});

test("theme switches between light, dark and system and persists", async ({
  browser,
}) => {
  const { context, page } = await adminPage(browser);
  try {
    await page.goto("/explorer");

    const themeSelect = page.locator("#pref-theme").first();
    await expect(themeSelect).toHaveValue("system");

    await themeSelect.selectOption("dark");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(page.locator("html")).toHaveAttribute(
      "data-theme-choice",
      "dark",
    );

    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

    await themeSelect.selectOption("light");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");

    await themeSelect.selectOption("system");
    await expect(page.locator("html")).toHaveAttribute(
      "data-theme-choice",
      "system",
    );
  } finally {
    await context.close();
  }
});

test("locale switches between Vietnamese and English and persists", async ({
  browser,
}) => {
  const { context, page } = await adminPage(browser);
  try {
    await page.goto("/explorer");

    // Default is Vietnamese.
    await expect(
      page.getByRole("button", { name: "Đăng xuất" }).first(),
    ).toBeVisible();

    const localeSelect = page.locator("#pref-locale").first();
    await localeSelect.selectOption("en");
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await expect(
      page.getByRole("button", { name: "Sign out" }).first(),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Transfers" }).first(),
    ).toBeVisible();

    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await expect(
      page.getByRole("button", { name: "Sign out" }).first(),
    ).toBeVisible();

    await localeSelect.selectOption("vi");
    await expect(page.locator("html")).toHaveAttribute("lang", "vi");
    await expect(
      page.getByRole("button", { name: "Đăng xuất" }).first(),
    ).toBeVisible();
  } finally {
    await context.close();
  }
});
