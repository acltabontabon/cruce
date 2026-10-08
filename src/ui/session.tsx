import { lazy, Suspense, useEffect, useState } from "react";
import { BRAND } from "./brand.tsx";
import { Landing } from "./landing.tsx";
import { Splash, settleBoot } from "./loading.tsx";
import { request } from "./request.ts";
import { rememberSignInDestination, requiresSignIn, restoreSignInDestination } from "./sign-in-destination.ts";
import { SURFACE_KEY } from "./splash.ts";

const Console = lazy(() => import("./App.tsx").then((module) => ({ default: module.App })));

/** Remembers which surface this browser lands on, so the next cold start paints it straight away. */
function rememberSurface(surface: "console" | "public") {
	if (surface === "console") document.documentElement.dataset.surface = "console";
	else delete document.documentElement.dataset.surface;
	try {
		localStorage.setItem(SURFACE_KEY, surface);
	} catch {
		// Without storage the next cold start paints the public surface.
	}
}

function SessionStatus({ error, retry }: { error?: string; retry?: () => void }) {
	if (!error) return <Splash />;
	return (
		<main className="session-status">
			<img src={BRAND.wordmarkInk} alt={BRAND.name} />
			<h1>Connection unavailable.</h1>
			<p role="alert">{error}</p>
			<button type="button" onClick={retry}>
				Try again
			</button>
			<a href="/auth/login" onClick={rememberSignInDestination}>
				Sign in
			</a>
		</main>
	);
}

export function SessionBoundary() {
	const [state, setState] = useState<"loading" | "public" | "expired" | "console" | "error">("loading"),
		[error, setError] = useState(""),
		[attempt, setAttempt] = useState(0);
	useEffect(() => {
		void attempt;
		const controller = new AbortController();
		setState("loading");
		const signIn = () => {
			rememberSignInDestination();
			location.replace("/auth/login");
		};
		const expire = () => {
			controller.abort();
			setState("expired");
			signIn();
		};
		const restored = (event: PageTransitionEvent) => {
			if (event.persisted) setAttempt((value) => value + 1);
		};
		window.addEventListener("cruce:session-expired", expire);
		window.addEventListener("pageshow", restored);
		void request<{ authenticated: boolean }>(
			"/auth/session",
			undefined,
			"GET",
			AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
		)
			.then((result) => {
				if (!controller.signal.aborted) {
					if (result.authenticated) {
						if (location.pathname === "/sign-in") history.replaceState(null, "", "/");
						restoreSignInDestination();
					}
					if (!result.authenticated && requiresSignIn()) {
						signIn();
						return;
					}
					setState(result.authenticated ? "console" : "public");
				}
			})
			.catch((failure: Error) => {
				if (!controller.signal.aborted) {
					setError(failure.message);
					setState("error");
				}
			});
		return () => {
			controller.abort();
			window.removeEventListener("cruce:session-expired", expire);
			window.removeEventListener("pageshow", restored);
		};
	}, [attempt]);
	useEffect(() => {
		if (state === "console" || state === "public") rememberSurface(state);
		settleBoot();
	}, [state]);
	if (state === "public") return <Landing />;
	if (state === "console")
		return (
			<Suspense fallback={<Splash />}>
				<Console />
			</Suspense>
		);
	return <SessionStatus key={attempt} error={state === "error" ? error : undefined} retry={() => setAttempt((value) => value + 1)} />;
}
