import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import type { ReactNode } from "react";
import {
  getSession,
  signInWithPassword,
  signOutRequest,
  type SessionUser,
} from "./api";

export type SessionState =
  | { status: "loading" }
  | { status: "signedOut" }
  | { status: "signedIn"; user: SessionUser }
  | { status: "unavailable" };

interface SessionContextValue {
  state: SessionState;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  refresh: () => Promise<void>;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<SessionState>({ status: "loading" });

  const refresh = useCallback(async () => {
    try {
      const user = await getSession();
      setState(user === null ? { status: "signedOut" } : { status: "signedIn", user });
    } catch {
      // Distinguish "could not read session" from a real signed-out state so
      // the UI can show a retry instead of silently pretending logged out.
      setState({ status: "unavailable" });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const signIn = useCallback(async (email: string, password: string) => {
    const user = await signInWithPassword(email, password);
    setState({ status: "signedIn", user });
  }, []);

  const signOut = useCallback(async () => {
    // Only clear the local view after the server confirms sign-out: on failure
    // the HttpOnly cookie may still be valid, and claiming otherwise would be
    // dishonest. Callers render a retryable error.
    await signOutRequest();
    setState({ status: "signedOut" });
  }, []);

  const value = useMemo<SessionContextValue>(
    () => ({ state, signIn, signOut, refresh }),
    [state, signIn, signOut, refresh],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const ctx = useContext(SessionContext);
  if (ctx === null) throw new Error("useSession must be used within SessionProvider");
  return ctx;
}
