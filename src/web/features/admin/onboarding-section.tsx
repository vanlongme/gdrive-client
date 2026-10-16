import { useCallback, useEffect, useState } from "react";
import {
  listAdminMounts,
  listConnections,
  listOAuthClients,
  listServiceAccounts,
  OAUTH_CALLBACK_PATH,
  type ConnectionView,
  type MountAdminView,
  type OAuthClientView,
  type ServiceAccountView,
  type SharedDriveEntry,
} from "../../lib/admin-api";
import { messageKeyForError } from "../../lib/error-message";
import { useI18n } from "../../lib/i18n";
import { useSetupStatus } from "../../lib/setup-status";
import { SharedDriveChooser } from "./shared-drive-chooser";

/**
 * Post-deploy onboarding checklist (spec section 11.3; wave-5 T11). Every
 * step shows its REAL state read from the admin APIs — the canonical OAuth
 * callback to register in Google Cloud, the OAuth client import, the
 * operator connection with its principal/scopes, the SA import plus Viewer
 * membership instructions, and the Shared Drive chooser that fills the
 * existing mount form (catalog/write/read stay separate). Nothing here
 * mutates state on render and no secret material is ever displayed.
 */

type LoadState =
  | { status: "loading" }
  | { status: "error"; error: unknown }
  | {
      status: "ready";
      clients: OAuthClientView[];
      connections: ConnectionView[];
      accounts: ServiceAccountView[];
      mounts: MountAdminView[];
    };

export function OnboardingSection({
  onNavigate,
  onPickDrive,
}: {
  onNavigate: (section: "connections" | "serviceAccounts" | "mounts") => void;
  onPickDrive: (drive: SharedDriveEntry) => void;
}) {
  const { t } = useI18n();
  const { state: setup } = useSetupStatus();
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [chooserConnectionId, setChooserConnectionId] = useState("");
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    setState({ status: "loading" });
    try {
      const [clients, connections, accounts, mounts] = await Promise.all([
        listOAuthClients(),
        listConnections(),
        listServiceAccounts(),
        listAdminMounts(),
      ]);
      setState({
        status: "ready",
        clients: clients.clients,
        connections: connections.connections,
        accounts: accounts.serviceAccounts,
        mounts: mounts.mounts,
      });
    } catch (error) {
      setState({ status: "error", error });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const canonicalOrigin =
    setup.status === "ready" ? setup.view.canonicalOrigin : null;
  const callbackUrl =
    canonicalOrigin === null
      ? null
      : new URL(OAUTH_CALLBACK_PATH, canonicalOrigin).toString();

  const copyCallback = async () => {
    if (callbackUrl === null) return;
    try {
      await navigator.clipboard.writeText(callbackUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };

  if (state.status === "loading") {
    return (
      <section className="card admin-section" aria-label={t("admin.onboardingTitle")}>
        <h2>{t("admin.onboardingTitle")}</h2>
        <p role="status">{t("common.loading")}</p>
      </section>
    );
  }

  if (state.status === "error") {
    return (
      <section className="card admin-section" aria-label={t("admin.onboardingTitle")}>
        <h2>{t("admin.onboardingTitle")}</h2>
        <p className="alert alert-error" role="alert">
          {t(messageKeyForError(state.error).key)}
        </p>
        <button type="button" className="btn btn-ghost" onClick={() => void load()}>
          {t("common.retry")}
        </button>
      </section>
    );
  }

  const usable = state.connections.filter(
    (c) => c.enabled && c.state !== "disabled",
  );
  const connected = usable.filter((c) => c.state === "connected" || c.state === "degraded");
  const reauth = usable.filter((c) => c.state === "needs_reauth");

  const stepBadge = (done: boolean) => (
    <span className={`badge ${done ? "badge-ok" : "badge-pending"}`}>
      {done ? t("admin.onboardDone") : t("admin.onboardPending")}
    </span>
  );

  return (
    <section className="card admin-section" aria-label={t("admin.onboardingTitle")}>
      <h2>{t("admin.onboardingTitle")}</h2>
      <p className="section-note">{t("admin.onboardingIntro")}</p>

      <ol className="steps onboarding-steps">
        <li>
          <span className="step-index" aria-hidden="true">1</span>
          <span>
            <strong>{t("admin.onboardStepCallback")}</strong> {stepBadge(callbackUrl !== null)}
            <br />
            {t("admin.onboardCallbackBody")}
            <br />
            {callbackUrl === null ? (
              <span className="alert alert-info">{t("admin.onboardNoOrigin")}</span>
            ) : (
              <span className="callback-line">
                <code className="detail-mono">{callbackUrl}</code>{" "}
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => void copyCallback()}
                >
                  {copied ? t("explorer.copied") : t("explorer.copy")}
                </button>
              </span>
            )}
          </span>
        </li>

        <li>
          <span className="step-index" aria-hidden="true">2</span>
          <span>
            <strong>{t("admin.onboardStepClient")}</strong> {stepBadge(state.clients.length > 0)}
            <br />
            {state.clients.length > 0
              ? t("admin.onboardClientDone", { count: state.clients.length })
              : t("admin.onboardClientPending")}{" "}
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => onNavigate("connections")}
            >
              {t("admin.onboardGoConnections")}
            </button>
          </span>
        </li>

        <li>
          <span className="step-index" aria-hidden="true">3</span>
          <span>
            <strong>{t("admin.onboardStepConnect")}</strong> {stepBadge(connected.length > 0)}
            <br />
            {connected.length > 0
              ? connected
                  .map((c) =>
                    t("admin.onboardConnectDone", {
                      email: c.displayEmail ?? c.id,
                    }),
                  )
                  .join("; ")
              : t("admin.onboardConnectPending")}{" "}
            {reauth.length > 0 ? (
              <span className="badge badge-warn">{t("admin.onboardNeedsReauth")}</span>
            ) : null}{" "}
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => onNavigate("connections")}
            >
              {t("admin.onboardGoConnections")}
            </button>
          </span>
        </li>

        <li>
          <span className="step-index" aria-hidden="true">4</span>
          <span>
            <strong>{t("admin.onboardStepSa")}</strong> {stepBadge(state.accounts.length > 0)}
            <br />
            {t("admin.onboardSaBody")}
            <br />
            {state.accounts.length > 0
              ? t("admin.onboardSaDone", { count: state.accounts.length })
              : t("admin.onboardSaPending")}{" "}
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => onNavigate("serviceAccounts")}
            >
              {t("admin.onboardGoSa")}
            </button>
          </span>
        </li>

        <li>
          <span className="step-index" aria-hidden="true">5</span>
          <span>
            <strong>{t("admin.onboardStepDrive")}</strong> {stepBadge(state.mounts.length > 0)}
            <br />
            {t("admin.onboardDriveBody")}
            {state.mounts.length > 0 ? (
              <>
                <br />
                {t("admin.onboardMountsDone", { count: state.mounts.length })}
              </>
            ) : null}
          </span>
        </li>
      </ol>

      <div className="admin-subsection">
        <div className="field">
          <label htmlFor="onboard-drive-conn">{t("admin.chooseConnection")}</label>
          <select
            id="onboard-drive-conn"
            className="input"
            value={chooserConnectionId}
            onChange={(event) => setChooserConnectionId(event.target.value)}
          >
            <option value="">{t("admin.connPick")}</option>
            {usable.map((conn) => (
              <option key={conn.id} value={conn.id}>
                {conn.displayEmail ?? conn.id}
              </option>
            ))}
          </select>
        </div>
        <SharedDriveChooser
          connectionId={chooserConnectionId}
          onPick={onPickDrive}
        />
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => onNavigate("mounts")}
        >
          {t("admin.onboardGoMounts")}
        </button>
      </div>
    </section>
  );
}
