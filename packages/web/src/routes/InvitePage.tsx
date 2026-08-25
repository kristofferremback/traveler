import { useLocation } from "react-router-dom";
import { Button } from "@/components/ui/button";

/**
 * Where an invite link lands, one tap short of signing in.
 *
 * Chat apps and mail clients fetch every link they are shown to build a preview, and the
 * verify endpoint signs in whoever fetches it, so a link that pointed straight at it was
 * spent by the preview before the person saw it. The token therefore travels in the URL
 * fragment, which browsers never send to a server and previewers never see, and the
 * verify call only happens when a human presses the button.
 */
export function InvitePage() {
  const { hash } = useLocation();
  const token = new URLSearchParams(hash.replace(/^#/, "")).get("token");

  if (!token) {
    return (
      <div className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-6 px-6 py-12">
        <h1 className="text-2xl font-semibold">Länken är ofullständig</h1>
        <p role="alert" className="text-sm text-[var(--color-muted)]">
          Kopiera hela inbjudningslänken och försök igen.
        </p>
      </div>
    );
  }

  // A real navigation rather than a fetch: the verify endpoint answers with a redirect
  // and a session cookie, which the browser handles for us this way.
  const verifyUrl = `/api/auth/magic-link/verify?token=${encodeURIComponent(token)}&callbackURL=${encodeURIComponent("/signin")}`;

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-6 px-6 py-12">
      <header className="space-y-3">
        <h1 className="text-2xl font-semibold">Du är inbjuden</h1>
        <p className="text-sm text-[var(--color-muted)]">
          Länken loggar in dig en gång. Nästa gång räcker det med Google och samma adress.
        </p>
      </header>
      <Button size="lg" className="w-full" onClick={() => window.location.assign(verifyUrl)}>
        Fortsätt
      </Button>
    </div>
  );
}
