import { useEffect, useId, useRef, useState } from "react";
import type { Namespace, Repository } from "../shared/platform.ts";
import { Icon } from "./design.tsx";
import { request } from "./request.ts";

export function RepositorySearch({
	namespaces,
	routeKey,
	openRepository,
}: {
	namespaces: Namespace[];
	routeKey: string;
	openRepository: (namespaceId: string, repositoryId: string) => void;
}) {
	const [open, setOpen] = useState(false),
		[query, setQuery] = useState(""),
		[selected, setSelected] = useState(-1),
		[loading, setLoading] = useState(true),
		[unavailable, setUnavailable] = useState(false),
		[retry, setRetry] = useState(0),
		[catalog, setCatalog] = useState<{ namespace: Namespace; repository: Repository }[]>([]);
	const root = useRef<HTMLDivElement>(null),
		input = useRef<HTMLInputElement>(null),
		toggle = useRef<HTMLButtonElement>(null),
		results = useRef<HTMLDivElement>(null);
	const id = useId();
	const terms = query.trim().toLowerCase().split(/\s+/);
	const matches = catalog.filter(({ namespace, repository }) =>
		terms.every((term) => `${namespace.handle}/${repository.name} ${namespace.name}`.toLowerCase().includes(term)),
	);
	useEffect(() => {
		void routeKey;
		setOpen(false);
		setQuery("");
		setSelected(-1);
	}, [routeKey]);
	useEffect(() => {
		const shortcut = (event: KeyboardEvent) => {
			if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "k" || document.querySelector("dialog[open]")) return;
			event.preventDefault();
			setOpen(true);
			input.current?.focus();
			input.current?.select();
		};
		window.addEventListener("keydown", shortcut);
		return () => window.removeEventListener("keydown", shortcut);
	}, []);
	useEffect(() => {
		if (!open) {
			setCatalog([]);
			setLoading(true);
			setUnavailable(false);
			return;
		}
		input.current?.focus();
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
	useEffect(() => {
		if (!open) return;
		void retry;
		const controller = new AbortController();
		setLoading(true);
		setUnavailable(false);
		setCatalog([]);
		setSelected(-1);
		void Promise.all(
			namespaces.map(async (namespace) => {
				try {
					const repositories = await request<Repository[]>(
						`/api/namespaces/${encodeURIComponent(namespace.id)}/repositories`,
						undefined,
						"GET",
						controller.signal,
					);
					return { rows: repositories.map((repository) => ({ namespace, repository })), failed: false };
				} catch {
					return { rows: [], failed: true };
				}
			}),
		).then((data) => {
			if (controller.signal.aborted) return;
			setCatalog(data.flatMap((item) => item.rows));
			setUnavailable(data.some((item) => item.failed));
			setLoading(false);
		});
		return () => controller.abort();
	}, [open, namespaces, retry]);
	useEffect(() => {
		results.current?.querySelector<HTMLElement>(`[data-result-index="${selected}"]`)?.scrollIntoView({ block: "nearest" });
	}, [selected]);
	const close = (restore = false) => {
		if (restore) {
			if (toggle.current?.getClientRects().length) toggle.current.focus();
			else input.current?.focus();
		}
		setOpen(false);
		setSelected(-1);
	};
	return (
		<div className="repository-search" data-open={open} ref={root}>
			<button
				className="search-toggle"
				type="button"
				ref={toggle}
				aria-label="Find repository"
				aria-expanded={open}
				aria-controls={id}
				onClick={() => setOpen(!open)}
				onKeyDown={(event) => {
					if (event.key === "Escape") close();
				}}
			>
				<Icon name="search" />
			</button>
			<div className="search-content">
				<div className="search-input-row">
					<Icon name="search" />
					<input
						ref={input}
						type="text"
						role="combobox"
						aria-label="Find repository"
						aria-autocomplete="list"
						aria-expanded={open}
						aria-controls={id}
						aria-activedescendant={open && selected >= 0 ? `${id}-${selected}` : undefined}
						autoComplete="off"
						spellCheck={false}
						placeholder="Find repository…"
						value={query}
						onFocus={() => setOpen(true)}
						onClick={() => setOpen(true)}
						onChange={(event) => {
							setQuery(event.target.value);
							setSelected(-1);
							setOpen(true);
						}}
						onKeyDown={(event) => {
							if (event.nativeEvent.isComposing) return;
							if (event.key === "Escape") {
								event.preventDefault();
								event.stopPropagation();
								close(true);
							}
							if (event.key === "ArrowDown" || event.key === "ArrowUp") {
								event.preventDefault();
								setOpen(true);
								setSelected((current) =>
									!matches.length
										? -1
										: current < 0
											? event.key === "ArrowDown"
												? 0
												: matches.length - 1
											: (current + (event.key === "ArrowDown" ? 1 : matches.length - 1)) % matches.length,
								);
							}
							if (event.key === "Enter" && open) {
								event.preventDefault();
								results.current?.querySelector<HTMLAnchorElement>(`[data-result-index="${selected < 0 ? 0 : selected}"]`)?.click();
							}
						}}
					/>
					<kbd>⌘K</kbd>
				</div>
				{open && (
					<section
						className="scope-menu search-results"
						aria-label="Repository search"
						onKeyDown={(event) => {
							if (event.key === "Escape") {
								event.preventDefault();
								event.stopPropagation();
								close(true);
							}
						}}
					>
						<p className="menu-label">Repositories · all namespaces</p>
						{loading && (
							<p className="menu-empty" role="status">
								Finding repositories…
							</p>
						)}
						{unavailable && (
							<div className="search-unavailable" role="alert">
								<span>Some repositories are unavailable.</span>
								<button
									type="button"
									onClick={() => {
										input.current?.focus();
										setLoading(true);
										setUnavailable(false);
										setCatalog([]);
										setSelected(-1);
										setRetry((value) => value + 1);
									}}
								>
									Retry
								</button>
							</div>
						)}
						<div className="search-matches" id={id} role="listbox" aria-label="Repositories" aria-busy={loading} ref={results}>
							{matches.map(({ namespace, repository }, index) => (
								<a
									key={`${namespace.id}/${repository.id}`}
									id={`${id}-${index}`}
									role="option"
									aria-label={`${namespace.handle}/${repository.name}`}
									aria-selected={selected === index}
									tabIndex={-1}
									data-result-index={index}
									className="scope-option"
									href={`/?namespace=${encodeURIComponent(namespace.id)}&repository=${encodeURIComponent(repository.id)}`}
									onMouseEnter={() => setSelected(index)}
									onClick={(event) => {
										if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
										event.preventDefault();
										close();
										openRepository(namespace.id, repository.id);
									}}
								>
									<Icon name="branch" />
									<span>
										<strong>{repository.name}</strong>
										<small>{namespace.handle}</small>
									</span>
									<Icon name="arrow" />
								</a>
							))}
						</div>
						{!loading && !unavailable && !matches.length && (
							<p className="menu-empty" role="status">
								No matching repositories.
							</p>
						)}
					</section>
				)}
			</div>
		</div>
	);
}
