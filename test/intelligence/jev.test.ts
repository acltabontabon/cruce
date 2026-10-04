import { describe, expect, it } from "vitest";
import { type EvidencePacket, evaluationGate, JEV_MODEL, validateAssessment } from "../../src/intelligence/jev.ts";

const packet: EvidencePacket = {
	fingerprint: "inputs",
	workstreamId: "a",
	otherId: "b",
	resources: ["s:src/payment.ts#PaymentService"],
	evidence: [
		{ id: "e1", revision: "sha", resource: "s:src/payment.ts#PaymentService", excerpt: "execute(id: string): Payment", verified: true },
	],
	state: {},
	questions: {
		intent: { type: "noul", instructions: "intent" },
		dependency: { type: "noul", instructions: "dependency" },
		omission: { type: "noul", instructions: "omission" },
		response: {
			type: "choice",
			instructions: "response",
			criteria: { none: "clear", review: "review", publication_dependency: "dependency", escalate: "human" },
		},
	},
};
const response = () => ({
	model: JEV_MODEL,
	answers: {
		intent: { type: "noul", noul: 0.01 },
		dependency: { type: "noul", noul: 0.99 },
		omission: { type: "noul", noul: 0.01 },
		response: {
			type: "choice",
			choice: "publication_dependency",
			confidence: 1,
			probabilities: { none: 0, review: 0, publication_dependency: 1, escalate: 0 },
		},
	},
	usage: { input_tokens: 500, output_tokens: 20 },
});
describe("bounded Jev assessment", () => {
	it("constructs supported constraints from pre-resolved resources and evidence", () => {
		expect(validateAssessment(packet, response())).toEqual([
			expect.objectContaining({
				probability: 0.99,
				response: "publication_dependency",
				dependency: "b",
				resources: packet.resources,
				evidence: ["e1"],
				automatic: false,
			}),
		]);
	});
	it("does not auto-constrain missing source evidence", () => {
		expect(validateAssessment({ ...packet, evidence: [] }, response())[0]).toMatchObject({
			response: "escalate",
			automatic: false,
			resources: [],
		});
	});
	it.each([NaN, -0.1, 1.1])("rejects an invalid probability %s", (p) => {
		const r = response();
		r.answers.dependency.noul = p;
		expect(() => validateAssessment(packet, r)).toThrow();
	});
	it("rejects model changes, missing answers, invented response references and invalid distributions", () => {
		expect(() => validateAssessment(packet, { ...response(), model: "jev-next" })).toThrow("Model version");
		expect(() => validateAssessment(packet, { ...response(), answers: {} })).toThrow("Missing");
		const r = response();
		r.answers.response.choice = "merge";
		expect(() => validateAssessment(packet, r)).toThrow("distribution");
		r.answers.response.choice = "publication_dependency";
		r.answers.response.probabilities.review = 0.2;
		expect(() => validateAssessment(packet, r)).toThrow("distribution");
	});
	it("does not promote an unlabeled or incomplete corpus", () => {
		const cases = Array.from({ length: 200 }, () => ({
			capability: "dependency",
			expectedConcern: true,
			concern: true,
			escalated: false,
			invalidResource: false,
			forbiddenAction: false,
			humanLabeled: false,
		}));
		expect(evaluationGate(cases, "dependency").passed).toBe(false);
		expect(
			evaluationGate(
				cases.map((c) => ({ ...c, humanLabeled: true, forbiddenAction: true })),
				"dependency",
			).passed,
		).toBe(false);
		expect(
			evaluationGate(
				cases.slice(0, 10).map((c) => ({ ...c, humanLabeled: true })),
				"dependency",
			).passed,
		).toBe(false);
	});
	it("requires both precision and consequential recall", () => {
		const cases = Array.from({ length: 50 }, (_, i) => ({
			capability: "dependency",
			expectedConcern: i < 25,
			concern: i < 25,
			escalated: false,
			invalidResource: false,
			forbiddenAction: false,
			humanLabeled: true,
		}));
		expect(evaluationGate(cases, "dependency")).toMatchObject({ precision: 1, recall: 1, passed: true });
		cases[0].concern = false;
		cases[1].concern = false;
		expect(evaluationGate(cases, "dependency").passed).toBe(false);
	});
});
