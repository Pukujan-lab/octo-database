import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AlertCircle, ArrowRight, Database, Hexagon, Lock, ShieldCheck } from "lucide-react";
import { Turnstile } from "./Turnstile";
import { OctoMark } from "./OctoMark";
import type { Health } from "@/lib/types";

const GOOGLE_ICON = (
  <svg viewBox="0 0 18 18" className="h-4 w-4" aria-hidden="true">
    <path
      fill="currentColor"
      d="M17.64 9.2c0-.64-.06-1.26-.17-1.84H9v3.48h4.86a4.16 4.16 0 0 1-1.8 2.74v2.26h2.92a8.7 8.7 0 0 0 2.66-6.64Z"
      opacity=".9"
    />
    <path
      fill="currentColor"
      d="M9 18c2.43 0 4.46-.8 5.96-2.18l-2.92-2.26c-.8.56-1.86.88-3.04.88-2.34 0-4.32-1.58-5.04-3.7H.96V12.7A9 9 0 0 0 9 18Z"
      opacity=".55"
    />
    <path
      fill="currentColor"
      d="M3.96 10.74A5.4 5.4 0 0 1 3.66 9c0-.6.1-1.2.3-1.74V4.98H.96A9 9 0 0 0 0 9c0 1.46.35 2.84.96 4.02l3-2.28Z"
      opacity=".75"
    />
    <path
      fill="currentColor"
      d="M9 3.58c1.32 0 2.5.46 3.44 1.35l2.58-2.58A8.66 8.66 0 0 0 9 0 9 9 0 0 0 .96 4.98l3 2.28C6.68 5.16 8.66 3.58 9 3.58Z"
      opacity=".35"
    />
  </svg>
);

export function LoginScreen({
  health,
  healthPending,
  notice,
  signingIn,
  onGuest,
  designControls,
  isDark,
}: {
  health: Health | undefined;
  healthPending: boolean;
  notice: string | null;
  signingIn: boolean;
  onGuest: (input: { displayName?: string; turnstileToken?: string }) => Promise<boolean>;
  designControls: React.ReactNode;
  isDark: boolean;
}) {
  const [displayName, setDisplayName] = useState("");
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);

  const siteKey = health?.turnstileSiteKey || "";
  const googleReady = Boolean(health?.googleAuthEnabled);
  // A advertised site key means the guest button must wait for a token.
  const guestBlocked = Boolean(siteKey) && !turnstileToken;

  return (
    <div data-testid="login-screen" className="relative min-h-dvh overflow-hidden bg-background text-foreground">
      <div className="motif-grid motif-grid-fade pointer-events-none absolute inset-0 opacity-50" aria-hidden="true" />
      <div className="motif-glow pointer-events-none absolute inset-0" aria-hidden="true" />

      <div className="relative mx-auto flex min-h-dvh w-full max-w-6xl flex-col px-5 py-6 sm:px-8">
        <header className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-2.5">
            <Hexagon className="h-5 w-5 text-primary" strokeWidth={1.75} />
            <span className="font-display text-sm font-semibold uppercase tracking-[0.16em]">Octo Portal</span>
          </div>
          {designControls}
        </header>

        <main className="grid flex-1 items-center gap-10 py-10 lg:grid-cols-[1.05fr_0.95fr] lg:gap-16">
          {/* ---------------- brand column ---------------- */}
          <section className="space-y-8">
            <div className="space-y-4">
              <p className="eyebrow text-primary">workspace data platform</p>
              <h1 className="font-display text-5xl font-bold leading-[1.02] tracking-tight sm:text-6xl">Octo</h1>
              <p className="max-w-md text-[15px] leading-relaxed text-muted-foreground">
                One control surface for every workspace: files, media, background jobs, keys and share
                links — all against your own self-hosted API.
              </p>
            </div>

            <div className="hidden max-w-md items-center gap-6 sm:flex">
              <OctoMark className="h-28 w-28 shrink-0" />
              <ul className="space-y-2.5 text-sm">
                <li className="flex items-center gap-2.5 text-muted-foreground">
                  <Database className="h-4 w-4 shrink-0 text-primary" /> Files, gallery &amp; object archive state
                </li>
                <li className="flex items-center gap-2.5 text-muted-foreground">
                  <ShieldCheck className="h-4 w-4 shrink-0 text-info" /> Confirm-code gate on destructive calls
                </li>
                <li className="flex items-center gap-2.5 text-muted-foreground">
                  <Lock className="h-4 w-4 shrink-0 text-warning" /> Short-lived sessions, 20-minute idle expiry
                </li>
              </ul>
            </div>
          </section>

          {/* ---------------- sign-in column ---------------- */}
          <section className="panel relative w-full p-6 sm:p-8">
            <div className="motif-scan pointer-events-none absolute inset-x-0 top-0 h-24 rounded-t-lg opacity-30" aria-hidden="true" />
            <div className="relative space-y-6">
              <div className="space-y-1">
                <h2 className="font-display text-xl font-semibold">Start a session</h2>
                <p className="text-sm text-muted-foreground">
                  Guest sessions get an isolated workspace. Google links your identity to the
                  workspaces you belong to.
                </p>
              </div>

              {notice ? (
                <div
                  role="status"
                  className="flex items-start gap-2.5 rounded-md border border-destructive/45 bg-destructive/10 px-3 py-2.5 text-sm text-destructive"
                >
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span className="leading-relaxed">{notice}</span>
                </div>
              ) : null}

              <div className="space-y-2">
                <Label htmlFor="guest-name">
                  Display name <span className="text-muted-foreground">(optional)</span>
                </Label>
                <Input
                  id="guest-name"
                  value={displayName}
                  autoComplete="name"
                  placeholder="e.g. Ada"
                  onChange={(event) => setDisplayName(event.target.value)}
                />
              </div>

              {siteKey ? <Turnstile siteKey={siteKey} theme={isDark ? "dark" : "light"} onToken={setTurnstileToken} /> : null}

              <div className="space-y-3">
                <Button
                  data-testid="login-guest"
                  size="lg"
                  className="w-full gap-2"
                  disabled={signingIn || guestBlocked || healthPending}
                  onClick={() =>
                    void onGuest({
                      displayName: displayName.trim() || undefined,
                      turnstileToken: turnstileToken ?? undefined,
                    })
                  }
                >
                  {signingIn ? "Opening session…" : healthPending ? "Checking server…" : "Continue as Guest"}
                  {!signingIn && !healthPending ? <ArrowRight className="h-4 w-4" /> : null}
                </Button>

                {googleReady ? (
                  <Button variant="outline" size="lg" className="w-full gap-2" data-testid="login-google" asChild>
                    <a href="/api/auth/google">{GOOGLE_ICON} Sign in with Google</a>
                  </Button>
                ) : (
                  <Button
                    variant="outline"
                    size="lg"
                    // A blanket opacity dims the label toward the panel until it can no
                    // longer be read. This control exists only to report that Google
                    // auth is off, so keep it legible and signal inactivity with a
                    // dashed border instead of faded text.
                    className="w-full gap-2 disabled:opacity-100 disabled:border-dashed disabled:bg-transparent disabled:text-muted-foreground"
                    data-testid="login-google"
                    disabled
                    title="Google sign-in is not configured on this server"
                  >
                    {GOOGLE_ICON} Sign in with Google
                    <span className="text-xs font-normal text-muted-foreground">not configured</span>
                  </Button>
                )}
              </div>

              <p className="border-t border-border pt-4 text-xs leading-relaxed text-muted-foreground">
                Sessions expire after 20 minutes of inactivity. Credentials minted here are shown once
                and never stored by this app.
              </p>
            </div>
          </section>
        </main>

        <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-5 text-xs text-muted-foreground">
          <span>
            Octo <span className="num">{health?.version ?? "—"}</span> · API{" "}
            <span className={health?.status === "ok" ? "text-success" : "text-warning"}>{health ? health.status : "unknown"}</span>
          </span>
          <span className="flex flex-wrap items-center gap-4">
            <span>
              storage{" "}
              <span className={health?.r2?.connected ? "text-success" : "text-warning"}>
                {health ? (health.r2.connected ? health.r2.bucket || "ok" : "down") : "—"}
              </span>
            </span>
            <span>
              database{" "}
              <span className={health?.database?.connected ? "text-success" : "text-warning"}>
                {health ? (health.database.connected ? "ok" : "down") : "—"}
              </span>
            </span>
          </span>
        </footer>
      </div>
    </div>
  );
}
