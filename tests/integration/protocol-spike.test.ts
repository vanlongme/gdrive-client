import { describe, expect, it } from 'vitest';

import { createDriveTransport } from '../../src/worker/drive/transport';
import { createGoogleOAuthProvider } from '../../src/worker/drive/providers/google-oauth';
import { createServiceAccountReadProvider } from '../../src/worker/drive/providers/service-account-read';
import type {
  CoordinatorTokenSource,
  ReadIdentity,
  ResolvedWriter,
  TokenIdentity,
  TokenResult,
} from '../../src/worker/drive/types';

const encoder = new TextEncoder();

const SESSION_URI =
  'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=spike-1';

const WRITER: ResolvedWriter = {
  connectionId: 'conn-1',
  principalId: 'perm-9',
  oauthClientId: 'client-1',
  projectId: 'proj-1',
  connectionVersion: 1,
  oauthClientVersion: 1,
};

const READER: ReadIdentity = {
  serviceAccountId: 'sa-1',
  serviceAccountVersion: 1,
  email: 'sa-1@proj-1.iam.gserviceaccount.com',
  projectId: 'proj-1',
};

const OK_TOKEN: TokenResult = {
  ok: true,
  accessToken: 'tok-1',
  expiresAtMs: Date.now() + 3_600_000,
};

function alwaysOkTokenSource(): CoordinatorTokenSource {
  return {
    getToken: (_identity: TokenIdentity) => Promise.resolve(OK_TOKEN),
    reportFailure: () => Promise.resolve(),
  };
}

function waitUntil(flag: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const check = () => {
      if (flag()) return resolve();
      if (Date.now() > deadline) {
        return reject(new Error('condition never became true'));
      }
      setTimeout(check, 5);
    };
    check();
  });
}

describe('FixedLengthStream upload spike (workerd)', () => {
  it('starts the upstream fetch while the producer is still writing', async () => {
    let fetchStarted = false;
    let received = '';
    const fetchImpl: typeof fetch = async (_input, init) => {
      fetchStarted = true;
      received = await new Response(init?.body ?? null).text();
      return new Response(
        JSON.stringify({ id: 'gen-1', name: 'n', mimeType: 'm' }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );
    };
    const transport = createDriveTransport('google_oauth', { fetchImpl });

    let emitted = 0;
    const source = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (emitted === 0) {
          controller.enqueue(encoder.encode('aa'));
          emitted += 1;
          return;
        }
        // Gate: emit nothing further until the upstream fetch demonstrably
        // exists. If the transport piped first and fetched second, this
        // deadlocks — the gate itself is the concurrency assertion.
        await waitUntil(() => fetchStarted);
        if (emitted === 1) {
          controller.enqueue(encoder.encode('bbb'));
          emitted += 1;
          return;
        }
        controller.enqueue(encoder.encode('c'));
        controller.close();
      },
    });

    const result = await transport.send({
      operation: 'oauth.upload.chunk',
      token: 'tok',
      absoluteUrl: SESSION_URI,
      headers: { 'content-range': 'bytes 0-5/6' },
      body: { kind: 'stream', stream: source, bytes: 6 },
    });
    expect(result.status).toBe(200);
    expect(fetchStarted).toBe(true);
    expect(received).toBe('aabbbc');
  });

  it('cancels both sides when the caller aborts mid-pipe', async () => {
    let fetchStarted = false;
    let upstreamAborted = false;
    let sourceCancelled = false;
    const fetchImpl: typeof fetch = (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        fetchStarted = true;
        init?.signal?.addEventListener('abort', () => {
          upstreamAborted = true;
          reject(init.signal?.reason);
        });
      });
    const transport = createDriveTransport('google_oauth', { fetchImpl });

    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('abcdef'));
      },
      cancel() {
        sourceCancelled = true;
      },
    });

    const caller = new AbortController();
    const pending = transport.send({
      operation: 'oauth.upload.chunk',
      token: 'tok',
      absoluteUrl: SESSION_URI,
      body: { kind: 'stream', stream: source, bytes: 6 },
      signal: caller.signal,
    });
    await waitUntil(() => fetchStarted);
    caller.abort();
    await expect(pending).rejects.toMatchObject({ reason: 'aborted' });
    expect(upstreamAborted).toBe(true);
    expect(sourceCancelled).toBe(true);
  });

  it('stops the producer when upstream answers early with an error', async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          error: {
            code: 403,
            message: 'denied',
            errors: [{ reason: 'insufficientPermissions', message: 'denied' }],
          },
        }),
        { status: 403, headers: { 'content-type': 'application/json' } },
      );
    const transport = createDriveTransport('google_oauth', { fetchImpl });

    let sourceCancelled = false;
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(encoder.encode('x'));
      },
      cancel() {
        sourceCancelled = true;
      },
    });

    const pending = transport.send({
      operation: 'oauth.upload.chunk',
      token: 'tok',
      absoluteUrl: SESSION_URI,
      body: { kind: 'stream', stream: source, bytes: 6 },
    });
    await expect(pending).rejects.toMatchObject({
      reason: 'permission-denied',
      status: 403,
    });
    await waitUntil(() => sourceCancelled);
    expect(sourceCancelled).toBe(true);
  });

  it('fails the upload when the producer under-delivers vs the declared length', async () => {
    let bodyError = false;
    const fetchImpl: typeof fetch = async (_input, init) => {
      try {
        await new Response(init?.body ?? null).text();
      } catch {
        bodyError = true;
        throw new Error('body stream terminated early');
      }
      return new Response('{}', { status: 200 });
    };
    const transport = createDriveTransport('google_oauth', { fetchImpl });
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('abc'));
        controller.close(); // 3 of the declared 6 bytes
      },
    });
    await expect(
      transport.send({
        operation: 'oauth.upload.chunk',
        token: 'tok',
        absoluteUrl: SESSION_URI,
        body: { kind: 'stream', stream: source, bytes: 6 },
      }),
    ).rejects.toMatchObject({ reason: 'transport-error' });
    expect(bodyError).toBe(true);
  });

  it('aborts the pending fetch when the producer fails mid-pipe', async () => {
    // Real-fetch shape: upstream is consuming the request body while it
    // waits for the response — draining it lets the pipe advance so the
    // producer's failure surfaces and must abort the fetch side.
    let fetchStarted = false;
    let upstreamAborted = false;
    const fetchImpl: typeof fetch = (_input, init) => {
      fetchStarted = true;
      void new Response(init?.body ?? null)
        .text()
        .catch(() => undefined);
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          upstreamAborted = true;
          reject(init.signal?.reason);
        });
      });
    };
    const transport = createDriveTransport('google_oauth', { fetchImpl });

    let emitted = 0;
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        emitted += 1;
        if (emitted === 1) {
          controller.enqueue(encoder.encode('ab'));
          return;
        }
        controller.error(new Error('producer blew up'));
      },
    });

    const pending = transport.send({
      operation: 'oauth.upload.chunk',
      token: 'tok',
      absoluteUrl: SESSION_URI,
      body: { kind: 'stream', stream: source, bytes: 6 },
    });
    await expect(pending).rejects.toMatchObject({
      reason: 'transport-error',
    });
    expect(fetchStarted).toBe(true);
    expect(upstreamAborted).toBe(true);
  });

  it('terminates when upstream answers early while holding the body lock', async () => {
    // Real-fetch shape: the upstream takes a reader on the request body
    // (locks the stream), answers 308 immediately and never drains it. The
    // transport must still cancel the producer and resolve — a pending pump
    // must not hang the send.
    let bodyReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const fetchImpl: typeof fetch = async (_input, init) => {
      const body = init?.body as ReadableStream<Uint8Array>;
      bodyReader = body.getReader(); // lock it like real fetch does
      return new Response('{}', {
        status: 308,
        headers: { range: 'bytes=0-2' },
      });
    };
    const transport = createDriveTransport('google_oauth', { fetchImpl });

    let sourceCancelled = false;
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(encoder.encode('x'));
      },
      cancel() {
        sourceCancelled = true;
      },
    });

    const started = Date.now();
    const result = await transport.send({
      operation: 'oauth.upload.chunk',
      token: 'tok',
      absoluteUrl: SESSION_URI,
      headers: { 'content-range': 'bytes 0-5/6' },
      body: { kind: 'stream', stream: source, bytes: 6 },
    });
    expect(Date.now() - started).toBeLessThan(4000);
    expect(result.status).toBe(308);
    expect(result.headers.get('range')).toBe('bytes=0-2');
    await waitUntil(() => sourceCancelled);
    expect(bodyReader).toBeDefined();
    expect(sourceCancelled).toBe(true);
    // Fixture teardown: release the lock the way a torn-down request would.
    await bodyReader?.cancel().catch(() => undefined);
    bodyReader?.releaseLock();
  });

  it('runs the provider-level putChunk against an injected fetch', async () => {
    let received = '';
    const fetchImpl: typeof fetch = async (_input, init) => {
      received = await new Response(init?.body ?? null).text();
      return new Response(
        JSON.stringify({ id: 'gen-9', name: 'n', mimeType: 'm' }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };
    const provider = createGoogleOAuthProvider({
      tokenSource: alwaysOkTokenSource(),
      transport: createDriveTransport('google_oauth', { fetchImpl }),
    });
    const result = await provider.putChunk({
      writer: WRITER,
      sessionUri: SESSION_URI,
      offset: 0n,
      chunkBytes: 6,
      totalBytes: 6n,
      body: new ReadableStream<Uint8Array>({
        async pull(controller) {
          controller.enqueue(encoder.encode('abc'));
          await new Promise((r) => setTimeout(r, 5));
          controller.enqueue(encoder.encode('def'));
          controller.close();
        },
      }),
    });
    expect(result).toMatchObject({ kind: 'completed', file: { id: 'gen-9' } });
    expect(received).toBe('abcdef');
  });
});

describe('downstream cancellation propagates upstream', () => {
  it('caller abort after headers cancels the open content stream', async () => {
    let upstreamCancelled = false;
    const fetchImpl: typeof fetch = async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            controller.enqueue(encoder.encode('data'));
          },
          cancel() {
            upstreamCancelled = true;
          },
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/octet-stream' },
        },
      );
    const provider = createServiceAccountReadProvider({
      tokenSource: alwaysOkTokenSource(),
      transport: createDriveTransport('service_account', { fetchImpl }),
    });
    const caller = new AbortController();
    const content = await provider.openContent({
      identity: READER,
      ref: { id: 'file-1' },
      signal: caller.signal,
    });
    // The response has already been handed back; aborting the caller signal
    // must still reach the live upstream stream, not just init.signal.
    expect(content.status).toBe(200);
    caller.abort();
    await waitUntil(() => upstreamCancelled);
    expect(upstreamCancelled).toBe(true);
  });

  it('cancelling the content body aborts the upstream stream', async () => {
    let upstreamCancelled = false;
    const fetchImpl: typeof fetch = async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            controller.enqueue(encoder.encode('data'));
          },
          cancel() {
            upstreamCancelled = true;
          },
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/octet-stream' },
        },
      );
    const provider = createServiceAccountReadProvider({
      tokenSource: alwaysOkTokenSource(),
      transport: createDriveTransport('service_account', { fetchImpl }),
    });
    const content = await provider.openContent({
      identity: READER,
      ref: { id: 'file-1' },
    });
    await content.body.cancel();
    expect(upstreamCancelled).toBe(true);
  });
});
