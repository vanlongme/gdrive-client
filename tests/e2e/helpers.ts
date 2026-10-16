import { expect, test } from "@playwright/test";
import type { APIRequestContext, Page } from "@playwright/test";
import { E2E_ORIGIN, E2E_SETUP_TOKEN } from "./e2e-env";

/**
 * Shared wave-3 helpers: real setup claim and sign-in against the isolated
 * workerd preview. Mirrored from the wave-2 spec conventions — sign-in
 * endpoints are rate-limited for real (3/10s), so every helper retries
 * through a declared window instead of asserting on a throttle artefact.
 */

export const ADMIN = {
  name: "E2E Admin",
  email: "e2e-admin@gdrive-client.test",
  password: "e2e-admin-password-1!",
};

export const EVIDENCE_DIR = "docs/evidence/private";

export const AUTH_HEADERS = { origin: E2E_ORIGIN };

export const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function readSetupState(
  request: APIRequestContext,
): Promise<string> {
  const res = await request.get("/api/v1/setup/status");
  expect(res.status()).toBe(200);
  return ((await res.json()) as { setupState: string }).setupState;
}

export async function ensureSetupComplete(
  request: APIRequestContext,
): Promise<void> {
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
  throw new Error("setup stayed rate-limited");
}

export async function apiSignIn(
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

export async function signInThroughUi(
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

/** Signs in once per file and stores the browser state for fresh contexts. */
export function useAdminStorage(): {
  get: () => Awaited<ReturnType<APIRequestContext["storageState"]>>;
} {
  let stored: Awaited<ReturnType<APIRequestContext["storageState"]>>;
  test.beforeAll(async ({ playwright }) => {
    const rc = await playwright.request.newContext({ baseURL: E2E_ORIGIN });
    await ensureSetupComplete(rc);
    await apiSignIn(rc, ADMIN.email, ADMIN.password);
    stored = await rc.storageState();
    await rc.dispose();
  });
  return { get: () => stored };
}
