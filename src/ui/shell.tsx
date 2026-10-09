import { type ReactNode, useEffect } from "react";
import { Backdrop } from "./backdrop.tsx";
import { BRAND } from "./brand.tsx";

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
