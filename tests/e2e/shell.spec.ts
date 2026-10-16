import { expect, test } from "@playwright/test";
import type { APIRequestContext } from "@playwright/test";

const SETUP_STATES = new Set(["uninitialized", "in_progress", "complete"]);

async function readSetupState(request: APIRequestContext): Promise<string> {
  const res = await request.get("/api/v1/setup/status");
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { setupState: string };
  return body.setupState;
}

test("shell serves the app with security headers", async ({ page }) => {
  const response = await page.goto("/");
  expect(response?.status()).toBe(200);
  const headers = response?.headers() ?? {};
  expect(headers["content-security-policy"]).toContain("default-src 'self'");
  expect(headers["x-content-type-options"]).toBe("nosniff");
  expect(headers["referrer-policy"]).toBe("no-referrer");
  // Vietnamese is the default locale.
  await expect(page.locator("html")).toHaveAttribute("lang", "vi");
});

test("unknown nested route serves the shell and renders not-found", async ({
  page,
}) => {
  const response = await page.goto("/explorer/nested/route");
  expect(response?.status()).toBe(200);
  expect(response?.headers()["content-type"]).toContain("text/html");
  await expect(page.locator("#root")).not.toBeEmpty();
  // Unknown paths render the app's not-found screen, not dead markup.
  await expect(
    page.getByRole("heading", { name: "Không tìm thấy trang" }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Quay lại trang chính" }).click();
  await page.waitForURL(/\/(setup|login|explorer)/);
});

test("deep link into a protected route passes through the gate", async ({
  page,
  request,
}) => {
  const state = await readSetupState(request);
  await page.goto("/transfers");
  await page.waitForURL(/\/(setup|login)/);
  if (state === "complete") {
    await expect(
      page.getByRole("heading", { name: "Đăng nhập" }),
    ).toBeVisible();
  } else {
    await expect(
      page.getByRole("heading", { name: "Thiết lập ban đầu" }),
    ).toBeVisible();
  }
});

test("health endpoint responds on the real surface", async ({ request }) => {
  const res = await request.get("/api/v1/health");
  expect(res.status()).toBe(200);
  expect((await res.json()).status).toBe("ok");
  expect(res.headers()["x-content-type-options"]).toBe("nosniff");
  expect(res.headers()["referrer-policy"]).toBe("no-referrer");
  expect(res.headers()["content-security-policy"]).toContain("default-src 'none'");
});

test("unknown API path returns JSON 404, not index.html", async ({ request }) => {
  const res = await request.get("/api/v1/definitely-missing");
  expect(res.status()).toBe(404);
  expect(res.headers()["content-type"]).toContain("application/json");
  const body = (await res.json()) as { error: { code: string; requestId: string } };
  expect(body.error.code).toBe("NOT_FOUND");
  expect(body.error.requestId).toBeTruthy();
});

test("setup status exposes the wave-2 contract shape", async ({ request }) => {
  const res = await request.get("/api/v1/setup/status");
  expect(res.status()).toBe(200);
  const body = (await res.json()) as Record<string, unknown>;
  expect(Object.keys(body).sort()).toEqual(["canonicalOrigin", "setupState"]);
  expect(SETUP_STATES.has(body.setupState as string)).toBe(true);
  expect(
    body.canonicalOrigin === null || typeof body.canonicalOrigin === "string",
  ).toBe(true);
});

test("protected APIs fail closed before setup, auth-gated after", async ({
  request,
}) => {
  const state = await readSetupState(request);
  const res = await request.get("/api/v1/mounts");
  if (state !== "complete") {
    expect(res.status()).toBe(503);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("SETUP_REQUIRED");
    const auth = await request.get("/api/auth/get-session");
    expect(auth.status()).toBe(503);
  } else {
    // After setup, wave-3 catalog semantics apply: the anonymous actor is
    // legitimately served the public_read mount list (spec §7.4). The
    // fail-closed check is that no private mount ever leaks into it.
    expect(res.status()).toBe(200);
    const body = (await res.json()) as {
      mounts?: { visibility: string }[];
    };
    expect(Array.isArray(body.mounts)).toBe(true);
    for (const mount of body.mounts ?? []) {
      expect(mount.visibility).toBe("public_read");
    }
    // Private surfaces stay auth-gated: a mount-scoped path must not be
    // served to an anonymous actor.
    const scoped = await request.get(
      "/api/v1/mounts/any-mount/files/any-file/content",
    );
    expect(scoped.status()).toBeGreaterThanOrEqual(400);
    // The admin surface requires a real session — anonymous gets 401.
    const admin = await request.get("/api/v1/admin/users");
    expect(admin.status()).toBe(401);
  }
});

test("root path lands on the gate matching real state", async ({
  page,
  request,
}) => {
  const state = await readSetupState(request);
  await page.goto("/");
  if (state === "complete") {
    await page.waitForURL(/\/login/);
    await expect(
      page.getByRole("heading", { name: "Đăng nhập" }),
    ).toBeVisible();
    await expect(page.getByLabel("Email")).toBeVisible();
  } else {
    await page.waitForURL(/\/setup/);
    await expect(
      page.getByRole("heading", { name: "Thiết lập ban đầu" }),
    ).toBeVisible();
    await expect(page.getByLabel("Mã thiết lập")).toBeVisible();
  }
});
