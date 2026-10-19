import { useState } from "react";
import type { FormEvent } from "react";
import { Navigate, useLocation, useNavigate } from "react-router";
import { ApiClientError } from "../../lib/api";
import { BrandBlock } from "../../components/brand";
import { useI18n } from "../../lib/i18n";
import { useSession } from "../../lib/session";
import { useSite, useDocumentTitle } from "../../lib/site";
import { useSetupStatus } from "../../lib/setup-status";

interface LocationState {
  setupComplete?: boolean;
  from?: string;
}

/** Email/password sign-in through Better Auth (spec section 9.3). */
export function LoginPage() {
  const { t } = useI18n();
  useDocumentTitle(t("auth.signInTitle"));
  const { state: setup } = useSetupStatus();
  const { state: session, signIn } = useSession();
  const { site } = useSite();
  const navigate = useNavigate();
  const location = useLocation();
  const locationState = (location.state ?? {}) as LocationState;

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  if (setup.status === "loading" || session.status === "loading") {
    return (
      <main className="splash" role="status">
        {t("common.loading")}
      </main>
    );
  }

  if (setup.status === "ready" && setup.view.setupState !== "complete") {
    return <Navigate to="/setup" replace />;
  }

  if (session.status === "signedIn") {
    return <Navigate to={locationState.from ?? "/explorer"} replace />;
  }

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFormError(null);
    setSubmitting(true);
    try {
      await signIn(email.trim(), password);
      navigate(locationState.from ?? "/explorer", { replace: true });
    } catch (error) {
      if (error instanceof ApiClientError) {
        if (error.status === 401 || error.status === 403) {
          setFormError(t("errors.signInFailed"));
        } else if (error.code === "RATE_LIMITED" || error.status === 429) {
          setFormError(
            t("errors.rateLimited", {
              seconds: error.retryAfterSeconds ?? 60,
            }),
          );
        } else if (error.code === "NETWORK_ERROR") {
          setFormError(t("errors.network"));
        } else {
          setFormError(error.message);
        }
      } else {
        setFormError(t("common.unknownError"));
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="auth-layout">
      <div className="auth-stack">
        <BrandBlock detail="tagline" className="auth-brand" />
        <div className="card auth-panel">
        <h1>{t("auth.signInTitle")}</h1>
        <p>{site.welcome !== "" ? site.welcome : t("auth.signInIntro")}</p>

        {locationState.setupComplete === true ? (
          <p className="alert alert-success">{t("auth.setupCompleteBanner")}</p>
        ) : null}
        {setup.status === "error" ? (
          <p className="alert alert-error">{t("shell.statusError")}</p>
        ) : null}
        {formError !== null ? (
          <p className="alert alert-error" role="alert">
            {formError}
          </p>
        ) : null}

        <form onSubmit={(event) => void onSubmit(event)}>
          <div className="field">
            <label htmlFor="login-email">{t("auth.email")}</label>
            <input
              id="login-email"
              name="email"
              className="input"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="login-password">{t("auth.password")}</label>
            <input
              id="login-password"
              name="password"
              className="input"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </div>
          <button type="submit" className="btn btn-primary" disabled={submitting}>
            {submitting ? t("auth.submitting") : t("auth.submit")}
          </button>
        </form>
        </div>
      </div>
    </main>
  );
}
