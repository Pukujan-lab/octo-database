import { useEffect, useRef, useState } from "react";

type TurnstileApi = {
  render: (
    container: HTMLElement,
    options: {
      sitekey: string;
      theme?: "dark" | "light";
      size?: "normal" | "flexible" | "compact";
      callback?: (token: string) => void;
      "expired-callback"?: () => void;
      "error-callback"?: () => void;
    },
  ) => string;
  remove?: (id: string) => void;
};

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let scriptPromise: Promise<TurnstileApi | null> | null = null;

function loadTurnstileScript(): Promise<TurnstileApi | null> {
  if (typeof window === "undefined") return Promise.resolve(null);
  if (window.turnstile) return Promise.resolve(window.turnstile);
  if (scriptPromise) return scriptPromise;

  scriptPromise = new Promise<TurnstileApi | null>((resolve) => {
    const existing = document.querySelector<HTMLScriptElement>('script[src*="challenges.cloudflare.com/turnstile"]');
    const script = existing ?? document.createElement("script");
    if (!existing) {
      script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
      script.async = true;
      script.defer = true;
      document.head.appendChild(script);
    }
    const timer = window.setInterval(() => {
      if (window.turnstile) {
        window.clearInterval(timer);
        resolve(window.turnstile);
      }
    }, 80);
    script.addEventListener("error", () => {
      window.clearInterval(timer);
      resolve(null);
    });
    window.setTimeout(() => {
      window.clearInterval(timer);
      resolve(window.turnstile ?? null);
    }, 8000);
  });
  return scriptPromise;
}

/** Mounts a Cloudflare Turnstile challenge with an explicit render, and clears
 *  the token whenever it expires — tokens are single-use and live ~5 minutes. */
export function Turnstile({
  siteKey,
  theme,
  onToken,
}: {
  siteKey: string;
  theme: "dark" | "light";
  onToken: (token: string | null) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const widgetId = useRef<string | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "unavailable">("loading");

  useEffect(() => {
    let cancelled = false;
    setState("loading");
    onToken(null);

    void loadTurnstileScript().then((api) => {
      if (cancelled) return;
      if (!api || !container.current) {
        setState("unavailable");
        return;
      }
      try {
        widgetId.current = api.render(container.current, {
          sitekey: siteKey,
          theme,
          size: "flexible",
          callback: (token) => {
            if (!cancelled) onToken(token);
          },
          "expired-callback": () => {
            if (!cancelled) onToken(null);
          },
          "error-callback": () => {
            if (!cancelled) onToken(null);
          },
        });
        setState("ready");
      } catch {
        setState("unavailable");
      }
    });

    return () => {
      cancelled = true;
      if (widgetId.current && window.turnstile?.remove) {
        try {
          window.turnstile.remove(widgetId.current);
        } catch {
          /* the container is discarded anyway */
        }
      }
      widgetId.current = null;
      container.current?.replaceChildren();
    };
    // Re-render on every draw and on theme change so a fresh token is requested.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [siteKey, theme]);

  return (
    <div className="space-y-1.5">
      <div ref={container} className="min-h-[65px] w-full" />
      {state === "loading" ? <p className="text-[11px] text-muted-foreground">Loading human verification…</p> : null}
      {state === "unavailable" ? (
        <p className="text-[11px] text-warning">
          Verification widget could not load. Check the network and reload the page to retry.
        </p>
      ) : null}
    </div>
  );
}
