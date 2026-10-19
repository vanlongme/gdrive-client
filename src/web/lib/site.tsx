import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";
import type { SiteBrandingView } from "../../shared/contracts/site";
import { getSite } from "./api";
import { useI18n } from "./i18n";

/**
 * Site branding provider (wave-8 C1). GET /api/v1/site is anonymous and
 * answers defaults before setup completes, so this provider sits above the
 * whole router — the public /public/<slug> surface uses it for the glass header
 * without ever touching session or admin APIs.
 *
 * While a fetch is in flight the server-side defaults are used so the brand
 * block never flashes an empty title.
 */
export const DEFAULT_SITE: SiteBrandingView = {
  title: "Drive Worker",
  tagline: "",
  welcome: "",
  supportEmail: null,
  defaultLocale: "vi",
  logoUrl: null,
};

export type SiteState =
  | { status: "loading" }
  | { status: "error"; error: unknown }
  | { status: "ready"; site: SiteBrandingView };

interface SiteContextValue {
  state: SiteState;
  /** The resolved view — real data when ready, server defaults otherwise. */
  site: SiteBrandingView;
  refresh: () => Promise<void>;
}

const SiteContext = createContext<SiteContextValue | null>(null);

const FAVICON_ID = "site-favicon";

function applyFavicon(logoUrl: string | null): void {
  let link = document.getElementById(FAVICON_ID) as HTMLLinkElement | null;
  if (logoUrl === null) {
    link?.remove();
    return;
  }
  if (link === null) {
    link = document.createElement("link");
    link.id = FAVICON_ID;
    link.rel = "icon";
    document.head.appendChild(link);
  }
  link.href = logoUrl;
}

export function SiteProvider({ children }: { children: ReactNode }) {
  const { setLocale } = useI18n();
  const [state, setState] = useState<SiteState>({ status: "loading" });
  const abortRef = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const site = await getSite(controller.signal);
      if (!controller.signal.aborted) setState({ status: "ready", site });
    } catch (error) {
      if (!controller.signal.aborted) {
        setState({ status: "error", error });
      }
    }
  }, []);

  useEffect(() => {
    void refresh();
    return () => abortRef.current?.abort();
  }, [refresh]);

  const site = state.status === "ready" ? state.site : DEFAULT_SITE;

  // Favicon follows the configured logo (or falls back to none). Only ever
  // a URL reference — an uploaded SVG logo is never inlined into the DOM.
  useEffect(() => {
    applyFavicon(site.logoUrl);
  }, [site.logoUrl]);

  // The admin-set default locale applies only when the visitor has never
  // chosen a language — an explicit preference always wins.
  const appliedDefault = useRef(false);
  useEffect(() => {
    if (appliedDefault.current || state.status !== "ready") return;
    appliedDefault.current = true;
    if (
      window.localStorage.getItem("drive-worker.locale") === null &&
      state.site.defaultLocale !== "vi"
    ) {
      setLocale(state.site.defaultLocale);
    }
  }, [state, setLocale]);

  const value = useMemo<SiteContextValue>(
    () => ({ state, site, refresh }),
    [state, site, refresh],
  );

  return <SiteContext.Provider value={value}>{children}</SiteContext.Provider>;
}

export function useSite(): SiteContextValue {
  const ctx = useContext(SiteContext);
  if (ctx === null) throw new Error("useSite must be used within SiteProvider");
  return ctx;
}

/** document.title = "<segment> · <site title>" (bare title when no segment). */
export function useDocumentTitle(segment?: string | null): void {
  const { site } = useSite();
  useEffect(() => {
    document.title =
      segment !== undefined && segment !== null && segment !== ""
        ? `${segment} · ${site.title}`
        : site.title;
  }, [segment, site.title]);
}
