/**
 * Repro 2: drive the REAL fake-google through Miniflare 5 outboundService
 * with the exact grant shapes the worker sends (authorization_code,
 * refresh_token, jwt-bearer RS256). Inline probe worker — never dist/.
 * Run: npx tsx tests/e2e/journey-repro.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { generateKeyPairSync, sign } from "node:crypto";
import { convertV4MiniflareOptions, Log, LogLevel, Miniflare } from "miniflare";
import { createFakeGoogle } from "./fake-google/index";

const DRIVE = "repro-drive-1";

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});
const SA_EMAIL = "repro-sa@repro.iam.gserviceaccount.com";
const SA_PUBLIC_PEM = publicKey.export({ format: "pem", type: "spki" }) as string;

const HEADER = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
const CLAIMS = Buffer.from(
  JSON.stringify({
    iss: SA_EMAIL,
    scope: "https://www.googleapis.com/auth/drive.readonly",
    aud: "https://oauth2.googleapis.com/token",
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
  }),
).toString("base64url");
const ASSERTION = `${HEADER}.${CLAIMS}.${sign("RSA-SHA256", Buffer.from(`${HEADER}.${CLAIMS}`), privateKey).toString("base64url")}`;

const SCRIPT = `
const ASSERTION = ${JSON.stringify(ASSERTION)};
const CODE = ${JSON.stringify("")};
async function post(path, body) {
  const r = await fetch("https://oauth2.googleapis.com" + path, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
    redirect: "manual",
  });
  return r.status + " :: " + (await r.text()).slice(0, 300);
}
export default {
  async fetch(req) {
    const url = new URL(req.url);
    const which = url.searchParams.get("g") ?? "code";
    try {
      if (which === "code") {
        return new Response(await post("/token", new URLSearchParams({
          grant_type: "authorization_code",
          code: url.searchParams.get("code") ?? "",
          redirect_uri: "http://localhost:8878/api/v1/admin/google/oauth/callback",
          client_id: "repro-client",
          client_secret: "repro-secret",
          code_verifier: "v",
        }).toString()));
      }
      if (which === "refresh") {
        return new Response(await post("/token", new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: url.searchParams.get("rt") ?? "",
          client_id: "repro-client",
          client_secret: "repro-secret",
        }).toString()));
      }
      if (which === "jwt") {
        return new Response(await post("/token", new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
          assertion: ASSERTION,
        }).toString()));
      }
      if (which === "about") {
        const r = await fetch("https://www.googleapis.com/drive/v3/about?fields=user", {
          headers: { authorization: "Bearer " + (url.searchParams.get("at") ?? "") },
          redirect: "manual",
        });
        return new Response(r.status + " :: " + (await r.text()).slice(0, 300));
      }
      return new Response("unknown g");
    } catch (e) {
      return new Response("THREW " + (e && (e.stack || e.message) || e));
    }
  },
};
`;

async function main(): Promise<void> {
  const fake = createFakeGoogle({
    drives: [{ id: DRIVE, name: "Repro Drive" }],
    members: [{ driveId: DRIVE, principal: "perm-repro", role: "writer" }],
  });
  fake.state.serviceAccounts.set(SA_EMAIL, {
    email: SA_EMAIL,
    projectId: "repro",
    publicKeyPem: SA_PUBLIC_PEM,
    enabled: true,
  });
  fake.state.authCodes.set("repro-code-1", {
    code: "repro-code-1",
    clientId: "repro-client",
    principal: "perm-repro",
    scopes: ["https://www.googleapis.com/auth/drive"],
    used: false,
  });
  fake.state.refreshTokens.set("rt-repro-1", {
    token: "rt-repro-1",
    provider: "oauth",
    clientId: "repro-client",
    principal: "perm-repro",
    scopes: ["https://www.googleapis.com/auth/drive"],
    revoked: false,
  });

  mkdirSync(".e2e-state/repro", { recursive: true });
  writeFileSync(".e2e-state/repro/probe.js", SCRIPT, "utf8");
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      host: "127.0.0.1",
      port: 8910,
      log: new Log(LogLevel.ERROR),
      telemetry: { enabled: false },
      workers: [
        {
          name: "probe",
          compatibilityDate: "2026-10-01",
          compatibilityFlags: ["nodejs_compat"],
          rootPath: ".e2e-state/repro",
          modules: [{ type: "ESModule", path: "probe.js" }],
          outboundService: (request: Request) => fake.handle(request),
        } as never,
      ],
    } as never),
  );
  await mf.ready;

  const go = async (q: string) => {
    const res = await mf.dispatchFetch(`http://127.0.0.1:8910/?${q}`);
    console.log(`[${q}]`, res.status, (await res.text()).slice(0, 400));
  };
  await go("g=code&code=repro-code-1");
  await go("g=refresh&rt=rt-repro-1");
  await go("g=jwt");
  await go("g=about&at=bogus");
  console.log("fake log:");
  for (const e of fake.requests()) {
    console.log(`  ${e.seq} ${e.provider} ${e.operation} -> ${e.status}`);
  }
  await mf.dispose();
  process.exit(0);
}

main().catch((e) => {
  console.error("repro failed:", e);
  process.exit(1);
});
