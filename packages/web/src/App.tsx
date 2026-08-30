import { Component, Suspense, lazy, type ErrorInfo, type ReactNode } from "react";
import { NavLink, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { AlertTriangle, MapPin, RefreshCw, Search, Settings, TriangleAlert } from "lucide-react";
import { CommutePage } from "./routes/CommutePage";
import { SignInPage } from "./routes/SignInPage";
import { Button } from "./components/ui/button";
import { useNewVersion } from "./hooks/useNewVersion";
import { useSession } from "./lib/auth";
import { cn } from "./lib/utils";

/**
 * The two screens someone can arrive on are in the app's own chunk; every other screen
 * is fetched when it is opened.
 *
 * They all shipped together before, so signing in cost a parse of eleven screens and of
 * the QR code library that only the settings page uses. A tab is one short fetch from
 * the same origin, and the browser keeps it for the rest of the session.
 */
const PlanPage = lazy(() => import("./routes/PlanPage").then((m) => ({ default: m.PlanPage })));
const StopPage = lazy(() => import("./routes/StopPage").then((m) => ({ default: m.StopPage })));
const NearbyPage = lazy(() =>
  import("./routes/NearbyPage").then((m) => ({ default: m.NearbyPage })),
);
const DisruptionsPage = lazy(() =>
  import("./routes/DisruptionsPage").then((m) => ({ default: m.DisruptionsPage })),
);
const InvitePage = lazy(() => import("./routes/InvitePage").then((m) => ({ default: m.InvitePage })));
const SettingsPage = lazy(() =>
  import("./routes/SettingsPage").then((m) => ({ default: m.SettingsPage })),
);
const PlacesPage = lazy(() => import("./routes/PlacesPage").then((m) => ({ default: m.PlacesPage })));
const NewPlacePage = lazy(() =>
  import("./routes/NewPlacePage").then((m) => ({ default: m.NewPlacePage })),
);
const PlacePage = lazy(() => import("./routes/PlacePage").then((m) => ({ default: m.PlacePage })));

/** Nothing to read yet: the same pause as before the session is known. */
const loading = (
  <div className="flex min-h-dvh items-center justify-center" role="status" aria-label="Laddar" />
);

const TABS = [
  { to: "/", label: "Res", icon: Search, end: true },
  { to: "/nearby", label: "Nära", icon: MapPin, end: false },
  { to: "/disruptions", label: "Trafikläget", icon: TriangleAlert, end: false },
  { to: "/settings", label: "Mer", icon: Settings, end: false },
];

function TabBar() {
  return (
    <nav
      aria-label="Huvudmeny"
      className="fixed inset-x-0 bottom-[var(--browser-chrome)] z-30 border-t border-[var(--color-border)] bg-[var(--color-surface)]/95 backdrop-blur safe-bottom"
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
 * The one thing that tells a long-lived tab it is out of date.
 *
 * It floats rather than taking a row of its own, so nothing on any screen moves when it
 * appears, and it does not reload by itself: someone reading the trip they are about to
 * take should not have it vanish. It is gone the moment it is used, and it can only
 * appear after an actual deploy.
 */
function ReloadPrompt() {
  const stale = useNewVersion();
  if (!stale) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 z-40 flex justify-center px-3 above-tabs">
      <button
        type="button"
        onClick={() => window.location.reload()}
        className="pointer-events-auto flex min-h-11 items-center gap-2 rounded-full border border-[var(--color-border)] bg-[var(--color-surface)]/95 px-4 text-sm font-medium shadow-lg backdrop-blur"
      >
        <RefreshCw className="size-4 text-[var(--color-accent)]" aria-hidden />
        Ny version, ladda om
      </button>
    </div>
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

/** Routes that make sense without an account. Everything else needs one. */
const PUBLIC_ROUTES = new Set(["/signin", "/invite"]);

export function App() {
  const { data: session, isPending } = useSession();
  const location = useLocation();
  const isPublic = PUBLIC_ROUTES.has(location.pathname);

  /**
   * Nothing is rendered until the session is known.
   *
   * Rendering the app first and redirecting on the answer shows a flash of the plan form
   * to someone who is signed out, and rendering the sign-in page first flashes it at
   * someone who is signed in. Both look like a bug, so neither is shown until the
   * question is settled.
   */
  if (isPending) return loading;

  if (!session && !isPublic) {
    return <Navigate to="/signin" replace />;
  }
  if (session && location.pathname === "/signin") {
    return <Navigate to="/" replace />;
  }

  return (
    <ErrorBoundary>
      <main className="min-h-dvh">
        <Suspense fallback={loading}>
          <Routes>
            <Route path="/" element={<CommutePage />} />
            <Route path="/plan" element={<PlanPage />} />
            <Route path="/stop/:siteId" element={<StopPage />} />
            <Route path="/nearby" element={<NearbyPage />} />
            <Route path="/disruptions" element={<DisruptionsPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/places" element={<PlacesPage />} />
            <Route path="/places/new" element={<NewPlacePage />} />
            <Route path="/places/:id" element={<PlacePage />} />
            <Route path="/signin" element={<SignInPage />} />
            <Route path="/invite" element={<InvitePage />} />
            <Route
              path="*"
              element={
                <div className="mx-auto max-w-2xl px-4 py-16 text-center">
                  <p className="text-sm text-[var(--color-muted)]">Sidan finns inte.</p>
                </div>
              }
            />
          </Routes>
        </Suspense>
      </main>
      {/* The sign-in and welcome pages are their own full screen; a tab bar there would
          offer four places to go before there is anywhere to go. */}
      {isPublic ? null : (
        <>
          <TabBar />
          <ReloadPrompt />
        </>
      )}
    </ErrorBoundary>
  );
}
