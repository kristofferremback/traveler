import { Component, type ErrorInfo, type ReactNode } from "react";
import { NavLink, Route, Routes } from "react-router-dom";
import { AlertTriangle, MapPin, Search, TriangleAlert } from "lucide-react";
import { PlanPage } from "./routes/PlanPage";
import { StopPage } from "./routes/StopPage";
import { NearbyPage } from "./routes/NearbyPage";
import { DisruptionsPage } from "./routes/DisruptionsPage";
import { Button } from "./components/ui/button";
import { cn } from "./lib/utils";

const TABS = [
  { to: "/", label: "Res", icon: Search, end: true },
  { to: "/nearby", label: "Nära", icon: MapPin, end: false },
  { to: "/disruptions", label: "Trafikläget", icon: TriangleAlert, end: false },
];

function TabBar() {
  return (
    <nav
      aria-label="Huvudmeny"
      className="fixed inset-x-0 bottom-0 z-30 border-t border-[var(--color-border)] bg-[var(--color-surface)]/95 backdrop-blur safe-bottom"
    >
      <ul className="mx-auto flex max-w-2xl">
        {TABS.map(({ to, label, icon: Icon, end }) => (
          <li key={to} className="flex-1">
            <NavLink
              to={to}
              end={end}
              className={({ isActive }) =>
                cn(
                  "flex min-h-14 flex-col items-center justify-center gap-0.5 text-xs",
                  isActive ? "text-[var(--color-accent)]" : "text-[var(--color-muted)]",
                )
              }
            >
              {({ isActive }) => (
                <>
                  <Icon className="size-5" aria-hidden />
                  <span>{label}</span>
                  {isActive ? <span className="sr-only">(aktuell sida)</span> : null}
                </>
              )}
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/**
 * A render error must not leave a white screen. Someone standing on a platform needs
 * either the app or a way back into it, never a blank page.
 */
class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Traveler crashed", error, info.componentStack);
  }

  override render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-4 px-6 text-center">
        <AlertTriangle className="size-8 text-[var(--color-warn)]" aria-hidden />
        <h1 className="text-lg font-semibold">Något gick sönder</h1>
        <p className="text-sm text-[var(--color-muted)]">{this.state.error.message}</p>
        <Button onClick={() => window.location.assign("/")}>Börja om</Button>
      </div>
    );
  }
}

export function App() {
  return (
    <ErrorBoundary>
      <main className="min-h-dvh">
        <Routes>
          <Route path="/" element={<PlanPage />} />
          <Route path="/stop/:siteId" element={<StopPage />} />
          <Route path="/nearby" element={<NearbyPage />} />
          <Route path="/disruptions" element={<DisruptionsPage />} />
          <Route
            path="*"
            element={
              <div className="mx-auto max-w-2xl px-4 py-16 text-center">
                <p className="text-sm text-[var(--color-muted)]">Sidan finns inte.</p>
              </div>
            }
          />
        </Routes>
      </main>
      <TabBar />
    </ErrorBoundary>
  );
}
