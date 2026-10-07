import { useEffect } from "react";
import { BRAND, Brand } from "./brand.tsx";
import { rememberSignInDestination, type SignInReason } from "./sign-in-destination.ts";
import { useAppearance } from "./theme.ts";

const COPY: Record<SignInReason, { title: string; lead: string }> = {
	requested: { title: `Sign in to ${BRAND.name}`, lead: "Continue to your repositories, workspaces and reviews." },
	repository: { title: `Sign in to ${BRAND.name}`, lead: "Sign in to open this repository." },
	invitation: { title: `Sign in to ${BRAND.name}`, lead: "Sign in to accept this namespace invitation." },
	expired: { title: "Your session ended", lead: "Sign in again to continue where you left off." },
};

/**
 * Cruce's own sign-in page. It hands off to the unchanged /auth/login route; Cloudflare Access still authenticates,
 * and with a single identity provider and Instant Auth it goes straight to that provider.
 */
export function SignIn({ reason, provider }: { reason: SignInReason; provider?: string }) {
	useAppearance();
	const copy = COPY[reason];
	useEffect(() => {
		document.title = `Sign in · ${BRAND.name}`;
	}, []);
	return (
		<div className="sign-in">
			<header>
				<a className="brand" href="/" aria-label={`${BRAND.name} home`}>
					<Brand />
				</a>
			</header>
			<main className="sign-in-panel" aria-labelledby="sign-in-heading">
				<h1 id="sign-in-heading">{copy.title}</h1>
				<p className="sign-in-lead">{copy.lead}</p>
				<a className="sign-in-continue" href="/auth/login" onClick={rememberSignInDestination}>
					{provider ? `Continue with ${provider}` : "Sign in"}
				</a>
				<p className="sign-in-note">
					Your first sign-in creates your account and a personal namespace. This installation's administrator decides who can sign in.
				</p>
			</main>
		</div>
	);
}
