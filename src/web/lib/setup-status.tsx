import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import type { ReactNode } from "react";
import type { SetupStatusView } from "../../shared/contracts/admin";
import { getSetupStatus } from "./api";

export type SetupStatusState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; view: SetupStatusView };

interface SetupStatusContextValue {
  state: SetupStatusState;
  refresh: () => Promise<void>;
}

const SetupStatusContext = createContext<SetupStatusContextValue | null>(null);

/**
 * Reads /api/v1/setup/status once at bootstrap. A read failure is reported as
 * "error" (never silently treated as uninitialized) so the UI mirrors the
 * fail-closed backend gate.
 */
export function SetupStatusProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<SetupStatusState>({ status: "loading" });

  const refresh = useCallback(async () => {
    try {
      const view = await getSetupStatus();
      setState({ status: "ready", view });
    } catch {
      setState({ status: "error" });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const value = useMemo<SetupStatusContextValue>(
    () => ({ state, refresh }),
    [state, refresh],
  );

  return (
    <SetupStatusContext.Provider value={value}>
      {children}
    </SetupStatusContext.Provider>
  );
}

export function useSetupStatus(): SetupStatusContextValue {
  const ctx = useContext(SetupStatusContext);
  if (ctx === null) {
    throw new Error("useSetupStatus must be used within SetupStatusProvider");
  }
  return ctx;
}
