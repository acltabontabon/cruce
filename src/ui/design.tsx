import { type ReactNode, useEffect, useId, useRef } from "react";

const paths: Record<string, ReactNode> = {
	repositories: (
		<>
			<rect x="3" y="4" width="7" height="7" rx="1.5" />
			<rect x="14" y="4" width="7" height="7" rx="1.5" />
			<rect x="3" y="15" width="7" height="7" rx="1.5" />
			<rect x="14" y="15" width="7" height="7" rx="1.5" />
		</>
	),
	settings: (
		<>
			<path d="m9 3-1 3-3 1-2 5 2 5 3 1 1 3h6l1-3 3-1 2-5-2-5-3-1-1-3Z" />
			<circle cx="12" cy="12" r="3" />
		</>
	),
	members: (
		<>
			<circle cx="9" cy="8" r="3" />
			<path d="M3 21v-3a6 6 0 0 1 12 0v3M16 5a3 3 0 0 1 0 6m2 4a5 5 0 0 1 3 5" />
		</>
	),
	teams: (
		<>
			<circle cx="12" cy="6" r="3" />
			<circle cx="5" cy="17" r="3" />
			<circle cx="19" cy="17" r="3" />
			<path d="m10 9-4 5m8-5 4 5M8 17h8" />
		</>
	),
	search: (
		<>
			<circle cx="10" cy="10" r="6" />
			<path d="m15 15 5 5" />
		</>
	),
	chevron: <path d="m8 10 4 4 4-4" />,
	plus: <path d="M12 5v14M5 12h14" />,
	close: <path d="m6 6 12 12M6 18 18 6" />,
	arrow: <path d="M4 12h16m-6-6 6 6-6 6" />,
	local: (
		<>
			<rect x="3" y="4" width="18" height="13" rx="2" />
			<path d="M8 21h8m-4-4v4m-6-9 3-3-3-3m6 6h4" />
		</>
	),
	cloud: <path d="M6 18a5 5 0 0 1-1-10 7 7 0 0 1 13-1 5.5 5.5 0 0 1 0 11Z" />,
	branch: (
		<>
			<circle cx="6" cy="5" r="2" />
			<circle cx="18" cy="6" r="2" />
			<circle cx="6" cy="19" r="2" />
			<path d="M6 7v10m0-4c8 0 12-1 12-5" />
		</>
	),
	lock: (
		<>
			<rect x="5" y="10" width="14" height="11" rx="2" />
			<path d="M8 10V7a4 4 0 0 1 8 0v3" />
		</>
	),
	check: <path d="m5 12 4 4L19 6" />,
};
export function Icon({ name, className = "" }: { name: string; className?: string }) {
	return (
		<svg
			className={`icon ${className}`}
			width="20"
			height="20"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.6"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			{paths[name] ?? paths.branch}
		</svg>
	);
}
export function Dialog({
	title,
	children,
	close,
	className = "",
}: {
	title: string;
	children: ReactNode;
	close: () => void;
	className?: string;
}) {
	const ref = useRef<HTMLDialogElement>(null),
		id = useId();
	useEffect(() => {
		const dialog = ref.current;
		const previous = document.activeElement as HTMLElement | null;
		dialog?.showModal();
		return () => {
			dialog?.close();
			if (previous?.isConnected) previous.focus();
		};
	}, []);
	return (
		<dialog
			ref={ref}
			aria-labelledby={id}
			className={`dialog ${className}`}
			onCancel={close}
			onKeyDown={(event) => {
				if (event.key !== "Tab") return;
				const items = Array.from(
					event.currentTarget.querySelectorAll<HTMLElement>(
						'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]',
					),
				).filter((element) => element.getClientRects().length > 0 && element.tabIndex >= 0);
				const first = items[0],
					last = items.at(-1);
				if (event.shiftKey && document.activeElement === first) {
					event.preventDefault();
					last?.focus();
				} else if (!event.shiftKey && document.activeElement === last) {
					event.preventDefault();
					first?.focus();
				}
			}}
		>
			<div className="dialog-heading">
				<h2 id={id}>{title}</h2>
				<button type="button" className="icon-button" aria-label="Close" onClick={close}>
					<Icon name="close" />
				</button>
			</div>
			{children}
		</dialog>
	);
}
export function BranchArt() {
	return (
		<div className="branch-art" aria-hidden="true">
			<svg viewBox="0 0 440 190" fill="none" aria-hidden="true">
				<path d="M-20 122h180c50 0 55-64 110-64h200M160 122h90c55 0 55 44 110 44h110" stroke="currentColor" strokeWidth="2" />
				<path d="M-20 122h490" stroke="currentColor" strokeWidth="2" />
				<circle cx="100" cy="122" r="9" fill="currentColor" />
				<circle cx="270" cy="58" r="9" fill="currentColor" />
				<circle cx="360" cy="166" r="9" fill="currentColor" />
				<circle cx="204" cy="122" r="21" fill="var(--accent)" stroke="var(--ink)" strokeWidth="2" />
				<path d="m196 122 6 6 10-12" stroke="var(--ink)" strokeWidth="2" />
			</svg>
			<span className="art-label label-code">your code</span>
			<span className="art-label label-work">shared context</span>
		</div>
	);
}
