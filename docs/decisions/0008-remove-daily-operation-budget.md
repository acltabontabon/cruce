# 0008 — Remove the namespace daily operation budget

Status: Accepted 2026-10-08

Supersedes the budget parts of [0003](0003-deployment-managed-storage.md) and [0004](0004-bounded-source-inspection-and-cache.md). Their other decisions stand.

## Context

Each namespace counted reserved resource operations per UTC day and refused new ones once the count reached a configurable limit (default 100). The count weighed every operation the same, so creating a repository and an explicit source read each counted as one, and it did not track Cloudflare cost. Reads counted, so ordinary agent work could reach the limit. When the limit was reached, every person and agent in the namespace was refused across all repositories until midnight UTC. That stopped legitimate work as well as runaway work.

The cost the budget guarded against does not exist at Cruce's current stage. The installation operator already pays and manages account-wide Cloudflare usage. The budget still added a setting, a console card, an error, per-day storage counters, API validation and tests to every resource operation.

## Decision

- Remove the daily count, its limit, the per-day counters and the budget-reached error. Namespaces no longer have a daily operation limit, and the console no longer shows today's usage.
- Keep namespace resource reservations. They remain atomic across repositories, give each operation a stable identity and exact input fingerprint, make retries reuse the original reservation, and keep uncertain outcomes recorded until reconciled. They are a record of the operation, not a charge against a budget.
- Keep namespace and repository resource policy (allow, maintainers only, not allowed) per action. Repository policy still only narrows namespace policy. Every resource operation still declares scope and cost and passes the namespace gate before infrastructure calls.

## Consequences

A looping agent with write authority can now create forks or publications without a numeric cap. Resource policy can still restrict or deny each action, and revoking the connection stops it. If unbounded growth becomes a real problem, the replacement should cap live resources, such as repositories or live workspace forks per namespace, rather than daily activity. That is a roadmap candidate, not current work.

Stored per-day counters and `dailyLimit` values in existing namespace records are ignored. No migration is needed.
