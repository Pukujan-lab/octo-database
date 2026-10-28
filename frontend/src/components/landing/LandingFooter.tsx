import { Link } from "react-router-dom";
import type { Health } from "@/lib/types";
import { INTEGRATION_GUIDE_URL, REPOSITORY_URL } from "./links";

/** Section 6: one row — mark, running version, links, health readouts. */
export function LandingFooter({ health }: { health: Health | undefined }) {
  return (
    <footer className="border-t border-border">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-5 py-6 text-xs text-muted-foreground sm:px-8 lg:flex-row lg:items-center lg:justify-between lg:gap-6">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <span className="font-display text-sm font-semibold text-foreground">Octo</span>
          <span aria-hidden="true">·</span>
          <span className="num">{health?.version ?? "—"}</span>
          <span aria-hidden="true">·</span>
          <Link to={INTEGRATION_GUIDE_URL} className="transition-colors hover:text-foreground">
            Integration guide
          </Link>
          <span aria-hidden="true">·</span>
          <a
            href={REPOSITORY_URL}
            target="_blank"
            rel="noreferrer"
            className="transition-colors hover:text-foreground"
          >
            Repository
          </a>
        </div>

        <div className="flex flex-wrap items-center gap-4">
          <span>
            API{" "}
            <span className={health?.status === "ok" ? "text-success" : "text-warning"}>
              {health ? health.status : "unknown"}
            </span>
          </span>
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
        </div>
      </div>
    </footer>
  );
}
