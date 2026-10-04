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
