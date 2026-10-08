import { MARK } from "../shared/brand.ts";

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
			<svg className="brand-symbol" viewBox={MARK.viewBox} aria-hidden="true">
				<g fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
					<path d={MARK.arch} />
					<path d={MARK.crossing} />
				</g>
			</svg>
			<span className="brand-name">{BRAND.name}</span>
		</>
	);
}
