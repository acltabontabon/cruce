# Decision records

[Documentation map](../../README.md#documentation-map) · [Product](../product.md) · [Principles](../principles.md)

Focused records of consequential decisions whose rationale is larger than its owning document can reasonably hold. Each record states context, decision, consequences and what it supersedes. Owning documents ([product](../product.md), [domain model](../domain-model.md), [architecture](../architecture.md)) describe the current state; these records explain why it changed. Git history preserves implementation history. These are not progress logs.

| Record | Status | Summary |
| --- | --- | --- |
| [0001 — Product boundary reset](0001-product-boundary-reset.md) | Accepted 2026-10-06 | Cruce is the durable Git coordination plane for parallel agentic development; execution, messaging, scheduling and CI/CD are out of scope. Includes the alignment audit and the keep/change/remove/defer analysis |
| [0002 — Workspace ownership and execution attachment](0002-workspace-ownership-and-execution-attachment.md) | Accepted 2026-10-06 | Workspaces are owned by users, not agent connections; execution attachments are replaceable |

Add a record only for a decision that changes the product boundary, the domain model, authority or a core dependency. Number records sequentially, and never rewrite an accepted record's decision. Supersede it with a new one.
