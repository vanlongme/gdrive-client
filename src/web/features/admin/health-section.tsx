import { useCallback, useEffect, useState } from "react";
import {
  getDiagnostics,
  getProviderHealth,
  type DiagnosticsView,
  type ProviderHealthView,
} from "../../lib/admin-api";
import { getHealth } from "../../lib/api";
import { messageKeyForError } from "../../lib/error-message";
import { useI18n } from "../../lib/i18n";

/**
 * Provider health (spec section 13/11.2): OAuth catalog/write connection
 * states and the SA read-pool states shown separately — an OAuth needs_reauth
 * must never read as "download down" and an SA problem never as "upload down".
 */

type LoadState<T> =
  | { status: "loading" }
  | { status: "error"; error: unknown }
  | { status: "ready"; value: T };

export function HealthSection() {
  const { t } = useI18n();
  const [health, setHealth] = useState<LoadState<ProviderHealthView>>({
    status: "loading",
  });
  const [apiOk, setApiOk] = useState<"loading" | "ok" | "error">("loading");
  const [diag, setDiag] = useState<LoadState<DiagnosticsView>>({
    status: "loading",
  });

  const load = useCallback(async () => {
    setHealth({ status: "loading" });
    setDiag({ status: "loading" });
    setApiOk("loading");
    try {
      const res = await getHealth();
      setApiOk(res.status === "ok" ? "ok" : "error");
    } catch {
      setApiOk("error");
    }
    try {
      const view = await getProviderHealth();
      setHealth({ status: "ready", value: view });
    } catch (error) {
      setHealth({ status: "error", error });
    }
    try {
      const value = await getDiagnostics();
      setDiag({ status: "ready", value });
    } catch (error) {
      setDiag({ status: "error", error });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section className="card admin-section" aria-label={t("admin.healthTitle")}>
      <h2>{t("admin.healthTitle")}</h2>
      <p role="status">
        {apiOk === "loading"
          ? t("common.loading")
          : apiOk === "ok"
            ? t("admin.healthOk")
            : t("admin.healthError")}
      </p>

      {health.status === "loading" ? (
        <p role="status">{t("common.loading")}</p>
      ) : health.status === "error" ? (
        <>
          <p className="alert alert-error" role="alert">
            {t(messageKeyForError(health.error).key)}
          </p>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => void load()}
          >
            {t("common.retry")}
          </button>
        </>
      ) : (
        <>
          <h3>{t("admin.providerOauth")}</h3>
          {health.value.oauthConnections.length === 0 ? (
            <p>{t("admin.connectionsEmpty")}</p>
          ) : (
            <ul className="health-list">
              {health.value.oauthConnections.map((conn) => (
                <li key={conn.connectionId}>
                  <span
                    className={`badge ${conn.enabled && conn.state === "connected" ? "badge-ok" : "badge-warn"}`}
                  >
                    {t(
                      conn.state === "connected"
                        ? "admin.stateConnected"
                        : conn.state === "degraded"
                          ? "admin.stateDegraded"
                          : conn.state === "needs_reauth"
                            ? "admin.stateNeedsReauth"
                            : "admin.stateDisabled",
                    )}
                  </span>{" "}
                  <span className="detail-mono">{conn.connectionId}</span>
                </li>
              ))}
            </ul>
          )}
          <h3>{t("admin.providerSa")}</h3>
          {health.value.serviceAccounts.length === 0 ? (
            <p>{t("admin.saEmpty")}</p>
          ) : (
            <ul className="health-list">
              {health.value.serviceAccounts.map((sa) => (
                <li key={sa.serviceAccountId}>
                  <span
                    className={`badge ${sa.enabled && !sa.coolingDown ? "badge-ok" : "badge-warn"}`}
                  >
                    {sa.coolingDown
                      ? t("admin.saCoolingDown")
                      : sa.enabled
                        ? t("admin.saEnabled")
                        : t("admin.stateDisabled")}
                  </span>{" "}
                  <span className="detail-mono">{sa.serviceAccountId}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      <DiagnosticsBlock diag={diag} onRetry={() => void load()} />
    </section>
  );
}

/** T14 diagnostics: counters/ids/enums only — never secrets or URIs. */
function DiagnosticsBlock({
  diag,
  onRetry,
}: {
  diag: LoadState<DiagnosticsView>;
  onRetry: () => void;
}) {
  const { t, locale } = useI18n();
  const fmt = (iso: string) =>
    new Date(iso).toLocaleString(locale === "vi" ? "vi-VN" : "en-US");

  if (diag.status === "loading") {
    return <p role="status">{t("common.loading")}</p>;
  }
  if (diag.status === "error") {
    return (
      <>
        <p className="alert alert-error" role="alert">
          {t(messageKeyForError(diag.error).key)}
        </p>
        <button type="button" className="btn btn-ghost" onClick={onRetry}>
          {t("common.retry")}
        </button>
      </>
    );
  }
  const d = diag.value;
  const uploadStates = Object.entries(d.uploads.byState);
  const readerStates = Object.entries(d.readers);
  const auditErrors = Object.entries(d.auditErrors24h);
  return (
    <div className="admin-ops-diag" aria-label={t("adminOps.diagTitle")}>
      <h3>{t("adminOps.diagTitle")}</h3>
      <p className="admin-ops-note">{t("adminOps.diagIntro")}</p>
      <p className="admin-ops-note">
        {t("adminOps.diagGenerated")}: {fmt(d.generatedAt)}
      </p>

      <h4>{t("adminOps.diagOAuthTitle")}</h4>
      {d.oauth.connections.length === 0 ? (
        <p>{t("adminOps.diagEmpty")}</p>
      ) : (
        <ul className="health-list">
          {d.oauth.connections.map((conn) => (
            <li key={conn.connectionId}>
              <span
                className={`badge ${conn.state === "connected" && conn.enabled ? "badge-ok" : "badge-warn"}`}
              >
                {conn.state}
              </span>{" "}
              <span className="detail-mono">{conn.connectionId}</span>{" "}
              <span className="admin-ops-note">
                {conn.coolingDown ? `${t("adminOps.diagCoolingDown")} · ` : ""}
                {t("adminOps.diagRecentFailures")}: {conn.recentFailures}
              </span>
            </li>
          ))}
        </ul>
      )}
      <p className="admin-ops-note">
        {d.oauth.totals.connections} {t("adminOps.diagConnections")} ·{" "}
        {d.oauth.totals.needsReauth} {t("adminOps.diagNeedsReauth")} ·{" "}
        {d.oauth.totals.disabled} {t("adminOps.diagDisabled")} ·{" "}
        {d.oauth.totals.coolingDown} {t("adminOps.diagCoolingDown")}
      </p>

      <h4>{t("adminOps.diagSaTitle")}</h4>
      {d.serviceAccounts.accounts.length === 0 ? (
        <p>{t("adminOps.diagEmpty")}</p>
      ) : (
        <ul className="health-list">
          {d.serviceAccounts.accounts.map((sa) => (
            <li key={sa.serviceAccountId}>
              <span
                className={`badge ${sa.enabled && !sa.coolingDown ? "badge-ok" : "badge-warn"}`}
              >
                {sa.coolingDown
                  ? t("adminOps.diagCoolingDown")
                  : sa.enabled
                    ? "enabled"
                    : t("adminOps.diagDisabled")}
              </span>{" "}
              <span className="detail-mono">{sa.serviceAccountId}</span>{" "}
              <span className="admin-ops-note">
                {t("adminOps.diagRecentFailures")}: {sa.recentFailures}
              </span>
            </li>
          ))}
        </ul>
      )}
      <p className="admin-ops-note">
        {d.serviceAccounts.totals.accounts} {t("adminOps.diagAccounts")} ·{" "}
        {d.serviceAccounts.totals.disabled} {t("adminOps.diagDisabled")} ·{" "}
        {d.serviceAccounts.totals.coolingDown}{" "}
        {t("adminOps.diagCoolingDown")}
      </p>

      <h4>{t("adminOps.diagUploadsTitle")}</h4>
      {uploadStates.length === 0 ? (
        <p>{t("adminOps.diagEmpty")}</p>
      ) : (
        <dl className="admin-ops-grid">
          {uploadStates.map(([state, n]) => (
            <div key={state} className="admin-ops-kv">
              <dt>{state}</dt>
              <dd>{n}</dd>
            </div>
          ))}
          <div className="admin-ops-kv">
            <dt>{t("adminOps.diagConfirmedBytes")}</dt>
            <dd>
              {d.uploads.confirmedBytes}
              {d.uploads.confirmedBytesTruncated
                ? ` (${t("adminOps.diagTruncated")})`
                : ""}
            </dd>
          </div>
          <div className="admin-ops-kv">
            <dt>{t("adminOps.diagBlockedReader")}</dt>
            <dd>{d.uploads.completedWithBlockedReader}</dd>
          </div>
        </dl>
      )}

      <h4>{t("adminOps.diagReadersTitle")}</h4>
      {readerStates.length === 0 ? (
        <p>{t("adminOps.diagEmpty")}</p>
      ) : (
        <dl className="admin-ops-grid">
          {readerStates.map(([state, n]) => (
            <div key={state} className="admin-ops-kv">
              <dt>{state}</dt>
              <dd>{n}</dd>
            </div>
          ))}
        </dl>
      )}

      <h4>{t("adminOps.diagAuditTitle")}</h4>
      {auditErrors.length === 0 ? (
        <p>{t("adminOps.diagNoErrors")}</p>
      ) : (
        <dl className="admin-ops-grid">
          {auditErrors.map(([op, n]) => (
            <div key={op} className="admin-ops-kv">
              <dt>{op}</dt>
              <dd>{n}</dd>
            </div>
          ))}
        </dl>
      )}

      <h4>{t("adminOps.diagCooldownsTitle")}</h4>
      {d.cooldowns.length === 0 ? (
        <p>{t("adminOps.diagNoCooldowns")}</p>
      ) : (
        <ul className="health-list">
          {d.cooldowns.map((cd, index) => (
            <li key={`${cd.credentialId}-${index}`}>
              <span className="badge badge-warn">{cd.reason}</span>{" "}
              <span className="detail-mono">{cd.credentialId}</span>{" "}
              <span className="admin-ops-note">
                {cd.scope}
                {cd.fileId !== undefined ? `/${cd.fileId}` : ""} ·{" "}
                {t("adminOps.diagRecentFailures")}: {cd.failures} ·{" "}
                {t("adminOps.diagRetryAfter")}:{" "}
                {Math.ceil(cd.retryAfterMs / 1000)}s
              </span>
            </li>
          ))}
        </ul>
      )}

      <h4>{t("adminOps.diagMaintenanceTitle")}</h4>
      <p>
        <span
          className={`badge ${d.maintenance.mode === "off" ? "badge-ok" : "badge-warn"}`}
        >
          {d.maintenance.mode}
        </span>{" "}
        <span className="admin-ops-note">
          {d.maintenance.phase} · {d.maintenance.processedCount} processed ·{" "}
          {d.maintenance.verifiedCount} verified
          {d.maintenance.toKeyLabel !== null
            ? ` → ${d.maintenance.toKeyLabel}`
            : ""}
        </span>
      </p>
    </div>
  );
}
