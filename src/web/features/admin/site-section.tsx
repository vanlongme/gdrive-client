import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import type {
  SiteBrandingView,
  SiteLocale,
} from "../../../shared/contracts/site";
import {
  deleteSiteLogo,
  updateSiteBranding,
  uploadSiteLogo,
} from "../../lib/admin-api";
import { getSite } from "../../lib/api";
import { messageKeyForError } from "../../lib/error-message";
import { useI18n } from "../../lib/i18n";
import { useSite } from "../../lib/site";
import { BrandMark } from "../../components/brand";

/**
 * "Thông tin trang" admin tab (wave-8 C2): the operator-facing identity —
 * title, tagline, welcome line, support email, default language and logo.
 * The form saves disabled until dirty; "reset to defaults" writes the same
 * defaults the server answers pre-setup. The logo is always referenced by
 * URL (<img>), never inlined.
 */

const LOGO_MAX_BYTES = 512 * 1024;
const LOGO_TYPES = new Set(["image/png", "image/webp", "image/svg+xml"]);

type LoadState =
  | { status: "loading" }
  | { status: "error"; error: unknown }
  | { status: "ready"; site: SiteBrandingView };

interface FormState {
  title: string;
  tagline: string;
  welcome: string;
  supportEmail: string;
  defaultLocale: SiteLocale;
}

function formOf(site: SiteBrandingView): FormState {
  return {
    title: site.title,
    tagline: site.tagline,
    welcome: site.welcome,
    supportEmail: site.supportEmail ?? "",
    defaultLocale: site.defaultLocale,
  };
}

const DEFAULTS: FormState = {
  title: "Drive Worker",
  tagline: "",
  welcome: "",
  supportEmail: "",
  defaultLocale: "vi",
};

export function SiteSection() {
  const { t } = useI18n();
  const { refresh: refreshSite } = useSite();
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [form, setForm] = useState<FormState>(DEFAULTS);
  const [baseline, setBaseline] = useState<FormState>(DEFAULTS);
  const [logoUrl, setLogoUrl] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [logoBusy, setLogoBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [formError, setFormError] = useState<unknown>(null);
  const [logoError, setLogoError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setState({ status: "loading" });
    try {
      const site = await getSite();
      setState({ status: "ready", site });
      setForm(formOf(site));
      setBaseline(formOf(site));
      setLogoUrl(site.logoUrl);
    } catch (error) {
      setState({ status: "error", error });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const dirty =
    form.title !== baseline.title ||
    form.tagline !== baseline.tagline ||
    form.welcome !== baseline.welcome ||
    form.supportEmail !== baseline.supportEmail ||
    form.defaultLocale !== baseline.defaultLocale;

  const valid =
    form.title.trim().length >= 1 &&
    form.title.length <= 40 &&
    form.tagline.length <= 80 &&
    form.welcome.length <= 160 &&
    (form.supportEmail.trim() === "" ||
      /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.supportEmail.trim()));

  const afterSave = (site: SiteBrandingView) => {
    setState({ status: "ready", site });
    setBaseline(formOf(site));
    setLogoUrl(site.logoUrl);
    setNotice(t("admin.siteSaved"));
    void refreshSite();
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!dirty || !valid) return;
    setSaving(true);
    setFormError(null);
    setNotice(null);
    try {
      const site = await updateSiteBranding({
        title: form.title.trim(),
        tagline: form.tagline,
        welcome: form.welcome,
        supportEmail:
          form.supportEmail.trim() === "" ? null : form.supportEmail.trim(),
        defaultLocale: form.defaultLocale,
      });
      afterSave(site);
    } catch (error) {
      setFormError(error);
    } finally {
      setSaving(false);
    }
  };

  const reset = () => {
    setForm(DEFAULTS);
    setNotice(null);
    setFormError(null);
  };

  const pickLogo = async (file: File | null) => {
    if (file === null) return;
    setLogoError(null);
    setNotice(null);
    if (!LOGO_TYPES.has(file.type)) {
      setLogoError(t("admin.siteLogoInvalidType"));
      return;
    }
    if (file.size > LOGO_MAX_BYTES) {
      setLogoError(t("admin.siteLogoTooLarge"));
      return;
    }
    setLogoBusy(true);
    try {
      const site = await uploadSiteLogo(file);
      afterSave(site);
    } catch (error) {
      setLogoError(t(messageKeyForError(error).key));
    } finally {
      setLogoBusy(false);
    }
  };

  const removeLogo = async () => {
    setLogoBusy(true);
    setLogoError(null);
    try {
      const site = await deleteSiteLogo();
      afterSave(site);
    } catch (error) {
      setLogoError(t(messageKeyForError(error).key));
    } finally {
      setLogoBusy(false);
    }
  };

  if (state.status === "loading") {
    return (
      <section className="card admin-section" aria-label={t("admin.siteTitle")}>
        <h2>{t("admin.siteTitle")}</h2>
        <p role="status">{t("common.loading")}</p>
      </section>
    );
  }
  if (state.status === "error") {
    return (
      <section className="card admin-section" aria-label={t("admin.siteTitle")}>
        <h2>{t("admin.siteTitle")}</h2>
        <p className="alert alert-error" role="alert">
          {t(messageKeyForError(state.error).key)}
        </p>
        <button type="button" className="btn btn-ghost" onClick={() => void load()}>
          {t("common.retry")}
        </button>
      </section>
    );
  }

  return (
    <section className="card admin-section" aria-label={t("admin.siteTitle")}>
      <h2>{t("admin.siteTitle")}</h2>
      <p className="section-note">{t("admin.siteIntro")}</p>

      {notice !== null ? (
        <p className="alert alert-success" role="status">
          {notice}
        </p>
      ) : null}
      {formError !== null ? (
        <p className="alert alert-error" role="alert">
          {t(messageKeyForError(formError).key)}
        </p>
      ) : null}

      <div className="site-grid">
        <form className="admin-form" onSubmit={(event) => void submit(event)}>
          <div className="field">
            <label htmlFor="site-logo-input">{t("admin.siteLogoLabel")}</label>
            <div className="site-logo-row">
              <span className="site-logo-preview" aria-hidden="true">
                {logoUrl !== null ? (
                  <img className="site-logo-img" src={logoUrl} alt="" />
                ) : (
                  <BrandMark className="brand-mark" />
                )}
              </span>
              <input
                ref={fileRef}
                id="site-logo-input"
                type="file"
                accept="image/png,image/webp,image/svg+xml"
                className="visually-hidden"
                data-testid="site-logo-input"
                onChange={(event) => {
                  void pickLogo(event.target.files?.[0] ?? null);
                  event.target.value = "";
                }}
              />
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={logoBusy}
                onClick={() => fileRef.current?.click()}
              >
                {logoBusy ? t("common.working") : t("admin.siteLogoUpload")}
              </button>
              {logoUrl !== null ? (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  disabled={logoBusy}
                  onClick={() => void removeLogo()}
                >
                  {t("admin.siteLogoRemove")}
                </button>
              ) : null}
            </div>
            <p className="hint">{t("admin.siteLogoHint")}</p>
            {logoError !== null ? (
              <p className="field-error" role="alert">
                {logoError}
              </p>
            ) : null}
          </div>

          <div className="field">
            <label htmlFor="site-title">{t("admin.siteTitleLabel")}</label>
            <input
              id="site-title"
              className="input"
              type="text"
              required
              maxLength={40}
              value={form.title}
              onChange={(event) =>
                setForm((prev) => ({ ...prev, title: event.target.value }))
              }
            />
            <p className="hint">
              {t("admin.siteCharCount", {
                count: form.title.length,
                max: 40,
              })}
            </p>
          </div>

          <div className="field">
            <label htmlFor="site-tagline">{t("admin.siteTaglineLabel")}</label>
            <input
              id="site-tagline"
              className="input"
              type="text"
              maxLength={80}
              value={form.tagline}
              onChange={(event) =>
                setForm((prev) => ({ ...prev, tagline: event.target.value }))
              }
            />
          </div>

          <div className="field">
            <label htmlFor="site-welcome">{t("admin.siteWelcomeLabel")}</label>
            <textarea
              id="site-welcome"
              className="input"
              rows={3}
              maxLength={160}
              value={form.welcome}
              onChange={(event) =>
                setForm((prev) => ({ ...prev, welcome: event.target.value }))
              }
            />
            <p className="hint">
              {t("admin.siteCharCount", {
                count: form.welcome.length,
                max: 160,
              })}
            </p>
          </div>

          <div className="field">
            <label htmlFor="site-support-email">
              {t("admin.siteSupportEmailLabel")}
            </label>
            <input
              id="site-support-email"
              className="input"
              type="email"
              value={form.supportEmail}
              aria-invalid={
                form.supportEmail.trim() !== "" &&
                !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.supportEmail.trim())
              }
              onChange={(event) =>
                setForm((prev) => ({
                  ...prev,
                  supportEmail: event.target.value,
                }))
              }
            />
            <p className="hint">{t("admin.siteSupportEmailHint")}</p>
          </div>

          <div className="field">
            <label htmlFor="site-locale">{t("admin.siteLocaleLabel")}</label>
            <select
              id="site-locale"
              className="input"
              value={form.defaultLocale}
              onChange={(event) =>
                setForm((prev) => ({
                  ...prev,
                  defaultLocale: event.target.value as SiteLocale,
                }))
              }
            >
              <option value="vi">Tiếng Việt</option>
              <option value="en">English</option>
            </select>
            <p className="hint">{t("admin.siteLocaleHint")}</p>
          </div>

          <div className="dialog-actions">
            <button
              type="submit"
              className="btn btn-primary"
              disabled={!dirty || !valid || saving}
            >
              {saving ? t("admin.siteSaving") : t("admin.siteSave")}
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              disabled={saving}
              onClick={reset}
            >
              {t("admin.siteReset")}
            </button>
          </div>
        </form>

        <aside className="site-preview" aria-label={t("admin.sitePreview")}>
          <h3>{t("admin.sitePreview")}</h3>
          <div className="card site-preview-card">
            <div className="brand">
              <span className="brand-title">
                {logoUrl !== null ? (
                  <img className="brand-mark" src={logoUrl} alt="" />
                ) : (
                  <BrandMark className="brand-mark" />
                )}
                {form.title || DEFAULTS.title}
              </span>
              {form.tagline !== "" ? (
                <span className="tagline">{form.tagline}</span>
              ) : null}
            </div>
            {form.welcome !== "" ? (
              <p className="site-preview-welcome">{form.welcome}</p>
            ) : null}
          </div>
        </aside>
      </div>
    </section>
  );
}
