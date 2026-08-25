import { useEffect, useRef, useState } from "react";
import { Clock, X } from "lucide-react";
import { dayLabel, formatTime, instantToLocalInput, localInputToInstant } from "@/lib/format";
import { Button } from "./ui/button";
import { cn } from "@/lib/utils";

/** When the trip is planned around: now, an earliest departure, or a latest arrival. */
export type PlanTime = { when: string; arriveBy: boolean } | null;

/**
 * The chosen time as one pill under the place chips.
 *
 * It reads as the third half of the question ("from here, to there, when") and opens
 * the picker. "Nu" is the resting state, because that is what the screen is for on an
 * ordinary morning; a chosen time is spelled out with its day so "07:30" cannot be
 * mistaken for today's.
 */
export function TimePill({ time, onOpen }: { time: PlanTime; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-haspopup="dialog"
      className={cn(
        "pointer-events-auto inline-flex min-h-11 max-w-full items-center gap-1.5 rounded-full border border-[var(--color-border)] bg-[var(--color-surface)]/95 px-3 text-sm backdrop-blur",
        time && "border-[var(--color-accent)] font-medium",
      )}
    >
      <Clock className="size-4 shrink-0 text-[var(--color-muted)]" aria-hidden />
      <span className="truncate">{describe(time)}</span>
    </button>
  );
}

function describe(time: PlanTime): string {
  if (!time) return "Nu";
  const day = dayLabel(time.when);
  const clock = `${day ? `${day} ` : ""}${formatTime(time.when)}`;
  return time.arriveBy ? `Framme senast ${clock}` : `Avgång ${clock}`;
}

/** The next whole five minutes, so a fresh picker does not open on 14:37. */
function roundedNow(): string {
  const step = 5 * 60_000;
  return new Date(Math.ceil(Date.now() / step) * step).toISOString();
}

/**
 * Choosing the time, and which end of the trip it pins.
 *
 * The same native dialog as the place picker, for the same reasons. The choice is held
 * locally until "Klar": a datetime field fires on every keystroke, and each of those
 * would otherwise be a URL change and a round of trip requests.
 */
export function TimePicker({
  time,
  onPick,
  onClose,
}: {
  time: PlanTime;
  onPick: (time: PlanTime) => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [when, setWhen] = useState(() => time?.when ?? roundedNow());
  const [arriveBy, setArriveBy] = useState(time?.arriveBy ?? false);

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
      aria-label="Välj tid"
      className="m-0 mt-auto w-full max-w-none rounded-t-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-fg)] backdrop:bg-black/50 sm:mx-auto sm:mb-auto sm:mt-[10dvh] sm:max-w-md sm:rounded-[var(--radius-card)]"
    >
      <div className="flex items-center justify-between gap-2 border-b border-[var(--color-border)] px-4 py-2">
        <h2 className="text-sm font-semibold">När reser du?</h2>
        <Button type="button" variant="ghost" size="icon" onClick={onClose} aria-label="Stäng">
          <X />
        </Button>
      </div>

      <form
        className="space-y-4 p-4"
        onSubmit={(e) => {
          e.preventDefault();
          onPick({ when, arriveBy });
        }}
      >
        <div className="grid grid-cols-2 gap-2" role="group" aria-label="Vad tiden gäller">
          <Button
            type="button"
            variant={arriveBy ? "outline" : "default"}
            onClick={() => setArriveBy(false)}
            aria-pressed={!arriveBy}
          >
            Avgång
          </Button>
          <Button
            type="button"
            variant={arriveBy ? "default" : "outline"}
            onClick={() => setArriveBy(true)}
            aria-pressed={arriveBy}
          >
            Framme senast
          </Button>
        </div>

        <div className="space-y-1">
          <label className="block text-sm" htmlFor="plan-time">
            {arriveBy ? "Senast framme" : "Tidigast avgång"}
          </label>
          <input
            id="plan-time"
            type="datetime-local"
            required
            value={instantToLocalInput(when)}
            onChange={(e) => {
              const instant = localInputToInstant(e.target.value);
              if (instant) setWhen(instant);
            }}
            className="min-h-11 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 text-sm"
          />
        </div>

        <div className="flex items-center justify-between gap-2">
          <Button type="button" variant="ghost" onClick={() => onPick(null)}>
            Nu
          </Button>
          <Button type="submit">Klar</Button>
        </div>
      </form>
    </dialog>
  );
}
