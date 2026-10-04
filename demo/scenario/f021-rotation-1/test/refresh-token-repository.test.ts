import assert from "node:assert/strict";
import { test } from "node:test";
import { RefreshTokenRepository } from "../src/persistence/refresh-token-repository.ts";

test("stores, finds, and deletes refresh tokens", () => {
	const repo = new RefreshTokenRepository();
	repo.save({ token: "t1", userId: "ada", expiresAt: 10 });
	repo.save({ token: "t2", userId: "ada", expiresAt: 10 });
	assert.equal(repo.find("t1")?.userId, "ada");
	assert.equal(repo.countForUser("ada"), 2);
	assert.equal(repo.delete("t1"), true);
	assert.equal(repo.find("t1"), undefined);
});

test("rotation keeps the family and makes the old token single-use", () => {
	const repo = new RefreshTokenRepository();
	repo.save({ token: "t1", userId: "ada", expiresAt: 10 });
	const rotated = repo.rotate("t1", { token: "t2", userId: "ada", expiresAt: 20 }, 5);
	assert.equal(rotated.status, "rotated");
	assert.equal(repo.find("t2")?.family, "t1");
	assert.equal(repo.find("t1")?.usedAt, 5);
});

test("reusing a rotated token revokes the whole family", () => {
	const repo = new RefreshTokenRepository();
	repo.save({ token: "t1", userId: "ada", expiresAt: 10 });
	repo.rotate("t1", { token: "t2", userId: "ada", expiresAt: 20 }, 5);
	assert.deepEqual(repo.rotate("t1", { token: "t3", userId: "ada", expiresAt: 30 }, 6), { status: "reused", family: "t1" });
	assert.equal(repo.find("t2"), undefined);
	assert.equal(repo.countForUser("ada"), 0);
});
