import { createContext, useContext } from "react";
import type { AuthenticatedSession } from "../api/server";

export const SessionContext = createContext<AuthenticatedSession | null>(null);

export function useSession(): AuthenticatedSession | null {
  return useContext(SessionContext);
}
