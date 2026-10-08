import { useEffect, useState, useSyncExternalStore } from "react";
import { SPLASH_INNER } from "./splash.ts";

/*
 * Every loading state in the console comes from here:
 * - Cold start shows the splash (the mark drawing itself) until the first real screen, as one continuous surface.
 * - Inside the console, whatever the person is waiting on (opening a page, an action, a requested read) is tracked; the header mark
 *   breathes and a hairline runs under the header. Background polling is never tracked.
 * - Content that has not arrived yet holds its place with skeletons, never with "Loading…" text.
 */

let splashes = 0;
/** The page's splash shows its mark 300ms after navigation (see splash.ts); once shown, it stays this long so it never blinks. */
const MARK_DELAY = 300,
	MARK_MINIMUM = 400;

/** Fades out the page's own splash once no Splash is mounted; a Splash mounted in the same commit keeps it up. */
export function settleBoot() {
	const now = performance.now(),
		hold = now < MARK_DELAY ? 0 : Math.max(0, MARK_DELAY + MARK_MINIMUM - now);
	setTimeout(() => {
		const boot = document.getElementById("boot");
		if (splashes || !boot || boot.dataset.done !== undefined) return;
		boot.dataset.done = "";
		boot.removeAttribute("role");
		const remove = () => boot.remove();
		boot.addEventListener("transitionend", remove, { once: true });
		setTimeout(remove, 400);
	}, hold);
}

/** The full-screen splash. While the page's own splash is still up, it keeps that one showing instead of drawing a second. */
export function Splash() {
	const [own] = useState(() => {
		const boot = document.getElementById("boot");
		return !boot || boot.dataset.done !== undefined;
	});
	useEffect(() => {
		splashes++;
		return () => {
			splashes--;
			settleBoot();
		};
	}, []);
	// biome-ignore lint/security/noDangerouslySetInnerHtml: constant markup shared with the page's pre-script splash.
	return own ? <div className="boot" role="status" dangerouslySetInnerHTML={{ __html: SPLASH_INNER }} /> : null;
}

let pending = 0;
const listeners = new Set<() => void>();
const emit = () => {
	for (const listener of listeners) listener();
};
function begin() {
	pending++;
	emit();
	let ended = false;
	return () => {
		if (ended) return;
		ended = true;
		pending--;
		emit();
	};
}

/** Shows progress in the header until the work settles, whether it succeeds or fails. */
export function track<T>(work: Promise<T>): Promise<T> {
	const end = begin();
	return work.finally(end);
}

/** Shows progress in the header while `active` is true and the component is mounted. */
export function usePending(active: boolean) {
	useEffect(() => (active ? begin() : undefined), [active]);
}

const subscribe = (listener: () => void) => {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
};
export function useProgress() {
	return useSyncExternalStore(
		subscribe,
		() => pending > 0,
		() => false,
	);
}

/** Stable keys for placeholder shapes; a skeleton never holds more than this many. */
const SHAPES = ["a", "b", "c", "d", "e", "f", "g", "h"];

/** List rows that have not arrived yet. */
export function SkeletonRows({ label, count = 3 }: { label: string; count?: number }) {
	return (
		<div className="rows skeleton" aria-busy="true">
			<p className="sr-only">{label}</p>
			{SHAPES.slice(0, count).map((shape) => (
				<span key={shape} className="skeleton-row" aria-hidden="true">
					<span />
					<span />
				</span>
			))}
		</div>
	);
}

/** Code or file content that has not arrived yet. */
export function SkeletonLines({ label, count = 6 }: { label: string; count?: number }) {
	return (
		<div className="skeleton skeleton-lines" aria-busy="true">
			<p className="sr-only">{label}</p>
			{SHAPES.slice(0, count).map((shape) => (
				<span key={shape} aria-hidden="true" />
			))}
		</div>
	);
}

/** A name that has not arrived yet, inline with text. */
export function SkeletonText({ label }: { label: string }) {
	return <span className="skeleton-text" role="img" aria-label={label} />;
}

/** A page whose data has not arrived yet: its title, then its list. */
export function SkeletonPage({ label }: { label: string }) {
	return (
		<div className="skeleton-page" aria-busy="true">
			<span className="skeleton-title" aria-hidden="true" />
			<SkeletonRows label={label} count={4} />
		</div>
	);
}
