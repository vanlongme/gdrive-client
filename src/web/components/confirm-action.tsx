import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useI18n } from "../lib/i18n";

/**
 * Two-step inline confirmation for destructive admin actions (spec section
 * 11.2: revoke/diagnostic actions need explicit confirmation explaining real
 * impact). Arming the action expands a panel in place; the confirm button
 * receives focus so keyboard users can never trigger the action by accident.
 */
export function ConfirmAction({
  label,
  confirmTitle,
  confirmBody,
  confirmLabel,
  onConfirm,
  busy,
  disabled,
  danger,
}: {
  label: string;
  confirmTitle: string;
  confirmBody: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  busy?: boolean;
  disabled?: boolean;
  danger?: boolean;
}) {
  const { t } = useI18n();
  const [armed, setArmed] = useState(false);
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (armed) confirmRef.current?.focus();
  }, [armed]);

  if (!armed) {
    return (
      <button
        type="button"
        className={`btn btn-sm ${danger ? "btn-danger" : "btn-ghost"}`}
        disabled={disabled || busy}
        onClick={() => setArmed(true)}
      >
        {label}
      </button>
    );
  }

  return (
    <div className="confirm-panel" role="alertdialog" aria-label={confirmTitle}>
      <p className="confirm-title">{confirmTitle}</p>
      <div className="confirm-body">{confirmBody}</div>
      <div className="confirm-actions">
        <button
          type="button"
          ref={confirmRef}
          className={`btn btn-sm ${danger ? "btn-danger" : "btn-primary"}`}
          disabled={busy}
          onClick={() => {
            setArmed(false);
            onConfirm();
          }}
        >
          {busy ? t("common.working") : confirmLabel}
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          disabled={busy}
          onClick={() => setArmed(false)}
        >
          {t("common.cancel")}
        </button>
      </div>
    </div>
  );
}
