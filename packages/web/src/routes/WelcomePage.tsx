import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { authClient, authErrorMessage, deviceLabel } from "@/lib/auth";
import { Button } from "@/components/ui/button";

/**
 * Where an invite link lands.
 *
 * The invite already signed you in, so this is not a step you have to complete -- it is
 * the one moment where adding a passkey makes obvious sense, because the link that got
 * you here is now spent and there is otherwise nothing to sign in with next time.
 */
export function WelcomePage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Better Auth redirects here with ?error= when the token is spent or expired, so this
  // page is also where a re-used link is explained.
  if (params.get("error")) {
    return (
      <div className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-6 px-6 py-12">
        <h1 className="text-2xl font-semibold">Länken fungerade inte</h1>
        <p role="alert" className="text-sm text-[var(--color-muted)]">
          Länken har redan använts eller gått ut. Be om en ny.
        </p>
        <Link to="/signin" className="text-sm text-[var(--color-accent)] underline">
          Till inloggningen
        </Link>
      </div>
    );
  }

  async function addPasskey() {
    setBusy(true);
    setError(null);
    try {
      const result = await authClient.passkey.addPasskey({ name: deviceLabel() });
      if (result?.error) {
        setError(authErrorMessage(result.error, "Passkeyn kunde inte sparas."));
        return;
      }
      navigate("/", { replace: true });
    } catch {
      setError("Passkeyn kunde inte sparas. Du kan lägga till den senare under Mer.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-6 px-6 py-12">
      <header className="space-y-3">
        <h1 className="text-2xl font-semibold">Välkommen</h1>
        <p className="text-sm text-[var(--color-muted)]">
          Med en passkey loggar du in med fingeravtryck eller ansikte nästa gång, utan
          lösenord och utan en ny länk.
        </p>
      </header>

      <Button size="lg" onClick={addPasskey} disabled={busy} className="w-full">
        {busy ? "Lägger till…" : "Lägg till passkey"}
      </Button>

      {error ? (
        <p role="alert" className="text-sm text-[var(--color-danger)]">
          {error}
        </p>
      ) : null}

      <Link
        to="/"
        replace
        className="inline-flex min-h-11 items-center justify-center text-sm text-[var(--color-muted)] underline"
      >
        Hoppa över
      </Link>
    </div>
  );
}
