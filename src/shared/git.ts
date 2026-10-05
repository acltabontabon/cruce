export interface ChangedFile {
	path: string;
	status: "added" | "modified" | "deleted";
	/** Changed line ranges in the BASE version of the file (1-based, inclusive). `insert`: new lines only. */
	ranges: { start: number; end: number; insert?: boolean }[];
}
