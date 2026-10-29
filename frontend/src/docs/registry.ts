import type { ComponentType } from "react";
import { OverviewPage } from "./pages/OverviewPage";
import { QuickstartPage } from "./pages/QuickstartPage";
import { AuthenticationPage } from "./pages/AuthenticationPage";
import { SqlPage } from "./pages/SqlPage";
import { FilesPage } from "./pages/FilesPage";
import { AnalyticsPage } from "./pages/AnalyticsPage";
import { RetrievalPage } from "./pages/RetrievalPage";
import { VaultPage } from "./pages/VaultPage";
import { McpPage } from "./pages/McpPage";
import { ApiPage } from "./pages/ApiPage";
import { PolicyPage } from "./pages/PolicyPage";

/** Slug to page component. The nav is the source of truth for which slugs exist;
 *  this map is what renders them. */
export const DOCS_CONTENT: Record<string, ComponentType> = {
  "": OverviewPage,
  quickstart: QuickstartPage,
  authentication: AuthenticationPage,
  sql: SqlPage,
  files: FilesPage,
  analytics: AnalyticsPage,
  retrieval: RetrievalPage,
  vault: VaultPage,
  mcp: McpPage,
  api: ApiPage,
  policy: PolicyPage,
};
