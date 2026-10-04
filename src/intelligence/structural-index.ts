import { parse } from "@babel/parser";
import type { AirspaceIndex, IndexedFile, IndexedModule, IndexedSymbol, SymbolKind } from "../core/airspace.ts";

/**
 * Structural code intelligence: file → types → members → imports.
 *
 * Uses @babel/parser (a proven, pure-JS TypeScript parser) so indexing runs inside the Worker.
 * Tree-sitter and ast-grep were evaluated: tree-sitter grammars load as Wasm side modules that
 * Workers cannot compile at runtime, and ast-grep ships as a native binary. Both remain good
 * candidates for a Sandbox-side indexer for other languages; see docs/architecture.md.
 */

export interface StructuralIndexer {
	readonly name: string;
	supports(path: string): boolean;
	indexFile(path: string, source: string): { symbols: IndexedSymbol[]; imports: string[] };
}

interface ModuleConfig {
	modules?: { id: string; label?: string; paths: string[] }[];
}

const SOURCE = /\.(m|c)?(t|j)sx?$/;

// biome-ignore lint/suspicious/noExplicitAny: Babel AST nodes are walked structurally.
type Node = any;

export class BabelTypeScriptIndexer implements StructuralIndexer {
	readonly name = "babel-typescript";

	supports(path: string): boolean {
		return SOURCE.test(path) && !path.endsWith(".d.ts");
	}

	indexFile(path: string, source: string) {
		let ast: Node;
		try {
			ast = parse(source, {
				sourceType: "module",
				plugins: ["typescript", ...(path.endsWith("x") ? (["jsx"] as const) : [])],
				errorRecovery: true,
			});
		} catch {
			return { symbols: [], imports: [] };
		}
		const symbols: IndexedSymbol[] = [];
		const imports = new Set<string>();
		const start = (n: Node) => Math.min(n.loc.start.line, ...(n.leadingComments ?? []).map((c: Node) => c.loc.start.line));
		const add = (name: string, kind: SymbolKind, n: Node, outer: Node, exported: boolean) =>
			symbols.push({ name, kind, startLine: start(outer), endLine: n.loc.end.line, exported });

		for (const stmt of ast.program.body as Node[]) {
			if (
				stmt.type === "ImportDeclaration" ||
				((stmt.type === "ExportNamedDeclaration" || stmt.type === "ExportAllDeclaration") && stmt.source)
			) {
				const resolved = resolveImport(path, stmt.source.value);
				if (resolved) imports.add(resolved);
			}
			const exported = stmt.type === "ExportNamedDeclaration" || stmt.type === "ExportDefaultDeclaration";
			const decl: Node = exported ? stmt.declaration : stmt;
			if (!decl) continue;
			switch (decl.type) {
				case "ClassDeclaration": {
					const cls = decl.id?.name ?? "default";
					add(cls, "class", decl, stmt, exported);
					for (const member of decl.body.body as Node[]) {
						const name = memberName(member);
						if (!name) continue;
						const kind: SymbolKind = member.type === "ClassMethod" || member.type === "TSDeclareMethod" ? "method" : "const";
						add(`${cls}.${name}`, kind, member, member, exported);
					}
					break;
				}
				case "FunctionDeclaration":
					if (decl.id) add(decl.id.name, "function", decl, stmt, exported);
					break;
				case "TSInterfaceDeclaration":
					add(decl.id.name, "interface", decl, stmt, exported);
					break;
				case "TSTypeAliasDeclaration":
					add(decl.id.name, "type", decl, stmt, exported);
					break;
				case "TSEnumDeclaration":
					add(decl.id.name, "enum", decl, stmt, exported);
					break;
				case "VariableDeclaration":
					for (const d of decl.declarations as Node[]) {
						if (d.id?.type === "Identifier") add(d.id.name, "const", d, stmt, exported);
					}
					break;
			}
		}
		return { symbols, imports: [...imports].sort() };
	}
}

function memberName(member: Node): string | undefined {
	if (member.type === "StaticBlock") return undefined;
	const key = member.key;
	if (!key) return undefined;
	if (key.type === "Identifier") return key.name;
	if (key.type === "PrivateName") return `#${key.id.name}`;
	if (key.type === "StringLiteral") return key.value;
	return undefined;
}

/** Resolve a relative import to a repo-relative path (TS projects import with .ts or no extension). */
export function resolveImport(fromPath: string, spec: string): string | undefined {
	if (!spec.startsWith(".")) return undefined;
	const dir = fromPath.split("/").slice(0, -1);
	for (const part of spec.split("/")) {
		if (part === "." || part === "") continue;
		if (part === "..") dir.pop();
		else dir.push(part);
	}
	const joined = dir.join("/");
	if (SOURCE.test(joined)) return joined.replace(/\.js$/, ".ts");
	return `${joined}.ts`;
}

/** Group files into modules: from cruce.json when present, otherwise by top-level source directory. */
export function inferModules(paths: string[], config?: ModuleConfig): IndexedModule[] {
	if (config?.modules?.length) {
		return config.modules.map((m) => ({ id: m.id, label: m.label ?? m.id, paths: m.paths }));
	}
	const dirs = new Map<string, string>();
	for (const p of paths) {
		const parts = p.split("/");
		const root = parts[0] === "src" && parts.length > 2 ? `src/${parts[1]}/` : parts.length > 1 ? `${parts[0]}/` : "";
		if (!root) continue;
		const id = root.split("/").filter(Boolean).pop() ?? "root";
		dirs.set(id, root);
	}
	return [...dirs.entries()].map(([id, path]) => ({ id, label: id[0].toUpperCase() + id.slice(1), paths: [path] }));
}

export function buildIndex(
	files: Record<string, string>,
	revision: string,
	indexer: StructuralIndexer = new BabelTypeScriptIndexer(),
): AirspaceIndex {
	let config: ModuleConfig | undefined;
	try {
		config = files["cruce.json"] ? (JSON.parse(files["cruce.json"]) as ModuleConfig) : undefined;
	} catch {
		config = undefined;
	}
	const sourcePaths = Object.keys(files)
		.filter((p) => indexer.supports(p))
		.sort();
	const modules = inferModules(sourcePaths, config);
	const moduleFor = (path: string) => {
		let best: { id: string; len: number } | undefined;
		for (const m of modules)
			for (const p of m.paths) if (path.startsWith(p) && (!best || p.length > best.len)) best = { id: m.id, len: p.length };
		return best?.id ?? "root";
	};
	const indexed: IndexedFile[] = sourcePaths.map((path) => {
		const { symbols, imports } = indexer.indexFile(path, files[path]);
		return { path, module: moduleFor(path), symbols, imports: imports.filter((i) => i in files) };
	});
	if (indexed.some((f) => f.module === "root") && !modules.some((m) => m.id === "root")) {
		modules.push({ id: "root", label: "Repository", paths: [""] });
	}
	return { revision, modules, files: indexed, indexer: indexer.name };
}
