export const BRAND = {
	name: "Cruce",
	symbol: "/brand/symbol.svg",
	wordmark: "/brand/wordmark-white.svg",
	wordmarkInk: "/brand/wordmark.svg",
	sourceUrl: undefined as string | undefined,
	docsUrl: undefined as string | undefined,
};
/** The interlaced junction drawn inline so it takes the theme's accent; the name is set in the console's own type. */
export function Brand() {
	return (
		<>
			<svg className="brand-symbol" viewBox="0 0 32 32" aria-hidden="true">
				<g fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
					<path d="M4 25 14.3 6.8Q16 3.8 17.7 6.8L28 25" />
					<path d="M3 14h3m5 3 2.2 3.2q2.8 4 5.6 0L21 17m5-3h3" />
				</g>
			</svg>
			<span className="brand-name">{BRAND.name}</span>
		</>
	);
}
