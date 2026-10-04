import { type ReactNode, useEffect, useId, useRef } from "react";
import type { FlightBadge } from "./model.ts";

const paths = {
	work: "M4 5h16v15H4z M8 3v4 M16 3v4 M4 10h16 M8 14h4",
	traffic: "M3 6h4c5 0 5 12 10 12h4 M3 18h4c5 0 5-12 10-12h4",
	repo: "M5 3h14v18H5z M9 3v18 M12 7h4",
	check: "m5 12 4 4L19 6",
	arrow: "M5 12h14 m-5-5 5 5-5 5",
	back: "M19 12H5 m5-5-5 5 5 5",
	close: "m6 6 12 12 M18 6 6 18",
	chevron: "m9 5 7 7-7 7",
	code: "m8 7-5 5 5 5 m8-10 5 5-5 5 m-3-13-2 16",
	clock: "M12 8v5l3 2 M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0",
	alert: "m12 3 10 18H2z M12 9v5 M12 17v.1",
	play: "m8 4 12 8-12 8z",
	pause: "M8 5v14 M16 5v14",
	more: "M5 12h.1 M12 12h.1 M19 12h.1",
	settings: "M4 7h16 M4 17h16 M8 4v6 M16 14v6",
	commit: "M3 12h5 M16 12h5 M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0",
	plus: "M12 5v14 M5 12h14",
} as const;
export function Icon({ name, size = 16 }: { name: keyof typeof paths; size?: number }) {
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.6"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			<path d={paths[name]} />
		</svg>
	);
}
export function Mark() {
	return (
		<svg width="26" height="26" viewBox="0 0 32 32" fill="none" aria-hidden="true">
			<path
				d="M4 9h7c7 0 3 14 10 14h7 M4 23h7c2 0 3-1 4-3 M18 12c1-2 2-3 4-3h6"
				stroke="currentColor"
				strokeWidth="2"
				strokeLinecap="round"
			/>
		</svg>
	);
}
export function Badge({ badge }: { badge: FlightBadge }) {
	return (
		<span className={`status tone-${badge.tone}`}>
			<span className="status-symbol" aria-hidden="true">
				{badge.label === "Done" ? (
					<Icon name="check" size={13} />
				) : badge.label === "Failed" || badge.label === "Needs attention" ? (
					<Icon name="alert" size={13} />
				) : badge.label === "Waiting" ? (
					<Icon name="pause" size={12} />
				) : (
					<span className="status-dot" />
				)}
			</span>
			{badge.label}
		</span>
	);
}
export function Dialog({
	title,
	onClose,
	children,
	wide = false,
}: {
	title: string;
	onClose(): void;
	children: ReactNode;
	wide?: boolean;
}) {
	const ref = useRef<HTMLDialogElement>(null);
	const id = useId();
	useEffect(() => {
		const previous = document.activeElement as HTMLElement | null;
		const dialog = ref.current;
		dialog?.showModal();
		return () => {
			dialog?.close();
			previous?.focus();
		};
	}, []);
	return (
		<dialog
			ref={ref}
			className={`dialog${wide ? " dialog-wide" : ""}`}
			aria-labelledby={id}
			onCancel={(e) => {
				e.preventDefault();
				onClose();
			}}
		>
			<div className="dialog-head">
				<h2 id={id}>{title}</h2>
				<button type="button" className="icon-button" aria-label="Close dialog" onClick={onClose}>
					<Icon name="close" />
				</button>
			</div>
			{children}
		</dialog>
	);
}
