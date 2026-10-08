/**
 * The Cruce mark and the cold-start splash. Plain strings so the Vite plugin in tools/boot-splash.ts can put the same splash into
 * the page before any script or stylesheet loads, and the console can show it again from React (see Splash in loading.tsx).
 */

/** The interlaced junction on a 32-unit grid: an arch, and the line that weaves through it. */
export const MARK = {
	viewBox: "0 0 32 32",
	arch: "M4 25 14.3 6.8Q16 3.8 17.7 6.8L28 25",
	crossing: "M3 14h3m5 3 2.2 3.2q2.8 4 5.6 0L21 17m5-3h3",
} as const;

/** Signed-in browsers remember it so the next cold start paints the console surface instead of the public one. */
export const SURFACE_KEY = "cruce.surface";

export const SPLASH_LABEL = "Loading Cruce";

/** Inside a `.boot` element: the mark draws its arch, the crossing weaves through, then both clear and repeat. */
export const SPLASH_INNER = `<svg class="boot-mark" viewBox="${MARK.viewBox}" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path pathLength="1" d="${MARK.arch}"/><path pathLength="1" d="${MARK.crossing}"/></g></svg><span class="boot-label">${SPLASH_LABEL}</span>`;

/**
 * Self-contained: it applies before the console stylesheet exists. The mark appears only after 300ms, so quick starts show nothing
 * but the surface colour. With reduced motion the mark appears still; these rules outrank the console's global motion reset.
 * The public surface keeps its paper palette whatever the appearance; the console surface follows the saved appearance.
 */
export const SPLASH_CSS = `html,body{margin:0;background:#f5f5ef}
.boot{position:fixed;inset:0;z-index:2147483000;display:grid;place-items:center;background:#f5f5ef;color:#346345;transition:opacity 180ms ease}
html[data-surface="console"] .boot{background:#f5f6f9;color:#2c58d0}
html[data-surface="console"][data-theme="dark"] .boot{background:#0f111a;color:#82a6ff}
.boot[data-done]{opacity:0;pointer-events:none}
.boot .boot-mark{width:48px;height:48px;opacity:0;animation:boot-in 240ms ease 300ms forwards}
.boot .boot-mark path{stroke-dasharray:1;stroke-dashoffset:1;animation:boot-draw 2.4s cubic-bezier(.6,0,.3,1) 300ms infinite}
.boot .boot-mark path+path{animation-delay:650ms}
.boot .boot-label{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
@keyframes boot-in{to{opacity:1}}
@keyframes boot-draw{0%{stroke-dashoffset:1}45%,70%{stroke-dashoffset:0}100%{stroke-dashoffset:-1}}
@media (prefers-reduced-motion:reduce){.boot .boot-mark{animation:boot-in 1ms linear 300ms forwards!important}.boot .boot-mark path{animation:none!important;stroke-dashoffset:0}}`;

/** Runs before first paint: the saved appearance (src/ui/theme.ts keeps it in sync afterwards) and the remembered surface. */
export const SPLASH_SCRIPT = `try{var s=localStorage.getItem("cruce.appearance"),t=s==="dark"||s==="light"?s:matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light",r=document.documentElement;r.dataset.theme=t;r.style.colorScheme=t;if(localStorage.getItem("${SURFACE_KEY}")==="console")r.dataset.surface="console"}catch(e){}`;
