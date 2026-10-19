import { useI18n } from "../lib/i18n";
import { useSite } from "../lib/site";

/**
 * Brand block wired to the site-branding API (wave-8 C1): uploaded logo via
 * <img> (never inline — an SVG logo must not execute in this document), else
 * a graphite monogram from the site title; title + a secondary line — the
 * request host in the shell, the tagline on auth screens.
 */
export function BrandMark({ className }: { className?: string }) {
  const { site } = useSite();
  if (site.logoUrl !== null) {
    return (
      <img
        className={className}
        src={site.logoUrl}
        alt=""
        aria-hidden="true"
      />
    );
  }
  const initial = [...site.title.trim()][0]?.toUpperCase() ?? "D";
  const monoClass =
    className === undefined
      ? "brand-monogram"
      : `${className} brand-monogram`;
  return (
    <span className={monoClass} aria-hidden="true">
      {initial}
    </span>
  );
}

export function BrandBlock({
  detail,
  className,
}: {
  detail?: "host" | "tagline";
  className?: string;
}) {
  const { t } = useI18n();
  const { site } = useSite();
  const tagline = site.tagline !== "" ? site.tagline : t("app.tagline");
  return (
    <div className={className === undefined ? "brand" : `brand ${className}`}>
      <span className="brand-title">
        <BrandMark className="brand-mark" />
        {site.title}
      </span>
      {detail === "host" ? (
        <span className="brand-host">{window.location.host}</span>
      ) : null}
      {detail === "tagline" && tagline !== "" ? (
        <span className="tagline">{tagline}</span>
      ) : null}
    </div>
  );
}
