/**
 * Worker-side facade over the per-project ProjectCoordinator Durable Object
 * (architecture §5.4). Providers receive this as their credential/token
 * source; it carries only identity references — never secret material — and
 * resolves the DO stub by project id so one coordinator serves each Google
 * project.
 *
 * Implements the frozen wave-2 contract `CoordinatorTokenSource`
 * (getToken/reportFailure in ./tokens). The DO answers an internal JSON
 * protocol over fetch(); the origin is fixed and never leaves this Worker.
 */

import { tokenFail, type CoordinatorTokenSource, type TokenResult } from './tokens';

const DO_ORIGIN = 'https://project-coordinator.internal';

export type CoordinatorEnv = Pick<Env, 'PROJECT_COORDINATOR'>;

export interface CoordinatorHealth {
  readonly cooldowns: readonly {
    scope_key: string;
    failures: number;
    until_ms: number;
    reason: string;
    updated_ms: number;
  }[];
}

export interface ProjectCoordinatorClient extends CoordinatorTokenSource {
  /** Cooldown/health snapshot for the project (admin diagnostics). */
  health(projectId: string): Promise<CoordinatorHealth>;
}

export function createCoordinatorTokenSource(
  env: CoordinatorEnv,
): ProjectCoordinatorClient {
  const stub = (projectId: string) =>
    env.PROJECT_COORDINATOR.get(env.PROJECT_COORDINATOR.idFromName(projectId));

  return {
    async getToken(identity, options) {
      let res: Response;
      try {
        res = await stub(identity.projectId).fetch(`${DO_ORIGIN}/admit`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            identity,
            ...(options?.fileId === undefined ? {} : { fileId: options.fileId }),
          }),
        });
      } catch {
        return tokenFail('UPSTREAM_UNAVAILABLE', { detail: 'coordinator_unreachable' });
      }
      if (!res.ok) {
        return tokenFail('UPSTREAM_UNAVAILABLE', {
          detail: `coordinator_rejected_${res.status}`,
        });
      }
      let parsed: unknown;
      try {
        parsed = await res.json();
      } catch {
        return tokenFail('UPSTREAM_UNAVAILABLE', { detail: 'coordinator_bad_response' });
      }
      return parseTokenResult(parsed);
    },

    async reportFailure(identity, report) {
      try {
        await stub(identity.projectId).fetch(`${DO_ORIGIN}/report-failure`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ identity, report }),
        });
      } catch {
        // Failure reporting is best-effort; the next admission re-reads
        // identity state and existing cooldowns anyway.
      }
    },

    async health(projectId) {
      try {
        const res = await stub(projectId).fetch(`${DO_ORIGIN}/health`);
        if (!res.ok) return { cooldowns: [] };
        const parsed = (await res.json()) as CoordinatorHealth;
        return { cooldowns: parsed.cooldowns ?? [] };
      } catch {
        return { cooldowns: [] };
      }
    },
  };
}

function parseTokenResult(parsed: unknown): TokenResult {
  if (typeof parsed === 'object' && parsed !== null) {
    const candidate = parsed as Record<string, unknown>;
    if (
      candidate.ok === true &&
      typeof candidate.accessToken === 'string' &&
      typeof candidate.expiresAtMs === 'number'
    ) {
      return { ok: true, accessToken: candidate.accessToken, expiresAtMs: candidate.expiresAtMs };
    }
    if (candidate.ok === false && typeof candidate.code === 'string') {
      return {
        ok: false,
        code: candidate.code as Extract<TokenResult, { ok: false }>['code'],
        ...(typeof candidate.retryAfterMs === 'number'
          ? { retryAfterMs: candidate.retryAfterMs }
          : {}),
        ...(typeof candidate.detail === 'string' ? { detail: candidate.detail } : {}),
      };
    }
  }
  return tokenFail('UPSTREAM_UNAVAILABLE', { detail: 'coordinator_bad_response' });
}
