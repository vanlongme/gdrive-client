import { useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";
import {
  disconnectConnection,
  importOAuthClient,
  listConnections,
  listOAuthClients,
  revokeConnection,
  setOAuthClientEnabled,
  startOAuthFlow,
  type ConnectionView,
  type OAuthClientView,
} from "../../lib/admin-api";
import { messageKeyForError } from "../../lib/error-message";
import { formatDateTime } from "../../lib/format";
import { useI18n } from "../../lib/i18n";
import { ConfirmAction } from "../../components/confirm-action";

/**
 * Google OAuth clients and operator connections (spec sections 5.5, 11.3).
 * Connect/reconnect navigate the browser to Google's authorization URL; the
 * callback lands back on the API surface and the admin returns here. Client
 * secrets are entered into a masked field and are never rendered back.
 */

type LoadState<T> =
  | { status: "loading" }
  | { status: "error"; error: unknown }
  | { status: "ready"; value: T };

function SectionError({ error }: { error: unknown }) {
  const { t } = useI18n();
  const mapped = messageKeyForError(error);
  return (
    <p className="alert alert-error" role="alert">
      {t(mapped.key, { seconds: mapped.retryAfterSeconds ?? 0 })}
      {mapped.requestId !== undefined ? ` (${mapped.requestId})` : ""}
    </p>
  );
}

export function ConnectionsSection() {
  const { t, locale } = useI18n();
  const [clients, setClients] = useState<LoadState<OAuthClientView[]>>({
    status: "loading",
  });
  const [connections, setConnections] = useState<LoadState<ConnectionView[]>>({
    status: "loading",
  });
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setClients({ status: "loading" });
    setConnections({ status: "loading" });
    try {
      const res = await listOAuthClients();
      setClients({ status: "ready", value: res.clients });
    } catch (error) {
      setClients({ status: "error", error });
    }
    try {
      const res = await listConnections();
      setConnections({ status: "ready", value: res.connections });
    } catch (error) {
      setConnections({ status: "error", error });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const connect = async (oauthClientId: string) => {
    setActionBusy(`connect:${oauthClientId}`);
    try {
      const res = await startOAuthFlow({ purpose: "connect", oauthClientId });
      // Real navigation to Google; the callback returns to the API surface.
      window.location.assign(res.authorizationUrl);
    } catch (error) {
      setActionBusy(null);
      setConnections({ status: "error", error });
    }
  };

  const reconnect = async (connectionId: string) => {
    setActionBusy(`reconnect:${connectionId}`);
    try {
      const res = await startOAuthFlow({
        purpose: "reconnect",
        connectionId,
      });
      window.location.assign(res.authorizationUrl);
    } catch (error) {
      setActionBusy(null);
      setConnections({ status: "error", error });
    }
  };

  const disconnect = async (connectionId: string) => {
    setActionBusy(`disconnect:${connectionId}`);
    try {
      await disconnectConnection(connectionId);
      setNotice(t("admin.disconnectDone"));
      const res = await listConnections();
      setConnections({ status: "ready", value: res.connections });
    } catch (error) {
      setConnections({ status: "error", error });
    } finally {
      setActionBusy(null);
    }
  };

  const revoke = async (connectionId: string) => {
    setActionBusy(`revoke:${connectionId}`);
    try {
      const res = await revokeConnection(connectionId);
      setNotice(
        res.revokedUpstream
          ? t("admin.revokeDoneOk")
          : t("admin.revokeDonePartial"),
      );
      const list = await listConnections();
      setConnections({ status: "ready", value: list.connections });
    } catch (error) {
      setConnections({ status: "error", error });
    } finally {
      setActionBusy(null);
    }
  };

  return (
    <section className="card admin-section" aria-label={t("admin.connectionsTitle")}>
      <h2>{t("admin.connectionsTitle")}</h2>
      <p className="section-note">{t("admin.connectionsIntro")}</p>
      {notice !== null ? (
        <p className="alert alert-info" role="status">
          {notice}
        </p>
      ) : null}

      {connections.status === "loading" ? (
        <p role="status">{t("common.loading")}</p>
      ) : connections.status === "error" ? (
        <SectionError error={connections.error} />
      ) : connections.value.length === 0 ? (
        <p>{t("admin.connectionsEmpty")}</p>
      ) : (
        <div className="table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th scope="col">{t("admin.connEmail")}</th>
                <th scope="col">{t("admin.connState")}</th>
                <th scope="col">{t("admin.connScopes")}</th>
                <th scope="col">{t("admin.connConnected")}</th>
                <th scope="col">
                  <span className="visually-hidden">{t("explorer.colActions")}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {connections.value.map((conn) => (
                <tr key={conn.id}>
                  <td>{conn.displayEmail ?? t("admin.connNoEmail")}</td>
                  <td>
                    <span
                      className={`badge ${conn.state === "connected" ? "badge-ok" : conn.state === "disabled" ? "" : "badge-warn"}`}
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
                    </span>
                  </td>
                  <td>{conn.grantedScopes.length}</td>
                  <td>{formatDateTime(conn.createdAt, locale)}</td>
                  <td className="entry-actions">
                    {conn.enabled ? (
                      <>
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          disabled={actionBusy !== null}
                          onClick={() => void reconnect(conn.id)}
                        >
                          {t("admin.reconnect")}
                        </button>
                        <ConfirmAction
                          label={t("admin.disconnect")}
                          confirmTitle={t("admin.disconnectConfirmTitle")}
                          confirmBody={t("admin.disconnectConfirmBody")}
                          confirmLabel={t("admin.disconnect")}
                          busy={actionBusy === `disconnect:${conn.id}`}
                          disabled={actionBusy !== null}
                          onConfirm={() => void disconnect(conn.id)}
                        />
                        <ConfirmAction
                          label={t("admin.revoke")}
                          confirmTitle={t("admin.revokeConfirmTitle")}
                          confirmBody={t("admin.revokeConfirmBody")}
                          confirmLabel={t("admin.revoke")}
                          busy={actionBusy === `revoke:${conn.id}`}
                          disabled={actionBusy !== null}
                          danger
                          onConfirm={() => void revoke(conn.id)}
                        />
                      </>
                    ) : (
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        disabled={actionBusy !== null}
                        onClick={() => void reconnect(conn.id)}
                      >
                        {t("admin.reconnect")}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h3>{t("admin.connectStartTitle")}</h3>
      {clients.status === "loading" ? (
        <p role="status">{t("common.loading")}</p>
      ) : clients.status === "error" ? (
        <SectionError error={clients.error} />
      ) : clients.value.length === 0 ? (
        <p>{t("admin.clientsEmpty")}</p>
      ) : (
        <ul className="client-list">
          {clients.value.map((client) => (
            <li key={client.id} className="client-row">
              <span className="detail-mono">{client.clientId}</span>
              {!client.enabled ? (
                <span className="badge">{t("admin.stateDisabled")}</span>
              ) : null}
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={actionBusy !== null || !client.enabled}
                onClick={() => void connect(client.id)}
              >
                {t("admin.connectButton")}
              </button>
              <ConfirmAction
                label={
                  client.enabled ? t("admin.clientDisable") : t("admin.clientEnable")
                }
                confirmTitle={
                  client.enabled
                    ? t("admin.clientDisableConfirmTitle")
                    : t("admin.clientEnableConfirmTitle")
                }
                confirmBody={
                  client.enabled
                    ? t("admin.clientDisableConfirmBody")
                    : t("admin.clientEnableConfirmBody")
                }
                confirmLabel={
                  client.enabled ? t("admin.clientDisable") : t("admin.clientEnable")
                }
                busy={actionBusy === `client:${client.id}`}
                disabled={actionBusy !== null}
                danger={client.enabled}
                onConfirm={() => {
                  setActionBusy(`client:${client.id}`);
                  void setOAuthClientEnabled(client.id, !client.enabled)
                    .then(() => load())
                    .finally(() => setActionBusy(null));
                }}
              />
            </li>
          ))}
        </ul>
      )}

      <ClientImportForm onImported={() => void load()} />
    </section>
  );
}

function ClientImportForm({ onImported }: { onImported: () => void }) {
  const { t } = useI18n();
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [projectId, setProjectId] = useState("");
  const [state, setState] = useState<
    "idle" | "submitting" | { error: unknown } | "done"
  >("idle");

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setState("submitting");
    void importOAuthClient({
      clientId: clientId.trim(),
      clientSecret,
      ...(projectId.trim() !== "" ? { projectId: projectId.trim() } : {}),
    })
      .then(() => {
        setState("done");
        setClientId("");
        setClientSecret("");
        setProjectId("");
        onImported();
      })
      .catch((error: unknown) => setState({ error }));
  };

  return (
    <form className="admin-form" onSubmit={submit}>
      <h3>{t("admin.clientImportTitle")}</h3>
      <div className="field">
        <label htmlFor="oauth-client-id">{t("admin.clientIdLabel")}</label>
        <input
          id="oauth-client-id"
          className="input"
          value={clientId}
          onChange={(event) => setClientId(event.target.value)}
          autoComplete="off"
          required
        />
      </div>
      <div className="field">
        <label htmlFor="oauth-client-secret">
          {t("admin.clientSecretLabel")}
        </label>
        <input
          id="oauth-client-secret"
          className="input"
          type="password"
          value={clientSecret}
          onChange={(event) => setClientSecret(event.target.value)}
          autoComplete="off"
          required
        />
        <p className="hint">{t("admin.clientSecretHint")}</p>
      </div>
      <div className="field">
        <label htmlFor="oauth-project-id">{t("admin.projectIdLabel")}</label>
        <input
          id="oauth-project-id"
          className="input"
          value={projectId}
          onChange={(event) => setProjectId(event.target.value)}
          autoComplete="off"
        />
        <p className="hint">{t("admin.projectIdHint")}</p>
      </div>
      <button
        type="submit"
        className="btn btn-primary"
        disabled={state === "submitting" || clientId.trim() === "" || clientSecret === ""}
      >
        {state === "submitting" ? t("common.working") : t("admin.importSubmit")}
      </button>
      {state === "done" ? (
        <p className="alert alert-success" role="status">
          {t("admin.importDone")}
        </p>
      ) : null}
      {typeof state === "object" ? (
        <SectionError error={state.error} />
      ) : null}
    </form>
  );
}
