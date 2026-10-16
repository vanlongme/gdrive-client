import { useCallback, useEffect, useState } from "react";
import { listShares, revokeShare } from "../../lib/api";
import type { ShareView } from "../../../shared/contracts";
import { messageKeyForError } from "../../lib/error-message";
import { formatDateTime } from "../../lib/format";
import { useI18n } from "../../lib/i18n";
import { ConfirmAction } from "../../components/confirm-action";

/**
 * Share oversight (spec section 11.2 admin "quản lý quyền và chia sẻ"): lists
 * active scoped shares and revokes them. Share tokens are never re-rendered —
 * the one-time token is only shown at creation in Explorer.
 */

type LoadState<T> =
  | { status: "loading" }
  | { status: "error"; error: unknown }
  | { status: "ready"; value: T };

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
  const [shares, setShares] = useState<LoadState<ShareView[]>>({
    status: "loading",
  });
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setShares({ status: "loading" });
    try {
      const res = await listShares();
      setShares({
        status: "ready",
        value: res.shares.filter((share) => share.revokedAt === undefined),
      });
    } catch (error) {
      setShares({ status: "error", error });
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

  return (
    <section className="card admin-section" aria-label={t("admin.sharesTitle")}>
      <h2>{t("admin.sharesTitle")}</h2>
      <p className="section-note">{t("admin.sharesIntro")}</p>

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
    </section>
  );
}
