import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { authClient, authErrorMessage } from "@/lib/auth";
import { Button } from "@/components/ui/button";

/**
 * The whole sign-in surface: one button.
 *
 * There is no email field because there is nothing to do with an address here -- an
 * account is created by an invite link, and after that the passkey is the credential.
 * A form that collected an address and then said "check your email" would be a lie.
 */
export function SignInPage() {
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function signIn() {
    setBusy(true);
    setError(null);
    try {
      const result = await authClient.signIn.passkey();
      if (result?.error) {
        setError(
          authErrorMessage(result.error, "Inloggningen avbröts. Försök igen."),
        );
        return;
      }
      navigate("/", { replace: true });
    } catch {
      // The browser throws rather than returning an error when the passkey prompt is
      // dismissed, or when the device has no passkey for this site at all.
      setError("Ingen passkey kunde användas. Öppna din inbjudningslänk om du är ny.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-6 px-6 py-12">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold">Traveler</h1>
        <p className="text-sm text-[var(--color-muted)]">
          Reseplaneraren för SL.
        </p>
      </header>

      <Button size="lg" onClick={signIn} disabled={busy} className="w-full">
        {busy ? "Loggar in…" : "Logga in med passkey"}
      </Button>

      {error ? (
        <p role="alert" className="text-sm text-[var(--color-danger)]">
          {error}
        </p>
      ) : null}

      <p className="text-sm text-[var(--color-muted)]">
        Ny här? Öppna din inbjudningslänk.
      </p>
    </div>
  );
}
