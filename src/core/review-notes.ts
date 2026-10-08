import type { Proposal, ReviewNote } from "../shared/platform.ts";

/** Who a note waits for. The owner side is the workspace owner through the console or any of their connections. */
export type ReviewNoteState = "awaiting_owner" | "awaiting_reviewer" | "resolved";

/**
 * The changes in the thread ending at `p`: `p` and every change it superseded, transitively, newest first. A thread
 * follows supersession from one workspace; a change closed by a human, withdrawn or promoted ends it.
 */
export function changeThread(proposals: readonly Proposal[], p: Proposal): Proposal[] {
	const thread = [p];
	for (let i = 0; i < thread.length; i++)
		for (const o of proposals) if (o.supersededBy === thread[i].id && !thread.includes(o)) thread.push(o);
	return thread.toSorted((a, b) => b.number - a.number);
}

/** The newest change in the thread containing `p`. */
export function threadHead(proposals: readonly Proposal[], p: Proposal): Proposal {
	const seen = new Set<string>();
	let head = p;
	while (head.supersededBy && !seen.has(head.id)) {
		seen.add(head.id);
		const next = proposals.find((o) => o.id === head.supersededBy);
		if (!next) break;
		head = next;
	}
	return head;
}

/** Every note in the thread ending at `p`, oldest first, with the change it was added to. */
export function threadNotes(proposals: readonly Proposal[], p: Proposal): { note: ReviewNote; change: Proposal }[] {
	return changeThread(proposals, p)
		.flatMap((change) => (change.notes ?? []).map((note) => ({ note, change })))
		.toSorted((a, b) => a.note.at - b.note.at || a.note.id.localeCompare(b.note.id));
}

export function reviewNoteState(note: ReviewNote, ownerId: string): ReviewNoteState {
	if (note.resolution) return "resolved";
	return note.replies.at(-1)?.actor.userId === ownerId ? "awaiting_reviewer" : "awaiting_owner";
}

/** The note with this ID anywhere in retained changes, with the change holding it. */
export function findReviewNote(proposals: readonly Proposal[], id?: string) {
	for (const change of proposals) {
		const note = change.notes?.find((n) => n.id === id);
		if (note) return { note, change };
	}
	return undefined;
}
