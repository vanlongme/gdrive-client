import { Link } from "react-router";
import { useI18n } from "../lib/i18n";

export function NotFoundPage() {
  const { t } = useI18n();
  return (
    <main className="auth-layout">
      <div className="card auth-panel">
        <h1>{t("notFound.title")}</h1>
        <p>{t("notFound.body")}</p>
        <Link className="btn btn-ghost" to="/">
          {t("notFound.backHome")}
        </Link>
      </div>
    </main>
  );
}
