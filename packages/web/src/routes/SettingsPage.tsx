import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import QRCode from "qrcode";
import { api } from "@/lib/api";
import { authClient, authErrorMessage, deviceLabel } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

function formatDate(value: string | null): string {
  if (!value) return "okänt datum";
  return new Intl.DateTimeFormat("sv-SE", {
    dateStyle: "medium",
    timeZone: "Europe/Stockholm",
  }).format(new Date(value));
}

/**
 * A value that exists to be copied out of the app: an invite link, an API key.
 *
 * Read-only rather than disabled, so it can still be selected and copied by hand on a
 * browser that refuses the clipboard API -- which is every browser when the page is not
 * a secure context.
 */
function CopyField({ label, value }: { label: string; value: string }) {
  const ref = useRef<HTMLInputElement>(null);
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      ref.current?.select();
    }
  }

  return (
    <div className="flex gap-2">
      <Input ref={ref} readOnly value={value} aria-label={label} onFocus={(e) => e.currentTarget.select()} />
      <Button variant="secondary" onClick={copy} className="shrink-0">
        {copied ? "Kopierad" : "Kopiera"}
      </Button>
    </div>
  );
}

/** The invite link as a QR code, so the next device can be a phone across the table. */
function InviteQr({ url }: { url: string }) {
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    // Rendered light-on-dark independent of the theme: a scanner wants contrast, and a
    // dark-mode QR code with inverted quiet zone is the one that will not scan.
    QRCode.toDataURL(url, { margin: 2, width: 240, color: { dark: "#000000", light: "#ffffff" } })
      .then((data) => {
        if (!cancelled) setSrc(data);
      })
      .catch(() => {
        if (!cancelled) setSrc(null);
      });
    return () => {
      cancelled = true;
    };
  }, [url]);

  if (!src) return null;
  return (
    <img
      src={src}
      alt="QR-kod för inbjudningslänken"
      width={240}
      height={240}
      className="rounded-lg bg-white p-2"
    />
  );
}

export function SettingsPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const me = useQuery({ queryKey: ["me"], queryFn: ({ signal }) => api.me(signal) });

  const [error, setError] = useState<string | null>(null);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteName, setInviteName] = useState("");
  const [invite, setInvite] = useState<{ url: string; email: string; expiresAt: string } | null>(
    null,
  );
  const [keyName, setKeyName] = useState("");
  // The full key is returned once and never again; it lives here until the page is left.
  const [freshKey, setFreshKey] = useState<string | null>(null);

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["me"] });

  const createInvite = useMutation({
    mutationFn: () =>
      api.createInvite({
        email: inviteEmail.trim(),
        ...(inviteName.trim() ? { name: inviteName.trim() } : {}),
      }),
    onSuccess: (result) => {
      setInvite(result);
      setInviteEmail("");
      setInviteName("");
      setError(null);
    },
    onError: (e: Error) => setError(e.message),
  });

  const createKey = useMutation({
    mutationFn: async () => {
      const result = await authClient.apiKey.create({ name: keyName.trim() || "Nyckel" });
      if (result.error) throw new Error(authErrorMessage(result.error, "Nyckeln kunde inte skapas."));
      return result.data;
    },
    onSuccess: (data) => {
      setFreshKey(data?.key ?? null);
      setKeyName("");
      setError(null);
      void refresh();
    },
    onError: (e: Error) => setError(e.message),
  });

  async function addPasskey() {
    setError(null);
    try {
      const result = await authClient.passkey.addPasskey({ name: deviceLabel() });
      if (result?.error) {
        setError(authErrorMessage(result.error, "Passkeyn kunde inte sparas."));
        return;
      }
      void refresh();
    } catch {
      setError("Passkeyn kunde inte sparas.");
    }
  }

  async function removePasskey(id: string, name: string | null) {
    if (!window.confirm(`Ta bort passkeyn ${name ?? "utan namn"}?`)) return;
    await authClient.passkey.deletePasskey({ id });
    void refresh();
  }

  async function removeKey(id: string, name: string | null) {
    if (!window.confirm(`Ta bort nyckeln ${name ?? "utan namn"}?`)) return;
    await authClient.apiKey.delete({ keyId: id });
    void refresh();
  }

  async function logOut() {
    await authClient.signOut();
    navigate("/signin", { replace: true });
  }

  return (
    <div className="mx-auto w-full max-w-2xl space-y-4 px-4 pb-24">
      <header className="pb-1 pt-3 safe-top">
        <h1 className="text-lg font-semibold">Mer</h1>
      </header>

      {error ? (
        <p role="alert" className="text-sm text-[var(--color-danger)]">
          {error}
        </p>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Konto</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {me.isPending ? (
            <Skeleton className="h-5 w-48" />
          ) : (
            <p className="text-sm text-[var(--color-muted)]">{me.data?.user.email}</p>
          )}
          <Button variant="outline" onClick={logOut}>
            Logga ut
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Passkeys</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {me.isPending ? (
            <Skeleton className="h-5 w-full" />
          ) : me.data?.passkeys.length ? (
            <ul className="divide-y divide-[var(--color-border)]">
              {me.data.passkeys.map((passkey) => (
                <li key={passkey.id} className="flex items-center justify-between gap-2 py-2">
                  <span className="text-sm">
                    {passkey.name ?? "Utan namn"}
                    <span className="block text-xs text-[var(--color-muted)]">
                      tillagd {formatDate(passkey.createdAt)}
                    </span>
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => removePasskey(passkey.id, passkey.name)}
                  >
                    Ta bort
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-[var(--color-muted)]">
              Inga passkeys än. Utan en behöver du en ny inbjudningslänk för att logga in.
            </p>
          )}
          <Button variant="secondary" onClick={addPasskey}>
            Lägg till passkey
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Bjud in</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-[var(--color-muted)]">
            Länken fungerar en gång och i sju dagar. Inget mejl skickas, så du får skicka
            den vidare själv.
          </p>
          <Input
            type="email"
            value={inviteEmail}
            onChange={(e) => setInviteEmail(e.target.value)}
            placeholder="namn@exempel.se"
            aria-label="E-postadress"
          />
          <Input
            value={inviteName}
            onChange={(e) => setInviteName(e.target.value)}
            placeholder="Namn (valfritt)"
            aria-label="Namn"
          />
          <Button
            onClick={() => createInvite.mutate()}
            disabled={!inviteEmail.trim() || createInvite.isPending}
          >
            {createInvite.isPending ? "Skapar…" : "Skapa inbjudan"}
          </Button>

          {invite ? (
            <div className="space-y-3 pt-1">
              <CopyField label="Inbjudningslänk" value={invite.url} />
              <InviteQr url={invite.url} />
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>API-nycklar</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-[var(--color-muted)]">
            För program som läser Traveler åt dig:{" "}
            <code className="break-all">curl -H "x-api-key: …" {window.location.origin}/api/commute?…</code>
          </p>
          {me.isPending ? (
            <Skeleton className="h-5 w-full" />
          ) : me.data?.apiKeys.length ? (
            <ul className="divide-y divide-[var(--color-border)]">
              {me.data.apiKeys.map((key) => (
                <li key={key.id} className="flex items-center justify-between gap-2 py-2">
                  <span className="text-sm">
                    {key.name ?? "Utan namn"}
                    <span className="block text-xs text-[var(--color-muted)]">
                      {key.start ? `${key.start}… · ` : ""}skapad {formatDate(key.createdAt)} ·{" "}
                      {key.lastRequest ? `senast använd ${formatDate(key.lastRequest)}` : "aldrig använd"}
                    </span>
                  </span>
                  <Button variant="ghost" size="sm" onClick={() => removeKey(key.id, key.name)}>
                    Ta bort
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-[var(--color-muted)]">Inga nycklar än.</p>
          )}

          <Input
            value={keyName}
            onChange={(e) => setKeyName(e.target.value)}
            placeholder="Vad ska nyckeln användas till?"
            aria-label="Namn på nyckeln"
          />
          <Button onClick={() => createKey.mutate()} disabled={createKey.isPending}>
            {createKey.isPending ? "Skapar…" : "Skapa nyckel"}
          </Button>

          {freshKey ? (
            <div className="space-y-2 pt-1">
              <p className="text-sm">Kopiera nyckeln nu. Den visas inte igen.</p>
              <CopyField label="API-nyckel" value={freshKey} />
            </div>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
