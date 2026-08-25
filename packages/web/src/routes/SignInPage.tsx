import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { authClient, authErrorMessage } from "@/lib/auth";
import { Button } from "@/components/ui/button";

/**
 * What Better Auth puts in ?error= when it sends someone back here, in words.
 *
 * Two of these are ours: NOT_INVITED comes from the account-creation hook, INVALID_TOKEN
 * from a spent or expired invite link. Anything else is Google's, and "try again" is
 * the honest advice for all of them.
 */
const ERRORS: Record<string, string> = {
  NOT_INVITED: "Ingen inbjudan finns för den här adressen. Be någon som är inne att bjuda in dig.",
  INVALID_TOKEN: "Inbjudningslänken har redan använts eller gått ut. Be om en ny.",
  EXPIRED_TOKEN: "Inbjudningslänken har gått ut. Be om en ny.",
};

/**
 * The whole sign-in surface: Google, when the server has a client for it.
 *
 * There is no email field because there is nothing to do with an address here: the
 * invite someone minted for it is what lets it in, and Google is what proves it is
 * yours. Without a Google client the invite link is the only way and the page says so.
 */
export function SignInPage() {
  const [params] = useSearchParams();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const methods = useQuery({ queryKey: ["sign-in-methods"], queryFn: api.signInMethods });

  const code = params.get("error");
  const redirectError = code ? (ERRORS[code] ?? "Inloggningen gick inte. Försök igen.") : null;

  async function signInWithGoogle() {
    setBusy(true);
    setError(null);
    const result = await authClient.signIn.social({
      provider: "google",
      callbackURL: "/",
      errorCallbackURL: "/signin",
    });
    if (result?.error) {
      setError(authErrorMessage(result.error, "Inloggningen gick inte. Försök igen."));
      setBusy(false);
    }
    // Otherwise the browser is on its way to Google; nothing more to do here.
  }

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-6 px-6 py-12">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold">Traveler</h1>
        <p className="text-sm text-[var(--color-muted)]">Reseplaneraren för SL.</p>
      </header>

      {methods.data?.google ? (
        <Button size="lg" onClick={signInWithGoogle} disabled={busy} className="w-full">
          {busy ? "Skickar dig till Google…" : "Logga in med Google"}
        </Button>
      ) : null}

      {error || redirectError ? (
        <p role="alert" className="text-sm text-[var(--color-danger)]">
          {error ?? redirectError}
        </p>
      ) : null}

      <p className="text-sm text-[var(--color-muted)]">
        {methods.data?.google
          ? "Ny här? Logga in med Google med adressen du blev inbjuden på, eller öppna din inbjudningslänk."
          : "Öppna din inbjudningslänk för att logga in."}
      </p>
    </div>
  );
}
