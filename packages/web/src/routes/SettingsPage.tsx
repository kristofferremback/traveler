import { useEffect, useId, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import QRCode from "qrcode";
import type { CommuteSettings } from "@traveler/shared";
import { ChevronRight } from "lucide-react";
import { api } from "@/lib/api";
import { authClient, authErrorMessage } from "@/lib/auth";
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

/**
 * The five walking settings, as numbers with units in their labels.
 *
 * Sliders would need a value readout anyway and are hard to hit precisely while
 * walking; a number input keeps the keyboard's own stepper and reads back exactly what
 * is stored. The bounds match the schema's, so the server never has to reject one of
 * these for being out of range.
 */
const WALK_FIELDS = [
  { key: "speedKmh", label: "Gånghastighet (km/h)", step: 0.5, min: 2, max: 10 },
  { key: "maxWalkMinutes", label: "Längsta promenad (min)", step: 1, min: 1, max: 45 },
  { key: "transferPenaltyMinutes", label: "Straff per byte (min)", step: 1, min: 0, max: 60 },
  { key: "walkMultiplier", label: "Vikt för gångtid", step: 0.1, min: 0, max: 5 },
  { key: "catchBufferMinutes", label: "Marginal till avgång (min)", step: 0.5, min: 0, max: 15 },
] as const satisfies readonly {
  key: keyof CommuteSettings;
  label: string;
  step: number;
  min: number;
  max: number;
}[];

function WalkSettingsCard() {
  const queryClient = useQueryClient();
  const fieldId = useId();
  const query = useQuery({
    queryKey: ["settings"],
    queryFn: ({ signal }) => api.settings.get(signal),
  });
  const current = query.data?.settings;

  // Drafts exist so a half-typed "1" in the speed field is not sent as 1 km/h. The
  // server's answer replaces them, so what is on screen is always what is stored.
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!current) return;
    setDrafts(Object.fromEntries(WALK_FIELDS.map((f) => [f.key, String(current[f.key])])));
  }, [current]);

  const save = useMutation({
    mutationFn: (patch: Partial<CommuteSettings>) => api.settings.put(patch),
    onSuccess: (data) => queryClient.setQueryData(["settings"], data),
  });

  function commit(key: keyof CommuteSettings) {
    if (!current) return;
    const value = Number(drafts[key]);
    if (!Number.isFinite(value) || value === current[key]) return;
    save.mutate({ [key]: value });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Promenad</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-[var(--color-muted)]">
          Hur du går avgör vilka hållplatser som räknas som dina och vilka resor som
          rankas högst. Ändringarna sparas när du lämnar fältet.
        </p>

        {query.isPending ? <Skeleton className="h-32 w-full" /> : null}

        {current ? (
          <form
            className="grid gap-3 sm:grid-cols-2"
            onSubmit={(e) => {
              e.preventDefault();
              for (const field of WALK_FIELDS) commit(field.key);
            }}
          >
            {WALK_FIELDS.map((field) => (
              <div key={field.key}>
                <label
                  htmlFor={`${fieldId}-${field.key}`}
                  className="mb-1 block text-xs font-medium text-[var(--color-muted)]"
                >
                  {field.label}
                </label>
                <Input
                  id={`${fieldId}-${field.key}`}
                  type="number"
                  inputMode="decimal"
                  step={field.step}
                  min={field.min}
                  max={field.max}
                  value={drafts[field.key] ?? ""}
                  onChange={(e) =>
                    setDrafts((d) => ({ ...d, [field.key]: e.target.value }))
                  }
                  onBlur={() => commit(field.key)}
                />
              </div>
            ))}
            {/* Submit exists for the keyboard: Enter in a number field should save the
                field it is in rather than doing nothing. */}
            <button type="submit" className="sr-only">
              Spara promenadinställningar
            </button>
          </form>
        ) : null}

        {save.isError ? (
          <p role="alert" className="text-sm text-[var(--color-danger)]">
            {save.error.message}
          </p>
        ) : null}
      </CardContent>
    </Card>
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
        <CardContent className="p-0">
          <Link
            to="/places"
            className="flex min-h-14 items-center justify-between gap-2 p-4"
          >
            <span className="text-sm font-semibold">Platser</span>
            <ChevronRight className="size-4 text-[var(--color-muted)]" aria-hidden />
          </Link>
        </CardContent>
      </Card>

      <WalkSettingsCard />

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
