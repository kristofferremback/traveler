import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App } from "./App";
import { trackBrowserChrome } from "./lib/viewport";
import "./index.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      // Transit data ages in seconds, but a refetch storm on every focus change costs
      // SL requests for no new information. Individual queries tighten this.
      staleTime: 30_000,
      refetchOnWindowFocus: false,
    },
  },
});

trackBrowserChrome();

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root");

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
