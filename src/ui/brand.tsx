export const BRAND = {
	name: "Cruce",
	symbol: "/brand/symbol.svg",
	wordmark: "/brand/wordmark-white.svg",
	wordmarkInk: "/brand/wordmark.svg",
	sourceUrl: undefined as string | undefined,
	docsUrl: undefined as string | undefined,
};
export function Brand() {
	return <img className="brand-wordmark" src={BRAND.wordmark} alt={BRAND.name} />;
}
