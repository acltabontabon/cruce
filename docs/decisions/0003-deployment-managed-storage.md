# 0003 — Deployment-managed storage

**Status:** Accepted, 2026-10-06

## Decision

Cruce's installation configures Cloudflare Artifacts storage once. Application namespaces inherit that explicit deployment binding; users do not supply Cloudflare accounts or API tokens. Namespace membership, repository grants and atomic resource budgets remain the authority for every resource operation.

This supersedes the connected-account requirement in the product and domain model. A deployment binding is the configured storage authority, never a fallback for missing customer credentials. Existing retained source must not be silently rebound or moved.

## Consequences

- `cf` configures the account, origin, Worker name and physical Artifacts namespace from installation environment settings; no personal deployment addresses are defaults.
- One installation binding holds repositories whose physical names include stable Cruce namespace IDs. Namespace authority and atomic budgets continue to gate infrastructure calls.
- The installation operator pays Cloudflare usage and manages account-wide capacity. Namespace budgets remain logical operation policy.
- Storage account/physical namespace are pinned on first resource use. Changed configuration and pre-existing connected-account records fail closed. There is no compatibility adapter, automatic migration or source deletion.
- The REST host remains only for explicitly authorized provider verification. New binding behavior requires hosted verification before deployment claims.

## Superseded

The connected-account requirement and prohibition on explicitly using deployment-account storage in the product, domain model, principles and AGENTS.md are superseded. The prohibition on silent credential fallback remains. Canonical authority, human approval, source retention and execution boundaries are unchanged.
