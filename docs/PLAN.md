# Workspace → Repository → Session foundation

The implementation replaces the project/mission architecture directly, without conversion or compatibility aliases.

1. Stable users/workspaces/repositories/actors; Access-based personal provisioning; shared membership, invitations, teams and grants; workspace account and atomic resource budget.
2. Local Git and Artifacts source adapters; workspace/repository REST and one intentional MCP catalog; exact committed-source publication.
3. Actor-neutral sessions, dedicated agent worktrees, exclusive checkout reservations/locks, heartbeats and advisory overlap.
4. Revision-bound changes/reviews/evidence; immutable artifact provenance; separate source promotion and artifact-driven deployment with failure, supersession and rollback handling.
5. New console and fixed-clock fixture; replacement documentation and legacy-code removal.

Defaults are private access, Access sign-in, local Git plus Artifacts, advisory overlap and explicit workspace resource accounts. External provider integrations, public signup, automated external merges/pushes and a general workflow engine remain out of scope.

See [local verification](local-verification.md) for executed checks and [test environment](test-environment.md) for the live verification boundary. Local tests never establish provider behavior by themselves.
