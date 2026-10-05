const key = "cruce:sign-in-destination";
function privateDestination(url: URL) {
	return (
		url.origin === location.origin &&
		((url.pathname === "/" && url.searchParams.has("namespace")) || /^\/invite\/[^/]+$/.test(url.pathname))
	);
}

// Keep the existing /auth/login link and redirect. Store only same-origin console navigation,
// including fragment-only detail/invitation state that cannot travel in a Referer header.
export function rememberSignInDestination() {
	try {
		const url = new URL(location.href);
		if (privateDestination(url)) sessionStorage.setItem(key, `${url.pathname}${url.search}${url.hash}`);
		else sessionStorage.removeItem(key);
	} catch {
		/* Navigation still works when browser storage is unavailable. */
	}
}

export function restoreSignInDestination() {
	try {
		const saved = sessionStorage.getItem(key);
		sessionStorage.removeItem(key);
		if (!saved || location.pathname !== "/" || location.search) return;
		const url = new URL(saved, location.origin);
		if (privateDestination(url)) history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
	} catch {
		/* Fall back to the authenticated Home. */
	}
}
