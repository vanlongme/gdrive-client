import { useCallback, useEffect, useRef, useState } from "react";
import { NavLink, Outlet, useNavigate } from "react-router";
import { TransferDrawer } from "../features/transfers/transfer-drawer";
import { useTransferRestore } from "../features/transfers/use-transfers";
import { useI18n, LOCALES, type Locale } from "../lib/i18n";
import { useSession } from "../lib/session";
import { THEME_CHOICES, useTheme, type ThemeChoice } from "../lib/theme";

/**
 * Authenticated frame: a ~240px sidebar on desktop, a top bar with a
 * navigation drawer on mobile (spec section 11.1). Admin navigation is only
 * rendered for the admin role — enforcement still lives server-side.
 */

function Preferences() {
  const { t, locale, setLocale } = useI18n();
  const { choice, setChoice } = useTheme();
  return (
    <fieldset className="prefs" style={{ border: 0, margin: 0, padding: 0 }}>
      <legend className="visually-hidden">{t("prefs.title")}</legend>
      <div className="field">
        <label htmlFor="pref-theme">{t("prefs.theme")}</label>
        <select
          id="pref-theme"
          className="input"
          value={choice}
          onChange={(event) => setChoice(event.target.value as ThemeChoice)}
        >
          {THEME_CHOICES.map((option) => (
            <option key={option} value={option}>
              {t(
                option === "light"
                  ? "prefs.themeLight"
                  : option === "dark"
                    ? "prefs.themeDark"
                    : "prefs.themeSystem",
              )}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor="pref-locale">{t("prefs.language")}</label>
        <select
          id="pref-locale"
          className="input"
          value={locale}
          onChange={(event) => setLocale(event.target.value as Locale)}
        >
          {LOCALES.map((option) => (
            <option key={option} value={option}>
              {option === "vi" ? "Tiếng Việt" : "English"}
            </option>
          ))}
        </select>
      </div>
    </fieldset>
  );
}

function NavLinks({ onNavigate }: { onNavigate?: () => void }) {
  const { t } = useI18n();
  const { state } = useSession();
  const isAdmin = state.status === "signedIn" && state.user.role === "admin";

  return (
    <nav aria-label={t("a11y.mainNavigation")} className="nav-list">
      <NavLink to="/explorer" onClick={onNavigate}>
        {t("nav.explorer")}
      </NavLink>
      <NavLink to="/transfers" onClick={onNavigate}>
        {t("nav.transfers")}
      </NavLink>
      {isAdmin ? (
        <NavLink to="/admin" onClick={onNavigate}>
          {t("nav.admin")}
        </NavLink>
      ) : null}
    </nav>
  );
}

function UserCard() {
  const { t } = useI18n();
  const { state, signOut } = useSession();
  const navigate = useNavigate();
  const [signingOut, setSigningOut] = useState(false);
  const [signOutFailed, setSignOutFailed] = useState(false);

  if (state.status !== "signedIn") return null;
  const { user } = state;

  const onSignOut = async () => {
    setSigningOut(true);
    setSignOutFailed(false);
    try {
      await signOut();
      navigate("/login", { replace: true });
    } catch {
      // The cookie may still be valid; keep the session and offer a retry.
      setSignOutFailed(true);
    } finally {
      setSigningOut(false);
    }
  };

  return (
    <div className="user-card">
      <span className="user-name">{user.name}</span>
      <span className="user-email">{user.email}</span>
      <span className="badge">{t(user.role === "admin" ? "role.admin" : "role.user")}</span>
      {signOutFailed ? (
        <p className="field-error" role="alert">
          {t("nav.signOutFailed")}
        </p>
      ) : null}
      <button
        type="button"
        className="btn btn-ghost"
        onClick={() => void onSignOut()}
        disabled={signingOut}
      >
        {signingOut ? t("nav.signingOut") : t("nav.signOut")}
      </button>
    </div>
  );
}

function SidebarContents({ onNavigate }: { onNavigate?: () => void }) {
  const { t } = useI18n();
  return (
    <>
      <div className="brand">
        <span>{t("app.name")}</span>
      </div>
      <NavLinks onNavigate={onNavigate} />
      <div className="sidebar-footer">
        <Preferences />
        <UserCard />
      </div>
    </>
  );
}

export function AppShell() {
  const { t } = useI18n();
  const [drawerOpen, setDrawerOpen] = useState(false);
  // Reload recovery: read IndexedDB metadata once; items that lack a live
  // source drop into the needs-reselect state (T09).
  useTransferRestore();
  const drawerRef = useRef<HTMLDivElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);

  const closeDrawer = useCallback(() => {
    setDrawerOpen(false);
    menuButtonRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!drawerOpen) return;
    const drawer = drawerRef.current;
    drawer?.focus();
    const FOCUSABLE =
      'a[href], button:not([disabled]), select:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closeDrawer();
        return;
      }
      // Modal behavior: keep Tab navigation inside the drawer while open.
      if (event.key !== "Tab" || drawer === null || drawer === undefined) return;
      const items = Array.from(
        drawer.querySelectorAll<HTMLElement>(FOCUSABLE),
      );
      const first = items[0];
      const last = items[items.length - 1];
      if (first === undefined || last === undefined) return;
      const active = document.activeElement;
      if (!drawer.contains(active)) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [drawerOpen, closeDrawer]);

  return (
    <div className="shell">
      <a className="skip-link" href="#main-content">
        {t("a11y.skipToContent")}
      </a>

      <header className="topbar">
        <button
          type="button"
          ref={menuButtonRef}
          className="btn-icon"
          aria-expanded={drawerOpen}
          aria-controls="nav-drawer"
          aria-label={drawerOpen ? t("a11y.closeMenu") : t("a11y.openMenu")}
          onClick={() => (drawerOpen ? closeDrawer() : setDrawerOpen(true))}
        >
          ☰
        </button>
        <span className="brand">{t("app.name")}</span>
      </header>

      <aside className="shell-sidebar" aria-label={t("a11y.mainNavigation")}>
        <SidebarContents />
      </aside>

      {drawerOpen ? (
        <>
          <div
            className="drawer-backdrop"
            aria-hidden="true"
            onClick={closeDrawer}
          />
          <div
            id="nav-drawer"
            className="drawer"
            role="dialog"
            aria-modal="true"
            aria-label={t("a11y.mainNavigation")}
            tabIndex={-1}
            ref={drawerRef}
          >
            <button
              type="button"
              className="btn-icon"
              aria-label={t("a11y.closeMenu")}
              onClick={closeDrawer}
            >
              ✕
            </button>
            <SidebarContents onNavigate={closeDrawer} />
          </div>
        </>
      ) : null}

      <main className="shell-main" id="main-content" tabIndex={-1}>
        <Outlet />
      </main>

      <TransferDrawer />
    </div>
  );
}
