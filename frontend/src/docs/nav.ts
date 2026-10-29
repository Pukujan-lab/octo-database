/** The docs table of contents, in reading order.
 *
 *  `href` is the whole truth about a page's address, so the sidebar, the
 *  previous/next footer and the router all read the same list. Adding a page here
 *  is the only registration it needs.
 */

export interface DocsPageEntry {
  /** Route segment. Empty for the index page. */
  slug: string;
  href: string;
  title: string;
}

export interface DocsSection {
  label: string;
  pages: DocsPageEntry[];
}

export const DOCS_SECTIONS: DocsSection[] = [
  {
    label: "Getting started",
    pages: [
      { slug: "", href: "/docs", title: "Overview" },
      { slug: "quickstart", href: "/docs/quickstart", title: "Quickstart" },
      { slug: "authentication", href: "/docs/authentication", title: "Authentication" },
    ],
  },
  {
    label: "Guides",
    pages: [
      { slug: "sql", href: "/docs/sql", title: "Running SQL" },
      { slug: "files", href: "/docs/files", title: "Files and publishing" },
      { slug: "analytics", href: "/docs/analytics", title: "Analytics" },
      { slug: "retrieval", href: "/docs/retrieval", title: "Retrieval and graph" },
      { slug: "vault", href: "/docs/vault", title: "Vault" },
      { slug: "mcp", href: "/docs/mcp", title: "MCP" },
    ],
  },
  {
    label: "Reference",
    pages: [
      { slug: "api", href: "/docs/api", title: "API reference" },
      { slug: "policy", href: "/docs/policy", title: "Adopter policy" },
    ],
  },
];

export const DOCS_PAGES: DocsPageEntry[] = DOCS_SECTIONS.flatMap((section) => section.pages);

export function findDocsPage(slug: string): DocsPageEntry | undefined {
  return DOCS_PAGES.find((page) => page.slug === slug);
}

/** The pages on either side of this one in reading order. */
export function docNeighbours(slug: string): {
  previous: DocsPageEntry | null;
  next: DocsPageEntry | null;
} {
  const index = DOCS_PAGES.findIndex((page) => page.slug === slug);
  if (index === -1) return { previous: null, next: null };
  return {
    previous: index > 0 ? DOCS_PAGES[index - 1] : null,
    next: index < DOCS_PAGES.length - 1 ? DOCS_PAGES[index + 1] : null,
  };
}
