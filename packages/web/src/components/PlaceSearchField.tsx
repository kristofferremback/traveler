import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { Place } from "@traveler/shared";
import { LocateFixed, Loader2, X } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { formatDistance } from "@/lib/format";
import { MODE_ICON } from "@/lib/modes";
import { ModeChips } from "./LineBadge";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { cn } from "@/lib/utils";

type Props = {
  label: string;
  value: Place | null;
  onChange: (place: Place | null) => void;
  placeholder?: string;
  /** Offers a "use my position" control. Only worth showing on the origin field. */
  allowCurrentPosition?: boolean;
};

const DEBOUNCE_MS = 180;

/**
 * Typeahead for stops, addresses and points of interest.
 *
 * Built as a real combobox rather than a text field with a list under it: the roles and
 * `aria-activedescendant` are what let a screen reader announce the highlighted option
 * while focus stays in the input, and they are what make the arrow keys behave the way
 * anyone who has used a search box expects.
 */
export function PlaceSearchField({
  label,
  value,
  onChange,
  placeholder,
  allowCurrentPosition = false,
}: Props) {
  const [text, setText] = useState("");
  const [results, setResults] = useState<Place[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [locating, setLocating] = useState(false);

  const inputId = useId();
  const listId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  /**
   * The last value this field itself sent upward.
   *
   * The parent echoes every change back as a prop, so without this the sync effect
   * cannot tell "the form swapped the endpoints" from "the user just typed a character
   * over a selected stop". The second case deselects deliberately and must keep the
   * typed text; treating it like an external clear wiped the field on every keystroke.
   */
  const lastEmitted = useRef<Place | null>(value);
  const inputRef = useRef<HTMLInputElement>(null);

  /**
   * Mirror an externally driven `value` into the visible text.
   *
   * Swapping the endpoints, restoring a shared link, or navigating Back all change
   * `value` without the field being touched. Changes this field originated are skipped,
   * so typing over a selection is left alone.
   */
  useEffect(() => {
    if (value === lastEmitted.current) return;
    lastEmitted.current = value;
    setText(value ? value.name : "");
  }, [value]);

  useEffect(() => {
    const query = text.trim();
    if (query.length < 2 || value?.name === query) {
      setResults([]);
      setPending(false);
      setError(null);
      return;
    }

    const controller = new AbortController();
    setPending(true);
    const timer = setTimeout(async () => {
      try {
        const { places } = await api.searchPlaces({ q: query, limit: 12 }, controller.signal);
        setResults(places);
        setActive(0);
        setError(null);
        setOpen(true);
      } catch (err) {
        if (controller.signal.aborted) return;
        setError(err instanceof ApiError ? err.message : "Sökningen misslyckades.");
        setResults([]);
        // Open the list so the message is actually visible. A failure recorded into
        // state that nothing renders is the same as no failure handling at all.
        setOpen(true);
      } finally {
        if (!controller.signal.aborted) setPending(false);
      }
    }, DEBOUNCE_MS);

    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [text, value?.name]);

  // Clicking outside commits nothing and closes the list, matching every other
  // typeahead people use.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  const select = useCallback(
    (place: Place) => {
      lastEmitted.current = place;
      onChange(place);
      setText(place.name);
      setOpen(false);
      setResults([]);
    },
    [onChange],
  );

  const clear = () => {
    lastEmitted.current = null;
    onChange(null);
    setText("");
    setResults([]);
    setOpen(false);
    inputRef.current?.focus();
  };

  const useCurrentPosition = () => {
    if (!navigator.geolocation) {
      setError("Enheten delar ingen position.");
      setOpen(true);
      return;
    }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      async ({ coords }) => {
        try {
          const { place } = await api.locate({
            lat: coords.latitude,
            lon: coords.longitude,
          });
          if (place) {
            select(place);
          } else {
            setError("Hittade ingen adress för din position.");
            setOpen(true);
          }
        } catch {
          setError("Kunde inte slå upp din position.");
          setOpen(true);
        } finally {
          setLocating(false);
        }
      },
      () => {
        setLocating(false);
        setError("Position nekades.");
        setOpen(true);
      },
      { enableHighAccuracy: true, timeout: 8000 },
    );
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open && results.length > 0) {
        setOpen(true);
        return;
      }
      const delta = e.key === "ArrowDown" ? 1 : -1;
      setActive((i) => (i + delta + results.length) % Math.max(1, results.length));
      return;
    }
    if (e.key === "Enter" && open && results[active]) {
      e.preventDefault();
      select(results[active]);
      return;
    }
    if (e.key === "Escape" && open) {
      e.preventDefault();
      setOpen(false);
    }
  };

  const showList = open && (results.length > 0 || Boolean(error));

  return (
    <div ref={rootRef} className="relative">
      <label htmlFor={inputId} className="mb-1 block text-xs font-medium text-[var(--color-muted)]">
        {label}
      </label>

      <div className="relative flex items-center gap-1">
        <Input
          id={inputId}
          ref={inputRef}
          role="combobox"
          aria-expanded={showList}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={showList && results[active] ? `${listId}-${active}` : undefined}
          autoComplete="off"
          value={text}
          placeholder={placeholder}
          onChange={(e) => {
            setText(e.target.value);
            // Typing over a committed selection deselects it; the text stays.
            if (value) {
              lastEmitted.current = null;
              onChange(null);
            }
          }}
          onFocus={() => results.length > 0 && setOpen(true)}
          onKeyDown={onKeyDown}
          className={cn("pr-10", value && "border-[var(--color-accent)]")}
        />

        <div className="absolute right-1 flex items-center">
          {pending ? (
            <Loader2 className="mr-2 size-4 animate-spin text-[var(--color-muted)]" aria-hidden />
          ) : null}
          {text ? (
            <Button type="button" variant="ghost" size="icon" onClick={clear} aria-label={`Rensa ${label.toLowerCase()}`}>
              <X />
            </Button>
          ) : allowCurrentPosition ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={useCurrentPosition}
              disabled={locating}
              aria-label="Använd min position"
            >
              {locating ? <Loader2 className="animate-spin" /> : <LocateFixed />}
            </Button>
          ) : null}
        </div>
      </div>

      {/* Announced politely so a screen reader hears the result count without losing
          the character the user just typed. */}
      <span className="sr-only" role="status" aria-live="polite">
        {showList ? `${results.length} träffar` : ""}
      </span>

      {showList ? (
        <ul
          id={listId}
          role="listbox"
          aria-label={`Förslag för ${label.toLowerCase()}`}
          className="absolute z-30 mt-1 max-h-72 w-full overflow-y-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] shadow-xl"
        >
          {error ? (
            <li className="px-3 py-3 text-sm text-[var(--color-danger)]">{error}</li>
          ) : null}
          {results.map((place, index) => {
            const Icon = MODE_ICON[place.modes[0] ?? "UNKNOWN"];
            const distance = formatDistance(place.distanceMetres);
            return (
              <li
                key={place.id}
                id={`${listId}-${index}`}
                role="option"
                aria-selected={index === active}
                onPointerDown={(e) => {
                  e.preventDefault();
                  select(place);
                }}
                onPointerEnter={() => setActive(index)}
                className={cn(
                  "flex min-h-12 cursor-pointer items-center gap-3 px-3 py-2",
                  index === active && "bg-[var(--color-surface-2)]",
                )}
              >
                <Icon className="size-4 shrink-0 text-[var(--color-muted)]" aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm">{place.name}</span>
                  {place.locality ? (
                    <span className="block truncate text-xs text-[var(--color-muted)]">
                      {place.locality}
                    </span>
                  ) : null}
                </span>
                {distance ? (
                  <span className="text-xs text-[var(--color-muted)]">{distance}</span>
                ) : null}
                <ModeChips modes={place.modes} />
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
