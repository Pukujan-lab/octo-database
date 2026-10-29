import { useEffect } from "react";
import { useParams } from "react-router-dom";
import { DocsLayout } from "@/docs/DocsLayout";
import { DOCS_CONTENT } from "@/docs/registry";
import { findDocsPage } from "@/docs/nav";
import NotFound from "@/pages/NotFound";

/** `/docs` and `/docs/:slug` — the developer documentation.
 *
 *  One route handles both shapes so the index and a subpage share the shell. An
 *  unknown slug falls through to the app's 404 rather than rendering an empty
 *  page under a docs header. */
export function DocsPage() {
  const { slug = "" } = useParams();
  const page = findDocsPage(slug);
  const Content = DOCS_CONTENT[slug];

  useEffect(() => {
    const previous = document.title;
    document.title = page ? `${page.title} — Octo docs` : "Docs — Octo";
    return () => {
      document.title = previous;
    };
  }, [page]);

  if (!page || !Content) return <NotFound />;

  return (
    <DocsLayout page={page}>
      <Content />
    </DocsLayout>
  );
}
