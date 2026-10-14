import React, { createContext, useContext } from "react";
import type { Me, Role } from "./types";

/** Public /api/config; feature flags are optional so an older server reads as "everything configured". */
export type Config = {
  googleEnabled: boolean;
  devLoginEnabled: boolean;
  stagingLogin?: boolean;
  environment?: "production" | "staging" | "development";
  payments?: boolean;
  shipping?: boolean;
  turnstile?: boolean;
};
export type Session = {
  me: Me;
  config: Config;
  logout: () => Promise<void>;
  /** Whether the signed-in admin may use an area; the server still enforces every route. */
  can: (area: "any" | "ops" | "catalog" | "owner") => boolean;
};

const AuthContext = createContext<Session>(null as unknown as Session);

export function AuthProvider({ session, children }: { session: Session; children: React.ReactNode }) {
  return <AuthContext.Provider value={session}>{children}</AuthContext.Provider>;
}

export function useSession() {
  return useContext(AuthContext);
}

export function areaAllowed(role: Role, areas: Role[], area: "any" | "ops" | "catalog" | "owner") {
  if (area === "any") return true;
  if (area === "owner") return role === "owner";
  return areas.includes(area);
}
