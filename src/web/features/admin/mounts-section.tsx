import { useCallback, useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import {
  createGrant,
  createMount,
  listAdminMounts,
  listAdminUsers,
  listConnections,
  listGrants,
  listServiceAccounts,
  revokeGrant,
  setReadPool,
  updateMount,
  type ConnectionView,
  type MountAdminView,
  type MountGrantView,
  type ServiceAccountView,
  type SharedDriveEntry,
  type UserView,
} from "../../lib/admin-api";
import { messageKeyForError } from "../../lib/error-message";
import { formatDateTime } from "../../lib/format";
import { useI18n } from "../../lib/i18n";
import { ConfirmAction } from "../../components/confirm-action";
import { SharedDriveChooser } from "./shared-drive-chooser";

/** A drive prefill pushed by the onboarding chooser into this form. */
export interface MountDrivePrefill {
  driveId: string;
  name: string;
}

/**
 * Mounts and per-mount grants (spec section 11.3 step 6): a mount maps one
 * Shared Drive to an OAuth catalog connection, an OAuth write connection and
 * a separate SA read pool. Grants give app users viewer/uploader roles on a
 * mount; they never expose connection or credential internals.
 */

type LoadState<T> =
  | { status: "loading" }
  | { status: "error"; error: unknown }
  | { status: "ready"; value: T };

export function MountsSection({
  prefill = null,
  onPrefillConsumed,
}: {
  prefill?: MountDrivePrefill | null;
  onPrefillConsumed?: () => void;
}) {
  const { t } = useI18n();
  const [mounts, setMounts] = useState<LoadState<MountAdminView[]>>({
    status: "loading",
  });
  const [connections, setConnections] = useState<ConnectionView[]>([]);
  const [accounts, setAccounts] = useState<ServiceAccountView[]>([]);
  const [selectedMountId, setSelectedMountId] = useState<string | null>(null);
  const [editingMountId, setEditingMountId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setMounts({ status: "loading" });
    try {
      const [mountRes, connRes, saRes] = await Promise.all([
        listAdminMounts(),
        listConnections(),
        listServiceAccounts(),
      ]);
      setMounts({ status: "ready", value: mountRes.mounts });
      setConnections(connRes.connections);
      setAccounts(saRes.serviceAccounts);
      setSelectedMountId((current) =>
        current !== null && mountRes.mounts.some((m) => m.id === current)
          ? current
          : (mountRes.mounts[0]?.id ?? null),
      );
    } catch (error) {
      setMounts({ status: "error", error });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const connLabel = useCallback(
    (id: string) => {
      const conn = connections.find((c) => c.id === id);
      return conn?.displayEmail ?? id;
    },
    [connections],
  );

  return (
    <section className="card admin-section" aria-label={t("admin.mountsTitle")}>
      <h2>{t("admin.mountsTitle")}</h2>
      <p className="section-note">{t("admin.mountsIntro")}</p>

      {mounts.status === "loading" ? (
        <p role="status">{t("common.loading")}</p>
      ) : mounts.status === "error" ? (
        <p className="alert alert-error" role="alert">
          {t(messageKeyForError(mounts.error).key)}
        </p>
      ) : (
        <>
          {mounts.value.length === 0 ? (
            <p>{t("admin.mountsEmpty")}</p>
          ) : (
            <div className="table-wrap">
              <table className="admin-table">
                <thead>
                  <tr>
                    <th scope="col">{t("admin.mountLabelField")}</th>
                    <th scope="col">{t("admin.mountDriveId")}</th>
                    <th scope="col">{t("admin.mountCatalog")}</th>
                    <th scope="col">{t("admin.mountWrite")}</th>
                    <th scope="col">{t("admin.mountReadPool")}</th>
                    <th scope="col">{t("admin.mountVisibility")}</th>
                    <th scope="col">
                      <span className="visually-hidden">
                        {t("explorer.colActions")}
                      </span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {mounts.value.map((mount) => (
                    <tr key={mount.id}>
                      <td>{mount.label}</td>
                      <td className="detail-mono">{mount.driveId}</td>
                      <td>{connLabel(mount.catalogConnectionId)}</td>
                      <td>{connLabel(mount.writeConnectionId)}</td>
                      <td>{mount.readPool.length}</td>
                      <td>
                        <span className="badge">
                          {mount.visibility === "public_read"
                            ? t("admin.visPublic")
                            : t("admin.visPrivate")}
                        </span>
                      </td>
                      <td className="entry-actions">
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          aria-expanded={editingMountId === mount.id}
                          onClick={() =>
                            setEditingMountId((current) =>
                              current === mount.id ? null : mount.id,
                            )
                          }
                        >
                          {t("admin.mountEdit")}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {editingMountId !== null
            ? (() => {
                const editing = mounts.value.find(
                  (m) => m.id === editingMountId,
                );
                return editing !== undefined ? (
                  <MountEditForm
                    mount={editing}
                    connections={connections}
                    accounts={accounts}
                    onSaved={() => {
                      setEditingMountId(null);
                      void load();
                    }}
                    onCancel={() => setEditingMountId(null)}
                  />
                ) : null;
              })()
            : null}

          <MountCreateForm
            connections={connections}
            accounts={accounts}
            prefill={prefill}
            onPrefillConsumed={onPrefillConsumed}
            onCreated={() => void load()}
          />

          {mounts.value.length > 0 ? (
            <GrantsPanel
              mounts={mounts.value}
              mountId={selectedMountId}
              onSelectMount={setSelectedMountId}
            />
          ) : null}
        </>
      )}
    </section>
  );
}

function MountCreateForm({
  connections,
  accounts,
  prefill = null,
  onPrefillConsumed,
  onCreated,
}: {
  connections: ConnectionView[];
  accounts: ServiceAccountView[];
  prefill?: MountDrivePrefill | null;
  onPrefillConsumed?: () => void;
  onCreated: () => void;
}) {
  const { t } = useI18n();
  const [label, setLabel] = useState("");
  const [driveId, setDriveId] = useState("");
  const [catalogId, setCatalogId] = useState("");
  const [writeId, setWriteId] = useState("");
  const [pool, setPool] = useState<ReadonlySet<string>>(new Set());
  const [visibility, setVisibility] = useState<"private" | "public_read">(
    "private",
  );
  const [browsing, setBrowsing] = useState(false);
  const [pickedName, setPickedName] = useState<string | null>(null);
  const [state, setState] = useState<
    "idle" | "submitting" | { error: unknown } | "done"
  >("idle");

  // A drive picked in the onboarding chooser lands here as a prefill — the
  // existing fields fill but the backend still validates on submit.
  useEffect(() => {
    if (prefill === null) return;
    setDriveId(prefill.driveId);
    setLabel((current) => (current.trim() === "" ? prefill.name : current));
    setPickedName(prefill.name);
    onPrefillConsumed?.();
  }, [prefill, onPrefillConsumed]);

  const pickDrive = (drive: SharedDriveEntry) => {
    setDriveId(drive.id);
    setLabel((current) => (current.trim() === "" ? drive.name : current));
    setPickedName(drive.name);
    setBrowsing(false);
  };

  const enabledConnections = connections.filter(
    (c) => c.enabled && c.state !== "disabled",
  );

  const togglePool = (id: string, checked: boolean) => {
    setPool((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setState("submitting");
    void createMount({
      label: label.trim(),
      driveId: driveId.trim(),
      catalogConnectionId: catalogId,
      writeConnectionId: writeId,
      serviceAccountIds: [...pool],
      visibility,
    })
      .then(() => {
        setState("done");
        setLabel("");
        setDriveId("");
        setCatalogId("");
        setWriteId("");
        setPool(new Set());
        onCreated();
      })
      .catch((error: unknown) => setState({ error }));
  };

  return (
    <form className="admin-form" onSubmit={submit}>
      <h3>{t("admin.mountCreateTitle")}</h3>
      <div className="field">
        <label htmlFor="mount-label">{t("admin.mountLabelField")}</label>
        <input
          id="mount-label"
          className="input"
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          required
        />
      </div>
      <div className="field">
        <label htmlFor="mount-drive">{t("admin.mountDriveId")}</label>
        <input
          id="mount-drive"
          className="input"
          value={driveId}
          onChange={(event) => setDriveId(event.target.value)}
          autoComplete="off"
          required
        />
        <p className="hint">{t("admin.mountDriveHint")}</p>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          aria-expanded={browsing}
          disabled={catalogId === ""}
          onClick={() => setBrowsing((current) => !current)}
        >
          {t("admin.browseDrives")}
        </button>
        {browsing ? (
          <SharedDriveChooser connectionId={catalogId} onPick={pickDrive} />
        ) : null}
        {pickedName !== null ? (
          <p className="alert alert-info" role="status">
            {t("admin.drivePicked", { name: pickedName })}
          </p>
        ) : null}
      </div>
      <div className="field">
        <label htmlFor="mount-catalog-conn">{t("admin.mountCatalog")}</label>
        <select
          id="mount-catalog-conn"
          className="input"
          value={catalogId}
          onChange={(event) => setCatalogId(event.target.value)}
          required
        >
          <option value="">{t("admin.connPick")}</option>
          {enabledConnections.map((conn) => (
            <option key={conn.id} value={conn.id}>
              {conn.displayEmail ?? conn.id}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor="mount-write-conn">{t("admin.mountWrite")}</label>
        <select
          id="mount-write-conn"
          className="input"
          value={writeId}
          onChange={(event) => setWriteId(event.target.value)}
          required
        >
          <option value="">{t("admin.connPick")}</option>
          {enabledConnections.map((conn) => (
            <option key={conn.id} value={conn.id}>
              {conn.displayEmail ?? conn.id}
            </option>
          ))}
        </select>
      </div>
      <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
        <legend className="field-legend">{t("admin.mountReadPool")}</legend>
        {accounts.length === 0 ? (
          <p className="hint">{t("admin.saEmpty")}</p>
        ) : (
          accounts.map((account) => (
            <label key={account.id} className="check-row">
              <input
                type="checkbox"
                checked={pool.has(account.id)}
                onChange={(event) =>
                  togglePool(account.id, event.target.checked)
                }
              />
              <span className="detail-mono">{account.email}</span>
            </label>
          ))
        )}
      </fieldset>
      <div className="field">
        <label htmlFor="mount-visibility">{t("admin.mountVisibility")}</label>
        <select
          id="mount-visibility"
          className="input"
          value={visibility}
          onChange={(event) =>
            setVisibility(event.target.value as "private" | "public_read")
          }
        >
          <option value="private">{t("admin.visPrivate")}</option>
          <option value="public_read">{t("admin.visPublic")}</option>
        </select>
      </div>
      <button
        type="submit"
        className="btn btn-primary"
        disabled={
          state === "submitting" ||
          label.trim() === "" ||
          driveId.trim() === "" ||
          catalogId === "" ||
          writeId === ""
        }
      >
        {state === "submitting" ? t("common.working") : t("admin.mountCreate")}
      </button>
      {state === "done" ? (
        <p className="alert alert-success" role="status">
          {t("admin.mountCreated")}
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

function GrantsPanel({
  mounts,
  mountId,
  onSelectMount,
}: {
  mounts: MountAdminView[];
  mountId: string | null;
  onSelectMount: (id: string) => void;
}) {
  const { t, locale } = useI18n();
  const [grants, setGrants] = useState<LoadState<MountGrantView[]>>({
    status: "loading",
  });
  const [users, setUsers] = useState<UserView[]>([]);
  const [userId, setUserId] = useState("");
  const [role, setRole] = useState<"viewer" | "uploader">("viewer");
  const [state, setState] = useState<
    "idle" | "submitting" | { error: unknown }
  >("idle");
  const [busyUser, setBusyUser] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (mountId === null) return;
    setGrants({ status: "loading" });
    try {
      const [grantRes, userRes] = await Promise.all([
        listGrants(mountId),
        listAdminUsers(),
      ]);
      setGrants({ status: "ready", value: grantRes.grants });
      setUsers(userRes.users);
    } catch (error) {
      setGrants({ status: "error", error });
    }
  }, [mountId]);

  useEffect(() => {
    void load();
  }, [load]);

  const userLabel = useMemo(() => {
    const map = new Map(users.map((u) => [u.id, `${u.name} <${u.email}>`]));
    return (id: string) => map.get(id) ?? id;
  }, [users]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (mountId === null || userId === "") return;
    setState("submitting");
    void createGrant(mountId, { userId, role })
      .then(() => {
        setState("idle");
        setUserId("");
        void load();
      })
      .catch((error: unknown) => setState({ error }));
  };

  const revoke = async (targetUserId: string) => {
    if (mountId === null) return;
    setBusyUser(targetUserId);
    try {
      await revokeGrant(mountId, targetUserId);
      await load();
    } finally {
      setBusyUser(null);
    }
  };

  return (
    <div className="admin-subsection">
      <h3>{t("admin.grantsTitle")}</h3>
      <div className="field">
        <label htmlFor="grant-mount">{t("admin.grantsFor")}</label>
        <select
          id="grant-mount"
          className="input"
          value={mountId ?? ""}
          onChange={(event) => onSelectMount(event.target.value)}
        >
          {mounts.map((mount) => (
            <option key={mount.id} value={mount.id}>
              {mount.label}
            </option>
          ))}
        </select>
      </div>

      {grants.status === "loading" ? (
        <p role="status">{t("common.loading")}</p>
      ) : grants.status === "error" ? (
        <p className="alert alert-error" role="alert">
          {t(messageKeyForError(grants.error).key)}
        </p>
      ) : grants.value.length === 0 ? (
        <p>{t("admin.grantsEmpty")}</p>
      ) : (
        <div className="table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th scope="col">{t("admin.grantUser")}</th>
                <th scope="col">{t("admin.grantRole")}</th>
                <th scope="col">{t("admin.grantGranted")}</th>
                <th scope="col">
                  <span className="visually-hidden">
                    {t("explorer.colActions")}
                  </span>
                </th>
              </tr>
            </thead>
            <tbody>
              {grants.value.map((grant) => (
                <tr key={grant.userId}>
                  <td>{userLabel(grant.userId)}</td>
                  <td>
                    <span className="badge">
                      {grant.role === "uploader"
                        ? t("admin.roleUploader")
                        : t("admin.roleViewer")}
                    </span>
                  </td>
                  <td>{formatDateTime(grant.createdAt, locale)}</td>
                  <td className="entry-actions">
                    <ConfirmAction
                      label={t("admin.grantRevoke")}
                      confirmTitle={t("admin.grantRevokeConfirmTitle")}
                      confirmBody={t("admin.grantRevokeConfirmBody")}
                      confirmLabel={t("admin.grantRevoke")}
                      busy={busyUser === grant.userId}
                      disabled={busyUser !== null}
                      danger
                      onConfirm={() => void revoke(grant.userId)}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <form className="admin-form" onSubmit={submit}>
        <h3>{t("admin.grantAddTitle")}</h3>
        <div className="field">
          <label htmlFor="grant-user">{t("admin.grantUser")}</label>
          <select
            id="grant-user"
            className="input"
            value={userId}
            onChange={(event) => setUserId(event.target.value)}
            required
          >
            <option value="">{t("admin.userPick")}</option>
            {users.map((user) => (
              <option key={user.id} value={user.id}>
                {user.name} &lt;{user.email}&gt;
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="grant-role">{t("admin.grantRole")}</label>
          <select
            id="grant-role"
            className="input"
            value={role}
            onChange={(event) =>
              setRole(event.target.value as "viewer" | "uploader")
            }
          >
            <option value="viewer">{t("admin.roleViewer")}</option>
            <option value="uploader">{t("admin.roleUploader")}</option>
          </select>
        </div>
        <button
          type="submit"
          className="btn btn-primary"
          disabled={state === "submitting" || userId === ""}
        >
          {state === "submitting" ? t("common.working") : t("admin.grantAdd")}
        </button>
        {typeof state === "object" ? (
          <p className="alert alert-error" role="alert">
            {t(messageKeyForError(state.error).key)}
          </p>
        ) : null}
      </form>
    </div>
  );
}

function MountEditForm({
  mount,
  connections,
  accounts,
  onSaved,
  onCancel,
}: {
  mount: MountAdminView;
  connections: ConnectionView[];
  accounts: ServiceAccountView[];
  onSaved: () => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const [label, setLabel] = useState(mount.label);
  const [visibility, setVisibility] = useState(mount.visibility);
  const [catalogId, setCatalogId] = useState(mount.catalogConnectionId);
  const [writeId, setWriteId] = useState(mount.writeConnectionId);
  const [pool, setPool] = useState<ReadonlySet<string>>(
    () => new Set(mount.readPool.map((sa) => sa.id)),
  );
  const [meta, setMeta] = useState<
    "idle" | "saving" | { error: unknown }
  >("idle");
  const [poolState, setPoolState] = useState<
    "idle" | "saving" | { error: unknown }
  >("idle");

  const enabledConnections = connections.filter(
    (c) => c.enabled && c.state !== "disabled",
  );
  const enabledPool = accounts.filter((a) => a.enabled || pool.has(a.id));

  const saveMeta = (event: FormEvent) => {
    event.preventDefault();
    const body: Record<string, unknown> = {};
    if (label.trim() !== mount.label) body.label = label.trim();
    if (visibility !== mount.visibility) body.visibility = visibility;
    if (catalogId !== mount.catalogConnectionId)
      body.catalogConnectionId = catalogId;
    if (writeId !== mount.writeConnectionId)
      body.writeConnectionId = writeId;
    if (Object.keys(body).length === 0) {
      onSaved();
      return;
    }
    setMeta("saving");
    void updateMount(mount.id, body)
      .then(onSaved)
      .catch((error: unknown) => setMeta({ error }));
  };

  const savePool = () => {
    setPoolState("saving");
    void setReadPool(mount.id, {
      entries: [...pool].map((serviceAccountId) => ({ serviceAccountId })),
    })
      .then(onSaved)
      .catch((error: unknown) => setPoolState({ error }));
  };

  return (
    <div className="admin-subsection">
      <h3>{t("admin.mountEditTitle", { label: mount.label })}</h3>
      <form className="admin-form" onSubmit={saveMeta}>
        <div className="field">
          <label htmlFor="edit-mount-label">
            {t("admin.mountLabelField")}
          </label>
          <input
            id="edit-mount-label"
            className="input"
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            required
          />
        </div>
        <div className="field">
          <label htmlFor="edit-mount-catalog">{t("admin.mountCatalog")}</label>
          <select
            id="edit-mount-catalog"
            className="input"
            value={catalogId}
            onChange={(event) => setCatalogId(event.target.value)}
            required
          >
            {enabledConnections.map((conn) => (
              <option key={conn.id} value={conn.id}>
                {conn.displayEmail ?? conn.id}
              </option>
            ))}
            {!enabledConnections.some((c) => c.id === catalogId) ? (
              <option value={catalogId}>{catalogId}</option>
            ) : null}
          </select>
        </div>
        <div className="field">
          <label htmlFor="edit-mount-write">{t("admin.mountWrite")}</label>
          <select
            id="edit-mount-write"
            className="input"
            value={writeId}
            onChange={(event) => setWriteId(event.target.value)}
            required
          >
            {enabledConnections.map((conn) => (
              <option key={conn.id} value={conn.id}>
                {conn.displayEmail ?? conn.id}
              </option>
            ))}
            {!enabledConnections.some((c) => c.id === writeId) ? (
              <option value={writeId}>{writeId}</option>
            ) : null}
          </select>
        </div>
        <div className="field">
          <label htmlFor="edit-mount-visibility">
            {t("admin.mountVisibility")}
          </label>
          <select
            id="edit-mount-visibility"
            className="input"
            value={visibility}
            onChange={(event) =>
              setVisibility(event.target.value as "private" | "public_read")
            }
          >
            <option value="private">{t("admin.visPrivate")}</option>
            <option value="public_read">{t("admin.visPublic")}</option>
          </select>
          <p className="hint">{t("admin.mountEditPolicyHint")}</p>
        </div>
        <div className="entry-actions">
          <button
            type="submit"
            className="btn btn-primary btn-sm"
            disabled={meta === "saving" || label.trim() === ""}
          >
            {meta === "saving" ? t("common.working") : t("admin.mountSave")}
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={onCancel}
          >
            {t("common.cancel")}
          </button>
        </div>
        {typeof meta === "object" ? (
          <p className="alert alert-error" role="alert">
            {t(messageKeyForError(meta.error).key)}
          </p>
        ) : null}
      </form>

      <div className="admin-form">
        <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="field-legend">{t("admin.mountReadPool")}</legend>
          {enabledPool.length === 0 ? (
            <p className="hint">{t("admin.saEmpty")}</p>
          ) : (
            enabledPool.map((account) => (
              <label key={account.id} className="check-row">
                <input
                  type="checkbox"
                  checked={pool.has(account.id)}
                  onChange={(event) =>
                    setPool((prev) => {
                      const next = new Set(prev);
                      if (event.target.checked) next.add(account.id);
                      else next.delete(account.id);
                      return next;
                    })
                  }
                />
                <span className="detail-mono">{account.email}</span>
              </label>
            ))
          )}
        </fieldset>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          disabled={poolState === "saving"}
          onClick={savePool}
        >
          {poolState === "saving"
            ? t("common.working")
            : t("admin.mountSavePool")}
        </button>
        {typeof poolState === "object" ? (
          <p className="alert alert-error" role="alert">
            {t(messageKeyForError(poolState.error).key)}
          </p>
        ) : null}
      </div>
    </div>
  );
}
