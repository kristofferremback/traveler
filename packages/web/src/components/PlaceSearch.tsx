import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
} from "react";
import type { Place, SavedPlace } from "@traveler/shared";
import { ChevronLeft, Loader2, LocateFixed, Search, X, type LucideProps } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { formatDistance } from "@/lib/format";
import { MODE_ICON } from "@/lib/modes";
import { KIND_ICON } from "@/lib/savedPlaces";
import { ModeChips } from "./LineBadge";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { cn } from "@/lib/utils";

/** What the screen hands back: where you are, a place you saved, or one it found. */
export type PlaceChoice =
  | { kind: "position" }
  | { kind: "saved"; place: SavedPlace }
  | { kind: "place"; place: Place };

const DEBOUNCE_MS = 180;
/** Shorter than this matches half of Stockholm, so the shortcuts stay up instead. */
const MIN_QUERY = 2;

type Option = {
  key: string;
  icon: ComponentType<LucideProps>;
  name: string;
  detail: string | null;
  meta?: ReactNode;
  choice: PlaceChoice;
};

/**
 * Choosing a place, wherever the app needs one.
 *
 * The field is the first thing under the header and everything else is under it, which
 * is the whole point: an on-screen keyboard covers the bottom of the screen, so a
 * search field near the bottom hides itself and its own suggestions the moment it is
 * used. Nothing is placed below the list, and the list is sized to the part of the
 * screen the keyboard leaves.
 *
 * One list, one shape of row, one position on screen. Empty, it offers your position
 * and your saved places; typed into, the same list holds the matches. The region does
 * not resize between those states, so the rows a thumb is aiming at do not move.
 *
 * A native `<dialog>`, opened modally, so the browser owns the focus trap, the
 * inertness of the page behind it and Escape. Escape is intercepted only to route the
 * close through the caller, so dismissing it and pressing Back are the same action.
 */
export function PlaceSearch({
  title,
  saved = [],
  currentPosition = "off",
  focusField = false,
  footer,
  onPick,
  onClose,
}: {
  /** The question in the header, and the dialog's accessible name. */
  title: string;
  /** Offered before anything is typed. A commute is the same two places most days. */
  saved?: SavedPlace[];
  /**
   * Whether "Min position" is offered, and what it means. "live" hands the choice
   * straight back, for a screen that plans from wherever the phone is at the moment it
   * searches; "address" looks up the place you are standing in, for a screen that
   * stores one.
   */
  currentPosition?: "off" | "live" | "address";
  /**
   * Opens the keyboard with the screen. For a screen whose list is empty until
   * something is typed; where saved places are on offer the answer is usually one tap
   * away, and a keyboard over them would be a tap to put it away again.
   */
  focusField?: boolean;
  /** Sits under the shortcuts, inside the scrolling list so the keyboard cannot cover it. */
  footer?: ReactNode;
  onPick: (choice: PlaceChoice) => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();

  const [text, setText] = useState("");
  const [results, setResults] = useState<Place[]>([]);
  const [active, setActive] = useState(0);
  /**
   * Whether the active row is painted.
   *
   * On a freshly opened screen it is not: a highlighted first row with nobody's finger
   * near it reads as a stuck hover on a phone. Arrowing, hovering or searching all mean
   * someone is moving through the list, and then the highlight has to be visible.
   */
  const [navigating, setNavigating] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [locating, setLocating] = useState(false);

  const query = text.trim();
  const searching = query.length >= MIN_QUERY;

  const shortcuts: Option[] = [
    ...(currentPosition !== "off"
      ? [
          {
            key: "me",
            icon: LocateFixed,
            name: "Min position",
            detail: null,
            choice: { kind: "position" } as const,
          },
        ]
      : []),
    ...saved.map((place) => ({
      key: `saved-${place.id}`,
      icon: KIND_ICON[place.kind],
      name: place.label,
      detail: place.name,
      choice: { kind: "saved", place } as const,
    })),
  ];

  const found: Option[] = results.map((place) => ({
    key: place.id,
    icon: MODE_ICON[place.modes[0] ?? "UNKNOWN"],
    name: place.name,
    detail: place.locality,
    meta: (
      <>
        {formatDistance(place.distanceMetres) ? (
          <span className="text-xs text-[var(--color-muted)]">
            {formatDistance(place.distanceMetres)}
          </span>
        ) : null}
        <ModeChips modes={place.modes} />
      </>
    ),
    choice: { kind: "place", place } as const,
  }));

  const options = searching ? found : shortcuts;

  useEffect(() => {
    const node = dialog.current;
    if (node && !node.open) node.showModal();
    if (focusField) inputRef.current?.focus();
  }, [focusField]);

  useEffect(() => {
    if (!searching) {
      setResults([]);
      setPending(false);
      setError(null);
      return;
    }

    const controller = new AbortController();
    setPending(true);
    const timer = setTimeout(async () => {
      try {
        const { places } = await api.searchPlaces({ q: query, limit: 20 }, controller.signal);
        setResults(places);
        setActive(0);
        setError(null);
      } catch (err) {
        if (controller.signal.aborted) return;
        setError(err instanceof ApiError ? err.message : "Sökningen misslyckades.");
        setResults([]);
      } finally {
        if (!controller.signal.aborted) setPending(false);
      }
    }, DEBOUNCE_MS);

    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [query, searching]);

  const pick = useCallback(
    (choice: PlaceChoice) => {
      if (choice.kind !== "position" || currentPosition === "live") {
        onPick(choice);
        return;
      }
      // Looking up the address you are standing in happens here rather than in every
      // screen that offers the row, along with the two ways it fails.
      if (!navigator.geolocation) {
        setError("Enheten delar ingen position.");
        return;
      }
      setLocating(true);
      navigator.geolocation.getCurrentPosition(
        async ({ coords }) => {
          try {
            const { place } = await api.locate({ lat: coords.latitude, lon: coords.longitude });
            if (place) onPick({ kind: "place", place });
            else setError("Hittade ingen adress för din position.");
          } catch {
            setError("Kunde inte slå upp din position.");
          } finally {
            setLocating(false);
          }
        },
        () => {
          setLocating(false);
          setError("Position nekades.");
        },
        { enableHighAccuracy: true, timeout: 8000 },
      );
    },
    [onPick, currentPosition],
  );

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (options.length === 0) return;
      const delta = e.key === "ArrowDown" ? 1 : -1;
      setNavigating(true);
      setActive((i) => (i + delta + options.length) % options.length);
      return;
    }
    if (e.key === "Enter" && options[active]) {
      e.preventDefault();
      pick(options[active]!.choice);
    }
  };

  const box = useVisualViewport();
  // Only the phone needs the measured height: a keyboard is what makes the visual
  // viewport differ from the layout one, and a desktop dialog is a panel, not a screen.
  const phone = box.width < 640;

  return (
    <dialog
      ref={dialog}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      aria-label={title}
      style={phone ? { height: box.height, transform: `translateY(${box.offsetTop}px)` } : undefined}
      className={cn(
        // A dialog's own max-height is "the viewport less a margin", which would leave
        // the bottom of the list floating above the tab bar rather than covering it.
        "m-0 flex h-full max-h-none w-full max-w-none flex-col overflow-hidden border-0 bg-[var(--color-bg)] text-[var(--color-fg)] backdrop:bg-black/50",
        "sm:mx-auto sm:my-[8dvh] sm:h-[min(34rem,84dvh)] sm:max-w-md sm:rounded-[var(--radius-card)] sm:border sm:border-[var(--color-border)] sm:bg-[var(--color-surface)]",
      )}
    >
      <div className="flex shrink-0 items-center gap-1 px-2 pb-1 pt-2 safe-top sm:pt-2">
        <Button type="button" variant="ghost" size="icon" onClick={onClose} aria-label="Stäng">
          <ChevronLeft />
        </Button>
        <h2 className="min-w-0 flex-1 truncate text-[15px] font-semibold">{title}</h2>
      </div>

      <div className="relative shrink-0 px-3 pb-2">
        {/* The spinner takes the search icon's place rather than the clear button's:
            a control that disappears while you type is a control you cannot aim at. */}
        {pending || locating ? (
          <Loader2
            className="absolute left-6 top-1/2 size-4 -translate-y-1/2 animate-spin text-[var(--color-muted)]"
            aria-hidden
          />
        ) : (
          <Search
            className="pointer-events-none absolute left-6 top-1/2 size-4 -translate-y-1/2 text-[var(--color-muted)]"
            aria-hidden
          />
        )}
        <Input
          ref={inputRef}
          role="combobox"
          aria-label="Sök hållplats eller adress"
          aria-expanded={options.length > 0}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={options[active] ? `${listId}-${active}` : undefined}
          autoComplete="off"
          enterKeyHint="search"
          value={text}
          placeholder="Slussen, Jarlaberg, Storgatan 1"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          className="rounded-full bg-[var(--color-surface-2)] pl-10 pr-10"
        />
        <div className="absolute right-5 top-1/2 flex -translate-y-1/2 items-center">
          {text ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-8"
              onClick={() => {
                setText("");
                inputRef.current?.focus();
              }}
              aria-label="Rensa sökningen"
            >
              <X />
            </Button>
          ) : null}
        </div>
      </div>

      {/* Announced politely so a screen reader hears the count without losing the
          character that was just typed. */}
      <span className="sr-only" role="status" aria-live="polite">
        {searching ? `${options.length} träffar` : ""}
      </span>

      {/* The one region that changes. Its size does not: everything above it is pinned,
          nothing sits below it, and it scrolls inside itself. */}
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pb-3">
        {error ? (
          <p role="alert" className="px-3 py-3 text-sm text-[var(--color-danger)]">
            {error}
          </p>
        ) : null}

        <ul id={listId} role="listbox" aria-label={title}>
          {options.map((option, index) => (
            <li
              key={option.key}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={index === active}
              // Keeps focus in the field: a blur would close the keyboard and shift
              // everything under the thumb mid-tap. The click still fires, which is what
              // activates the row, including for a screen reader's own tap.
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => pick(option.choice)}
              onPointerEnter={() => {
                setNavigating(true);
                setActive(index);
              }}
              className={cn(
                // px-3 + gap-3 puts a row's icon and name on the field's own icon and
                // text, so the list reads as one column with the field above it.
                "flex min-h-14 cursor-pointer items-center gap-3 rounded-xl px-3",
                index === active && (navigating || searching) && "bg-[var(--color-surface-2)]",
              )}
            >
              <option.icon className="size-4 shrink-0 text-[var(--color-muted)]" aria-hidden />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[15px]">{option.name}</span>
                {option.detail ? (
                  <span className="block truncate text-xs text-[var(--color-muted)]">
                    {option.detail}
                  </span>
                ) : null}
              </span>
              {option.meta}
            </li>
          ))}
        </ul>

        {searching && !pending && !error && options.length === 0 ? (
          <p className="px-3 py-3 text-sm text-[var(--color-muted)]">
            Ingen plats heter så. Prova en annan stavning.
          </p>
        ) : null}

        {!searching && footer ? (
          <div className="mt-2 border-t border-[var(--color-border)] px-3 pt-2">{footer}</div>
        ) : null}
      </div>
    </dialog>
  );
}

/**
 * The part of the screen the phone is actually showing.
 *
 * A `<dialog>` is in the top layer and is laid out against the layout viewport, which
 * Android does not shrink for the on-screen keyboard and iOS never shrinks. Sizing to
 * the visual viewport instead is what keeps the last row above the keyboard rather than
 * behind it, and following its offset is what keeps the field under the status bar when
 * iOS scrolls the page to reveal a focused field.
 */
function useVisualViewport() {
  const read = () => {
    const vv = typeof window === "undefined" ? null : window.visualViewport;
    if (!vv) {
      const height = typeof window === "undefined" ? 800 : window.innerHeight;
      const width = typeof window === "undefined" ? 400 : window.innerWidth;
      return { height, width, offsetTop: 0 };
    }
    return { height: vv.height, width: vv.width, offsetTop: vv.offsetTop };
  };

  const [box, setBox] = useState(read);

  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => setBox(read());
    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
    };
  }, []);

  return box;
}
