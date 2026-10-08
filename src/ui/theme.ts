import { useEffect, useState } from "react";

/** Appearance is a per-browser preference. Matching the system is the default; Midnight is the dark theme and Daylight the light one. */
export type Appearance = "system" | "dark" | "light";
const KEY = "cruce.appearance";
const dark = () => matchMedia("(prefers-color-scheme: dark)").matches;

export function readAppearance(): Appearance {
	try {
		const saved = localStorage.getItem(KEY);
		return saved === "dark" || saved === "light" ? saved : "system";
	} catch {
		return "system";
	}
}

/** Resolves the preference onto <html data-theme>, which the stylesheet themes from. APPEARANCE_SCRIPT in src/shared/brand.ts runs the same logic before first paint. */
export function applyAppearance(appearance: Appearance) {
	const theme = appearance === "system" ? (dark() ? "dark" : "light") : appearance,
		root = document.documentElement;
	if (root.dataset.theme === theme) return;
	// Switch in one frame: colour transitions would otherwise fade every control between themes.
	root.classList.add("theme-switching");
	root.dataset.theme = theme;
	root.style.colorScheme = theme;
	requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove("theme-switching")));
}

export function useAppearance() {
	const [appearance, setAppearance] = useState(readAppearance);
	useEffect(() => {
		applyAppearance(appearance);
		if (appearance !== "system") return;
		const query = matchMedia("(prefers-color-scheme: dark)");
		const follow = () => applyAppearance("system");
		query.addEventListener("change", follow);
		return () => query.removeEventListener("change", follow);
	}, [appearance]);
	const choose = (next: Appearance) => {
		try {
			if (next === "system") localStorage.removeItem(KEY);
			else localStorage.setItem(KEY, next);
		} catch {
			// Storage can be unavailable; the choice still applies for this visit.
		}
		setAppearance(next);
	};
	return [appearance, choose] as const;
}
