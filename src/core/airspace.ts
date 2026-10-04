import type { PlanResource } from "./domain.ts";

/**
 * Airspace: the shared code territory Flights traverse.
 *
 * Canonical resource ids form a strict hierarchy, so overlap is an ancestor check:
 *
 *   m:auth                                              module
 *   f:src/auth/token-validator.ts                       file
 *   s:src/auth/token-validator.ts#TokenValidator        type / class
 *   s:src/auth/token-validator.ts#TokenValidator.validate   member
 */

export type ResourceKind = "module" | "file" | "symbol";

export type SymbolKind = "class" | "interface" | "type" | "function" | "method" | "const" | "enum";

export interface IndexedSymbol {
	/** Qualified name inside the file, e.g. `TokenValidator.validate`. */
	name: string;
	kind: SymbolKind;
	startLine: number;
	endLine: number;
	exported: boolean;
	/** Parser-derived public declaration shape, excluding implementation bodies and positions. */
	contract?: string;
}

export interface IndexedFile {
	path: string;
	coverage?: "symbols" | "file";
	limitation?: string;
	module: string;
	symbols: IndexedSymbol[];
	/** Repo-relative paths of files this file imports (resolved where possible). */
	imports: string[];
}

export interface IndexedModule {
	id: string;
	label: string;
	paths: string[];
}

export interface AirspaceIndex {
	revision: string;
	modules: IndexedModule[];
	files: IndexedFile[];
	indexer: string;
}

export interface ResolvedResource {
	id: string;
	kind: ResourceKind;
	module: string;
	file?: string;
	symbol?: string;
	/** True when the plan names something the index does not contain yet (a new symbol or file). */
	isNew: boolean;
	/** The name as the plan wrote it. */
	requested: string;
}

export const moduleId = (module: string) => `m:${module}`;
export const fileId = (path: string) => `f:${path}`;
export const symbolId = (path: string, name: string) => `s:${path}#${name}`;

export function parseResourceId(id: string): { kind: ResourceKind; module?: string; file?: string; symbol?: string } {
	if (id.startsWith("m:")) return { kind: "module", module: id.slice(2) };
	if (id.startsWith("f:")) return { kind: "file", file: id.slice(2) };
	if (id.startsWith("s:")) {
		const [file, symbol] = id.slice(2).split("#");
		return { kind: "symbol", file, symbol };
	}
	throw new Error(`Invalid resource id: ${id}`);
}

/** The chain of ancestors of a resource id, nearest first (excluding the id itself). */
export function ancestors(id: string, index: AirspaceIndex): string[] {
	const parsed = parseResourceId(id);
	const out: string[] = [];
	if (parsed.kind === "symbol" && parsed.file && parsed.symbol) {
		const parts = parsed.symbol.split(".");
		for (let i = parts.length - 1; i > 0; i--) out.push(symbolId(parsed.file, parts.slice(0, i).join(".")));
		out.push(fileId(parsed.file));
		out.push(moduleId(moduleOfPath(parsed.file, index)));
	} else if (parsed.kind === "file" && parsed.file) {
		out.push(moduleId(moduleOfPath(parsed.file, index)));
	}
	return out;
}

export function isAncestorOrEqual(a: string, b: string, index: AirspaceIndex): boolean {
	return a === b || ancestors(b, index).includes(a);
}

export type Overlap = "same" | "contains" | "same-file" | "none";

/**
 * How two resources relate.
 * - `same`: identical
 * - `contains`: one encloses the other (module ⊃ file ⊃ class ⊃ member)
 * - `same-file`: distinct symbols in one file (textual proximity, but separate airspace)
 */
export function overlap(a: string, b: string, index: AirspaceIndex): Overlap {
	if (a === b) return "same";
	if (isAncestorOrEqual(a, b, index) || isAncestorOrEqual(b, a, index)) return "contains";
	const pa = parseResourceId(a);
	const pb = parseResourceId(b);
	if (pa.kind === "symbol" && pb.kind === "symbol" && pa.file === pb.file) return "same-file";
	return "none";
}

export function moduleOfPath(path: string, index: AirspaceIndex): string {
	const known = index.files.find((f) => f.path === path);
	if (known) return known.module;
	let best: { id: string; len: number } | undefined;
	for (const m of index.modules) {
		for (const p of m.paths) {
			if (path.startsWith(p) && (!best || p.length > best.len)) best = { id: m.id, len: p.length };
		}
	}
	return best?.id ?? "root";
}

export function moduleLabel(id: string, index: AirspaceIndex): string {
	return index.modules.find((m) => m.id === id)?.label ?? id;
}

/** Short human label for a resource id: `TokenValidator.validate`, `jwt-decoder.ts`, `Authentication`. */
export function resourceLabel(id: string, index: AirspaceIndex): string {
	const p = parseResourceId(id);
	if (p.kind === "module") return moduleLabel(p.module ?? "", index);
	if (p.kind === "file") return componentName(p.file ?? "", index);
	return p.symbol ?? id;
}

/** A file's display name: its primary type when the file is named after it (`RefreshTokenRepository`). */
export function componentName(path: string, index: AirspaceIndex): string {
	const base = path.split("/").pop() ?? path;
	const file = index.files.find((f) => f.path === path);
	const primary = file?.symbols.find(
		(s) => !s.name.includes(".") && (s.kind === "class" || s.kind === "function") && `${kebab(s.name)}.ts` === base,
	);
	return primary?.name ?? base;
}

const kebab = (name: string) =>
	name
		.replace(/([a-z0-9])([A-Z])/g, "$1-$2")
		.replace(/([A-Z])([A-Z][a-z])/g, "$1-$2")
		.toLowerCase();

const stripCall = (s: string) => s.trim().replace(/\(\)$/, "");

/**
 * Resolve a plan's loose resource name to a canonical airspace id.
 * Resolution is deterministic and conservative: if a name is ambiguous it resolves to the
 * smallest enclosing resource that covers every candidate, so coordination never under-claims.
 */
export function resolveResource(entry: PlanResource | { type: "symbol"; resource: string }, index: AirspaceIndex): ResolvedResource {
	const requested = stripCall(entry.resource);
	const base = { requested };

	if (entry.type === "module") {
		const m = index.modules.find(
			(x) => x.id === requested || x.label.toLowerCase() === requested.toLowerCase() || x.paths.includes(requested),
		);
		const id = m?.id ?? requested.toLowerCase();
		return { ...base, id: moduleId(id), kind: "module", module: id, isNew: !m };
	}

	if (entry.type === "file" || requested.includes("/")) {
		const path = requested.replace(/^\.\//, "");
		const known = index.files.find((f) => f.path === path || f.path.endsWith(`/${path}`));
		const p = known?.path ?? path;
		return { ...base, id: fileId(p), kind: "file", module: moduleOfPath(p, index), file: p, isNew: !known };
	}

	// symbol or component: match qualified names first, then the last segment.
	const matches: { file: IndexedFile; sym: IndexedSymbol }[] = [];
	for (const file of index.files) {
		for (const sym of file.symbols) {
			if (sym.name === requested) matches.push({ file, sym });
		}
	}
	if (matches.length === 0 && !requested.includes(".")) {
		for (const file of index.files) {
			for (const sym of file.symbols) {
				if (sym.name.split(".").pop() === requested && sym.kind !== "method") matches.push({ file, sym });
			}
		}
	}

	if (matches.length === 1) {
		const { file, sym } = matches[0];
		// A component is the unit a type lives in: when a file is named after its class, the component
		// is the file (so companion types and helpers travel with it).
		if (entry.type === "component" && file.path.endsWith(`/${kebab(sym.name)}.ts`)) {
			return { ...base, id: fileId(file.path), kind: "file", module: file.module, file: file.path, isNew: false };
		}
		return {
			...base,
			id: symbolId(file.path, sym.name),
			kind: "symbol",
			module: file.module,
			file: file.path,
			symbol: sym.name,
			isNew: false,
		};
	}
	if (matches.length > 1) {
		const files = new Set(matches.map((m) => m.file.path));
		if (files.size === 1) {
			const file = matches[0].file;
			return { ...base, id: fileId(file.path), kind: "file", module: file.module, file: file.path, isNew: false };
		}
		const modules = new Set(matches.map((m) => m.file.module));
		const mod = modules.size === 1 ? [...modules][0] : "root";
		return { ...base, id: moduleId(mod), kind: "module", module: mod, isNew: false };
	}

	// Not indexed yet. A new member of a known type resolves under that type.
	const segments = requested.split(".");
	if (segments.length > 1) {
		const owner = segments.slice(0, -1).join(".");
		for (const file of index.files) {
			if (file.symbols.some((s) => s.name === owner)) {
				return {
					...base,
					id: symbolId(file.path, requested),
					kind: "symbol",
					module: file.module,
					file: file.path,
					symbol: requested,
					isNew: true,
				};
			}
		}
	}
	// A component named after a file (RefreshTokenRepository → refresh-token-repository.ts).
	const fileName = `${kebab(segments[0])}.ts`;
	const byName = index.files.find((f) => f.path.endsWith(`/${fileName}`));
	if (byName) {
		return {
			...base,
			id: fileId(byName.path),
			kind: "file",
			module: byName.module,
			file: byName.path,
			isNew: false,
		};
	}
	return { ...base, id: moduleId("root"), kind: "module", module: "root", isNew: true };
}

/** All indexed resources in a file, used to map changed line ranges back to symbols. */
export function symbolsAt(path: string, startLine: number, endLine: number, index: AirspaceIndex): string[] {
	const file = index.files.find((f) => f.path === path);
	if (!file) return [];
	const hits = file.symbols.filter((s) => s.startLine <= endLine && s.endLine >= startLine);
	// Keep the innermost symbols: drop any symbol that encloses another hit.
	const innermost = hits.filter(
		(s) => !hits.some((o) => o !== s && o.name.startsWith(`${s.name}.`) && o.startLine >= s.startLine && o.endLine <= s.endLine),
	);
	return innermost.map((s) => symbolId(path, s.name));
}

/** Files that import `path` (direct dependents), from the structural index. */
export function dependentsOf(path: string, index: AirspaceIndex): string[] {
	return index.files.filter((f) => f.imports.includes(path)).map((f) => f.path);
}
