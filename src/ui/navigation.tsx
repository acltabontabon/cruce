import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import type { Namespace, Repository, User } from "../shared/platform.ts";
import { BRAND, Brand } from "./brand.tsx";
import { Icon } from "./design.tsx";
import { RepositorySearch } from "./search.tsx";
import { type Appearance, useAppearance } from "./theme.ts";

const appearances: [Appearance, string][] = [
	["system", "System"],
	["dark", "Dark"],
	["light", "Light"],
];

type Option = { id: string; name: string; detail: string; href: string; selected?: boolean; select: () => void };
function HeaderDropdown({
	label,
	trigger,
	routeKey,
	children,
	onOpen,
	initialOpen = false,
	className = "",
}: {
	label: string;
	trigger: ReactNode;
	routeKey: string;
	children: (close: (restore?: boolean) => void) => ReactNode;
	onOpen?: () => void;
	initialOpen?: boolean;
	className?: string;
}) {
	const [open, setOpen] = useState(initialOpen);
	const root = useRef<HTMLDivElement>(null),
		button = useRef<HTMLButtonElement>(null),
		panel = useRef<HTMLElement>(null);
	const id = useId();
	useEffect(() => {
		void routeKey;
		setOpen(initialOpen);
	}, [routeKey, initialOpen]);
	useEffect(() => {
		if (!open) return;
		(
			panel.current?.querySelector<HTMLElement>("input:checked") ?? panel.current?.querySelector<HTMLElement>("input,a[href],button")
		)?.focus();
		const outside = (event: Event) => {
			if (!root.current?.contains(event.target as Node)) setOpen(false);
		};
		document.addEventListener("pointerdown", outside);
		document.addEventListener("focusin", outside);
		return () => {
			document.removeEventListener("pointerdown", outside);
			document.removeEventListener("focusin", outside);
		};
	}, [open]);
	const close = (restore = false) => {
		setOpen(false);
		if (restore) button.current?.focus();
	};
	return (
		<div className={`scope-dropdown ${className}`} ref={root}>
			<button
				type="button"
				className={className === "account-dropdown" ? "header-account" : "scope-trigger"}
				ref={button}
				aria-label={label}
				aria-expanded={open}
				aria-controls={id}
				onClick={() => {
					onOpen?.();
					setOpen(!open);
				}}
				onKeyDown={(event) => {
					if (event.key === "ArrowDown" || event.key === "ArrowUp") {
						event.preventDefault();
						onOpen?.();
						setOpen(true);
					}
				}}
			>
				{trigger}
				{className !== "account-dropdown" && <Icon name="chevron" />}
			</button>
			{open && (
				<section
					className="scope-menu"
					id={id}
					aria-label={label}
					ref={panel}
					onKeyDown={(event) => {
						if (event.key === "Escape") {
							event.preventDefault();
							event.stopPropagation();
							close(true);
							return;
						}
						// Radio groups keep their native arrow-key selection.
						if (event.target instanceof HTMLInputElement && event.target.type === "radio") return;
						const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("a[href],button:not(:disabled)"));
						const current = items.indexOf(document.activeElement as HTMLElement);
						if (event.key === "ArrowDown" || event.key === "ArrowUp") {
							event.preventDefault();
							const next =
								current === -1
									? event.key === "ArrowDown"
										? 0
										: items.length - 1
									: (current + (event.key === "ArrowDown" ? 1 : items.length - 1)) % items.length;
							items[next]?.focus();
						}
						if ((event.key === "Home" || event.key === "End") && event.target instanceof HTMLAnchorElement) {
							event.preventDefault();
							(event.key === "Home" ? items[0] : items.at(-1))?.focus();
						}
						if (event.key === "Enter" && event.target instanceof HTMLInputElement) {
							event.preventDefault();
							event.currentTarget.querySelector<HTMLAnchorElement>(".scope-options a[href]")?.click();
						}
					}}
				>
					{children(close)}
				</section>
			)}
		</div>
	);
}
function ScopeDropdown({
	label,
	trigger,
	options,
	routeKey,
	create,
}: {
	label: string;
	trigger: ReactNode;
	options: Option[];
	routeKey: string;
	create?: { label: string; action: () => void };
}) {
	const [filter, setFilter] = useState("");
	const matches = options.filter((option) => `${option.name} ${option.detail}`.toLowerCase().includes(filter.trim().toLowerCase()));
	return (
		<HeaderDropdown label={label} trigger={trigger} routeKey={routeKey} onOpen={() => setFilter("")}>
			{(close) => (
				<>
					<p className="menu-label">{label === "Switch namespace" ? "Namespaces" : "Repositories"}</p>
					<label className="scope-search">
						<Icon name="search" />
						<input
							aria-label={label === "Switch namespace" ? "Search namespaces" : "Search repositories"}
							placeholder="Type to filter…"
							value={filter}
							onChange={(event) => setFilter(event.target.value)}
						/>
					</label>
					<div className="scope-options">
						{matches.map((option) => (
							<a
								key={option.id}
								href={option.href}
								className="scope-option"
								aria-current={option.selected ? "true" : undefined}
								onClick={(event) => {
									if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
									event.preventDefault();
									close();
									option.select();
								}}
							>
								<span className="scope-option-avatar" aria-hidden="true">
									{option.name.slice(0, 1).toUpperCase()}
								</span>
								<span>
									<strong>{option.name}</strong>
									<small>{option.detail}</small>
								</span>
								{option.selected && <Icon name="check" />}
							</a>
						))}
						{!matches.length && <p className="menu-empty">No matches.</p>}
					</div>
					{create && (
						<button
							className="menu-create"
							type="button"
							onClick={() => {
								close(true);
								create.action();
							}}
						>
							<Icon name="plus" />
							{create.label}
						</button>
					)}
				</>
			)}
		</HeaderDropdown>
	);
}

export function ConsoleHeader({
	me,
	screen,
	namespaceId,
	namespace,
	repositoryId,
	repository,
	repositories,
	routeKey,
	open,
	home,
	setup,
	accountRequested,
	create,
}: {
	me: { user: User; namespaces: Namespace[] };
	screen: string;
	namespaceId: string;
	namespace?: Namespace;
	repositoryId: string;
	repository?: Repository;
	repositories: Repository[];
	routeKey: string;
	open: (namespaceId: string, repositoryId?: string) => void;
	home: () => void;
	setup: () => void;
	accountRequested: boolean;
	create: () => void;
}) {
	const [appearance, setAppearance] = useAppearance();
	return (
		<header className="console-header" data-scope={screen}>
			<div className="header-inner">
				<a
					className="brand"
					href="/"
					aria-label={`${BRAND.name} home`}
					onClick={(event) => {
						if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
						event.preventDefault();
						home();
					}}
				>
					<Brand />
				</a>
				<nav className="scope-path" aria-label="Current location">
					<span className="scope-divider" aria-hidden="true">
						/
					</span>
					{screen === "namespace" ? (
						<>
							<ScopeDropdown
								label="Switch namespace"
								routeKey={routeKey}
								trigger={
									<span className="scope-name" title={namespace?.name}>
										{namespace?.name ?? "Namespace unavailable"}
									</span>
								}
								options={me.namespaces.map((item) => ({
									id: item.id,
									name: item.name,
									detail: item.kind === "personal" ? "Personal namespace" : "Shared namespace",
									href: `/?namespace=${encodeURIComponent(item.id)}`,
									selected: item.id === namespaceId,
									select: () => open(item.id),
								}))}
								create={{ label: "Create namespace", action: create }}
							/>
							{repositoryId && (
								<>
									<span className="scope-divider" aria-hidden="true">
										/
									</span>
									<ScopeDropdown
										label="Switch repository"
										routeKey={routeKey}
										trigger={
											<>
												<Icon name="branch" />
												<span className="scope-name" title={repository?.name}>
													{repository?.name ?? "Repository unavailable"}
												</span>
											</>
										}
										options={[
											...repositories.map((item) => ({
												id: item.id,
												name: item.name,
												detail: item.defaultBranch,
												href: `/?namespace=${encodeURIComponent(namespaceId)}&repository=${encodeURIComponent(item.id)}`,
												selected: item.id === repositoryId,
												select: () => open(namespaceId, item.id),
											})),
											{
												id: "all-repositories",
												name: "All repositories",
												detail: namespace?.name ?? "Namespace",
												href: `/?namespace=${encodeURIComponent(namespaceId)}`,
												select: () => open(namespaceId),
											},
										]}
									/>
								</>
							)}
						</>
					) : (
						<span className="global-location" aria-current="page">
							{screen === "setup" ? "Local setup" : "Home"}
						</span>
					)}
				</nav>
				<div className="header-actions">
					<RepositorySearch namespaces={me.namespaces} routeKey={routeKey} openRepository={open} />
					<HeaderDropdown
						label="Your account"
						className="account-dropdown"
						routeKey={routeKey}
						initialOpen={accountRequested}
						trigger={
							<span className="account-avatar" title={me.user.name}>
								{me.user.name.slice(0, 1).toUpperCase()}
							</span>
						}
					>
						{() => (
							<>
								<div className="account-summary">
									<span className="account-portrait" aria-hidden="true">
										{me.user.name.slice(0, 1).toUpperCase()}
									</span>
									<div>
										<strong>{me.user.name}</strong>
										<p>{me.user.email}</p>
									</div>
								</div>
								<fieldset className="appearance">
									<legend>Appearance</legend>
									<div className="appearance-options">
										{appearances.map(([value, label]) => (
											<label key={value}>
												<input
													type="radio"
													name="appearance"
													value={value}
													checked={appearance === value}
													onChange={() => setAppearance(value)}
												/>
												{label}
											</label>
										))}
									</div>
								</fieldset>
								<div className="account-actions">
									<a
										className="account-link"
										href="/?page=setup"
										aria-current={screen === "setup" ? "page" : undefined}
										onClick={(event) => {
											if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
											event.preventDefault();
											setup();
										}}
									>
										<Icon name="local" />
										<span>Local setup</span>
										<Icon name="arrow" />
									</a>
									<a className="account-link account-sign-out" href="/auth/logout">
										<Icon name="logout" />
										<span>Sign out</span>
										<Icon name="arrow" />
									</a>
								</div>
							</>
						)}
					</HeaderDropdown>
				</div>
			</div>
		</header>
	);
}
