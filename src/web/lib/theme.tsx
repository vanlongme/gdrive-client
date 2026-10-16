import { createContext, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";

export const THEME_CHOICES = ["light", "dark", "system"] as const;
export type ThemeChoice = (typeof THEME_CHOICES)[number];
export type ResolvedTheme = "light" | "dark";

const STORAGE_KEY = "drive-worker.theme";

interface ThemeContextValue {
  /** The user's choice: light, dark, or follow the OS. */
  choice: ThemeChoice;
  /** The concrete theme currently applied to the document. */
  resolved: ResolvedTheme;
  setChoice: (choice: ThemeChoice) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function readInitialChoice(): ThemeChoice {
  const stored = window.localStorage.getItem(STORAGE_KEY);
  return stored === "light" || stored === "dark" || stored === "system"
    ? stored
    : "system";
}

function systemTheme(): ResolvedTheme {
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

function applyTheme(choice: ThemeChoice, resolved: ResolvedTheme): void {
  const root = document.documentElement;
  root.dataset.theme = resolved;
  root.dataset.themeChoice = choice;
  root.style.colorScheme = resolved;
}

// Apply the persisted choice at module load (before the first React paint) so
// a dark preference does not flash the light theme on load.
const initialChoice = readInitialChoice();
applyTheme(
  initialChoice,
  initialChoice === "system" ? systemTheme() : initialChoice,
);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [choice, setChoiceState] = useState<ThemeChoice>(readInitialChoice);
  const [systemResolved, setSystemResolved] = useState<ResolvedTheme>(systemTheme);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (event: MediaQueryListEvent) => {
      setSystemResolved(event.matches ? "dark" : "light");
    };
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  const resolved: ResolvedTheme = choice === "system" ? systemResolved : choice;

  useEffect(() => {
    applyTheme(choice, resolved);
    window.localStorage.setItem(STORAGE_KEY, choice);
  }, [choice, resolved]);

  const value = useMemo<ThemeContextValue>(
    () => ({ choice, resolved, setChoice: setChoiceState }),
    [choice, resolved],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (ctx === null) throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
}
