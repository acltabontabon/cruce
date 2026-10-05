import type { ReactNode } from "react";
import { BRAND } from "./brand.tsx";

export function Shell({ navigation, children }: { navigation: ReactNode; children: ReactNode }) {
	return (
		<div className="shell">
			<button type="button" className="skip" onClick={() => document.getElementById("content")?.focus()}>
				Skip to content
			</button>
			{navigation}
			{children}
			<footer className="console-footer">{BRAND.name} · Alpha</footer>
		</div>
	);
}
