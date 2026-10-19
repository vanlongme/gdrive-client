/**
 * Loopback control plane for the fake Google boundary (T15).
 *
 * Playwright runs in a different process than the journey server that hosts
 * Miniflare, so test-side state mutation (mint auth codes, register the SA
 * public key, flip drive membership) and log reads go through a small HTTP
 * surface on 127.0.0.1 — never reachable from the worker.
 *
 * Every non-control path is ALSO forwarded through the same fake dispatch,
 * so a request issued with curl/fetch exercises the identical classification,
 * permission and logging pipeline as a worker-bound request. That is what
 * the negative provider-violation test drives.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import {
  GOOGLE_API_HOST,
  GOOGLE_TOKEN_HOST,
  type FakeGoogle,
} from "./index";
import type { DriveRole } from "./state";

interface ControlBody {
  [key: string]: unknown;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(text);
}

async function readJson(req: IncomingMessage): Promise<ControlBody> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as ControlBody;
  } catch {
    return {};
  }
}

/**
 * Wire control routes onto a Node http server handler. Returns the handler
 * for http.createServer.
 */
export function controlHandler(
  fake: FakeGoogle,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const path = url.pathname;

    try {
      // ---- Control endpoints ------------------------------------------------
      if (path === "/__fake__/requests" && req.method === "GET") {
        const since = Number.parseInt(url.searchParams.get("since") ?? "0", 10);
        const entries = fake
          .requests()
          .filter((entry) => entry.seq >= (Number.isNaN(since) ? 0 : since));
        json(res, 200, { requests: entries });
        return;
      }
      if (path === "/__fake__/auth-codes" && req.method === "POST") {
        const body = await readJson(req);
        const clientId =
          typeof body.clientId === "string" && body.clientId !== ""
            ? body.clientId
            : "unused-client";
        const principal =
          typeof body.principal === "string" && body.principal !== ""
            ? body.principal
            : "perm-fake-operator";
        const scopes = Array.isArray(body.scopes)
          ? body.scopes.filter((s): s is string => typeof s === "string")
          : ["https://www.googleapis.com/auth/drive"];
        const code = `fake-code-${Math.random().toString(36).slice(2, 14)}`;
        fake.state.authCodes.set(code, {
          code,
          clientId,
          principal,
          scopes,
          used: false,
        });
        json(res, 200, { code });
        return;
      }
      if (path === "/__fake__/service-accounts" && req.method === "POST") {
        const body = await readJson(req);
        const email = typeof body.email === "string" ? body.email : "";
        const projectId =
          typeof body.projectId === "string" ? body.projectId : "";
        const publicKeyPem =
          typeof body.publicKeyPem === "string" ? body.publicKeyPem : "";
        if (email === "" || projectId === "" || publicKeyPem === "") {
          json(res, 400, { error: "email, projectId and publicKeyPem required" });
          return;
        }
        fake.state.serviceAccounts.set(email, {
          email,
          projectId,
          publicKeyPem,
          enabled: true,
        });
        json(res, 200, { registered: email });
        return;
      }
      if (path === "/__fake__/drives" && req.method === "POST") {
        const body = await readJson(req);
        const id = typeof body.id === "string" ? body.id : "";
        const name = typeof body.name === "string" ? body.name : id;
        if (id === "") {
          json(res, 400, { error: "id required" });
          return;
        }
        fake.state.drives.set(id, { id, name });
        if (!fake.state.files.has(id)) {
          const nowIso = new Date().toISOString();
          fake.state.files.set(id, {
            id,
            name,
            mimeType: "application/vnd.google-apps.folder",
            parents: [],
            driveId: id,
            trashed: false,
            content: null,
            exportable: false,
            canDownload: false,
            revisions: [],
            createdTime: nowIso,
            modifiedTime: nowIso,
          });
        }
        if (!fake.state.members.has(id)) fake.state.members.set(id, new Map());
        json(res, 200, { drive: { id, name } });
        return;
      }
      const memberMatch = /^\/__fake__\/drives\/([^/]+)\/members$/.exec(path);
      if (memberMatch !== null && req.method === "POST") {
        const body = await readJson(req);
        const driveId = decodeURIComponent(memberMatch[1] ?? "");
        const principal =
          typeof body.principal === "string" ? body.principal : "";
        const role: DriveRole =
          body.role === "writer" || body.role === "organizer"
            ? body.role
            : "reader";
        if (!fake.state.drives.has(driveId) || principal === "") {
          json(res, 400, { error: "unknown drive or missing principal" });
          return;
        }
        fake.state.members.get(driveId)?.set(principal, role);
        json(res, 200, { granted: { driveId, principal, role } });
        return;
      }
      if (memberMatch !== null && req.method === "DELETE") {
        const driveId = decodeURIComponent(memberMatch[1] ?? "");
        const principal = url.searchParams.get("principal") ?? "";
        fake.state.members.get(driveId)?.delete(principal);
        json(res, 200, { revoked: { driveId, principal } });
        return;
      }
      // ---- My Drive seeding + permission controls --------------------------
      if (
        (path === "/__fake__/my-drive/folders" ||
          path === "/__fake__/my-drive/files") &&
        req.method === "POST"
      ) {
        const body = await readJson(req);
        const name = typeof body.name === "string" ? body.name : "";
        if (name === "") {
          json(res, 400, { error: "name required" });
          return;
        }
        const input = {
          name,
          ...(typeof body.id === "string" && body.id !== "" ? { id: body.id } : {}),
          ...(typeof body.parentId === "string" && body.parentId !== ""
            ? { parentId: body.parentId }
            : {}),
          ...(typeof body.ownerPrincipal === "string" && body.ownerPrincipal !== ""
            ? { ownerPrincipal: body.ownerPrincipal }
            : {}),
        };
        try {
          const file =
            path === "/__fake__/my-drive/folders"
              ? fake.seedMyDriveFolder(input)
              : fake.seedMyDriveFile({
                  ...input,
                  ...(typeof body.mimeType === "string" ? { mimeType: body.mimeType } : {}),
                  content:
                    typeof body.contentB64 === "string"
                      ? Buffer.from(body.contentB64, "base64")
                      : typeof body.text === "string"
                        ? Buffer.from(body.text, "utf8")
                        : new Uint8Array(0),
                });
          json(res, 200, {
            file: {
              id: file.id,
              name: file.name,
              parentId: file.parents[0] ?? null,
              ownerPrincipal: file.ownerPrincipal ?? null,
            },
          });
        } catch (err) {
          json(res, 400, { error: err instanceof Error ? err.message : String(err) });
        }
        return;
      }
      if (path === "/__fake__/permissions/rate-limit" && req.method === "POST") {
        const body = await readJson(req);
        const count =
          typeof body.count === "number" && Number.isInteger(body.count) && body.count >= 0
            ? body.count
            : 0;
        fake.state.sharingRateLimitExceeded = {
          remaining: count,
          ...(typeof body.retryAfterSeconds === "number"
            ? { retryAfterSeconds: body.retryAfterSeconds }
            : {}),
        };
        json(res, 200, { sharingRateLimitExceeded: fake.state.sharingRateLimitExceeded });
        return;
      }
      const filePermMatch = /^\/__fake__\/files\/([^/]+)\/permissions$/.exec(path);
      if (filePermMatch !== null) {
        const fileId = decodeURIComponent(filePermMatch[1] ?? "");
        if (!fake.state.files.has(fileId)) {
          json(res, 404, { error: "file not found" });
          return;
        }
        if (req.method === "GET") {
          json(res, 200, { permissions: fake.state.permissions.get(fileId) ?? [] });
          return;
        }
        if (req.method === "POST") {
          const body = await readJson(req);
          const emailAddress = typeof body.emailAddress === "string" ? body.emailAddress : "";
          if (emailAddress === "") {
            json(res, 400, { error: "emailAddress required" });
            return;
          }
          const perm = fake.seedPermission(
            fileId,
            emailAddress,
            body.role === "writer" ? "writer" : "reader",
          );
          json(res, 200, { permission: perm });
          return;
        }
      }
      const fileFlagMatch = /^\/__fake__\/files\/([^/]+)\/flags$/.exec(path);
      if (fileFlagMatch !== null && req.method === "POST") {
        const file = fake.state.files.get(decodeURIComponent(fileFlagMatch[1] ?? ""));
        if (file === undefined) {
          json(res, 404, { error: "file not found" });
          return;
        }
        const body = await readJson(req);
        if (typeof body.canDownload === "boolean") file.canDownload = body.canDownload;
        if (typeof body.trashed === "boolean") file.trashed = body.trashed;
        // Simulates an external move made in the Drive UI (no app request).
        if (
          Array.isArray(body.parents) &&
          body.parents.every((p): p is string => typeof p === "string")
        ) {
          file.parents = [...body.parents];
        }
        if (typeof body.thumbnailContentB64 === "string") {
          file.thumbnailContent = Buffer.from(body.thumbnailContentB64, "base64");
          file.thumbnailLink = `https://lh3.googleusercontent.com/fake-thumb/${file.id}`;
        }
        json(res, 200, { id: file.id });
        return;
      }
      if (path === "/__fake__/state" && req.method === "GET") {
        json(res, 200, {
          drives: [...fake.state.drives.values()],
          files: [...fake.state.files.values()].map((f) => ({
            id: f.id,
            name: f.name,
            mimeType: f.mimeType,
            driveId: f.driveId ?? null,
            ownerPrincipal: f.ownerPrincipal ?? null,
            parents: f.parents,
            trashed: f.trashed,
            size: f.content?.byteLength ?? null,
            sha256: f.sha256Checksum ?? null,
            revisions: f.revisions.map((r) => r.id),
          })),
          permissions: Object.fromEntries(
            [...fake.state.permissions.entries()].map(([fileId, list]) => [
              fileId,
              list.map((p) => ({ id: p.id, role: p.role, emailAddress: p.emailAddress })),
            ]),
          ),
          myDriveRoots: Object.fromEntries(fake.state.myDriveRoots),
          members: Object.fromEntries(
            [...fake.state.members.entries()].map(([d, m]) => [
              d,
              Object.fromEntries(m),
            ]),
          ),
          sessions: [...fake.state.uploadSessions.values()].map((s) => ({
            uploadId: s.uploadId,
            fileId: s.fileId,
            confirmed: s.confirmed.byteLength,
            finalized: s.finalized,
          })),
        });
        return;
      }

      // ---- Data plane: identical dispatch to the worker-bound path ----------
      const bodyBytes = Buffer.from(
        await new Promise<Buffer>((resolve) => {
          const chunks: Buffer[] = [];
          req.on("data", (c: Buffer) => chunks.push(c));
          req.on("end", () => resolve(Buffer.concat(chunks)));
        }),
      );
      // Re-host the request onto the Google host the path belongs to so the
      // same dispatch sees the same URL shape it sees via outboundService.
      const host =
        path === "/token" || path === "/revoke"
          ? GOOGLE_TOKEN_HOST
          : GOOGLE_API_HOST;
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) {
        if (name === "host" || name === "connection" || name === "content-length")
          continue;
        if (typeof value === "string") headers.set(name, value);
        else if (Array.isArray(value)) headers.set(name, value.join(","));
      }
      const synthetic = new Request(`https://${host}${url.pathname}${url.search}`, {
        method: req.method ?? "GET",
        headers,
        ...(req.method === "GET" || req.method === "HEAD"
          ? {}
          : { body: bodyBytes }),
      });
      const out = await fake.handle(synthetic);
      const responseBody = Buffer.from(await out.arrayBuffer());
      res.writeHead(out.status, {
        "content-type": out.headers.get("content-type") ?? "application/octet-stream",
        "content-length": String(responseBody.byteLength),
        ...(out.headers.get("location") !== null
          ? { location: out.headers.get("location") as string }
          : {}),
        ...(out.headers.get("range") !== null
          ? { range: out.headers.get("range") as string }
          : {}),
        ...(out.headers.get("content-range") !== null
          ? { "content-range": out.headers.get("content-range") as string }
          : {}),
      });
      res.end(responseBody);
    } catch (err) {
      json(res, 500, {
        error: "control-plane failure",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };
}
