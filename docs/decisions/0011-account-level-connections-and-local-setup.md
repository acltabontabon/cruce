# 0011 — Account-level connections and local setup

**Status:** Accepted 2026-10-08

## Context

Local setup was repeated for every repository. Each repository's setup guide asked the person to install the client, authorize Git with `cruce auth --namespace --repository`, and connect each coding tool with `cruce connect --namespace --repository`. Each authorization produced its own OAuth grant and its own local credential file. The consent page confirmed exactly one repository, the Git credential helper was configured for one canonical URL, and tool MCP settings were written into each project. A person with ten repositories approved twenty connections and edited thirty project files. None of this repetition protected anything the server does not already recheck on every request.

## Decision

A connection's **repository approval** is either **all repositories its user can access** or a **chosen list**. Consent defaults to all. "All" follows the user's current access, so it includes repositories created or shared later and loses repositories when access is removed. Choosing narrows a connection to named repositories, and the server rejects an empty or unoffered choice. Effective agent authority remains the intersection of current namespace membership, repository grants, the repository approval and the granted scopes, rechecked on every request and retry. "All" never widens a user's own access. Canonical promotion still requires authenticated human approval, and a paired terminal stays bound to one workspace ([ADR 0002](0002-workspace-ownership-and-execution-attachment.md)).

Local setup happens once per person per machine:

- `npm install` installs the client.
- `cruce login --server URL` authorizes Git with read scope and configures one credential helper for that Cruce server. The helper answers only Cruce Git paths there.
- `cruce connect --server URL --client TOOL` approves one connection per tool and registers the local bridge in that tool's user-level settings. Project files are never written. The bridge sends participation guidance as MCP server instructions.

Each workspace fork keeps its own local credential entry, which clears the server-level helper, so fork pushes authenticate as the tool's own connection and never as the Git login.

The bridge finds which repository a checkout works on from local state an attachment recorded, or else from exactly one remote naming that repository's canonical Git on the configured server. Several such remotes are refused rather than guessed. That URL is an **address** carrying stable IDs. It selects which repository to ask for and proves no identity or authority; the server checks the connection's authority on every call. Outside a checkout, the bridge starts and explains how to clone or add the canonical remote, and the prompt hint prints nothing. An existing checkout opts in with `git remote add cruce <canonical URL>`; `cruce human` remains the per-workspace path for working by hand.

Repository-scoped consent state, per-repository credential files, per-project MCP settings and the per-repository setup steps are removed with no compatibility layer.

## Consequences

The repository's **Set up locally** guide only clones or attaches an existing checkout, and links to the account **Local setup** page, which holds the one-time commands and lists connections with what each reaches. Existing per-repository grants keep their recorded lists until revoked. Installed clients need `cruce login` and `cruce connect` once, and existing project-level `cruce` MCP entries and participation blocks can be deleted.

A leaked or misused "all" connection reaches more repositories than a single-repository grant did. The mitigations are scopes chosen at consent, revocation from Local setup, the OAuth refresh lifetime, membership removal, and human-only promotion. Choosing repositories remains available when narrower reach matters.

This replaces the repository-scoped CLI consent described in the architecture document, and the rule that the bridge never identifies a repository from a matching remote URL. AGENTS.md's "remote URL matching never proves identity" still holds: matching selects an address, never identity.
