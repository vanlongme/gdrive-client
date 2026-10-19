import { useEffect, useRef, useState } from "react";
import type { PublicFolderLinkView } from "../../../shared/contracts/public-links";
import {
  createPublicLink,
  revokePublicLink,
  updatePublicLink,
} from "../../lib/admin-api";
import { messageKeyForError } from "../../lib/error-message";
import { formatDateTime } from "../../lib/format";
import { useI18n } from "../../lib/i18n";
import { ConfirmAction } from "../../components/confirm-action";

/**
 * Public folder share dialog (wave-8 C3): creates, edits or revokes the one
 * active public link per folder. The dialog is a native <dialog> styled by
 * .dialog; the link URL is shown once created via .inline-copy. Expiry
 * presets mirror the design; "không hết hạn" stays visible — when a
 * shareMaxLifetimeSeconds cap exists the server applies it and the dialog
 * shows the resulting expiry honestly.
 */

type ExpiryChoice = "1" | "7" | "30" | "90" | "never";

function expiryToIso(choice: ExpiryChoice): string | null {
  if (choice === "never") return null;
  const days = Number(choice);
  return new Date(Date.now() + days * 86_400_000).toISOString();
}

function expiryChoiceOf(link: PublicFolderLinkView | null): ExpiryChoice {
  if (link === null || link.expiresAt === null) return "never";
  const days = Math.round((Date.parse(link.expiresAt) - Date.now()) / 86_400_000);
  if (days <= 2) return "1";
  if (days <= 10) return "7";
  if (days <= 45) return "30";
  return "90";
}

export function SharePublicDialog({
  mountId,
  folder,
  link,
  onClose,
  onChanged,
}: {
  mountId: string;
  folder: { id: string; name: string };
  /** The folder's current link, or null when it has none. */
  link: PublicFolderLinkView | null;
  onClose: () => void;
  onChanged: (link: PublicFolderLinkView | null) => void;
}) {
  const { t, locale } = useI18n();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [current, setCurrent] = useState<PublicFolderLinkView | null>(link);
  const [requirePassword, setRequirePassword] = useState(
    link?.hasPassword ?? false,
  );
  const [password, setPassword] = useState("");
  const [expiry, setExpiry] = useState<ExpiryChoice>(() => expiryChoiceOf(link));
  const [allowZip, setAllowZip] = useState(link?.allowZip ?? false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog !== null && !dialog.open) dialog.showModal();
  }, []);

  const absoluteUrl =
    current === null
      ? null
      : `${window.location.origin}${current.path}`;

  const copyLink = () => {
    if (absoluteUrl === null) return;
    void navigator.clipboard?.writeText(absoluteUrl).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    });
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    const expiresAt = expiryToIso(expiry);
    if (requirePassword && current === null && password.length < 4) {
      setError(new RangeError("password-too-short"));
      return;
    }
    setBusy(true);
    try {
      if (current === null) {
        const res = await createPublicLink({
          mountId,
          folderId: folder.id,
          password: requirePassword ? password : null,
          expiresAt,
          allowZip,
        });
        setCurrent(res.link);
        onChanged(res.link);
      } else {
        const body: {
          password?: string | null;
          expiresAt?: string | null;
          allowZip?: boolean;
        } = { expiresAt, allowZip };
        if (!requirePassword && current.hasPassword) body.password = null;
        else if (requirePassword && password !== "") body.password = password;
        const res = await updatePublicLink(current.id, body);
        setCurrent(res.link);
        onChanged(res.link);
      }
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const revoke = async () => {
    if (current === null) return;
    setBusy(true);
    setError(null);
    try {
      await revokePublicLink(current.id);
      setCurrent(null);
      onChanged(null);
      dialogRef.current?.close();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <dialog
      ref={dialogRef}
      className="dialog"
      onClose={onClose}
      aria-label={t("publicShare.title")}
    >
      <h2>{t("publicShare.title")}</h2>
      <p className="dialog-intro">
        {t("publicShare.intro", { name: folder.name })}
      </p>

      {error !== null ? (
        <p className="alert alert-error" role="alert">
          {error instanceof RangeError && error.message === "password-too-short"
            ? t("publicShare.passwordTooShort")
            : t(messageKeyForError(error).key)}
        </p>
      ) : null}

      {current !== null ? (
        <div className="field">
          <label htmlFor="public-link-url">{t("publicShare.linkLabel")}</label>
          <div className="inline-copy">
            <input
              id="public-link-url"
              className="input"
              readOnly
              value={absoluteUrl ?? ""}
              onFocus={(event) => event.target.select()}
            />
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={copyLink}
            >
              {copied ? t("explorer.copied") : t("publicShare.copyLink")}
            </button>
          </div>
          <p className="hint">
            {current.expiresAt !== null
              ? t("publicShare.expiresAt", {
                  date: formatDateTime(current.expiresAt, locale),
                })
              : t("publicShare.noExpiry")}
          </p>
        </div>
      ) : null}

      <form onSubmit={(event) => void submit(event)}>
        <label className="check-field">
          <input
            type="checkbox"
            checked={requirePassword}
            onChange={(event) => setRequirePassword(event.target.checked)}
          />
          <span>
            {t("publicShare.passwordToggle")}
            <span className="hint">{t("publicShare.passwordHint")}</span>
          </span>
        </label>

        {requirePassword ? (
          <div className="field">
            <label htmlFor="public-link-password">
              {t("publicShare.passwordLabel")}
            </label>
            <input
              id="public-link-password"
              className="input"
              type="password"
              autoComplete="new-password"
              minLength={4}
              maxLength={128}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
            {current !== null && current.hasPassword ? (
              <p className="hint">{t("publicShare.passwordKeepHint")}</p>
            ) : null}
          </div>
        ) : null}

        <div className="field">
          <label htmlFor="public-link-expiry">
            {t("publicShare.expiryLabel")}
          </label>
          <select
            id="public-link-expiry"
            className="input"
            value={expiry}
            onChange={(event) => setExpiry(event.target.value as ExpiryChoice)}
          >
            <option value="1">{t("publicShare.expiry1d")}</option>
            <option value="7">{t("publicShare.expiry7d")}</option>
            <option value="30">{t("publicShare.expiry30d")}</option>
            <option value="90">{t("publicShare.expiry90d")}</option>
            <option value="never">{t("publicShare.expiryNever")}</option>
          </select>
        </div>

        <label className="check-field">
          <input
            type="checkbox"
            checked={allowZip}
            onChange={(event) => setAllowZip(event.target.checked)}
          />
          <span>
            {t("publicShare.zipToggle")}
            <span className="hint">{t("publicShare.zipHint")}</span>
          </span>
        </label>

        <div className="dialog-actions">
          {current !== null ? (
            <ConfirmAction
              label={t("publicShare.revoke")}
              confirmTitle={t("publicShare.revokeTitle")}
              confirmBody={t("publicShare.revokeBody")}
              confirmLabel={t("publicShare.revoke")}
              busy={busy}
              danger
              onConfirm={() => void revoke()}
            />
          ) : null}
          <span className="spacer" />
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => dialogRef.current?.close()}
          >
            {t("publicShare.close")}
          </button>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={busy || (requirePassword && current === null && password.length < 4)}
          >
            {busy
              ? current === null
                ? t("publicShare.creating")
                : t("publicShare.saving")
              : current === null
                ? t("publicShare.create")
                : t("publicShare.save")}
          </button>
        </div>
      </form>
    </dialog>
  );
}
