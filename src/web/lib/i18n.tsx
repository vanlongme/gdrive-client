import { createContext, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { en } from "../locales/en";
import { vi, type Messages } from "../locales/vi";

export const LOCALES = ["vi", "en"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "vi";

const STORAGE_KEY = "drive-worker.locale";

const DICTIONARIES: Record<Locale, Messages> = { vi, en };

/** Dot-separated paths into the message tree, e.g. "setup.title". */
export type MessagePath = {
  [K in keyof Messages & string]: Messages[K] extends string
    ? K
    : Messages[K] extends string[]
      ? K
      : {
          [K2 in keyof Messages[K] & string]: Messages[K][K2] extends string
            ? `${K}.${K2}`
            : never;
        }[keyof Messages[K] & string];
}[keyof Messages & string];

interface I18nContextValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  messages: Messages;
  t: (path: MessagePath, vars?: Record<string, string | number>) => string;
}

const I18nContext = createContext<I18nContextValue | null>(null);

function readInitialLocale(): Locale {
  const stored = window.localStorage.getItem(STORAGE_KEY);
  return stored === "en" || stored === "vi" ? stored : DEFAULT_LOCALE;
}

function lookup(messages: Messages, path: string): string | undefined {
  let node: unknown = messages;
  for (const part of path.split(".")) {
    if (typeof node !== "object" || node === null) return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === "string" ? node : undefined;
}

export function LocaleProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(readInitialLocale);

  useEffect(() => {
    document.documentElement.lang = locale;
    window.localStorage.setItem(STORAGE_KEY, locale);
  }, [locale]);

  const value = useMemo<I18nContextValue>(() => {
    const messages = DICTIONARIES[locale];
    return {
      locale,
      setLocale: setLocaleState,
      messages,
      t: (path, vars) => {
        const template = lookup(messages, path) ?? lookup(vi, path) ?? path;
        if (vars === undefined) return template;
        return template.replace(/\{(\w+)\}/g, (match, name: string) =>
          name in vars ? String(vars[name]) : match,
        );
      },
    };
  }, [locale]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (ctx === null) throw new Error("useI18n must be used within LocaleProvider");
  return ctx;
}
