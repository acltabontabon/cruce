import { type ReactNode, useEffect } from "react";
import { BRAND } from "./brand.tsx";

/** A quiet branded backdrop: an accent glow, a fading dot grid and the Cruce crossing drawn in hairlines. */
function Backdrop() {
	return (
		<div className="shell-backdrop" aria-hidden="true">
			<svg className="backdrop-crossing" viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
				<path d="M4 25 14.3 6.8Q16 3.8 17.7 6.8L28 25" vectorEffect="non-scaling-stroke" />
				<path d="M-8 14h14m5 3 2.2 3.2q2.8 4 5.6 0L21 17m5-3h14" vectorEffect="non-scaling-stroke" />
				<path d="M7.2 25 15.4 10.4Q16 9.4 16.6 10.4L24.8 25" vectorEffect="non-scaling-stroke" />
			</svg>
		</div>
	);
}

/** Rows whose hover spotlight follows the pointer; see the row hover rules in styles.css. */
const HOVER_ROWS = ".change-row, .workspace-row, .repo-row, .namespace-link, .mini-row, .retained-row, .decision-row, .heads-row";

export function Shell({ navigation, children }: { navigation: ReactNode; children: ReactNode }) {
	useEffect(() => {
		const follow = (event: PointerEvent) => {
			if (event.pointerType !== "mouse" || !(event.target instanceof Element)) return;
			const row = event.target.closest<HTMLElement>(HOVER_ROWS);
			if (!row) return;
			const box = row.getBoundingClientRect();
			row.style.setProperty("--hover-x", `${event.clientX - box.left}px`);
			row.style.setProperty("--hover-y", `${event.clientY - box.top}px`);
		};
		document.addEventListener("pointermove", follow, { passive: true });
		return () => document.removeEventListener("pointermove", follow);
	}, []);
	return (
		<div className="shell">
			<button type="button" className="skip" onClick={() => document.getElementById("content")?.focus()}>
				Skip to content
			</button>
			<Backdrop />
			{navigation}
			{children}
			<footer className="console-footer">{BRAND.name} · Alpha</footer>
		</div>
	);
}
