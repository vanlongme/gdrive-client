/**
 * Journey helpers (T15): control-plane client for the fake Google boundary
 * plus admin/user API plumbing bound to the journey origin (8878). All HTTP
 * here hits either the real worker or the fake's loopback control port —
 * no production code paths are stubbed.
 */

import { expect } from "@playwright/test";
import type { APIRequestContext } from "@playwright/test";

export const JOURNEY_ORIGIN = "http://localhost:8878";
export const CONTROL_ORIGIN = "http://127.0.0.1:8898";
export const JOURNEY_HEADERS = { origin: JOURNEY_ORIGIN };

export const JOURNEY_ADMIN = {
  name: "Journey Admin",
  email: "journey-admin@gdrive-client.test",
  password: "journey-admin-password-1!",
};
export const JOURNEY_UPLOADER = {
  name: "Journey Uploader",
  email: "journey-uploader@gdrive-client.test",
  password: "journey-uploader-password-1!",
};

export interface FakeRequestLogEntry {
  seq: number;
  at: string;
  host: string;
  method: string;
  path: string;
  queryKeys: string[];
  operation: string;
  provider: "oauth" | "service_account" | "none";
  principal: string | null;
  status: number;
  requestBytes: number;
  responseBytes: number;
  requestSha256?: string;
  providerViolation?: string;
}

async function controlFetch(
  request: APIRequestContext,
  method: string,
  path: string,
  data?: unknown,
): Promise<unknown> {
  const url = `${CONTROL_ORIGIN}${path}`;
  const res =
    method === "GET"
      ? await request.get(url)
      : method === "DELETE"
        ? await request.delete(url)
        : await request.post(url, { data });
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  if (!res.ok()) {
    throw new Error(`control ${method} ${path} -> ${res.status()}: ${text}`);
  }
  return body;
}

export async function fakeRequests(
  request: APIRequestContext,
): Promise<FakeRequestLogEntry[]> {
  const body = (await controlFetch(request, "GET", "/__fake__/requests")) as {
    requests: FakeRequestLogEntry[];
  };
  return body.requests;
}

export async function mintAuthCode(
  request: APIRequestContext,
  clientId: string,
  principal = "perm-fake-operator",
): Promise<string> {
  const body = (await controlFetch(request, "POST", "/__fake__/auth-codes", {
    clientId,
    principal,
    scopes: ["https://www.googleapis.com/auth/drive"],
  })) as { code: string };
  return body.code;
}

export async function registerFakeServiceAccount(
  request: APIRequestContext,
  sa: { email: string; projectId: string; publicKeyPem: string },
): Promise<void> {
  await controlFetch(request, "POST", "/__fake__/service-accounts", sa);
}

export async function createFakeDrive(
  request: APIRequestContext,
  id: string,
  name: string,
): Promise<void> {
  await controlFetch(request, "POST", "/__fake__/drives", { id, name });
}

export async function grantDriveMembership(
  request: APIRequestContext,
  driveId: string,
  principal: string,
  role: "reader" | "writer" | "organizer" = "reader",
): Promise<void> {
  await controlFetch(request, "POST", `/__fake__/drives/${driveId}/members`, {
    principal,
    role,
  });
}

export async function revokeDriveMembership(
  request: APIRequestContext,
  driveId: string,
  principal: string,
): Promise<void> {
  await controlFetch(
    request,
    "DELETE",
    `/__fake__/drives/${driveId}/members?principal=${encodeURIComponent(principal)}`,
  );
}

export interface FakeFileState {
  id: string;
  name: string;
  mimeType: string;
  driveId: string;
  parents: string[];
  trashed: boolean;
  size: number | null;
  sha256: string | null;
  revisions: string[];
}

export async function fakeState(request: APIRequestContext): Promise<{
  files: FakeFileState[];
  members: Record<string, Record<string, string>>;
}> {
  return (await controlFetch(request, "GET", "/__fake__/state")) as {
    files: FakeFileState[];
    members: Record<string, Record<string, string>>;
  };
}

// ---------------------------------------------------------------------------
// Real worker API plumbing (journey origin, same flows as the UI drives).
// ---------------------------------------------------------------------------

export async function journeySetup(request: APIRequestContext): Promise<void> {
  const status = await request.get("/api/v1/setup/status");
  const { setupState } = (await status.json()) as { setupState: string };
  if (setupState === "complete") return;
  const token =
    process.env.E2E_SETUP_TOKEN ??
    "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";
  const res = await request.post("/api/v1/setup", {
    data: {
      token,
      name: JOURNEY_ADMIN.name,
      email: JOURNEY_ADMIN.email,
      password: JOURNEY_ADMIN.password,
      canonicalOrigin: JOURNEY_ORIGIN,
    },
    headers: JOURNEY_HEADERS,
  });
  expect([200, 409], `setup POST returned ${res.status()}`).toContain(
    res.status(),
  );
}

export async function journeySignIn(
  request: APIRequestContext,
  email: string,
  password: string,
): Promise<void> {
  const res = await request.post("/api/auth/sign-in/email", {
    data: { email, password },
    headers: JOURNEY_HEADERS,
  });
  expect(res.status(), `sign-in ${res.status()}: ${await res.text()}`).toBe(200);
}
