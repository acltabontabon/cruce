# Controller model

`DirectoryController` handles stable identity, personal/shared namespace creation and unique mutable handles. `NamespaceController` derives membership and repository access, manages teams/invitations and atomically reserves shared resource budgets. `RepositoryController` handles workspace participation, advisory overlap, revision-bound changes/reviews/evidence, immutable artifacts, deployment decisions and lineage.

Controllers are pure and deterministic with injected time and IDs. Durable Objects persist their results. Infrastructure adapters perform Git and Cloudflare calls only after the authoritative namespace resource gate. Every mutation has an operation identity; exact input fingerprints protect retries from accidental reuse. Reads never provision resources.

The UI uses controller-derived permission/readiness data. Agent labels do not grant permission. Current grants are checked before returning mutation receipts. Production is human-only; disagreement needs a recorded reasoned resolution. Stale bases invalidate acceptance readiness but do not stop local editing. Presence expiration never grants a writer another checkout's lock.

The old flight, mission, workstream, mandatory scheduling and migration controllers have been removed rather than translated into workspaces.
