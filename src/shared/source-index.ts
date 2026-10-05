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

export interface SourceIndex {
	revision: string;
	modules: IndexedModule[];
	files: IndexedFile[];
	indexer: string;
}
