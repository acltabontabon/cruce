/**
 * Line-at-a-time syntax colouring for review diffs: comments, strings, numbers, keywords and type names only. A
 * reading aid, deliberately small; it never parses, so a construct spanning lines simply stays uncoloured.
 */
type Grammar = { pattern: RegExp; classes: string[] };

const C_LIKE =
	/(\/\/.*$|\/\*.*?\*\/|\/\*\*?.*$|^\s*\*.*$)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|\b(\d[\d_]*(?:\.\d+)?)\b|\b(import|export|from|const|let|var|return|function|if|else|async|await|new|type|interface|enum|throw|for|while|do|try|catch|finally|class|extends|implements|readonly|private|public|protected|static|constructor|super|this|of|in|as|instanceof|typeof|keyof|switch|case|default|break|continue|yield|package|func|struct|impl|fn|pub|use|mod|match|where|def|lambda|go|defer|chan|map|range)\b|\b(true|false|null|undefined|nil|None|True|False)\b|\b([A-Z][A-Za-z0-9_]+)\b/g;
const GRAMMARS: Record<string, Grammar> = {
	c: { pattern: C_LIKE, classes: ["syn-com", "syn-str", "syn-num", "syn-kw", "syn-num", "syn-type"] },
	hash: {
		pattern:
			/(#.*$)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|\b(\d[\d_]*(?:\.\d+)?)\b|\b(import|from|def|class|return|if|elif|else|for|while|in|try|except|finally|with|as|lambda|yield|raise|pass|then|fi|do|done|case|esac|function|local|export)\b|\b(True|False|None|true|false|null)\b/g,
		classes: ["syn-com", "syn-str", "syn-num", "syn-kw", "syn-num"],
	},
	json: {
		pattern: /("(?:[^"\\]|\\.)*"(?=\s*:))|("(?:[^"\\]|\\.)*")|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false|null)\b/g,
		classes: ["syn-type", "syn-str", "syn-num", "syn-kw"],
	},
	yaml: {
		pattern: /(#.*$)|^(\s*[-\w@/."']+:)|("(?:[^"\\]|\\.)*"|'[^']*')|\b(\d[\w.-]*)\b|\b(true|false|null|yes|no)\b/g,
		classes: ["syn-com", "syn-type", "syn-str", "syn-num", "syn-kw"],
	},
	markdown: { pattern: /^(#{1,6} .*)$|(`[^`]+`)|^(\s*(?:[-*+]|\d+\.) )/g, classes: ["syn-kw", "syn-str", "syn-num"] },
};
const BY_EXTENSION: Record<string, string> = {
	ts: "c",
	tsx: "c",
	js: "c",
	jsx: "c",
	mjs: "c",
	cjs: "c",
	java: "c",
	kt: "c",
	go: "c",
	rs: "c",
	c: "c",
	h: "c",
	cc: "c",
	cpp: "c",
	cs: "c",
	swift: "c",
	scala: "c",
	css: "c",
	py: "hash",
	rb: "hash",
	sh: "hash",
	bash: "hash",
	zsh: "hash",
	toml: "hash",
	json: "json",
	yaml: "yaml",
	yml: "yaml",
	md: "markdown",
	mdx: "markdown",
};
export function grammarFor(path: string): string | undefined {
	return BY_EXTENSION[path.slice(path.lastIndexOf(".") + 1).toLowerCase()];
}

/** One segment of a line: its text, an optional syntax class, and whether word-level diff marks it changed. */
export interface Segment {
	text: string;
	syntax?: string;
	changed?: boolean;
}
export function segments(text: string, grammar?: string, changed: [number, number][] = []): Segment[] {
	const n = text.length;
	if (!n) return [];
	const syntax = new Array<string | undefined>(n);
	const g = grammar ? GRAMMARS[grammar] : undefined;
	if (g && n <= 2000) {
		const pattern = new RegExp(g.pattern.source, g.pattern.flags);
		for (let m = pattern.exec(text); m; m = pattern.exec(text)) {
			const group = m.slice(1).findIndex((x) => x !== undefined);
			for (let i = m.index; i < m.index + m[0].length; i++) syntax[i] = g.classes[group];
			if (!m[0].length) pattern.lastIndex++;
		}
	}
	const marked = new Uint8Array(n);
	for (const [a, b] of changed) for (let i = a; i < Math.min(b, n); i++) marked[i] = 1;
	const out: Segment[] = [];
	for (let i = 0; i < n; ) {
		let j = i;
		while (j < n && syntax[j] === syntax[i] && marked[j] === marked[i]) j++;
		out.push({ text: text.slice(i, j), ...(syntax[i] ? { syntax: syntax[i] } : {}), ...(marked[i] ? { changed: true } : {}) });
		i = j;
	}
	return out;
}
