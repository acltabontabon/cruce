import { lazy, Suspense, useEffect, useState } from "react";
import { BRAND } from "./brand.tsx";
import { Landing } from "./landing.tsx";
import { request } from "./request.ts";
import { rememberSignInDestination, restoreSignInDestination } from "./sign-in-destination.ts";

const Console = lazy(() => import("./App.tsx").then((module) => ({ default: module.App })));

function SessionStatus({ error, retry }: { error?: string; retry?: () => void }) {
	return (
		<main className="session-status" aria-busy={!error}>
			<img src={BRAND.wordmarkInk} alt={BRAND.name} />
			{error ? (
				<>
					<h1>Connection unavailable.</h1>
					<p role="alert">{error}</p>
					<button type="button" onClick={retry}>
						Try again
					</button>
					<a href="/auth/login" onClick={rememberSignInDestination}>
						Sign in
					</a>
				</>
			) : (
				<p role="status">Finding your common ground…</p>
			)}
		</main>
	);
}

export function SessionBoundary() {
	const [state, setState] = useState<"loading" | "public" | "console" | "error">("loading"),
		[error, setError] = useState(""),
		[attempt, setAttempt] = useState(0);
	useEffect(() => {
		void attempt;
		const controller = new AbortController();
		setState("loading");
		const expire = () => {
			controller.abort();
			setState("public");
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
					if (result.authenticated) restoreSignInDestination();
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
	if (state === "public") return <Landing />;
	if (state === "console")
		return (
			<Suspense fallback={<SessionStatus />}>
				<Console />
			</Suspense>
		);
	return <SessionStatus error={state === "error" ? error : undefined} retry={() => setAttempt((value) => value + 1)} />;
}
