# Deterministic console demo

Run `pnpm dev:fixture`. The server prints a loopback URL and displays an explicit fixture banner. It uses the new domain controllers and the same console as the Worker. It cannot access live workspaces and is not a deployed route.

The fixed-clock scenario includes a personal workspace, shared Maya workspace, payment-service repository, Cris and Codex sessions, overlapping retry work, exact reproducible Git commits, a source snapshot and a proposed change. Explore workspace/repository switching, Code, session provenance, review and attestation, artifact lineage, Members and Teams. Cloud environments stay empty until configured; the fixture does not fake provider synchronization.

`pnpm verify:scenario` recreates the new scenario twice and compares commit IDs, then independently runs reusable auth-service source overlays through ordinary Git merges and Node tests. Overlay directory names are preserved fixture paths. Every verification commit uses a fixed author/committer clock. `pnpm test:browser` exercises the console journeys and mobile layout.
