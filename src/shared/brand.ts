/** The Cruce mark on a 32-unit grid: an arch, and the line that weaves through it. The console and Worker-rendered pages draw it inline. */
export const MARK = {
	viewBox: "0 0 32 32",
	arch: "M4 25 14.3 6.8Q16 3.8 17.7 6.8L28 25",
	crossing: "M3 14h3m5 3 2.2 3.2q2.8 4 5.6 0L21 17m5-3h3",
} as const;

/** Runs before first paint: resolves the saved appearance onto <html data-theme>, as src/ui/theme.ts does afterwards. */
export const APPEARANCE_SCRIPT = `try{var s=localStorage.getItem("cruce.appearance"),t=s==="dark"||s==="light"?s:matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light",r=document.documentElement;r.dataset.theme=t;r.style.colorScheme=t}catch(e){}`;
