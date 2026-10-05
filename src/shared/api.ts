export interface ChangeFile {
	path: string;
	status: "added" | "modified" | "deleted";
	additions: number | null;
	deletions: number | null;
	binary: boolean;
	tooLarge: boolean;
}

/** A Git comparison pinned to actual commits; optional file content is requested separately. */
export interface ChangesResponse {
	comparison: "published" | "integrated";
	baseCommit: string | null;
	headCommit: string | null;
	files: ChangeFile[];
	additions: number;
	deletions: number;
	statsComplete: boolean;
	file?: { path: string; patch: string | null; reason?: string };
}
