import { useState } from "react";
import { useI18n } from "../../lib/i18n";
import type { MessagePath } from "../../lib/i18n";
import { useSession } from "../../lib/session";
import { useDocumentTitle } from "../../lib/site";
import type { SharedDriveEntry } from "../../lib/admin-api";
import { ConnectionsSection } from "./connections-section";
import { HealthSection } from "./health-section";
import { MaintenanceSection } from "./maintenance-section";
import { MountsSection, type MountDrivePrefill } from "./mounts-section";
import { OnboardingSection } from "./onboarding-section";
import { ServiceAccountsSection } from "./service-accounts-section";
import { SharesSection } from "./shares-section";
import { SiteSection } from "./site-section";
import { UsersSection } from "./users-section";

/**
 * Admin area (spec section 11.2): real surfaces for Google OAuth clients and
 * connections, service accounts, mounts + grants, users, shares and provider
 * health. Only admins reach this page — enforcement stays server-side.
 */
type SectionKey =
  | "onboarding"
  | "site"
  | "connections"
  | "serviceAccounts"
  | "mounts"
  | "users"
  | "shares"
  | "health"
  | "ops";

const SECTIONS: { key: SectionKey; labelKey: MessagePath }[] = [
  { key: "onboarding", labelKey: "admin.tab_onboarding" },
  { key: "site", labelKey: "admin.tab_site" },
  { key: "connections", labelKey: "admin.tab_connections" },
  { key: "serviceAccounts", labelKey: "admin.tab_serviceAccounts" },
  { key: "mounts", labelKey: "admin.tab_mounts" },
  { key: "users", labelKey: "admin.tab_users" },
  { key: "shares", labelKey: "admin.tab_shares" },
  { key: "health", labelKey: "admin.tab_health" },
  { key: "ops", labelKey: "adminOps.title" },
];

export function AdminPage() {
  const { t } = useI18n();
  useDocumentTitle(t("admin.title"));
  const { state } = useSession();
  const [section, setSection] = useState<SectionKey>("onboarding");
  const [mountPrefill, setMountPrefill] = useState<MountDrivePrefill | null>(
    null,
  );

  // The onboarding Shared Drive chooser hands the picked drive to the mount
  // create form; My Drive folders are picked inside the form itself.
  const pickDrive = (drive: SharedDriveEntry) => {
    setMountPrefill({
      kind: "shared_drive",
      rootFolderId: drive.id,
      name: drive.name,
    });
    setSection("mounts");
  };

  if (state.status !== "signedIn") return null;

  if (state.user.role !== "admin") {
    return (
      <>
        <header className="page-header">
          <h1>{t("admin.title")}</h1>
        </header>
        <section className="card empty-state">
          <h2>{t("admin.forbiddenTitle")}</h2>
          <p>{t("admin.forbiddenBody")}</p>
        </section>
      </>
    );
  }

  const { user } = state;

  return (
    <>
      <header className="page-header">
        <h1>{t("admin.title")}</h1>
        <p>{t("admin.intro")}</p>
      </header>

      <nav className="admin-tabs" aria-label={t("admin.sectionNav")}>
        {SECTIONS.map((item) => (
          <button
            key={item.key}
            type="button"
            className="btn btn-ghost btn-sm"
            aria-pressed={section === item.key}
            onClick={() => setSection(item.key)}
          >
            {t(item.labelKey)}
          </button>
        ))}
      </nav>

      <div className="admin-account">
        <span className="badge">{t("admin.accountTitle")}</span>{" "}
        <span className="user-name">{user.name}</span>{" "}
        <span className="user-email">{user.email}</span>
      </div>

      {section === "onboarding" ? (
        <OnboardingSection onNavigate={setSection} onPickDrive={pickDrive} />
      ) : null}
      {section === "site" ? <SiteSection /> : null}
      {section === "connections" ? <ConnectionsSection /> : null}
      {section === "serviceAccounts" ? <ServiceAccountsSection /> : null}
      {section === "mounts" ? (
        <MountsSection
          prefill={mountPrefill}
          onPrefillConsumed={() => setMountPrefill(null)}
        />
      ) : null}
      {section === "users" ? <UsersSection /> : null}
      {section === "shares" ? <SharesSection /> : null}
      {section === "health" ? <HealthSection /> : null}
      {section === "ops" ? <MaintenanceSection /> : null}
    </>
  );
}
