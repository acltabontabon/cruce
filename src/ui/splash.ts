/**
 * The cold-start splash. Plain strings so the Vite plugin in tools/boot-splash.ts can put the same splash into
 * the page before any script or stylesheet loads, and the console can show it again from React (see Splash in loading.tsx).
 */
import { MARK } from "../shared/brand.ts";

export const SPLASH_LABEL = "Loading Cruce";

/** Inside a `.boot` element: the mark draws its arch, the crossing weaves through, then both clear and repeat. */
export const SPLASH_INNER = `<svg class="boot-mark" viewBox="${MARK.viewBox}" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path pathLength="1" d="${MARK.arch}"/><path pathLength="1" d="${MARK.crossing}"/></g></svg><span class="boot-label">${SPLASH_LABEL}</span>`;

/**
 * Self-contained: it applies before the console stylesheet exists. The mark appears only after 300ms, so quick starts show nothing
 * but the surface colour. With reduced motion the mark appears still; these rules outrank the console's global motion reset.
 * The public homepage and the console share one palette, so the splash follows the saved appearance on either surface.
 */
export const SPLASH_CSS = `html,body{margin:0;background:#f5f6f9}
html[data-theme="dark"],html[data-theme="dark"] body{background:#0f111a}
.boot{position:fixed;inset:0;z-index:2147483000;display:grid;place-items:center;background:#f5f6f9;color:#2c58d0;transition:opacity 180ms ease}
html[data-theme="dark"] .boot{background:#0f111a;color:#82a6ff}
.boot[data-done]{opacity:0;pointer-events:none}
.boot .boot-mark{width:48px;height:48px;opacity:0;animation:boot-in 240ms ease 300ms forwards}
.boot .boot-mark path{stroke-dasharray:1;stroke-dashoffset:1;animation:boot-draw 2.4s cubic-bezier(.6,0,.3,1) 300ms infinite}
.boot .boot-mark path+path{animation-delay:650ms}
.boot .boot-label{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
@keyframes boot-in{to{opacity:1}}
@keyframes boot-draw{0%{stroke-dashoffset:1}45%,70%{stroke-dashoffset:0}100%{stroke-dashoffset:-1}}
@media (prefers-reduced-motion:reduce){.boot .boot-mark{animation:boot-in 1ms linear 300ms forwards!important}.boot .boot-mark path{animation:none!important;stroke-dashoffset:0}}`;
