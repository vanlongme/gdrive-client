import { useState } from "react";
import { createBrowserRouter, Navigate, Outlet, RouterProvider, useLocation } from "react-router";
import { AppShell } from "./components/app-shell";
import { NotFoundPage } from "./components/not-found";
import { AdminPage } from "./features/admin/admin-page";
import { LoginPage } from "./features/auth/login-page";
import { ExplorerPage } from "./features/explorer/explorer-page";
import { SetupPage } from "./features/setup/setup-page";
import { TransfersPage } from "./features/transfers/transfers-page";
import { LocaleProvider, useI18n } from "./lib/i18n";
import { SessionProvider, useSession } from "./lib/session";
import { SetupStatusProvider, useSetupStatus } from "./lib/setup-status";
import { ThemeProvider } from "./lib/theme";

/**
 * Routing for the wave-2 shell (spec section 11):
 * - "/" redirects by real state: setup wizard before completion, sign-in when
 *   unauthenticated, Explorer once signed in.
 * - /setup and /login sit outside the authenticated frame.
 * - The app shell owns navigation; feature areas render through its Outlet.
 */
function Splash() {
  const { t } = useI18n();
  return (
    <main className="splash" role="status">
      {t("common.loading")}
    </main>
  );
}

/** Retryable panel when the session endpoint cannot be read. */
function SessionErrorPanel() {
  const { t } = useI18n();
  const { refresh } = useSession();
  const [retrying, setRetrying] = useState(false);
  return (
    <main className="auth-layout">
      <div className="card auth-panel">
        <p className="alert alert-error" role="alert">
          {t("shell.sessionError")}
        </p>
        <button
          type="button"
          className="btn btn-ghost"
          disabled={retrying}
          onClick={() => {
            setRetrying(true);
            void refresh().finally(() => setRetrying(false));
          }}
        >
          {t("common.retry")}
        </button>
      </div>
    </main>
  );
}

function HomeRedirect() {
  const { state: setup } = useSetupStatus();
  const { state: session } = useSession();

  if (setup.status === "loading") return <Splash />;
  if (setup.status === "error") return <Navigate to="/login" replace />;
  if (setup.view.setupState !== "complete") return <Navigate to="/setup" replace />;
  if (session.status === "loading") return <Splash />;
  if (session.status === "unavailable") return <SessionErrorPanel />;
  return <Navigate to={session.status === "signedIn" ? "/explorer" : "/login"} replace />;
}

/** Route guard: protected areas need a completed setup AND a session. */
function RequireAuth() {
  const { state: setup } = useSetupStatus();
  const { state: session } = useSession();
  const location = useLocation();

  if (setup.status === "loading" || session.status === "loading") {
    return <Splash />;
  }
  if (setup.status === "ready" && setup.view.setupState !== "complete") {
    return <Navigate to="/setup" replace />;
  }
  if (session.status === "unavailable") return <SessionErrorPanel />;
  if (session.status !== "signedIn") {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }
  return <Outlet />;
}

const router = createBrowserRouter([
  { path: "/", element: <HomeRedirect /> },
  { path: "/setup", element: <SetupPage /> },
  { path: "/login", element: <LoginPage /> },
  {
    element: <RequireAuth />,
    children: [
      {
        element: <AppShell />,
        children: [
          { path: "/explorer", element: <ExplorerPage /> },
          { path: "/transfers", element: <TransfersPage /> },
          { path: "/admin", element: <AdminPage /> },
        ],
      },
    ],
  },
  { path: "*", element: <NotFoundPage /> },
]);

export function App() {
  return (
    <LocaleProvider>
      <ThemeProvider>
        <SetupStatusProvider>
          <SessionProvider>
            <RouterProvider router={router} />
          </SessionProvider>
        </SetupStatusProvider>
      </ThemeProvider>
    </LocaleProvider>
  );
}
