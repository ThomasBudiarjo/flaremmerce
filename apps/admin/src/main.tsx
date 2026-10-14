/// <reference types="vite/client" />
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { LoaderCircle, LogIn, LogOut } from "lucide-react";
import "./style.css";
import { get, post, HttpError } from "@/lib/api";
import { AuthProvider, areaAllowed, type Config, type Session } from "@/lib/auth";
import { RouterProvider } from "@/lib/router";
import type { Me } from "@/lib/types";
import { AppShell } from "@/components/app-shell";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type State =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "signed-out" }
  | { kind: "setup" }
  | { kind: "denied"; message: string }
  | { kind: "ready"; me: Me };

function Centered({ children }: { children: React.ReactNode }) {
  return <main className="flex min-h-svh items-center justify-center bg-muted/40 p-4">{children}</main>;
}

/** Config, setup and session are read once per sign-in transition, never per page. */
function Bootstrap() {
  const [config, setConfig] = useState<Config | null>(null);
  const [state, setState] = useState<State>({ kind: "loading" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [secret, setSecret] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const sequence = useRef(0);

  const resolve = useCallback(async () => {
    const current = ++sequence.current;
    setState({ kind: "loading" });
    try {
      const [nextConfig, setup] = await Promise.all([get<Config>("/api/config"), get<{ initialized: boolean }>("/api/setup")]);
      if (current !== sequence.current) return;
      setConfig(nextConfig);
      const session =
        nextConfig.googleEnabled || nextConfig.devLoginEnabled || nextConfig.stagingLogin
          ? await get<{ user?: { id: string } } | null>("/api/auth/get-session?disableCookieCache=true")
          : null;
      if (current !== sequence.current) return;
      if (!session?.user) return setState({ kind: "signed-out" });
      if (!setup.initialized) return setState({ kind: "setup" });
      try {
        const me = await get<Me>("/api/admin/me");
        if (current === sequence.current) setState({ kind: "ready", me });
      } catch (e) {
        if (current !== sequence.current) return;
        if (e instanceof HttpError && (e.status === 401 || e.status === 403))
          setState({ kind: "denied", message: "Akun ini belum memiliki akses administrator. Minta owner memberikan peran." });
        else throw e;
      }
    } catch (e) {
      if (current === sequence.current) setState({ kind: "error", message: (e as Error).message });
    }
  }, []);

  useEffect(() => {
    void resolve();
    return () => {
      ++sequence.current;
    };
  }, [resolve]);

  async function run(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const login = () =>
    run(async () => {
      if (config?.devLoginEnabled) {
        await post("/api/auth/development-login");
        await resolve();
        return;
      }
      const data = await post<{ url?: string }>("/api/auth/sign-in/social", { provider: "google", callbackURL: `${location.origin}/admin/` });
      if (!data.url) throw new Error("Google sign-in belum tersedia.");
      location.assign(data.url);
    });

  const logout = useCallback(async () => {
    ++sequence.current;
    setState({ kind: "loading" });
    try {
      await post("/api/auth/sign-out");
    } finally {
      await resolve();
    }
  }, [resolve]);

  const me = state.kind === "ready" ? state.me : null;
  const session = useMemo<Session | null>(
    () =>
      me && config
        ? { me, config, logout, can: (area) => areaAllowed(me.role, me.areas, area) }
        : null,
    [me, config, logout],
  );

  if (session) {
    return (
      <AuthProvider session={session}>
        <RouterProvider>
          <AppShell />
        </RouterProvider>
      </AuthProvider>
    );
  }

  const stagingLogin = () =>
    run(async () => {
      await post("/api/auth/staging-login", { secret: passphrase });
      setPassphrase("");
      await resolve();
    });
  const loginLabel = config?.devLoginEnabled ? "Masuk admin dev" : "Masuk dengan Google";
  const anyLogin = !!(config?.devLoginEnabled || config?.googleEnabled || config?.stagingLogin);
  return (
    <Centered>
      {state.kind === "loading" && (
        <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
          <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" />
          Memuat data…
        </p>
      )}
      {state.kind === "error" && (
        <Alert variant="destructive" role="alert" className="max-w-md">
          <AlertDescription className="grid gap-2">
            {state.message}
            <Button variant="outline" className="justify-self-start" onClick={resolve}>
              Muat ulang
            </Button>
          </AlertDescription>
        </Alert>
      )}
      {(state.kind === "signed-out" || state.kind === "setup" || state.kind === "denied") && (
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle>
              <h1 className="text-xl">
                {state.kind === "signed-out" ? "Masuk ke admin" : state.kind === "setup" ? "Aktifkan admin pertama" : "Akses ditolak"}
              </h1>
            </CardTitle>
            <CardDescription>
              {state.kind === "signed-out"
                ? config?.devLoginEnabled
                  ? "Development lokal. Tidak memerlukan akun Google atau password."
                  : config?.stagingLogin && !config.googleEnabled
                    ? "Lingkungan staging. Masukkan passphrase staging dari operator deployment."
                    : "Gunakan akun Google yang memiliki akses administrator."
                : state.kind === "setup"
                  ? "Gunakan bootstrap secret deployment. Setup ditutup setelah berhasil."
                  : state.message}
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            {error && (
              <Alert variant="destructive" role="alert">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            {state.kind === "signed-out" && (
              <>
                {config?.stagingLogin && !config.devLoginEnabled && (
                  <form
                    className="grid gap-4"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void stagingLogin();
                    }}
                  >
                    <div className="grid gap-2">
                      <Label htmlFor="staging-passphrase">Passphrase staging</Label>
                      <Input id="staging-passphrase" type="password" autoComplete="current-password" required value={passphrase} onChange={(e) => setPassphrase(e.target.value)} />
                    </div>
                    <Button disabled={busy}>
                      <LogIn />
                      Masuk staging
                    </Button>
                  </form>
                )}
                {(config?.devLoginEnabled || config?.googleEnabled) && (
                  <Button variant={config.stagingLogin && !config.devLoginEnabled ? "outline" : "default"} onClick={login} disabled={busy}>
                    <LogIn />
                    {loginLabel}
                  </Button>
                )}
                {!anyLogin && (
                  <p className="text-sm text-muted-foreground">Google sign-in belum dikonfigurasi. Hubungi operator deployment.</p>
                )}
              </>
            )}
            {state.kind === "setup" && (
              <form
                className="grid gap-4"
                onSubmit={(e) => {
                  e.preventDefault();
                  void run(async () => {
                    await post("/api/setup", { secret });
                    setSecret("");
                    await resolve();
                  });
                }}
              >
                <div className="grid gap-2">
                  <Label htmlFor="bootstrap-secret">Bootstrap secret</Label>
                  <Input id="bootstrap-secret" type="password" autoComplete="off" required value={secret} onChange={(e) => setSecret(e.target.value)} />
                </div>
                <Button disabled={busy}>Aktifkan admin pertama</Button>
              </form>
            )}
            {(state.kind === "setup" || state.kind === "denied") && (
              <Button variant="outline" disabled={busy} onClick={() => void run(logout)}>
                <LogOut />
                Keluar
              </Button>
            )}
          </CardContent>
        </Card>
      )}
    </Centered>
  );
}

export function AdminApp() {
  return <Bootstrap />;
}

if (import.meta.env.MODE !== "test") {
  createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <AdminApp />
    </React.StrictMode>,
  );
}
