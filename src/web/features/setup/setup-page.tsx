import { useState } from "react";
import type { FormEvent } from "react";
import { Link, useNavigate } from "react-router";
import { ApiClientError, submitSetup } from "../../lib/api";
import { BrandBlock } from "../../components/brand";
import { useI18n } from "../../lib/i18n";
import { useSetupStatus } from "../../lib/setup-status";
import { useDocumentTitle } from "../../lib/site";

/**
 * Step 1 of the onboarding flow (spec section 11.3): claim the installation
 * with SETUP_TOKEN and create the first admin. Later steps are listed
 * truthfully as pending — their backend routes land in later waves.
 */
export function SetupPage() {
  const { t, messages } = useI18n();
  useDocumentTitle(t("setup.title"));
  const { state, refresh } = useSetupStatus();
  const navigate = useNavigate();

  const [token, setToken] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [canonicalOrigin, setCanonicalOrigin] = useState(
    () => window.location.origin,
  );
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [invalidFields, setInvalidFields] = useState<ReadonlySet<string>>(
    new Set(),
  );

  if (state.status === "loading") {
    return (
      <main className="splash" role="status">
        {t("shell.checkingStatus")}
      </main>
    );
  }

  if (state.status === "error") {
    return (
      <main className="auth-layout">
        <div className="auth-stack">
          <BrandBlock detail="tagline" className="auth-brand" />
          <div className="card auth-panel">
          <h1>{t("app.name")}</h1>
          <p role="alert" className="alert alert-error">
            {t("shell.statusError")}
          </p>
          <button type="button" className="btn btn-ghost" onClick={() => void refresh()}>
            {t("common.retry")}
          </button>
          </div>
        </div>
      </main>
    );
  }

  if (state.view.setupState === "complete") {
    return (
      <main className="auth-layout">
        <div className="auth-stack">
          <BrandBlock detail="tagline" className="auth-brand" />
          <div className="card auth-panel">
          <h1>{t("setup.title")}</h1>
          <p className="alert alert-info">{t("setup.alreadyComplete")}</p>
          <Link className="btn btn-primary" to="/login">
            {t("setup.goToSignIn")}
          </Link>
          </div>
        </div>
      </main>
    );
  }

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFormError(null);

    const invalid = new Set<string>();
    if (token.trim() === "") invalid.add("token");
    if (name.trim() === "") invalid.add("name");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) invalid.add("email");
    if (password.length < 8) invalid.add("password");
    if (password !== confirmPassword) invalid.add("confirmPassword");
    try {
      new URL(canonicalOrigin.trim());
    } catch {
      invalid.add("canonicalOrigin");
    }
    setInvalidFields(invalid);
    if (invalid.size > 0) {
      setFormError(t("errors.validation"));
      return;
    }

    setSubmitting(true);
    try {
      await submitSetup({
        token: token.trim(),
        name: name.trim(),
        email: email.trim(),
        password,
        canonicalOrigin: canonicalOrigin.trim(),
      });
      // Refresh before navigating so the login page's setup gate observes the
      // completed state instead of bouncing back to /setup on the stale view.
      await refresh();
      navigate("/login", {
        replace: true,
        state: { setupComplete: true },
      });
    } catch (error) {
      if (error instanceof ApiClientError) {
        if (error.code === "SETUP_TOKEN_INVALID") {
          setFormError(t("errors.setupTokenInvalid"));
          setInvalidFields(new Set(["token"]));
        } else if (error.code === "SETUP_ALREADY_COMPLETED") {
          setFormError(t("errors.setupCompleted"));
          void refresh();
        } else if (error.code === "RATE_LIMITED" || error.status === 429) {
          setFormError(
            t("errors.rateLimited", {
              seconds: error.retryAfterSeconds ?? 60,
            }),
          );
        } else if (error.code === "VALIDATION_FAILED") {
          setFormError(t("errors.validation"));
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

  const hintId = (id: string) => `${id}-hint`;

  return (
    <main className="auth-layout">
      <div className="auth-stack">
        <BrandBlock detail="tagline" className="auth-brand" />
        <div className="card auth-panel">
          <h1>{t("setup.title")}</h1>
          <p>{t("setup.intro")}</p>

          {state.view.setupState === "in_progress" ? (
            <p className="alert alert-info">{t("setup.inProgressNote")}</p>
          ) : null}
          {formError !== null ? (
            <p className="alert alert-error" role="alert">
              {formError}
            </p>
          ) : null}

          <form onSubmit={(event) => void onSubmit(event)} noValidate>
            <div className="field">
              <label htmlFor="setup-token">{t("setup.token")}</label>
              <input
                id="setup-token"
                name="token"
                className="input"
                type="password"
                autoComplete="off"
                required
                aria-invalid={invalidFields.has("token")}
                aria-describedby={hintId("setup-token")}
                value={token}
                onChange={(event) => setToken(event.target.value)}
              />
              <p className="hint" id="setup-token-hint">
                {t("setup.tokenHint")}
              </p>
            </div>

            <div className="field">
              <label htmlFor="setup-name">{t("setup.adminName")}</label>
              <input
                id="setup-name"
                name="name"
                className="input"
                type="text"
                autoComplete="name"
                required
                aria-invalid={invalidFields.has("name")}
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </div>

            <div className="field">
              <label htmlFor="setup-email">{t("setup.email")}</label>
              <input
                id="setup-email"
                name="email"
                className="input"
                type="email"
                autoComplete="email"
                required
                aria-invalid={invalidFields.has("email")}
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </div>

            <div className="field">
              <label htmlFor="setup-password">{t("setup.password")}</label>
              <input
                id="setup-password"
                name="password"
                className="input"
                type="password"
                autoComplete="new-password"
                required
                minLength={8}
                aria-invalid={invalidFields.has("password")}
                aria-describedby={hintId("setup-password")}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
              <p className="hint" id="setup-password-hint">
                {t("setup.passwordHint")}
              </p>
            </div>

            <div className="field">
              <label htmlFor="setup-confirm">{t("setup.confirmPassword")}</label>
              <input
                id="setup-confirm"
                name="confirmPassword"
                className="input"
                type="password"
                autoComplete="new-password"
                required
                aria-invalid={invalidFields.has("confirmPassword")}
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
              />
            </div>

            <div className="field">
              <label htmlFor="setup-origin">{t("setup.canonicalOrigin")}</label>
              <input
                id="setup-origin"
                name="canonicalOrigin"
                className="input"
                type="url"
                required
                aria-invalid={invalidFields.has("canonicalOrigin")}
                aria-describedby={hintId("setup-origin")}
                value={canonicalOrigin}
                onChange={(event) => setCanonicalOrigin(event.target.value)}
              />
              <p className="hint" id="setup-origin-hint">
                {t("setup.canonicalOriginHint")}
              </p>
            </div>

            <button type="submit" className="btn btn-primary" disabled={submitting}>
              {submitting ? t("setup.submitting") : t("setup.submit")}
            </button>
          </form>
        </div>

        <section className="card">
          <h2 style={{ marginTop: 0, fontSize: "1rem" }}>{t("setup.stepsTitle")}</h2>
          <ol className="steps">
            {messages.setup.steps.map((step, index) => (
              <li key={step} aria-current={index === 0 ? "step" : undefined}>
                <span className="step-index" aria-hidden="true">
                  {index + 1}
                </span>
                <span>{step}</span>
                <span className="badge badge-pending">
                  {index === 0 ? t("setup.stepCurrent") : t("setup.stepPending")}
                </span>
              </li>
            ))}
          </ol>
        </section>
      </div>
    </main>
  );
}
