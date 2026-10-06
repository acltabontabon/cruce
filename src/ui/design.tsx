import { type ReactNode, useEffect, useId, useRef, useState } from "react";

const paths: Record<string, ReactNode> = {
	menu: <path d="M4 7h16M4 12h16M4 17h16" />,

	repositories: (
		<>
			<path d="M8 5h12v16H8M8 5H4v16h4M8 5v16M12 9h5M12 13h5" />
			<circle cx="14" cy="17" r="1" />
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
	logout: (
		<>
			<path d="M10 4H4v16h6M10 12h10m-4-4 4 4-4 4" />
		</>
	),
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
	invite: (
		<>
			<circle cx="10" cy="8" r="3.5" />
			<path d="M3 20v-1.5a6.5 6.5 0 0 1 11-4.7M18 14v6m-3-3h6" />
		</>
	),
	back: <path d="M20 12H4m6-6-6 6 6 6" />,
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
export function Pill({ tone, children }: { tone: string; children: ReactNode }) {
	return <span className={`pill ${tone}`}>{children}</span>;
}
/** Overview page heading: a mono kicker naming the scope, the title and the page's primary actions. */
export function PageHeader({ kicker, title, children }: { kicker?: ReactNode; title: string; children?: ReactNode }) {
	return (
		<header className="page-header">
			<div className="page-title">
				{kicker && <p className="kicker">{kicker}</p>}
				<h1>{title}</h1>
			</div>
			{children && <div className="actions">{children}</div>}
		</header>
	);
}
/** A strip of counts read at a glance; a count only gets colour when it asks for a person. */
export function Stats({ label, items }: { label: string; items: { label: string; value: ReactNode; tone?: string }[] }) {
	return (
		<dl className="stats" aria-label={label}>
			{items.map((item) => (
				<div key={item.label} className={`stat ${item.tone ?? ""}`}>
					<dt>{item.label}</dt>
					<dd>{item.value}</dd>
				</div>
			))}
		</dl>
	);
}
/** A titled block under an ink rule, with an optional count and one header action. */
export function Section({
	title,
	count,
	action,
	id,
	className = "",
	children,
}: {
	title: string;
	count?: number;
	action?: ReactNode;
	id?: string;
	className?: string;
	children: ReactNode;
}) {
	const heading = useId();
	return (
		<section className={`panel ${className}`} aria-labelledby={heading} id={id}>
			<div className="panel-head">
				<h2 id={heading}>{title}</h2>
				{count !== undefined && <span className="panel-count">{count}</span>}
				{action && <div className="panel-action">{action}</div>}
			</div>
			{children}
		</section>
	);
}
/** Initials for a person or namespace tile. */
export function Initials({ name, className = "" }: { name: string; className?: string }) {
	const letters = name
		.split(/[\s@._-]+/)
		.filter(Boolean)
		.slice(0, 2)
		.map((part) => part[0])
		.join("");
	return (
		<span className={`initials ${className}`} aria-hidden="true">
			{(letters || "?").toUpperCase()}
		</span>
	);
}
/** A shell command with a copy button. Values shown are addresses and IDs, never credentials. */
export function CopyCommand({ text, label }: { text: string; label?: string }) {
	const [copied, setCopied] = useState(false);
	return (
		<div className="copy-command">
			{label && <span className="copy-label">{label}</span>}
			<pre>
				<code>{text}</code>
			</pre>
			<button
				type="button"
				className="text-button"
				onClick={() =>
					void navigator.clipboard
						?.writeText(text)
						.then(() => {
							setCopied(true);
							setTimeout(() => setCopied(false), 1500);
						})
						.catch(() => undefined)
				}
			>
				{copied ? "Copied" : "Copy"}
			</button>
		</div>
	);
}
export function BranchArt() {
	return (
		<div className="branch-art" aria-hidden="true">
			<svg viewBox="0 0 320 180" fill="none" aria-hidden="true">
				<path d="M24 54h272M24 126h272" stroke="currentColor" strokeWidth="2" />
				{[54, 126].map((y) => (
					<g key={y}>
						<circle cx="24" cy={y} r="5" fill="var(--paper)" stroke="currentColor" strokeWidth="2" />
						<circle cx="296" cy={y} r="5" fill="var(--paper)" stroke="currentColor" strokeWidth="2" />
					</g>
				))}
				<path d="M170 40h-12v100h12" stroke="var(--attention)" strokeWidth="2" />
			</svg>
			<span className="art-label label-code">independent work</span>
			<span className="art-label label-work">shared context</span>
		</div>
	);
}
