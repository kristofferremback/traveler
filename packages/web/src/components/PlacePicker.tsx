import { useEffect, useRef } from "react";
import { Link } from "react-router-dom";
import type { SavedPlace } from "@traveler/shared";
import { LocateFixed, X } from "lucide-react";
import { KIND_ICON } from "@/lib/savedPlaces";
import { PlaceSearchField } from "./PlaceSearchField";
import { Button } from "./ui/button";

/**
 * Choosing one end of the trip.
 *
 * A native `<dialog>`, opened modally: the browser then owns the focus trap, the
 * inertness of the page behind it and the Escape key, all of which a hand-rolled panel
 * gets subtly wrong. Escape is intercepted only to route the close through the caller,
 * so that dismissing it and pressing Back are the same action.
 *
 * Saved places first, because a commute is the same two places nearly every day. The
 * search field is there for the day it is not.
 */
export function PlacePicker({
  end,
  places,
  onPick,
  onClose,
}: {
  end: "from" | "to";
  places: SavedPlace[];
  /** A place ref: "me", "place:<id>", or a plain place id. */
  onPick: (ref: string) => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const node = dialog.current;
    if (node && !node.open) node.showModal();
  }, []);

  return (
    <dialog
      ref={dialog}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      aria-label={end === "from" ? "Välj var du börjar" : "Välj vart du ska"}
      className="m-0 mt-auto max-h-[85dvh] w-full max-w-none rounded-t-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-fg)] backdrop:bg-black/50 sm:mx-auto sm:mb-auto sm:mt-[10dvh] sm:max-w-md sm:rounded-[var(--radius-card)]"
    >
      <div className="flex items-center justify-between gap-2 border-b border-[var(--color-border)] px-4 py-2">
        <h2 className="text-sm font-semibold">
          {end === "from" ? "Var börjar du?" : "Vart ska du?"}
        </h2>
        <Button type="button" variant="ghost" size="icon" onClick={onClose} aria-label="Stäng">
          <X />
        </Button>
      </div>

      <div className="space-y-3 p-4">
        <ul className="space-y-1">
          <li>
            <button
              type="button"
              onClick={() => onPick("me")}
              className="flex min-h-11 w-full items-center gap-3 rounded-lg px-2 text-left hover:bg-[var(--color-surface-2)]"
            >
              <LocateFixed className="size-4 shrink-0 text-[var(--color-muted)]" aria-hidden />
              <span className="text-sm">Min position</span>
            </button>
          </li>
          {places.map((place) => {
            const Icon = KIND_ICON[place.kind];
            return (
              <li key={place.id}>
                <button
                  type="button"
                  onClick={() => onPick(`place:${place.id}`)}
                  className="flex min-h-11 w-full items-center gap-3 rounded-lg px-2 text-left hover:bg-[var(--color-surface-2)]"
                >
                  <Icon className="size-4 shrink-0 text-[var(--color-muted)]" aria-hidden />
                  <span className="min-w-0">
                    <span className="block truncate text-sm">{place.label}</span>
                    <span className="block truncate text-xs text-[var(--color-muted)]">
                      {place.name}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>

        <PlaceSearchField
          label="Sök hållplats eller adress"
          value={null}
          onChange={(place) => place && onPick(place.id)}
          placeholder="Slussen, Jarlaberg, Storgatan 1"
        />

        {/* The planner is one search away rather than a fifth tab: it answers a
            different question, and only sometimes. */}
        <Link
          to="/plan"
          className="inline-flex min-h-11 items-center text-sm text-[var(--color-accent)] underline underline-offset-2"
        >
          Sök valfri resa
        </Link>
      </div>
    </dialog>
  );
}
