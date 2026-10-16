import { useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";
import {
  importServiceAccount,
  listServiceAccounts,
  setServiceAccountEnabled,
  type ServiceAccountView,
} from "../../lib/admin-api";
import { messageKeyForError } from "../../lib/error-message";
import { formatDateTime } from "../../lib/format";
import { useI18n } from "../../lib/i18n";
import { ConfirmAction } from "../../components/confirm-action";

/**
 * Read-only service accounts (spec section 11.3 step 5): import key JSON into
 * the vault and manage enable/disable. The key field is masked where the
 * browser supports it, never echoed back and never persisted client-side.
 */

type LoadState<T> =
  | { status: "loading" }
  | { status: "error"; error: unknown }
  | { status: "ready"; value: T };

export function ServiceAccountsSection() {
  const { t, locale } = useI18n();
  const [accounts, setAccounts] = useState<LoadState<ServiceAccountView[]>>({
    status: "loading",
  });
  const [keyJson, setKeyJson] = useState("");
  const [submit, setSubmit] = useState<
    "idle" | "submitting" | { error: unknown } | "done"
  >("idle");
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setAccounts({ status: "loading" });
    try {
      const res = await listServiceAccounts();
      setAccounts({ status: "ready", value: res.serviceAccounts });
    } catch (error) {
      setAccounts({ status: "error", error });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    setSubmit("submitting");
    void importServiceAccount({ keyJson })
      .then(() => {
        setSubmit("done");
        setKeyJson("");
        void load();
      })
      .catch((error: unknown) => setSubmit({ error }));
  };

  const toggle = async (account: ServiceAccountView) => {
    setBusyId(account.id);
    try {
      await setServiceAccountEnabled(account.id, !account.enabled);
      await load();
    } finally {
      setBusyId(null);
    }
  };

  return (
    <section
      className="card admin-section"
      aria-label={t("admin.serviceAccountsTitle")}
    >
      <h2>{t("admin.serviceAccountsTitle")}</h2>
      <p className="section-note">{t("admin.saIntro")}</p>

      {accounts.status === "loading" ? (
        <p role="status">{t("common.loading")}</p>
      ) : accounts.status === "error" ? (
        <p className="alert alert-error" role="alert">
          {t(messageKeyForError(accounts.error).key)}
        </p>
      ) : accounts.value.length === 0 ? (
        <p>{t("admin.saEmpty")}</p>
      ) : (
        <div className="table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th scope="col">{t("admin.saEmail")}</th>
                <th scope="col">{t("admin.saProject")}</th>
                <th scope="col">{t("admin.saKeyId")}</th>
                <th scope="col">{t("admin.saCreated")}</th>
                <th scope="col">
                  <span className="visually-hidden">
                    {t("explorer.colActions")}
                  </span>
                </th>
              </tr>
            </thead>
            <tbody>
              {accounts.value.map((account) => (
                <tr key={account.id}>
                  <td className="detail-mono">{account.email}</td>
                  <td className="detail-mono">{account.projectId}</td>
                  <td className="detail-mono">{account.keyId}</td>
                  <td>{formatDateTime(account.createdAt, locale)}</td>
                  <td className="entry-actions">
                    <ConfirmAction
                      label={
                        account.enabled
                          ? t("admin.saDisable")
                          : t("admin.saEnable")
                      }
                      confirmTitle={
                        account.enabled
                          ? t("admin.saDisableConfirmTitle")
                          : t("admin.saEnableConfirmTitle")
                      }
                      confirmBody={
                        account.enabled
                          ? t("admin.saDisableConfirmBody")
                          : t("admin.saEnableConfirmBody")
                      }
                      confirmLabel={
                        account.enabled
                          ? t("admin.saDisable")
                          : t("admin.saEnable")
                      }
                      busy={busyId === account.id}
                      disabled={busyId !== null}
                      onConfirm={() => void toggle(account)}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <form className="admin-form" onSubmit={onSubmit}>
        <h3>{t("admin.saImportTitle")}</h3>
        <div className="field">
          <label htmlFor="sa-key-json">{t("admin.saKeyLabel")}</label>
          <textarea
            id="sa-key-json"
            className="input input-secret"
            rows={4}
            value={keyJson}
            onChange={(event) => setKeyJson(event.target.value)}
            autoComplete="off"
            spellCheck={false}
            required
          />
          <p className="hint">{t("admin.saKeyHint")}</p>
        </div>
        <button
          type="submit"
          className="btn btn-primary"
          disabled={submit === "submitting" || keyJson.trim() === ""}
        >
          {submit === "submitting" ? t("common.working") : t("admin.importSubmit")}
        </button>
        {submit === "done" ? (
          <p className="alert alert-success" role="status">
            {t("admin.importDone")}
          </p>
        ) : null}
        {typeof submit === "object" ? (
          <p className="alert alert-error" role="alert">
            {t(messageKeyForError(submit.error).key)}
          </p>
        ) : null}
      </form>
    </section>
  );
}
