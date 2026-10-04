import { describe, expect, it } from "vitest";
import { classify, interactions } from "../../src/core/conflict-matrix.ts";
import { baseIndex } from "../fixtures.ts";

const V = "s:src/auth/token-validator.ts#TokenValidator.validate";
const TV_FILE = "f:src/auth/token-validator.ts";
const HAS_SCOPE = "s:src/auth/token-validator.ts#TokenValidator.hasScope";
const SESSIONS = "f:src/sessions/session-service.ts";

describe("conflict matrix", () => {
	it("READ × READ is safe", () => {
		expect(classify("read", "read", "same").control).toBe("none");
	});

	it("READ × WRITE on the same airspace is a low-severity caution", () => {
		const c = classify("read", "write", "same");
		expect(c).toMatchObject({ level: 2, severity: "low", control: "caution" });
	});

	it("WRITE × WRITE on the same symbol is an exclusive structural collision", () => {
		expect(classify("write", "write", "same")).toMatchObject({ level: 1, severity: "high", control: "exclusive" });
		expect(classify("write", "write", "contains")).toMatchObject({ level: 1, control: "exclusive" });
	});

	it("CONTRACT × dependent READ requires landing order, not a hold", () => {
		expect(classify("contract", "read", "same")).toMatchObject({ level: 3, severity: "high", control: "land-after" });
		expect(classify("read", "contract", "contains", true)).toMatchObject({ level: 2, control: "land-after" });
	});

	it("WRITE × CONTRACT is critical", () => {
		expect(classify("write", "contract", "same")).toMatchObject({ severity: "critical", control: "exclusive" });
	});

	it("distinct symbols in one file are separate airspace (caution only)", () => {
		expect(classify("write", "write", "same-file")).toMatchObject({ severity: "low", control: "caution" });
		expect(classify("read", "write", "same-file").control).toBe("none");
	});

	it("independent modules never interact", () => {
		const found = interactions(
			[{ resource: V, mode: "write", origin: "declared", requested: "x" }],
			[{ resource: SESSIONS, mode: "write", origin: "declared", requested: "y" }],
			baseIndex,
		);
		expect(found).toEqual([]);
	});

	it("a file-level write contains every symbol in the file", () => {
		const found = interactions(
			[{ resource: TV_FILE, mode: "write", origin: "declared", requested: "x" }],
			[{ resource: HAS_SCOPE, mode: "write", origin: "declared", requested: "y" }],
			baseIndex,
		);
		expect(found).toHaveLength(1);
		expect(found[0].overlap).toBe("contains");
	});

	it("derived × derived reads are ignored", () => {
		const found = interactions(
			[{ resource: TV_FILE, mode: "read", origin: "derived", requested: "x" }],
			[{ resource: TV_FILE, mode: "read", origin: "derived", requested: "y" }],
			baseIndex,
		);
		expect(found).toEqual([]);
	});
});
