/** A quiet branded backdrop: an accent glow, a fading dot grid and the Cruce crossing drawn in hairlines. */
export function Backdrop() {
	return (
		<div className="shell-backdrop" aria-hidden="true">
			<svg
				aria-hidden="true"
				className="backdrop-crossing"
				viewBox="0 0 32 32"
				fill="none"
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
			>
				<path d="M4 25 14.3 6.8Q16 3.8 17.7 6.8L28 25" vectorEffect="non-scaling-stroke" />
				<path d="M-8 14h14m5 3 2.2 3.2q2.8 4 5.6 0L21 17m5-3h14" vectorEffect="non-scaling-stroke" />
				<path d="M7.2 25 15.4 10.4Q16 9.4 16.6 10.4L24.8 25" vectorEffect="non-scaling-stroke" />
			</svg>
		</div>
	);
}
