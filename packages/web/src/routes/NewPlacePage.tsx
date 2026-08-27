import { useId, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Place } from "@traveler/shared";
import { ChevronLeft, Search } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { useOverlay } from "@/lib/overlay";
import { PlaceSearch } from "@/components/PlaceSearch";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * Saving a place is two answers: what you call it, and which place it is.
 *
 * The place goes over as its id rather than as a name and a coordinate, so the server
 * resolves the same place the search offered and the two cannot disagree.
 */
export function NewPlacePage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const labelId = useId();
  const placeFieldId = useId();
  const { open: picker, show: openPicker, close: closePicker } = useOverlay<"place">();

  const [label, setLabel] = useState("");
  const [place, setPlace] = useState<Place | null>(null);

  const save = useMutation({
    mutationFn: () => api.places.create({ label: label.trim(), placeId: place!.id }),
    onSuccess: async ({ place: saved }) => {
      await queryClient.invalidateQueries({ queryKey: ["places"] });
      navigate(`/places/${saved.id}`, { replace: true });
    },
  });

  const ready = label.trim().length > 0 && place !== null;

  return (
    <div className="mx-auto w-full max-w-2xl space-y-4 px-4 pb-24">
      <header className="flex items-center gap-1 pb-1 pt-3 safe-top">
        <Button asChild variant="ghost" size="icon">
          <Link to="/places" aria-label="Tillbaka till platser">
            <ChevronLeft />
          </Link>
        </Button>
        <h1 className="text-lg font-semibold">Ny plats</h1>
      </header>

      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (ready) save.mutate();
        }}
      >
        <div>
          <label
            htmlFor={labelId}
            className="mb-1 block text-xs font-medium text-[var(--color-muted)]"
          >
            Namn
          </label>
          <Input
            id={labelId}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Hem"
            maxLength={40}
            autoComplete="off"
          />
        </div>

        <div>
          <span
            id={placeFieldId}
            className="mb-1 block text-xs font-medium text-[var(--color-muted)]"
          >
            Plats
          </span>
          {/* The same search screen the trip control opens, so choosing a place is one
              act with one layout wherever the app asks for one. */}
          <button
            type="button"
            aria-labelledby={placeFieldId}
            aria-haspopup="dialog"
            onClick={() => openPicker("place")}
            className="flex min-h-11 w-full items-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-left"
          >
            <Search className="size-4 shrink-0 text-[var(--color-muted)]" aria-hidden />
            <span className="min-w-0 flex-1 truncate text-base">
              {place ? (
                place.name
              ) : (
                <span className="text-[var(--color-muted)]">Hållplats, adress eller plats</span>
              )}
            </span>
          </button>
        </div>

        {save.isError ? (
          <p role="alert" className="text-sm text-[var(--color-danger)]">
            {save.error instanceof ApiError ? save.error.message : "Platsen kunde inte sparas."}
          </p>
        ) : null}

        <Button type="submit" disabled={!ready || save.isPending}>
          {save.isPending ? "Sparar…" : "Spara"}
        </Button>
      </form>

      {picker === "place" ? (
        <PlaceSearch
          title="Vilken plats?"
          currentPosition="address"
          /* Nothing to offer until something is typed, so the keyboard comes with the
             screen rather than costing a second tap. */
          focusField
          onPick={(choice) => {
            if (choice.kind === "place") setPlace(choice.place);
            closePicker();
          }}
          onClose={closePicker}
        />
      ) : null}
    </div>
  );
}
