import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import type { CommuteOption, JourneyLeg } from "@traveler/shared";
import { ChevronLeft, Footprints, GitBranch } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { dayLabel, formatDuration, formatTime } from "@/lib/format";
import { modeColor } from "@/lib/modes";
import { arrivalAtLeg, board, boardFrom, boardable, leaveLabel, liveStatus, sameRide, splice } from "@/lib/trips";
import { LineBadge } from "./LineBadge";
import { TripRow } from "./CommuteRows";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Skeleton } from "./ui/skeleton";
import { cn } from "@/lib/utils";

/** How many other trips from a stop are shown. A boardful, not a timetable. */
const MAX_BRANCHES = 8;

function minutes(seconds: number): number {
  return Math.max(1, Math.round(seconds / 60));
}

function delayMinutes(leg: JourneyLeg): number | null {
  if (!leg.origin.scheduled || !leg.origin.expected) return null;
  const d = Math.round(
    (new Date(leg.origin.expected).getTime() - new Date(leg.origin.scheduled).getTime()) / 60_000,
  );
  return d === 0 ? null : d;
}

/**
 * One row of the timeline: a time on the left, a dot on the line, and what happens.
 * The line down from the dot is the colour of what you ride next; a walk is dotted.
 */
function Row({
  time,
  scheduled,
  color,
  walk,
  last,
  children,
}: {
  time: string | null;
  scheduled?: string | null;
  color: string;
  walk?: boolean;
  last?: boolean;
  children: ReactNode;
}) {
  return (
    <li className="relative grid grid-cols-[52px_20px_1fr] items-start gap-x-2.5">
      <span className="pt-0.5 text-right text-sm font-semibold tabular-nums">
        {time ? formatTime(time) : ""}
        {scheduled && scheduled !== time ? (
          <span className="block text-xs font-normal text-[var(--color-muted)]">{formatTime(scheduled)}</span>
        ) : null}
      </span>
      <span className="relative h-full">
        <span
          className={cn(
            "absolute left-1/2 top-1.5 z-10 -translate-x-1/2 rounded-full border-[3px] bg-[var(--color-surface)]",
            walk ? "size-2.5" : "size-3.5",
          )}
          style={{ borderColor: color }}
        />
        {!last ? (
          <span
            className="absolute left-1/2 top-3 -bottom-1 -translate-x-1/2"
            style={
              walk
                ? { width: 3, backgroundImage: `repeating-linear-gradient(${color} 0 4px, transparent 4px 9px)` }
                : { width: 4, backgroundColor: color }
            }
          />
        ) : null}
      </span>
      <div className="min-w-0 pb-4">{children}</div>
    </li>
  );
}

/**
 * The other trips from one stop, planned live from that stop by id to the same
 * destination, around the time the leg leaves. Each is a real door-to-door option;
 * picking one welds it onto the trip above the stop.
 */
function Branches({
  parent,
  index,
  to,
  now,
  onPick,
}: {
  parent: CommuteOption;
  index: number;
  to: string;
  now: number;
  onPick: (option: CommuteOption) => void;
}) {
  const leg = parent.journey.legs[index]!;
  const from = leg.origin.siteGid!;
  // Fixed when the branches open rather than following the clock, so the answer stays
  // put while it is being read.
  const [when] = useState(() => new Date(boardFrom(parent, index, Date.now())).toISOString());
  const branches = useQuery({
    queryKey: ["branches", from, to, when],
    queryFn: ({ signal }) => api.commute({ from, to, when, paths: "all" }, signal),
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  // The ride already on the trip holds its place whatever else is on the board: it is
  // the row that says "this one", and the answer is unreadable without it.
  const reachable = branches.data ? boardable(parent, index, branches.data.options) : [];
  const mine = reachable.find((b) => sameRide(parent, index, b));
  const others = board(
    reachable.filter((b) => !sameRide(parent, index, b) && liveStatus(b, now) !== "missed"),
    MAX_BRANCHES - (mine ? 1 : 0),
  );
  const shown = (mine ? [mine, ...others] : others).sort(
    (a, b) => new Date(a.boardAt).getTime() - new Date(b.boardAt).getTime(),
  );

  return (
    <div className="mt-2 border-l-[3px] border-[var(--color-accent)] pl-2" aria-live="polite">
      {branches.isPending ? (
        <ul className="space-y-2 py-1" aria-busy="true" aria-label="Söker resor härifrån">
          {[0, 1, 2].map((i) => (
            <li key={i}>
              <Skeleton className="h-11 w-full" />
            </li>
          ))}
        </ul>
      ) : branches.isError ? (
        <div className="flex items-center justify-between gap-2 py-1">
          <p className="text-sm">
            {branches.error instanceof ApiError ? branches.error.message : "Kunde inte hämta resor."}
          </p>
          <Button variant="secondary" size="sm" onClick={() => branches.refetch()}>
            Försök igen
          </Button>
        </div>
      ) : shown.length === 0 ? (
        <p className="py-2 text-sm text-[var(--color-muted)]">Inga andra resor härifrån just nu.</p>
      ) : (
        <ul aria-label={`Resor från ${leg.origin.name}`} className="divide-y divide-[var(--color-border)]">
          {shown.map((branch) => {
            const ours = branch === mine;
            const option = splice(parent, index, branch);
            // One SL site can span platforms a walk apart -- Cityterminalen carries
            // T-Centralen's metro -- so a row whose ride starts somewhere else says where.
            const boards = branch.journey.legs.find((l) => l.mode !== "WALK")?.origin.name ?? null;
            return (
              <li key={branch.id}>
                <TripRow
                  option={option}
                  now={now}
                  selected={ours}
                  onOpen={ours ? () => {} : onPick}
                  arriveLabel={ours ? "Den här" : null}
                  note={boards && boards !== leg.origin.name ? `från ${boards}` : null}
                  className="grid-cols-[1fr_auto] px-2 [&>span:first-child]:hidden"
                />
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/**
 * One trip, stop by stop, with a way to ask "what else goes from here" at every stop.
 *
 * This is the screen for the platform: the stop you are at, when the bus leaves, and
 * the other buses you could take instead, without re-planning the whole commute from a
 * new origin. The list this came from is untouched behind it; Back returns to it.
 */
export function TripView({
  option,
  destinationName,
  to,
  now,
  onBack,
  onPick,
}: {
  option: CommuteOption;
  /** What the far end is called on the last row. */
  destinationName: string;
  /** The destination as the API takes it, for planning branches to the same place. */
  to: string;
  now: number;
  onBack: () => void;
  onPick: (option: CommuteOption) => void;
}) {
  const [openLeg, setOpenLeg] = useState<number | null>(null);
  const legs = option.journey.legs;
  const rides = legs.filter((leg) => leg.mode !== "WALK");
  const leave = leaveLabel(option, now);
  const status = liveStatus(option, now);
  const day = dayLabel(option.leaveAt);

  return (
    <section aria-label="Vald resa">
      <div className="flex items-start gap-2">
        <Button type="button" variant="ghost" size="icon" onClick={onBack} aria-label="Tillbaka till listan" className="-ml-2 shrink-0">
          <ChevronLeft />
        </Button>
        <div className="min-w-0">
          <p className="flex flex-wrap items-baseline gap-x-2">
            <span className={cn("text-[26px] font-bold leading-none tracking-tight tabular-nums", status === "missed" && "text-[var(--color-muted)]")}>
              {leave.big}
            </span>
            <span className="text-[15px] text-[var(--color-muted)]">
              {/* A trip on another day says so: "Gå 08:10" alone is this morning. */}
              {day ? `${day} · ` : ""}
              {leave.small ? `${leave.small} · ` : ""}framme {formatTime(option.arriveAt)}
            </span>
          </p>
          <p className="mt-1 text-[13px] text-[var(--color-muted)]">
            {option.transfers === 0 ? "Inget byte" : `${option.transfers} byte${option.transfers > 1 ? "n" : ""}`}
            {` · ${minutes(option.walkSeconds)} min promenad`}
            {option.timetabled ? " · Enligt tidtabell" : null}
            {status === "recommended" ? <span className="ml-1 font-semibold text-[var(--color-accent)]">· Rekommenderad</span> : null}
            {status === "tight" ? <span className="ml-1 font-semibold text-[var(--color-warn)]">· Knappt</span> : null}
          </p>
        </div>
      </div>

      <ul className="mt-3">
        {option.origin.stop ? (
          <Row time={option.origin.walkSeconds > 0 ? option.leaveAt : null} color={modeColor("WALK")} walk>
            <p className="flex items-center gap-2 pt-0.5 text-sm text-[var(--color-muted)]">
              <Footprints className="size-4 shrink-0" aria-hidden />
              Gå {formatDuration(option.origin.walkSeconds)} till {option.origin.stop.name}
            </p>
          </Row>
        ) : null}

        {legs.map((leg, i) => {
          if (leg.mode === "WALK") {
            const from = arrivalAtLeg(legs, i);
            return (
              <Row key={leg.index} time={from ? new Date(from).toISOString() : null} color={modeColor("WALK")} walk>
                <p className="flex items-center gap-2 pt-0.5 text-sm text-[var(--color-muted)]">
                  <Footprints className="size-4 shrink-0" aria-hidden />
                  Gå {formatDuration(leg.durationSeconds)}
                  {leg.destination.name ? ` till ${leg.destination.name}` : ""}
                </p>
              </Row>
            );
          }
          const color = modeColor(leg.mode, leg.line?.designation);
          const delay = delayMinutes(leg);
          const arrival = arrivalAtLeg(legs, i);
          const departs = leg.origin.expected ?? leg.origin.scheduled;
          const change =
            rides[0] !== leg && arrival !== null && departs
              ? Math.round((new Date(departs).getTime() - arrival) / 60_000)
              : null;
          return (
            <Row key={leg.index} time={departs} scheduled={leg.origin.scheduled} color={color}>
              <p className="flex flex-wrap items-center gap-x-2 text-[15px] font-semibold">
                {leg.origin.name}
                {delay !== null ? (
                  <Badge variant="warn">{delay > 0 ? `+${delay} min` : `${delay} min`}</Badge>
                ) : null}
              </p>
              <p className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-[var(--color-muted)]">
                {change !== null ? <span>Byte {Math.max(0, change)} min ·</span> : null}
                <LineBadge line={leg.line} mode={leg.mode} />
                {leg.towards ? <span>mot {leg.towards}</span> : null}
                {leg.origin.platform ? <span>· läge {leg.origin.platform}</span> : null}
                {leg.intermediateStops.length > 0 ? <span>· {leg.intermediateStops.length + 1} hållplatser</span> : null}
              </p>
              {leg.notes.map((note) => (
                <p key={note} className="mt-1 text-xs text-[var(--color-warn)]">{note}</p>
              ))}
              {leg.origin.siteGid ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  aria-expanded={openLeg === i}
                  onClick={() => setOpenLeg(openLeg === i ? null : i)}
                  className={cn("mt-2 rounded-full", openLeg === i && "bg-[var(--color-surface-2)]")}
                >
                  <GitBranch className="text-[var(--color-accent)]" />
                  Fler val härifrån
                </Button>
              ) : null}
              {openLeg === i ? <Branches parent={option} index={i} to={to} now={now} onPick={onPick} /> : null}
            </Row>
          );
        }).flatMap((row, i) => {
          // A change straight onto the next ride is one row, the next leg's; alighting
          // gets a row of its own only when a walk or the end of the trip follows.
          const leg = legs[i]!;
          const next = legs[i + 1];
          if (leg.mode === "WALK" || (next && next.mode !== "WALK")) return [row];
          const ours = !next && option.destination.stop !== null;
          return [
            row,
            <Row
              key={`alight-${leg.index}`}
              time={leg.destination.expected ?? leg.destination.scheduled}
              scheduled={leg.destination.scheduled}
              color={modeColor("WALK")}
              walk
              last={!next && !ours}
            >
              <p className="text-[15px] font-semibold">{leg.destination.name}</p>
              {ours ? (
                <p className="mt-1 flex items-center gap-2 text-sm text-[var(--color-muted)]">
                  <Footprints className="size-4 shrink-0" aria-hidden />
                  Gå {formatDuration(option.destination.walkSeconds)} till {destinationName}
                </p>
              ) : null}
            </Row>,
          ];
        })}

        {option.destination.stop || legs.at(-1)?.mode === "WALK" ? (
          <Row time={option.arriveAt} color={modeColor("WALK")} walk last>
            <p className="text-[15px] font-semibold">{destinationName}</p>
          </Row>
        ) : null}
      </ul>

      {option.alternatives.map((alternative) => (
        <p key={`${alternative.end}-${alternative.stop.stopPointId}`} className="text-[13px] text-[var(--color-muted)]">
          eller {alternative.stop.name}, {minutes(alternative.walkSeconds)} min promenad, framme {formatTime(alternative.arriveAt)}
        </p>
      ))}
    </section>
  );
}
