import { useEffect, useMemo, useRef, useState } from "react";
import type { TowerEvent } from "../../core/controller.ts";
import { timeOf } from "../model.ts";

interface Props {
	events: TowerEvent[];
	focusFlight: string | null;
	onSelectFlight(id: string): void;
}

const QUIET = new Set(["flight.activity"]);

/** The tower log: every decision, in order, with its reasons one click away. */
export function TowerLog({ events, focusFlight, onSelectFlight }: Props) {
	const [open, setOpen] = useState<number | null>(null);
	const [onlyFocus, setOnlyFocus] = useState(true);
	const [showActivity, setShowActivity] = useState(false);
	const end = useRef<HTMLDivElement>(null);
	const list = useMemo(
		() =>
			events.filter(
				(e) =>
					(showActivity || !QUIET.has(e.type)) &&
					(!onlyFocus || !focusFlight || e.flightId === focusFlight || e.title.includes(focusFlight)),
			),
		[events, focusFlight, onlyFocus, showActivity],
	);
	const last = list.at(-1)?.seq;
	// biome-ignore lint/correctness/useExhaustiveDependencies: scroll when the newest event changes.
	useEffect(() => {
		end.current?.scrollIntoView({ block: "end" });
	}, [last]);
	return (
		<section className="log" aria-label="Tower log">
			<div className="log-head">
				<span className="eyebrow">Tower log</span>
				<div className="log-filters">
					{focusFlight && (
						<label>
							<input type="checkbox" checked={onlyFocus} onChange={(e) => setOnlyFocus(e.target.checked)} /> only {focusFlight}
						</label>
					)}
					<label>
						<input type="checkbox" checked={showActivity} onChange={(e) => setShowActivity(e.target.checked)} /> agent activity
					</label>
				</div>
			</div>
			<div className="log-body">
				{list.length === 0 && <div className="log-empty">Quiet frequency.</div>}
				{list.map((e) => (
					<div key={e.seq} className={`log-row t-${e.type.replace(".", "-")} ${open === e.seq ? "open" : ""}`}>
						<button type="button" className="log-line" onClick={() => setOpen(open === e.seq ? null : e.seq)}>
							<span className="log-time mono">{timeOf(e.at)}</span>
							<span className={`log-actor a-${e.actor}`}>{e.actor}</span>
							<span className="log-title">{e.title}</span>
							{e.detail?.length ? <span className="log-more">{open === e.seq ? "−" : `+${e.detail.length}`}</span> : null}
						</button>
						{open === e.seq && e.detail && (
							<div className="log-detail">
								{e.detail.map((d) => (
									<div key={d}>{d}</div>
								))}
								{e.flightId && (
									<button type="button" className="link" onClick={() => onSelectFlight(e.flightId as string)}>
										open {e.flightId}
									</button>
								)}
							</div>
						)}
					</div>
				))}
				<div ref={end} />
			</div>
		</section>
	);
}
