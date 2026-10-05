export const BRAND = {
	name: "Cruce",
	tagline: ["Agent work.", "Shared direction."],
	symbol: "/brand/symbol.svg",
	wordmark: "/brand/wordmark-white.svg",
};
export function Brand() {
	return <img className="brand-wordmark" src={BRAND.wordmark} alt={BRAND.name} />;
}
