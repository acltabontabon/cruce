import { type CSSProperties, Fragment, type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { changeThread, type ReviewNoteState, reviewNoteState, threadNotes } from "../core/review-notes.ts";
import type { ChangeFile, ChangesResponse } from "../shared/api.ts";
import type { Actor, Proposal, RepositorySnapshot, ReviewNote } from "../shared/platform.ts";
import { Initials } from "./design.tsx";
import { enclosing, type Hunk, type Placement, parsePatch, placeNotes, prepareRows, type Row, supportingKind } from "./diff-model.ts";
import { grammarFor, segments } from "./highlight.ts";
import { laneIndex } from "./lanes.ts";
import type { Execute } from "./source.tsx";
import { actorLabel, ago, type People, short } from "./status.ts";

/** A note as the console shows it: its state for this change's owner and the change number it was added on. */
export interface ThreadNote {
	note: ReviewNote;
	change: number;
	state: ReviewNoteState;
}
export function changeNotes(view: RepositorySnapshot, p: Proposal): ThreadNote[] {
	const owner = view.workspaces.find((w) => w.id === p.workspaceId)?.ownerId ?? "";
	return threadNotes(view.proposals, p).map(({ note, change }) => ({ note, change: change.number, state: reviewNoteState(note, owner) }));
}

/** Per-viewer reading preferences; storage can be unavailable, and every default works without it. */
interface Prefs {
	beside: boolean;
	split: boolean;
	whitespace: boolean;
	resolved: boolean;
}
const PREFS_KEY = "cruce.review.view";
function readJson<T>(key: string, fallback: T): T {
	try {
		const raw = localStorage.getItem(key);
		return raw ? { ...fallback, ...JSON.parse(raw) } : fallback;
	} catch {
		return fallback;
	}
}
function writeJson(key: string, value: unknown) {
	try {
		localStorage.setItem(key, JSON.stringify(value));
	} catch {
		// Storage can be unavailable; the choice still applies for this visit.
	}
}
function useWide(query: string) {
	const [wide, setWide] = useState(() => typeof matchMedia === "function" && matchMedia(query).matches);
	useEffect(() => {
		if (typeof matchMedia !== "function") return;
		const media = matchMedia(query);
		const follow = () => setWide(media.matches);
		media.addEventListener("change", follow);
		return () => media.removeEventListener("change", follow);
	}, [query]);
	return wide;
}
const typing = () => {
	const el = document.activeElement as HTMLElement | null;
	return !!el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable) && (el as HTMLInputElement).type !== "checkbox";
};

interface Stop {
	revision: string;
	label: string;
	note: string;
}
/** Comparison points for one change: its review base, then every revision in its thread, oldest first. */
function stopsFor(view: RepositorySnapshot, p: Proposal, viewerId?: string): Stop[] {
	const stops: Stop[] = [{ revision: p.base, label: "base", note: `review base · ${view.repository.defaultBranch}` }];
	for (const o of changeThread(view.proposals, p).toReversed()) {
		if (stops.some((s) => s.revision === o.revision)) continue;
		const approved = o.reviews.some((r) => r.revision === o.revision && r.outcome === "approve" && r.actor.userId === viewerId);
		stops.push({
			revision: o.revision,
			label: `#${o.number}`,
			note:
				o.id === p.id
					? "under review"
					: approved
						? "you approved"
						: o.reviews.some((r) => r.revision === o.revision)
							? "reviewed"
							: "earlier",
		});
	}
	return stops;
}
/** The latest earlier revision of this change someone reviewed: reviewing only what changed since avoids reviewing twice. */
export function reviewedEarlier(view: RepositorySnapshot, p: Proposal) {
	return changeThread(view.proposals, p).find(
		(o) => o.id !== p.id && o.revision !== p.revision && o.reviews.some((r) => r.revision === o.revision),
	);
}

interface Loaded {
	patch?: string | null;
	reason?: string;
	error?: string;
	loading?: boolean;
	content?: string[] | null;
}
interface Entry {
	file: ChangeFile;
	kind: string;
	notes: ThreadNote[];
	overlap: { id: string; title: string; lane?: number }[];
}

function AgentAvatar() {
	return (
		<span className="rv-av agent" aria-hidden="true">
			AI
		</span>
	);
}
function Who({ actor, who }: { actor: Actor; who: People }) {
	const person = who.people?.find((x) => x.id === actor.userId)?.name;
	if (actor.kind === "agent")
		return (
			<>
				<AgentAvatar />
				<b>{actorLabel(actor)}</b>
				<span className="rv-faint" title={`Agent connection of ${person ?? "its user"}`}>
					{actor.userId === who.viewerId ? "your agent" : person ? `${person}'s agent` : "agent"}
				</span>
			</>
		);
	return (
		<>
			<Initials name={person ?? actor.name} className="rv-av" />
			<b>{actor.userId === who.viewerId ? "You" : (person ?? actor.name)}</b>
		</>
	);
}

/** One review note with its replies and the actions this viewer may take. */
export function NoteCard({
	item,
	who,
	execute,
	canReply,
	canResolve,
	placement,
	onCite,
	anchorKey,
	compact = false,
}: {
	item: ThreadNote;
	who: People;
	execute: Execute;
	canReply: boolean;
	canResolve: boolean;
	placement?: Placement;
	onCite?: (revision: string) => void;
	anchorKey?: string;
	compact?: boolean;
}) {
	const { note, state } = item;
	const [mode, setMode] = useState<"reply" | "resolve">(),
		[text, setText] = useState(""),
		[error, setError] = useState(""),
		[busy, setBusy] = useState(false),
		[open, setOpen] = useState(false);
	const quiet = state === "resolved" || (note.kind === "comment" && state !== "awaiting_reviewer");
	const clamped = (quiet || compact) && !open;
	const submit = async () => {
		if (!text.trim()) return setError(mode === "resolve" ? "Give a reason to resolve this note." : "Write a reply first.");
		setBusy(true);
		setError("");
		try {
			await execute(
				mode === "resolve"
					? { tool: "resolve_review_note", noteId: note.id, reason: text.trim() }
					: { tool: "reply_review_note", noteId: note.id, body: text.trim() },
			);
			setMode(undefined);
			setText("");
		} catch (e) {
			setError((e as Error).message);
		} finally {
			setBusy(false);
		}
	};
	// A note whose line is not shown here names its exact place, and can switch the comparison to show it.
	const anchorAt = note.anchor && (note.anchor.revision === note.revision ? `#${item.change}` : short(note.anchor.revision));
	const where = note.anchor && (
		<button
			type="button"
			className="rv-where"
			title={`${note.anchor.path}:${note.anchor.line} at ${note.anchor.revision}. Show the comparison that contains this line.`}
			onClick={() => onCite?.(note.anchor!.revision)}
			disabled={!onCite}
		>
			Line {note.anchor.line} in {anchorAt}
		</button>
	);
	return (
		<div className={`rv-note${quiet ? " quiet" : ""} ${state}`} data-note-id={note.id} data-anchor={anchorKey ?? ""}>
			<div className="rv-nhead">
				<Who actor={note.actor} who={who} />
				<span
					className={note.kind === "concern" ? "rv-kind is-concern" : "rv-kind"}
					title={note.kind === "concern" ? "Blocks promotion until a maintainer resolves it" : "Never blocks"}
				>
					{note.kind}
				</span>
				{placement?.changed && (
					<span className="rv-tag" title="The line this note points at was removed or rewritten later">
						line changed
					</span>
				)}
				{placement?.carried && <span className="rv-tag">from #{item.change}</span>}
				<span className="rv-when" title={`Written on ${note.revision}`}>
					#{item.change} · {ago(note.at)}
				</span>
			</div>
			{!placement?.key && where}
			{clamped ? (
				<button type="button" className="rv-clamp" onClick={() => setOpen(true)} title="Show the whole note">
					{note.body}
				</button>
			) : (
				<p className="rv-body">{note.body}</p>
			)}
			{!clamped &&
				note.replies.map((r) => (
					<div key={r.id} className="rv-reply">
						<div className="rv-nhead">
							<Who actor={r.actor} who={who} />
							<span className="rv-when">{ago(r.at)}</span>
						</div>
						<p className="rv-body">{r.body}</p>
						{r.citedRevision && (
							<button
								type="button"
								className="rv-cite"
								title="Compare up to the cited revision"
								onClick={() => onCite?.(r.citedRevision!)}
								disabled={!onCite}
							>
								cites {short(r.citedRevision)}
							</button>
						)}
					</div>
				))}
			{state === "resolved" && note.resolution && (
				<p className="rv-resolved">
					Resolved by {note.resolution.actor.userId === who.viewerId ? "you" : actorLabel(note.resolution.actor)}: {note.resolution.reason}
				</p>
			)}
			{state === "awaiting_reviewer" && !clamped && <p className="rv-state">Answered. Check the code, then resolve or reply.</p>}
			{mode ? (
				<form
					className="rv-form"
					onSubmit={(e) => {
						e.preventDefault();
						void submit();
					}}
				>
					<textarea
						value={text}
						onChange={(e) => {
							setText(e.target.value);
							setError("");
						}}
						placeholder={mode === "resolve" ? "Reason, for example: verified in the new revision" : "Reply"}
						aria-label={mode === "resolve" ? "Reason for resolving" : "Reply"}
						rows={2}
						// biome-ignore lint/a11y/noAutofocus: the field opens in response to the reviewer's own click.
						autoFocus
					/>
					<div className="rv-acts">
						<button type="submit" disabled={busy}>
							{busy ? "Saving…" : mode === "resolve" ? "Resolve" : "Reply"}
						</button>
						<button type="button" className="text-button" onClick={() => setMode(undefined)}>
							Cancel
						</button>
					</div>
					{error && <p role="alert">{error}</p>}
				</form>
			) : (
				state !== "resolved" &&
				!clamped &&
				(canResolve || canReply) && (
					<div className="rv-acts">
						{canResolve && (
							<button type="button" onClick={() => setMode("resolve")}>
								Resolve
							</button>
						)}
						{canReply && (
							<button type="button" className="text-button" onClick={() => setMode("reply")}>
								Reply
							</button>
						)}
					</div>
				)
			)}
		</div>
	);
}

/** Writes a new note on one line, or on the whole change when no line is given. */
export function NoteComposer({
	p,
	execute,
	anchor,
	onDone,
	anchorKey,
}: {
	p: Proposal;
	execute: Execute;
	anchor?: { path: string; line: number; revision: string; text: string };
	onDone: () => void;
	anchorKey?: string;
}) {
	const [kind, setKind] = useState<"concern" | "comment">("concern"),
		[text, setText] = useState(""),
		[error, setError] = useState(""),
		[busy, setBusy] = useState(false);
	return (
		<form
			className="rv-note composer"
			data-anchor={anchorKey ?? ""}
			onSubmit={async (e) => {
				e.preventDefault();
				if (!text.trim()) return setError("Write the note first.");
				setBusy(true);
				setError("");
				try {
					await execute({
						tool: "add_review_note",
						proposalId: p.id,
						revision: p.revision,
						kind,
						body: text.trim(),
						...(anchor
							? { path: anchor.path, line: anchor.line, anchorRevision: anchor.revision, lineText: anchor.text.slice(0, 500) }
							: {}),
					});
					onDone();
				} catch (err) {
					setError((err as Error).message);
				} finally {
					setBusy(false);
				}
			}}
		>
			<fieldset className="rv-kindpick">
				<legend className="sr-only">Note kind</legend>
				<button type="button" aria-pressed={kind === "concern"} onClick={() => setKind("concern")}>
					Concern
				</button>
				<button type="button" aria-pressed={kind === "comment"} onClick={() => setKind("comment")}>
					Comment
				</button>
			</fieldset>
			<textarea
				value={text}
				onChange={(e) => {
					setText(e.target.value);
					setError("");
				}}
				placeholder={kind === "concern" ? "What must change before this can land?" : "Say something about this line"}
				aria-label={anchor ? `Note on line ${anchor.line}` : "Note on the whole change"}
				rows={3}
				onKeyDown={(e) => {
					if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) e.currentTarget.form?.requestSubmit();
					if (e.key === "Escape") onDone();
				}}
				// biome-ignore lint/a11y/noAutofocus: the composer opens in response to the reviewer's own click.
				autoFocus
			/>
			<div className="rv-acts">
				<button type="submit" className="primary" disabled={busy}>
					{busy ? "Saving…" : kind === "concern" ? "Add concern" : "Add comment"}
				</button>
				<button type="button" className="text-button" onClick={onDone}>
					Cancel
				</button>
				<span className="rv-faint">{kind === "concern" ? "Blocks promotion until resolved." : "Doesn’t block."}</span>
			</div>
			{error && <p role="alert">{error}</p>}
		</form>
	);
}

function Code({ row, grammar, side }: { row: Row; grammar?: string; side?: "o" | "n" }) {
	const words = side === undefined || (side === "o" ? row.k === "d" : row.k === "a") ? row.words : undefined;
	return (
		<>
			{segments(row.t, grammar, words).map((s, i) =>
				s.changed ? (
					// biome-ignore lint/suspicious/noArrayIndexKey: segments are derived from fixed line text.
					<mark key={i}>{s.syntax ? <span className={s.syntax}>{s.text}</span> : s.text}</mark>
				) : s.syntax ? (
					// biome-ignore lint/suspicious/noArrayIndexKey: segments are derived from fixed line text.
					<span key={i} className={s.syntax}>
						{s.text}
					</span>
				) : (
					// biome-ignore lint/suspicious/noArrayIndexKey: segments are derived from fixed line text.
					<Fragment key={i}>{s.text}</Fragment>
				),
			)}
		</>
	);
}
const keysOf = (...rows: (Row | undefined)[]) =>
	rows
		.flatMap((r) => (r ? [r.o !== undefined && r.k !== "a" ? `o${r.o}` : "", r.n !== undefined && r.k !== "d" ? `n${r.n}` : ""] : []))
		.filter(Boolean)
		.join(" ");

/** The diff of one file with its notes, in a margin beside the code or under their lines. */
function FileBlock({
	entry,
	loaded,
	p,
	from,
	to,
	prefs,
	beside,
	closed,
	viewed,
	who,
	execute,
	canWrite,
	canResolve,
	onToggle,
	onViewed,
	onLoad,
	onContent,
	onCite,
	draftKey,
	setDraftKey,
	stored,
}: {
	entry: Entry;
	loaded?: Loaded;
	p: Proposal;
	from: string;
	to: string;
	prefs: Prefs;
	beside: boolean;
	closed: boolean;
	viewed: boolean;
	who: People;
	execute: Execute;
	canWrite: boolean;
	canResolve: boolean;
	onToggle: () => void;
	onViewed: () => void;
	onLoad: () => void;
	onContent: () => void;
	onCite: (revision: string) => void;
	draftKey?: string;
	setDraftKey: (key?: string) => void;
	stored: boolean;
}) {
	const { file } = entry;
	const ref = useRef<HTMLDivElement>(null);
	const [openGaps, setOpenGaps] = useState<Set<number>>(new Set());
	const grammar = grammarFor(file.path);
	const hunks = useMemo<Hunk[]>(
		() => (loaded?.patch ? parsePatch(loaded.patch).map((h) => ({ ...h, rows: prepareRows(h.rows, prefs.whitespace) })) : []),
		[loaded?.patch, prefs.whitespace],
	);
	const placements = useMemo(
		() =>
			placeNotes(
				entry.notes.map((n) => n.note),
				hunks,
				from,
				to,
			),
		[entry.notes, hunks, from, to],
	);
	const byKey = new Map<string, { item: ThreadNote; placement: Placement }[]>();
	const unplaced: { item: ThreadNote; placement: Placement }[] = [];
	entry.notes.forEach((item, i) => {
		const placement = placements[i];
		if (placement?.key) byKey.set(placement.key, [...(byKey.get(placement.key) ?? []), { item, placement }]);
		else unplaced.push({ item, placement });
	});
	const canAdd = canWrite && p.state === "open";
	const draft = draftKey ? /^(o|n)(\d+)$/.exec(draftKey) : null;
	const draftRow = draft ? hunks.flatMap((h) => h.rows).find((r) => (draft[1] === "o" ? r.o : r.n) === +draft[2]) : undefined;
	const card = (x: { item: ThreadNote; placement: Placement }) => (
		<NoteCard
			key={x.item.note.id}
			item={x.item}
			who={who}
			execute={execute}
			canReply={canWrite && p.state === "open"}
			canResolve={canResolve && p.state === "open"}
			placement={x.placement}
			anchorKey={x.placement.key}
			onCite={onCite}
		/>
	);
	const composer = draft && (
		<NoteComposer
			key={`draft-${draftKey}`}
			p={p}
			execute={execute}
			anchorKey={draftKey}
			anchor={{ path: file.path, line: +draft[2], revision: draft[1] === "o" ? from : to, text: draftRow?.t ?? "" }}
			onDone={() => setDraftKey(undefined)}
		/>
	);
	const inline = (keys: string) => {
		if (beside) return null;
		const here = keys.split(" ").flatMap((k) => byKey.get(k) ?? []);
		const drafting = !!draftKey && keys.split(" ").includes(draftKey);
		if (!here.length && !drafting) return null;
		return (
			<div className="rv-inline">
				{here.map(card)}
				{drafting && composer}
			</div>
		);
	};
	// Margin notes sit level with their line and push down rather than overlap.
	useLayoutEffect(() => {
		const row = ref.current,
			margin = row?.querySelector<HTMLElement>(".rv-margin");
		if (!row || !margin) return;
		const place = () => {
			const top = row.getBoundingClientRect().top;
			const cards = [...margin.querySelectorAll<HTMLElement>(":scope > .rv-note")].map((el) => {
				const key = el.dataset.anchor;
				const line = key ? row.querySelector<HTMLElement>(`.rv-ln[data-key~="${key}"]`) : null;
				return { el, want: line ? line.getBoundingClientRect().top - top - 6 : 52 };
			});
			let bottom = 0;
			for (const c of cards.sort((a, b) => a.want - b.want)) {
				const at = Math.max(c.want, bottom ? bottom + 10 : 0);
				c.el.style.top = `${at}px`;
				bottom = at + c.el.offsetHeight;
			}
			margin.style.minHeight = `${bottom}px`;
		};
		place();
		// Positioning in the next frame keeps a resize from re-triggering within the same observation.
		let frame = 0;
		const observer = new ResizeObserver(() => {
			cancelAnimationFrame(frame);
			frame = requestAnimationFrame(place);
		});
		observer.observe(row);
		for (const el of margin.querySelectorAll(":scope > .rv-note")) observer.observe(el);
		return () => {
			cancelAnimationFrame(frame);
			observer.disconnect();
		};
	});
	const highlightLine = (key: string | undefined, on: boolean) => {
		if (!key) return;
		ref.current?.querySelector(`.rv-ln[data-key~="${key}"]`)?.classList.toggle("lit", on);
	};
	const addButton = (r: Row, side: "o" | "n") =>
		canAdd && (
			<button
				type="button"
				className={`rv-add side-${side}`}
				aria-label={`Add a note on line ${side === "o" ? r.o : r.n}`}
				onClick={() => setDraftKey(`${side}${side === "o" ? r.o : r.n}`)}
			>
				+
			</button>
		);
	const pin = (keys: string) => {
		if (!beside) return null;
		const here = keys.split(" ").flatMap((k) => byKey.get(k) ?? []);
		if (!here.length) return null;
		const state = here.some((x) => x.item.state === "awaiting_owner" && x.item.note.kind === "concern") ? "open" : here[0].item.state;
		return <span className={`rv-pin ${state}`} aria-hidden="true" />;
	};
	const unified = (r: Row) => {
		const keys = keysOf(r);
		return (
			<Fragment key={`${r.k}${r.o ?? ""}:${r.n ?? ""}`}>
				<div className={`rv-ln ${r.k}${draftKey && keys.split(" ").includes(draftKey) ? " lit" : ""}`} data-key={keys}>
					<span className="rv-no">{r.o}</span>
					<span className="rv-no">{r.n}</span>
					<span className="rv-sg">{r.k === "a" ? "+" : r.k === "d" ? "−" : ""}</span>
					<code>
						<Code row={r} grammar={grammar} />
					</code>
					{addButton(r, r.k === "d" ? "o" : "n")}
					{pin(keys)}
				</div>
				{inline(keys)}
			</Fragment>
		);
	};
	const split = (rows: Row[]) => {
		const out: ReactNode[] = [];
		for (let i = 0; i < rows.length; ) {
			if (rows[i].k === "c") {
				const r = rows[i++],
					keys = keysOf(r);
				out.push(
					<Fragment key={`c${r.o}:${r.n}`}>
						<div className="rv-ln sp" data-key={keys}>
							<span className="rv-no">{r.o}</span>
							<code className="left">
								<Code row={r} grammar={grammar} />
							</code>
							<span className="rv-no">{r.n}</span>
							<code>
								<Code row={r} grammar={grammar} />
							</code>
							{addButton(r, "n")}
							{pin(keys)}
						</div>
						{inline(keys)}
					</Fragment>,
				);
				continue;
			}
			let j = i;
			while (j < rows.length && rows[j].k !== "c") j++;
			const del = rows.slice(i, j).filter((r) => r.k === "d"),
				add = rows.slice(i, j).filter((r) => r.k === "a");
			for (let q = 0; q < Math.max(del.length, add.length); q++) {
				const d = del[q],
					a = add[q],
					keys = keysOf(d, a);
				out.push(
					<Fragment key={`s${d?.o ?? ""}:${a?.n ?? ""}`}>
						<div className="rv-ln sp" data-key={keys}>
							<span className={d ? "rv-no d" : "rv-no e"}>{d?.o}</span>
							<code className={d ? "left d" : "left e"}>{d && <Code row={d} grammar={grammar} side="o" />}</code>
							<span className={a ? "rv-no a" : "rv-no e"}>{a?.n}</span>
							<code className={a ? "a" : "e"}>{a && <Code row={a} grammar={grammar} side="n" />}</code>
							{a ? addButton(a, "n") : d && addButton(d, "o")}
							{pin(keys)}
						</div>
						{inline(keys)}
					</Fragment>,
				);
			}
			i = j;
		}
		return out;
	};
	const rows = (list: Row[]) => (prefs.split ? split(list) : list.map(unified));
	const gap = (index: number, start: number, end: number | undefined, offset: number) => {
		if (end !== undefined && end < start) return null;
		const content = loaded?.content;
		if (openGaps.has(index) && content) {
			const last = Math.min(end ?? content.length, content.length);
			const lines: Row[] = [];
			for (let n = start; n <= last; n++) lines.push({ k: "c", t: content[n - 1], o: n + offset, n });
			return <Fragment key={`gap${index}`}>{rows(lines)}</Fragment>;
		}
		if (stored || file.status !== "modified") return null;
		const count = end === undefined ? undefined : end - start + 1;
		return (
			<button
				key={`gap${index}`}
				type="button"
				className="rv-gap"
				onClick={() => {
					setOpenGaps((g) => new Set(g).add(index));
					if (!loaded?.content) onContent();
				}}
				title="Reads the file from the local cache"
			>
				{loaded?.content === null
					? "Unchanged lines are unavailable in the local cache"
					: count === undefined
						? "Show the rest of the file"
						: `${count} unchanged ${count === 1 ? "line" : "lines"}`}
			</button>
		);
	};
	const body = () => {
		if (!loaded || loaded.loading) return <p className="rv-quiet">Loading changes…</p>;
		if (loaded.error)
			return (
				<p role="alert" className="rv-quiet">
					{loaded.error}{" "}
					<button type="button" className="text-button" onClick={onLoad}>
						Retry
					</button>
				</p>
			);
		if (!loaded.patch) return <p className="rv-quiet">{loaded.reason ?? (file.binary ? "Binary file." : "No line changes to show.")}</p>;
		const out: ReactNode[] = [];
		let prevNewEnd = 0;
		hunks.forEach((h, i) => {
			out.push(gap(i, prevNewEnd + 1, h.newStart - 1, h.oldStart - h.newStart));
			const fn = enclosing(
				h.rows,
				h.rows.findIndex((r) => r.k !== "c"),
			);
			if (fn)
				out.push(
					// biome-ignore lint/suspicious/noArrayIndexKey: hunks are fixed for one loaded patch.
					<div key={`h${i}`} className="rv-hh">
						in {fn}
					</div>,
				);
			out.push(...rows(h.rows));
			prevNewEnd = h.newStart + h.newCount - 1;
			if (i === hunks.length - 1) out.push(gap(hunks.length, prevNewEnd + 1, undefined, h.oldStart + h.oldCount - prevNewEnd - 1));
		});
		return <div className={`rv-code${prefs.split ? " split" : ""}`}>{out}</div>;
	};
	const open = !closed;
	const unresolved = entry.notes.filter((n) => n.state !== "resolved").length;
	const slash = file.path.lastIndexOf("/");
	return (
		<div className="rv-frow" ref={ref} data-path={file.path}>
			<article className={`rv-file${closed ? " closed" : ""}${entry.kind ? " sup" : ""}`} data-file={file.path}>
				<header className="rv-fh">
					<button
						type="button"
						className="rv-chev"
						aria-expanded={open}
						aria-label={`${open ? "Fold" : "Unfold"} ${file.path}`}
						onClick={onToggle}
					>
						<svg viewBox="0 0 24 24" aria-hidden="true">
							<path d="m6 9 6 6 6-6" />
						</svg>
					</button>
					<span className="rv-path">
						<span>{file.path.slice(0, slash + 1)}</span>
						{file.path.slice(slash + 1)}
					</span>
					{file.additions !== null && (
						<span className="rv-counts">
							<span className="plus">+{file.additions}</span>
							<span className="minus">−{file.deletions}</span>
						</span>
					)}
					{entry.kind && <span className="rv-why">{entry.kind}</span>}
					{file.before && file.after && file.before.mode !== file.after.mode && (
						<span className="rv-why">
							Mode {file.before.mode} → {file.after.mode}
						</span>
					)}
					{(file.before?.type === "commit" || file.after?.type === "commit") && (
						<span className="rv-why">
							Submodule {file.before?.oid ? short(file.before.oid) : "absent"} → {file.after?.oid ? short(file.after.oid) : "absent"}
						</span>
					)}
					{file.status === "added" && !entry.kind && <span className="rv-why">New file</span>}
					{closed && unresolved > 0 && (
						<span className="rv-count" title="Unresolved notes">
							{unresolved} {unresolved === 1 ? "note" : "notes"}
						</span>
					)}
					<label className="rv-viewed">
						<input type="checkbox" checked={viewed} onChange={onViewed} /> Viewed
					</label>
				</header>
				{open && (
					<div className="rv-fb">
						{entry.overlap.length > 0 && (
							<p className="rv-overlap">
								{entry.overlap.map((o) => (
									<span key={o.id} className="rv-lane" style={{ "--lane": `var(--lane-${o.lane ?? 1})` } as CSSProperties} />
								))}
								Also changed in {entry.overlap.map((o) => o.title).join(", ")}. Advisory: whichever lands second reconciles with Git.
							</p>
						)}
						{!beside && unplaced.length > 0 && <div className="rv-inline">{unplaced.map(card)}</div>}
						{body()}
					</div>
				)}
			</article>
			{beside && (
				<aside
					className="rv-margin"
					aria-label={`Notes on ${file.path}`}
					onMouseOver={(e) => highlightLine((e.target as HTMLElement).closest<HTMLElement>(".rv-note")?.dataset.anchor, true)}
					onMouseOut={(e) => highlightLine((e.target as HTMLElement).closest<HTMLElement>(".rv-note")?.dataset.anchor, false)}
					onFocus={(e) => highlightLine((e.target as HTMLElement).closest<HTMLElement>(".rv-note")?.dataset.anchor, true)}
					onBlur={(e) => highlightLine((e.target as HTMLElement).closest<HTMLElement>(".rv-note")?.dataset.anchor, false)}
				>
					{open && [...unplaced, ...[...byKey.values()].flat()].map(card)}
					{open && draft && composer}
				</aside>
			)}
		</div>
	);
}

/**
 * Files changed in one exact comparison, read as one continuous page: likely review targets first, supporting files
 * folded, review notes beside their lines. Viewed marks and reading preferences stay in this browser.
 */
export function ReviewFiles({
	view,
	p,
	execute,
	who,
	focus,
}: {
	view: RepositorySnapshot;
	p: Proposal;
	execute: Execute;
	who: People;
	focus?: { id: string; nonce: number };
}) {
	const stops = useMemo(() => stopsFor(view, p, who.viewerId), [view, p, who.viewerId]);
	const earlier = reviewedEarlier(view, p);
	const [range, setRange] = useState<{ from: string; to: string }>(() => ({ from: earlier?.revision ?? p.base, to: p.revision }));
	const { from, to } = range;
	const [prefs, setPrefsState] = useState<Prefs>(() =>
		readJson(PREFS_KEY, { beside: true, split: false, whitespace: true, resolved: false }),
	);
	const setPrefs = (next: Partial<Prefs>) =>
		setPrefsState((current) => {
			const value = { ...current, ...next };
			writeJson(PREFS_KEY, value);
			return value;
		});
	const wideEnough = useWide("(min-width: 1360px)");
	const besideAllowed = prefs.beside && wideEnough;
	const sideBySide = prefs.split && wideEnough;
	const viewedKey = `cruce.review.viewed.${view.repository.id}.${p.workspaceId}`;
	const [viewed, setViewed] = useState<Record<string, string>>(() => readJson(viewedKey, {}));
	const [list, setList] = useState<ChangesResponse>(),
		[listError, setListError] = useState(""),
		[stored, setStored] = useState(false),
		[fromCanonical, setFromCanonical] = useState<Set<string>>(new Set()),
		[loaded, setLoaded] = useState<Record<string, Loaded>>({}),
		[collapsed, setCollapsed] = useState<Record<string, boolean>>({}),
		[query, setQuery] = useState(""),
		[timeline, setTimeline] = useState(false),
		[menu, setMenu] = useState(false),
		[current, setCurrent] = useState<string>(),
		[draft, setDraft] = useState<{ path: string; key: string }>(),
		[wholeDraft, setWholeDraft] = useState(false);
	const ticket = useRef(0);
	const rootRef = useRef<HTMLDivElement>(null);
	const canWrite = view.permissions.write && view.permissions.human;
	const canResolve = view.permissions.approve;
	const notes = useMemo(() => changeNotes(view, p).filter((n) => prefs.resolved || n.state !== "resolved"), [view, p, prefs.resolved]);
	// A newer revision of this change becomes the comparison target; an older choice of base stays where it was.
	useEffect(() => {
		setRange((r) => (r.to === p.revision ? r : { from: earlier?.revision ?? p.base, to: p.revision }));
	}, [p.revision, p.base, earlier?.revision]);
	const fetchFile = async (path: string, key: number, fromStorage = stored) => {
		setLoaded((l) => ({ ...l, [path]: { ...l[path], loading: true, error: undefined } }));
		try {
			const result = (await execute({
				tool: fromStorage ? "inspect_source" : "get_diff",
				...(fromStorage ? { sourceView: "diff" as const } : {}),
				baseRevision: from,
				revision: to,
				path,
			})) as ChangesResponse;
			if (key !== ticket.current) return;
			setLoaded((l) => ({ ...l, [path]: { ...l[path], loading: false, patch: result.file?.patch ?? null, reason: result.file?.reason } }));
		} catch (e) {
			if (key === ticket.current) setLoaded((l) => ({ ...l, [path]: { ...l[path], loading: false, error: (e as Error).message } }));
		}
	};
	const fetchContent = async (path: string, key: number) => {
		try {
			const result = (await execute({ tool: "get_source", revision: to, path })) as { files?: Record<string, string> };
			if (key !== ticket.current) return;
			const text = result.files?.[path];
			setLoaded((l) => ({ ...l, [path]: { ...l[path], content: text === undefined ? null : text.replace(/\n$/, "").split("\n") } }));
		} catch {
			if (key === ticket.current) setLoaded((l) => ({ ...l, [path]: { ...l[path], content: null } }));
		}
	};
	const loadList = async (fromStorage: boolean) => {
		const key = ++ticket.current;
		setListError("");
		setLoaded({});
		setCollapsed({});
		setDraft(undefined);
		try {
			const changedPaths = async (base: string, revision: string) =>
				new Set(((await execute({ tool: "get_diff", baseRevision: base, revision })) as ChangesResponse).files.map((f) => f.path));
			const earlierChange = changeThread(view.proposals, p).find((o) => o.revision === from && o.id !== p.id);
			const [result, own] = await Promise.all([
				execute({
					tool: fromStorage ? "inspect_source" : "get_diff",
					...(fromStorage ? { sourceView: "diff" as const } : {}),
					baseRevision: from,
					revision: to,
				}) as Promise<ChangesResponse>,
				// Grouping reads the bounded local cache only; a stored diff is shown ungrouped rather than spend more operations.
				earlierChange && to === p.revision && !fromStorage
					? Promise.all([changedPaths(p.base, p.revision), changedPaths(earlierChange.base, earlierChange.revision)])
					: undefined,
			]);
			if (key !== ticket.current) return;
			setStored(fromStorage);
			setList(result);
			setFromCanonical(new Set(own ? result.files.filter((f) => !own[0].has(f.path) && !own[1].has(f.path)).map((f) => f.path) : []));
		} catch (e) {
			if (key === ticket.current) {
				setList(undefined);
				setListError((e as Error).message);
			}
		}
	};
	// biome-ignore lint/correctness/useExhaustiveDependencies: load once per exact comparison.
	useEffect(() => {
		void loadList(false);
	}, [from, to]);
	const overlaps = useMemo(() => {
		const lanes = laneIndex(view),
			byPath = new Map<string, Entry["overlap"]>();
		for (const o of view.overlaps) {
			if (!o.workspaces.includes(p.workspaceId)) continue;
			byPath.set(
				o.surface,
				o.workspaces
					.filter((id) => id !== p.workspaceId)
					.map((id) => ({ id, title: view.workspaces.find((w) => w.id === id)?.title ?? id, lane: lanes.get(id) })),
			);
		}
		return byPath;
	}, [view, p.workspaceId]);
	const entries = useMemo(() => {
		const all = (list?.files ?? []).map((file): Entry => {
			const fileNotes = notes.filter((n) => n.note.anchor?.path === file.path);
			const overlap = overlaps.get(file.path) ?? [];
			const kind =
				fileNotes.some((n) => n.state !== "resolved") || overlap.length ? "" : supportingKind(file, fromCanonical.has(file.path));
			return { file, kind, notes: fileNotes, overlap };
		});
		const score = (e: Entry) =>
			e.notes.filter((n) => n.state !== "resolved").length * 1000 +
			(e.overlap.length ? 300 : 0) +
			(e.file.additions ?? 0) +
			(e.file.deletions ?? 0);
		return [
			...all.filter((e) => !e.kind).toSorted((a, b) => score(b) - score(a) || a.file.path.localeCompare(b.file.path)),
			...all.filter((e) => e.kind).toSorted((a, b) => a.kind.localeCompare(b.kind) || a.file.path.localeCompare(b.file.path)),
		];
	}, [list, notes, overlaps, fromCanonical]);
	const shown = entries.filter((e) => !query.trim() || e.file.path.toLowerCase().includes(query.trim().toLowerCase()));
	const isViewed = (path: string) => viewed[path] === to;
	const isClosed = (e: Entry) => collapsed[e.file.path] ?? (isViewed(e.file.path) || !!e.kind);
	// The notes margin exists only while an open file has a note or a draft in it; otherwise the code takes the width.
	const beside = besideAllowed && (!!draft || shown.some((e) => !isClosed(e) && e.notes.length > 0));
	// Open files load their changes as soon as the list arrives, a few at a time; folded ones load when unfolded.
	// A stored diff spends an operation per file, so only files the reviewer opens are requested.
	// biome-ignore lint/correctness/useExhaustiveDependencies: request each open file once per comparison.
	useEffect(() => {
		if (!list) return;
		const key = ticket.current;
		const wanted = shown.filter((e) => !isClosed(e) && !loaded[e.file.path]).map((e) => e.file.path);
		let next = 0;
		const worker = async () => {
			while (next < wanted.length && key === ticket.current) await fetchFile(wanted[next++], key);
		};
		void Promise.all([worker(), worker(), worker()]);
	}, [list, collapsed, query, viewed]);
	const markViewed = (path: string) => {
		setViewed((v) => {
			const next = { ...v };
			if (next[path] === to) delete next[path];
			else next[path] = to;
			writeJson(viewedKey, next);
			return next;
		});
		setCollapsed((c) => {
			const { [path]: _, ...rest } = c;
			return rest;
		});
	};
	const scrollToFile = (path: string) => {
		const el = rootRef.current?.querySelector<HTMLElement>(`[data-file="${CSS.escape(path)}"]`);
		el?.scrollIntoView({ behavior: "smooth", block: "start" });
	};
	const openFile = (path: string) => {
		const e = entries.find((x) => x.file.path === path);
		if (e && isClosed(e)) setCollapsed((c) => ({ ...c, [path]: false }));
		requestAnimationFrame(() => scrollToFile(path));
	};
	const cite = (revision: string) => {
		const index = stops.findIndex((s) => s.revision === revision);
		if (index > 0) setRange({ from: stops[index - 1].revision, to: revision });
	};
	// The current file follows the reading position; a new file list starts it again.
	// biome-ignore lint/correctness/useExhaustiveDependencies: rerun when the rendered files change.
	useEffect(() => {
		let frame = 0;
		const spy = () => {
			cancelAnimationFrame(frame);
			frame = requestAnimationFrame(() => {
				const files = rootRef.current?.querySelectorAll<HTMLElement>(".rv-file");
				if (!files?.length) return;
				let at: string | undefined;
				for (const f of files) if (f.getBoundingClientRect().top < 180) at = f.dataset.file;
				setCurrent(at ?? files[0].dataset.file);
			});
		};
		window.addEventListener("scroll", spy, { passive: true });
		spy();
		return () => {
			window.removeEventListener("scroll", spy);
			cancelAnimationFrame(frame);
		};
	}, [shown.length]);
	// Keyboard reading: files, changes, notes, viewed and folding. Never while typing.
	useEffect(() => {
		const step = (selector: string, dir: 1 | -1, offset = 150) => {
			const els = [...(rootRef.current?.querySelectorAll<HTMLElement>(selector) ?? [])].filter((e) => e.offsetParent);
			const target =
				dir > 0
					? els.find((e) => e.getBoundingClientRect().top > offset + 4)
					: els.toReversed().find((e) => e.getBoundingClientRect().top < offset - 4);
			if (target) window.scrollBy({ top: target.getBoundingClientRect().top - offset, behavior: "smooth" });
		};
		const keys = (e: KeyboardEvent) => {
			if (e.metaKey || e.ctrlKey || e.altKey || typing()) return;
			if (e.key === "n") step(".rv-file", 1, 120);
			else if (e.key === "p") step(".rv-file", -1, 120);
			else if (e.key === "j") step(".rv-ln.a:not(.a + .a), .rv-ln.d:not(.d + .d):not(.a + .d), .rv-ln.sp:has(.a, .d)", 1);
			else if (e.key === "k") step(".rv-ln.a:not(.a + .a), .rv-ln.d:not(.d + .d):not(.a + .d), .rv-ln.sp:has(.a, .d)", -1);
			else if (e.key === "]") step(".rv-note.awaiting_owner, .rv-note.awaiting_reviewer", 1, 200);
			else if (e.key === "[") step(".rv-note.awaiting_owner, .rv-note.awaiting_reviewer", -1, 200);
			else if (e.key === "v" && current) markViewed(current);
			else if (e.key === "x" && current) {
				const e2 = entries.find((x) => x.file.path === current);
				if (e2) setCollapsed((c) => ({ ...c, [current]: !isClosed(e2) }));
			} else return;
			e.preventDefault();
		};
		window.addEventListener("keydown", keys);
		return () => window.removeEventListener("keydown", keys);
	});
	// Another part of the page asked to show one note: switch to a comparison that contains it, open its file, then scroll.
	// biome-ignore lint/correctness/useExhaustiveDependencies: run once per request.
	useEffect(() => {
		if (!focus) return;
		const target = notes.find((n) => n.note.id === focus.id);
		const path = target?.note.anchor?.path;
		if (path) {
			const anchorRevision = target.note.anchor!.revision;
			if (![from, to].includes(anchorRevision) && anchorRevision !== p.base) setRange({ from: p.base, to: p.revision });
			setCollapsed((c) => ({ ...c, [path]: false }));
		}
		let tries = 0;
		const find = () => {
			const card = rootRef.current?.querySelector<HTMLElement>(`[data-note-id="${CSS.escape(focus.id)}"]`);
			if (card) {
				card.scrollIntoView({ behavior: "smooth", block: "center" });
				card.classList.add("flash");
				setTimeout(() => card.classList.remove("flash"), 1600);
			} else if (tries++ < 40) setTimeout(find, 100);
		};
		find();
	}, [focus?.nonce]);
	const viewedCount = entries.filter((e) => isViewed(e.file.path)).length;
	const label =
		from === p.base && to === p.revision
			? "Whole change"
			: earlier && from === earlier.revision && to === p.revision
				? `Since #${earlier.number} was reviewed`
				: "Comparing";
	const stopLabel = (revision: string) => stops.find((s) => s.revision === revision)?.label ?? short(revision);
	const moveTo = (i: number) => {
		const fi = stops.findIndex((s) => s.revision === from),
			ti = stops.findIndex((s) => s.revision === to);
		if (i === fi || i === ti) return;
		if (i < fi || (i < ti && i - fi <= ti - i)) setRange({ from: stops[i].revision, to });
		else setRange({ from, to: stops[i].revision });
	};
	const fi = stops.findIndex((s) => s.revision === from),
		ti = stops.findIndex((s) => s.revision === to);
	const wholeNotes = notes.filter((n) => !n.note.anchor);
	const elsewhere = notes.filter(
		(n) => n.note.anchor && !entries.some((e) => e.file.path === n.note.anchor!.path) && n.state !== "resolved",
	);
	const main = shown.filter((e) => !e.kind),
		supporting = shown.filter((e) => e.kind);
	const block = (e: Entry) => (
		<FileBlock
			key={`${from}:${to}:${e.file.path}`}
			entry={e}
			loaded={loaded[e.file.path]}
			p={p}
			from={from}
			to={to}
			prefs={{ ...prefs, split: sideBySide }}
			beside={beside}
			closed={isClosed(e)}
			viewed={isViewed(e.file.path)}
			who={who}
			execute={execute}
			canWrite={canWrite}
			canResolve={canResolve}
			stored={stored}
			onToggle={() => setCollapsed((c) => ({ ...c, [e.file.path]: !isClosed(e) }))}
			onViewed={() => markViewed(e.file.path)}
			onLoad={() => void fetchFile(e.file.path, ticket.current)}
			onContent={() => void fetchContent(e.file.path, ticket.current)}
			onCite={cite}
			draftKey={draft?.path === e.file.path ? draft.key : undefined}
			setDraftKey={(key) => setDraft(key ? { path: e.file.path, key } : undefined)}
		/>
	);
	const treeItem = (e: Entry) => {
		const slash = e.file.path.lastIndexOf("/");
		const open = e.notes.filter((n) => n.state !== "resolved").length;
		return (
			<button
				key={e.file.path}
				type="button"
				className={`rv-titem${e.kind ? " sup" : ""}${current === e.file.path ? " current" : ""}`}
				onClick={() => openFile(e.file.path)}
				title={e.file.path}
			>
				<span className={isViewed(e.file.path) ? "rv-vi on" : "rv-vi"} aria-hidden="true" />
				<span className="rv-nm">
					{e.file.path.slice(slash + 1)}
					{isViewed(e.file.path) && <span className="sr-only"> (viewed)</span>}
					<small>{e.file.path.slice(0, Math.max(0, slash))}</small>
				</span>
				<span className="rv-ct">
					{open > 0 && (
						<span className="rv-count" title="Unresolved notes">
							{open}
						</span>
					)}
					{e.overlap.length > 0 && (
						<span
							className="rv-lane"
							title={`Also changed in ${e.overlap.map((o) => o.title).join(", ")}`}
							style={{ "--lane": `var(--lane-${e.overlap[0].lane ?? 1})` } as CSSProperties}
						/>
					)}
					{e.kind}
				</span>
			</button>
		);
	};
	return (
		<div className={`rv${beside ? " beside" : ""}`} ref={rootRef}>
			<aside className="rv-tree" aria-label="Changed files">
				<div className="rv-tree-head">
					<b>Files</b>
					<span>
						{viewedCount} of {entries.length} viewed
					</span>
				</div>
				<div className="rv-bar">
					<i style={{ width: `${entries.length ? (viewedCount / entries.length) * 100 : 0}%` }} />
				</div>
				{/* A short list reads faster than a filter. */}
				{(entries.length > 8 || query) && (
					<input
						type="search"
						value={query}
						onChange={(e) => setQuery(e.target.value)}
						placeholder="Filter files"
						aria-label="Filter files"
					/>
				)}
				<nav aria-label="Changed files list">
					{/* Group headings only earn their place when both groups are present. */}
					{main.length > 0 && (
						<>
							{supporting.length > 0 && (
								<p className="rv-group">
									<span>Start here</span>
									<span>{main.length}</span>
								</p>
							)}
							{main.map(treeItem)}
						</>
					)}
					{supporting.length > 0 && (
						<>
							{main.length > 0 && (
								<p className="rv-group">
									<span>Supporting</span>
									<span>{supporting.length}</span>
								</p>
							)}
							{supporting.map(treeItem)}
						</>
					)}
					{list && !shown.length && <p className="rv-quiet">{entries.length ? "No files match." : "No file changes."}</p>}
				</nav>
			</aside>
			<section className="rv-stream" aria-label="Files changed">
				<div className="rv-toolbar">
					<button type="button" className="rv-quietbtn rv-compare" aria-expanded={timeline} onClick={() => setTimeline((t) => !t)}>
						{label}
						<code>
							{stopLabel(from)} → {stopLabel(to)}
						</code>
						<svg viewBox="0 0 24 24" aria-hidden="true">
							<path d="m6 9 6 6 6-6" />
						</svg>
					</button>
					{list && (
						<span className="rv-sum">
							{list.files.length} {list.files.length === 1 ? "file" : "files"}
							{list.statsComplete && (
								<>
									{" · "}
									<span className="plus">+{list.additions}</span> <span className="minus">−{list.deletions}</span>
								</>
							)}
						</span>
					)}
					<span className="rv-menuwrap">
						<button type="button" className="rv-quietbtn" aria-expanded={menu} aria-haspopup="true" onClick={() => setMenu((m) => !m)}>
							View
							<svg viewBox="0 0 24 24" aria-hidden="true">
								<path d="m6 9 6 6 6-6" />
							</svg>
						</button>
						{menu && (
							<fieldset className="rv-menu">
								<legend className="sr-only">View options</legend>
								<label>
									Notes beside the code
									<input
										type="checkbox"
										checked={prefs.beside}
										onChange={(e) => setPrefs({ beside: e.target.checked })}
										disabled={!wideEnough}
									/>
								</label>
								<label>
									Side by side
									<input
										type="checkbox"
										checked={prefs.split}
										onChange={(e) => setPrefs({ split: e.target.checked })}
										disabled={!wideEnough}
									/>
								</label>
								<label>
									Hide whitespace changes
									<input type="checkbox" checked={prefs.whitespace} onChange={(e) => setPrefs({ whitespace: e.target.checked })} />
								</label>
								<label>
									Show resolved notes
									<input type="checkbox" checked={prefs.resolved} onChange={(e) => setPrefs({ resolved: e.target.checked })} />
								</label>
								<p>
									<kbd>n</kbd> <kbd>p</kbd> files · <kbd>j</kbd> <kbd>k</kbd> changes · <kbd>]</kbd> <kbd>[</kbd> notes · <kbd>v</kbd>{" "}
									viewed · <kbd>x</kbd> fold
								</p>
							</fieldset>
						)}
					</span>
					{timeline && (
						<div className="rv-timeline">
							<div className="rv-track" style={{ "--stops": stops.length } as CSSProperties}>
								{stops.map((s, i) => (
									<button
										key={s.revision}
										type="button"
										className={`rv-stop${i === fi ? " from" : i === ti ? " to" : i > fi && i < ti ? " in" : ""}${i >= fi && i < ti ? " span" : ""}`}
										onClick={() => moveTo(i)}
										title={`${s.label} ${s.revision}`}
									>
										<span className="rv-rail">
											<span className="rv-dot" />
											{i < stops.length - 1 && <span className="rv-line" />}
										</span>
										<code>
											{s.label} <span>{short(s.revision)}</span>
										</code>
										<small>{s.note}</small>
									</button>
								))}
							</div>
							<p className="rv-faint">
								Choose a revision to move the nearest end of the comparison.{" "}
								{!(from === p.base && to === p.revision) && (
									<button type="button" className="text-button" onClick={() => setRange({ from: p.base, to: p.revision })}>
										Whole change
									</button>
								)}
							</p>
						</div>
					)}
				</div>
				{listError && (
					<div className="rv-unavailable" role="alert">
						<p>{listError}</p>
						<p className="rv-faint">
							Loading the stored diff uses cloud storage and one namespace resource operation per file you open, and may recover retained
							Git objects.
						</p>
						<div className="rv-acts">
							<button type="button" onClick={() => void loadList(false)}>
								Retry
							</button>
							<button type="button" onClick={() => void loadList(true)}>
								Load stored diff
							</button>
						</div>
					</div>
				)}
				{!list && !listError && <p className="rv-quiet">Loading changed files…</p>}
				{(wholeNotes.length > 0 || wholeDraft) && (
					<div className="rv-whole">
						<p className="rv-section">Notes on the whole change</p>
						{wholeNotes.map((item) => (
							<NoteCard
								key={item.note.id}
								item={item}
								who={who}
								execute={execute}
								canReply={canWrite && p.state === "open"}
								canResolve={canResolve && p.state === "open"}
								onCite={cite}
							/>
						))}
						{wholeDraft && <NoteComposer p={p} execute={execute} onDone={() => setWholeDraft(false)} />}
					</div>
				)}
				{canWrite && p.state === "open" && !wholeDraft && (
					<button type="button" className="text-button rv-addwhole" onClick={() => setWholeDraft(true)}>
						Add a note on the whole change
					</button>
				)}
				{main.map(block)}
				{supporting.length > 0 && (
					<p className="rv-section">
						Supporting <span>{[...new Set(supporting.map((e) => e.kind.toLowerCase()))].join(", ")}, folded</span>
					</p>
				)}
				{supporting.map(block)}
				{elsewhere.length > 0 && (
					<div className="rv-whole">
						<p className="rv-section">Notes on files outside this comparison</p>
						{elsewhere.map((item) => (
							<div key={item.note.id}>
								<p className="rv-faint">
									<code>{item.note.anchor!.path}</code>
								</p>
								<NoteCard
									item={item}
									who={who}
									execute={execute}
									canReply={canWrite && p.state === "open"}
									canResolve={canResolve && p.state === "open"}
									onCite={cite}
								/>
							</div>
						))}
					</div>
				)}
			</section>
		</div>
	);
}
