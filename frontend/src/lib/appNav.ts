import { createContext, useContext } from "react";
import type { AppView } from "../components/layout";
import type { Mission } from "../types/mission";

/** What any view can ask the app shell to do: switch view, or open the mission editor. App.tsx
 * provides it; without a provider (tests, a view rendered alone) every action is undefined, and the
 * buttons that need one are left out. */
export interface AppNav {
  openView?: (view: AppView) => void;
  newMission?: () => void;
  editMission?: (mission: Mission) => void;
  /** Opens Tools → Scans with this target filled in. */
  scanTarget?: (target: string) => void;
}

export const AppNavContext = createContext<AppNav>({});

export function useAppNav(): AppNav {
  return useContext(AppNavContext);
}
