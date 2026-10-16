import { useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";
import {
  createAdminUser,
  listAdminUsers,
  setUserDisabled,
  type UserView,
} from "../../lib/admin-api";
import { messageKeyForError } from "../../lib/error-message";
import { formatDateTime } from "../../lib/format";
import { useI18n } from "../../lib/i18n";
import { useSession } from "../../lib/session";
import { ConfirmAction } from "../../components/confirm-action";

/**
 * Application users (spec section 11.2 admin): admin creates accounts —
 * public sign-up stays disabled — and disables/enables them. Mount-level
 * capabilities live in the grants panel, not in the app role.
 */

type LoadState<T> =
  | { status: "loading" }
  | { status: "error"; error: unknown }
  | { status: "ready"; value: T };

export function UsersSection() {
  const { t, locale } = useI18n();
  const { state: session } = useSession();
  const selfId = session.status === "signedIn" ? session.user.id : null;
  const [users, setUsers] = useState<LoadState<UserView[]>>({
    status: "loading",
  });
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setUsers({ status: "loading" });
    try {
      const res = await listAdminUsers();
      setUsers({ status: "ready", value: res.users });
    } catch (error) {
      setUsers({ status: "error", error });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const toggle = async (user: UserView) => {
    setBusyId(user.id);
    try {
      await setUserDisabled(user.id, !user.disabled);
      await load();
    } finally {
      setBusyId(null);
    }
  };

  return (
    <section className="card admin-section" aria-label={t("admin.usersTitle")}>
      <h2>{t("admin.usersTitle")}</h2>
      <p className="section-note">{t("admin.usersIntro")}</p>

      {users.status === "loading" ? (
        <p role="status">{t("common.loading")}</p>
      ) : users.status === "error" ? (
        <p className="alert alert-error" role="alert">
          {t(messageKeyForError(users.error).key)}
        </p>
      ) : users.value.length === 0 ? (
        <p>{t("admin.usersEmpty")}</p>
      ) : (
        <div className="table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th scope="col">{t("admin.userName")}</th>
                <th scope="col">{t("admin.userEmail")}</th>
                <th scope="col">{t("admin.userRole")}</th>
                <th scope="col">{t("admin.userCreated")}</th>
                <th scope="col">
                  <span className="visually-hidden">
                    {t("explorer.colActions")}
                  </span>
                </th>
              </tr>
            </thead>
            <tbody>
              {users.value.map((user) => (
                <tr key={user.id}>
                  <td>
                    {user.name}
                    {user.disabled ? (
                      <>
                        {" "}
                        <span className="badge">{t("admin.disabledBadge")}</span>
                      </>
                    ) : null}
                  </td>
                  <td className="detail-mono">{user.email}</td>
                  <td>
                    {t(user.role === "admin" ? "role.admin" : "role.user")}
                  </td>
                  <td>{formatDateTime(user.createdAt, locale)}</td>
                  <td className="entry-actions">
                    {user.id === selfId ? (
                      <span className="badge">{t("admin.selfBadge")}</span>
                    ) : (
                      <ConfirmAction
                        label={
                          user.disabled
                            ? t("admin.userEnable")
                            : t("admin.userDisable")
                        }
                        confirmTitle={
                          user.disabled
                            ? t("admin.userEnableConfirmTitle")
                            : t("admin.userDisableConfirmTitle")
                        }
                        confirmBody={
                          user.disabled
                            ? t("admin.userEnableConfirmBody")
                            : t("admin.userDisableConfirmBody")
                        }
                        confirmLabel={
                          user.disabled
                            ? t("admin.userEnable")
                            : t("admin.userDisable")
                        }
                        busy={busyId === user.id}
                        disabled={busyId !== null}
                        danger={!user.disabled}
                        onConfirm={() => void toggle(user)}
                      />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <UserCreateForm onCreated={() => void load()} />
    </section>
  );
}

function UserCreateForm({ onCreated }: { onCreated: () => void }) {
  const { t } = useI18n();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<"admin" | "user">("user");
  const [state, setState] = useState<
    "idle" | "submitting" | { error: unknown } | "done"
  >("idle");

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setState("submitting");
    void createAdminUser({
      name: name.trim(),
      email: email.trim(),
      password,
      role,
    })
      .then(() => {
        setState("done");
        setName("");
        setEmail("");
        setPassword("");
        setRole("user");
        onCreated();
      })
      .catch((error: unknown) => setState({ error }));
  };

  return (
    <form className="admin-form" onSubmit={submit}>
      <h3>{t("admin.userCreateTitle")}</h3>
      <div className="field">
        <label htmlFor="user-name">{t("admin.userName")}</label>
        <input
          id="user-name"
          className="input"
          value={name}
          onChange={(event) => setName(event.target.value)}
          required
        />
      </div>
      <div className="field">
        <label htmlFor="user-email">{t("admin.userEmail")}</label>
        <input
          id="user-email"
          className="input"
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          autoComplete="off"
          required
        />
      </div>
      <div className="field">
        <label htmlFor="user-password">{t("admin.userPassword")}</label>
        <input
          id="user-password"
          className="input"
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          autoComplete="new-password"
          minLength={8}
          required
        />
        <p className="hint">{t("setup.passwordHint")}</p>
      </div>
      <div className="field">
        <label htmlFor="user-role">{t("admin.userRole")}</label>
        <select
          id="user-role"
          className="input"
          value={role}
          onChange={(event) => setRole(event.target.value as "admin" | "user")}
        >
          <option value="user">{t("role.user")}</option>
          <option value="admin">{t("role.admin")}</option>
        </select>
      </div>
      <button
        type="submit"
        className="btn btn-primary"
        disabled={
          state === "submitting" ||
          name.trim() === "" ||
          email.trim() === "" ||
          password.length < 8
        }
      >
        {state === "submitting" ? t("common.working") : t("admin.userCreate")}
      </button>
      {state === "done" ? (
        <p className="alert alert-success" role="status">
          {t("admin.userCreatedDone")}
        </p>
      ) : null}
      {typeof state === "object" ? (
        <p className="alert alert-error" role="alert">
          {t(messageKeyForError(state.error).key)}
        </p>
      ) : null}
    </form>
  );
}
