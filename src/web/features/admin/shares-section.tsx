import { useCallback, useEffect, useState } from "react";
import { listShares, revokeShare } from "../../lib/api";
import {
  listPublicLinks,
  revokePublicLink,
} from "../../lib/admin-api";
import type { PublicFolderLinkView } from "../../../shared/contracts/public-links";
import type { ShareView } from "../../../shared/contracts";
import { messageKeyForError } from "../../lib/error-message";
import { formatDateTime } from "../../lib/format";
import { useI18n } from "../../lib/i18n";
import { ConfirmAction } from "../../components/confirm-action";

/**
 * Share oversight (spec section 11.2 admin "quản lý quyền và chia sẻ"): the
 * segmented filter switches between token file shares (unchanged rows) and
 * wave-8 public folder links. Share tokens are never re-rendered — the
 * one-time token is only shown at creation in Explorer.
 */

type LoadState<T> =
  | { status: "loading" }
  | { status: "error"; error: unknown }
  | { status: "ready"; value: T };

type Filter = "all" | "public" | "files";

function scopeLabel(
  t: ReturnType<typeof useI18n>["t"],
  share: ShareView,
): string {
  switch (share.scope.kind) {
    case "mount":
      return `${t("admin.shareScopeMount")}: ${share.scope.mountId}`;
    case "file":
      return `${t("admin.shareScopeFile")}: ${share.scope.fileId}`;
    case "package":
      return `${t("admin.shareScopePackage")}: ${share.scope.packageId}`;
  }
}

export function SharesSection() {
  const { t, locale } = useI18n();
  const [filter, setFilter] = useState<Filter>("all");
  const [shares, setShares] = useState<LoadState<ShareView[]>>({
    status: "loading",
  });
  const [links, setLinks] = useState<LoadState<PublicFolderLinkView[]>>({
    status: "loading",
  });
  const [busyId, setBusyId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setShares({ status: "loading" });
    setLinks({ status: "loading" });
    try {
      const res = await listShares();
      setShares({
        status: "ready",
        value: res.shares.filter((share) => share.revokedAt === undefined),
      });
    } catch (error) {
      setShares({ status: "error", error });
    }
    try {
      const rows = await listPublicLinks();
      setLinks({
        status: "ready",
        value: rows.filter((link) => link.status !== "revoked"),
      });
    } catch (error) {
      setLinks({ status: "error", error });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const revoke = async (shareId: string) => {
    setBusyId(shareId);
    try {
      await revokeShare(shareId);
      await load();
    } catch (error) {
      setShares({ status: "error", error });
    } finally {
      setBusyId(null);
    }
  };

  const revokeLink = async (id: string) => {
    setBusyId(id);
    try {
      await revokePublicLink(id);
      await load();
    } catch (error) {
      setLinks({ status: "error", error });
    } finally {
      setBusyId(null);
    }
  };

  const copyLink = (link: PublicFolderLinkView) => {
    void navigator.clipboard
      ?.writeText(`${window.location.origin}${link.path}`)
      .then(() => {
        setCopiedId(link.id);
        window.setTimeout(() => setCopiedId(null), 2000);
      });
  };

  const statusBadge = (link: PublicFolderLinkView) => {
    const cls =
      link.status === "active"
        ? "badge badge-ok"
        : link.status === "expired"
          ? "badge badge-warn"
          : "badge badge-muted";
    const key =
      link.status === "active"
        ? "admin.plStatusActive"
        : link.status === "expired"
          ? "admin.plStatusExpired"
          : "admin.plStatusInvalidated";
    return <span className={cls}>{t(key)}</span>;
  };

  const showShares = filter !== "public";
  const showLinks = filter !== "files";

  return (
    <section className="card admin-section" aria-label={t("admin.sharesTitle")}>
      <h2>{t("admin.sharesTitle")}</h2>
      <p className="section-note">{t("admin.sharesIntro")}</p>

      <div className="toolbar-group" role="group" aria-label={t("admin.sharesFilterLabel")}>
        {(["all", "public", "files"] as const).map((option) => (
          <button
            key={option}
            type="button"
            className="btn btn-ghost btn-sm"
            aria-pressed={filter === option}
            onClick={() => setFilter(option)}
          >
            {t(
              option === "all"
                ? "admin.sharesFilterAll"
                : option === "public"
                  ? "admin.sharesFilterPublic"
                  : "admin.sharesFilterFiles",
            )}
          </button>
        ))}
      </div>

      {showLinks ? (
        <>
          <h3>{t("admin.publicLinksTitle")}</h3>
          {links.status === "loading" ? (
            <p role="status">{t("common.loading")}</p>
          ) : links.status === "error" ? (
            <>
              <p className="alert alert-error" role="alert">
                {t(messageKeyForError(links.error).key)}
              </p>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => void load()}
              >
                {t("common.retry")}
              </button>
            </>
          ) : links.value.length === 0 ? (
            <p>{t("admin.publicLinksEmpty")}</p>
          ) : (
            <div className="table-wrap">
              <table className="admin-table">
                <thead>
                  <tr>
                    <th scope="col">{t("admin.plColLink")}</th>
                    <th scope="col">{t("admin.plColFolder")}</th>
                    <th scope="col">{t("admin.plColOptions")}</th>
                    <th scope="col">{t("admin.plColCreator")}</th>
                    <th scope="col">{t("admin.plColExpiry")}</th>
                    <th scope="col">{t("admin.plColStats")}</th>
                    <th scope="col">
                      <span className="visually-hidden">
                        {t("explorer.colActions")}
                      </span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {links.value.map((link) => (
                    <tr key={link.id}>
                      <td className="detail-mono">
                        {link.path} {statusBadge(link)}
                      </td>
                      <td>
                        {link.folderName}
                        <br />
                        <span className="entry-meta">{link.mountLabel}</span>
                      </td>
                      <td>
                        {link.hasPassword
                          ? t("admin.plPasswordYes")
                          : t("admin.plPasswordNo")}
                        {" · "}
                        {link.allowZip ? "zip" : t("admin.plNoZip")}
                      </td>
                      <td>{link.createdByEmail ?? "—"}</td>
                      <td>
                        {link.expiresAt !== null
                          ? formatDateTime(link.expiresAt, locale)
                          : t("publicShare.noExpiry")}
                      </td>
                      <td className="entry-meta">
                        {link.viewCount} / {link.downloadCount}
                      </td>
                      <td className="entry-actions">
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          onClick={() => copyLink(link)}
                        >
                          {copiedId === link.id
                            ? t("explorer.copied")
                            : t("admin.plCopy")}
                        </button>
                        {link.status === "active" ? (
                          <ConfirmAction
                            label={t("admin.plDisable")}
                            confirmTitle={t("admin.plDisableTitle")}
                            confirmBody={t("admin.plDisableBody")}
                            confirmLabel={t("admin.plDisable")}
                            busy={busyId === link.id}
                            disabled={busyId !== null}
                            danger
                            onConfirm={() => void revokeLink(link.id)}
                          />
                        ) : (
                          <ConfirmAction
                            label={t("admin.plDelete")}
                            confirmTitle={t("admin.plDeleteTitle")}
                            confirmBody={t("admin.plDeleteBody")}
                            confirmLabel={t("admin.plDelete")}
                            busy={busyId === link.id}
                            disabled={busyId !== null}
                            danger
                            onConfirm={() => void revokeLink(link.id)}
                          />
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      ) : null}

      {showShares ? (
        <>
          <h3>{t("admin.fileSharesTitle")}</h3>
          {shares.status === "loading" ? (
            <p role="status">{t("common.loading")}</p>
          ) : shares.status === "error" ? (
            <>
              <p className="alert alert-error" role="alert">
                {t(messageKeyForError(shares.error).key)}
              </p>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => void load()}
              >
                {t("common.retry")}
              </button>
            </>
          ) : shares.value.length === 0 ? (
            <p>{t("admin.sharesEmpty")}</p>
          ) : (
            <div className="table-wrap">
              <table className="admin-table">
                <thead>
                  <tr>
                    <th scope="col">{t("admin.shareScope")}</th>
                    <th scope="col">{t("admin.shareExpiresCol")}</th>
                    <th scope="col">{t("admin.shareCreatedCol")}</th>
                    <th scope="col">
                      <span className="visually-hidden">
                        {t("explorer.colActions")}
                      </span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {shares.value.map((share) => (
                    <tr key={share.shareId}>
                      <td className="detail-mono">{scopeLabel(t, share)}</td>
                      <td>{formatDateTime(share.expiresAt, locale)}</td>
                      <td>{formatDateTime(share.createdAt, locale)}</td>
                      <td className="entry-actions">
                        <ConfirmAction
                          label={t("admin.shareRevoke")}
                          confirmTitle={t("admin.shareRevokeConfirmTitle")}
                          confirmBody={t("admin.shareRevokeConfirmBody")}
                          confirmLabel={t("admin.shareRevoke")}
                          busy={busyId === share.shareId}
                          disabled={busyId !== null}
                          danger
                          onConfirm={() => void revoke(share.shareId)}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      ) : null}
    </section>
  );
}
