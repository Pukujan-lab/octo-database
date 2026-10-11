import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import Index from "./pages/Index";
import NotFound from "./pages/NotFound";
import { PublicShareViewer } from "./views/PublicShareViewer";
import { useTheme } from "./hooks/useTheme";
import { ThemeControls } from "./components/portal/ThemeControls";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
      staleTime: 15 * 1000,
    },
  },
});

/** The share viewer is a standalone route: no shell, no bearer token. */
function ShareRoute() {
  const theme = useTheme();
  return (
    <PublicShareViewer
      themeControls={
        <ThemeControls
          design={theme.design}
          onDesign={theme.setDesign}
          isDark={theme.isDark}
          onToggle={theme.toggleVariant}
          compact
        />
      }
    />
  );
}

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Toaster />
      <Sonner position="bottom-right" closeButton />
      {/* Vite's BASE_URL carries the mount path ("/v2/"); the router needs it
          without the trailing slash so nested routes resolve under the mount. */}
      <BrowserRouter basename={import.meta.env.BASE_URL.replace(/\/$/, "")}>
        <Routes>
          <Route path="/" element={<Index />} />
          {/* Tokens may themselves contain slashes, so the splat is decoded whole. */}
          <Route path="/share/*" element={<ShareRoute />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
