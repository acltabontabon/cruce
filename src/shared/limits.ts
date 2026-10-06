/** Supported coordination envelope. These are Cruce limits, not provider quotas. */
export const STATE_LIMITS = {
	recordBytes: 1024 * 1024,
	stateBytes: 768 * 1024,
	admissionBytes: 640 * 1024,
	storeBytes: 128 * 1024 * 1024,
	storeRecords: 200_000,
	recoveryBytes: 2 * 1024 * 1024,
	pageSize: 100,
	namespaceCandidates: 128,
	directoryConversionRecords: 4096,
	repositories: 64,
	workspaces: 256,
	artifacts: 1024,
	proposals: 512,
	verifications: 2048,
	promotions: 512,
	recentActivity: 100,
	cleanupRefs: 256,
	recoveryBatch: 4,
} as const;
export const TRANSFER_LIMITS = { gitBytes: 32 * 1024 * 1024, gitAdvertisementBytes: 128 * 1024, commandBytes: 2 * 1024 * 1024 } as const;
