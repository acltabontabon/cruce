# Native system setup

Cruce uses Cloudflare Artifacts and native membership. GitHub/GitLab credentials are unnecessary.

## Infrastructure and identity

Use `cf` and `cloudflare.config.ts`. Non-offline mode binds Artifacts and Workers AI. `SystemDirectory` and `ControlTower` are SQLite Durable Objects; OAuth tokens use the configured KV binding.

Configure a Cloudflare Access application for the Cruce hostname with your chosen identity provider. Protect the console and `/auth/*` and `/authorize`. Allow the OAuth protocol endpoints (`/oauth/*`, discovery under `/.well-known/*`) and `/mcp` to reach Cruce without an Access browser redirect; Cruce protects MCP with OAuth and revalidates the Access identity behind it. The public isolated demo and its `/api/projects/demo/*` endpoints may be excluded from Access deliberately.

Set deployment configuration:

```text
CRUCE_PUBLIC_ORIGIN=https://YOUR_CRUCE_HOST
CRUCE_ACCESS_ISSUER=https://YOUR_TEAM.cloudflareaccess.com
CRUCE_ACCESS_AUD=YOUR_ACCESS_APPLICATION_AUDIENCE
CRUCE_SECRET=<server-only random encryption/protocol secret>
```

Issuer/audience are configuration, not developer-supplied authorization. Cruce verifies JWT signature, audience, issuer, expiry and native membership. OAuth access is bounded by the underlying Access JWT; expired identity requires sign-in. Access user revocation follows its session/token lifetime; native membership removal takes effect on the next request. No shared production admin token authorizes the native system.

Sign in, create a named System, and record intent. Creation assigns an immutable system ID and the creator as maintainer. Authenticated governance API `POST /api/systems/access?systemId=…` supports versioned membership, display-name and active-state updates; no external organization installation is needed. Disabling a system denies source and agent access while allowing its existing maintainers to re-enable it through governance. Contributors propose; observers read; human maintainers promote or change policy.

## Existing clients

```sh
node /ABSOLUTE/PATH/cruce/runner/cruce.ts checkout --url https://YOUR_CRUCE_HOST --system SYSTEM_ID --directory ./payments
node /ABSOLUTE/PATH/cruce/runner/cruce.ts connect --url https://YOUR_CRUCE_HOST --system SYSTEM_ID --client codex --cwd ./payments
```

Checkout creates a new directory from accepted source; it never replaces an existing checkout. Connect attaches the existing checkout without changing its branch. Use `claude` or `cursor` as the client. The command opens browser authorization with PKCE and stores MCP credentials outside source in `~/.config/cruce` with mode 0600. `.cruce/` contains non-secret local associations and is ignored by Git.

The bridge preserves other MCP servers and adds narrowly scoped participation instructions. Codex uses trusted project `.codex/config.toml` plus `AGENTS.md`; Claude uses `.mcp.json` plus `CLAUDE.md`; Cursor uses `.cursor/mcp.json` plus its always-applied Cruce rule. Trust/enable the server in the chosen client. Basic configuration does not guarantee adaptive participation; hooks and adaptive verification are explicitly false until live sequences pass.

`cruce refresh` (or the local `refresh_source` MCP tool) fetches accepted Git objects into `refs/cruce/accepted` without changing or discarding working-tree files. Agents inspect and reconcile with normal Git tools before amending plans. Managed source publication performs a real three-way refresh against an amended baseline; conflicts preserve the existing workspace and require explicit resolution.

Run normal tools. Agents discover source/context/policy, create a bounded mission, accept it, check coordination, report actual changes, publish source/evidence, create a proposal and request review. Human UI or authenticated browser API reviews evidence and promotes. MCP identities cannot promote, resolve disagreement or change policy.

`node runner/cruce.ts mcp --cwd ./payments` is the stdio bridge. `node runner/cruce.ts check --cwd ./payments` reports local constraints and exits nonzero for uncertain/blocked publication. The remote server is Streamable HTTP `/mcp`. It is stateless; durable business state belongs to the system authority, not the transport session.

Native commands require idempotency keys and relevant expected versions. A successful retry returns a receipt, not renewed clearance. Use new keys for new actions, inspect latest versions after constraints, and acknowledge instructions separately from resolution. Never discard local code implicitly during refresh.

## Source, evidence and policy

`publish_source` accepts bounded changed text files, exact workspace base and live writer/plan versions. Cruce creates actual source objects, analyzes the exact diff and gates the managed workspace push. Native request bodies are bounded to 4 MiB; focused file/output text is capped at 100,000 characters, export packs at 32 MiB.

`publish_artifact` records typed outputs against an exact source revision. `read_artifact` retrieves content with provenance. `attach_verification` references exact-revision evidence; agent results remain reported. Human attestation is labeled and distinct from runtime verification. `set_policy` is human-maintainer-only, requires a reason and current policy version, and supports required evidence kinds and human approval counts. Agents never gain production authority.

Source promotion is the current native boundary. Hosted mission execution, automated runtime verifier, environment deployments and release records require subsequent implementation and verification. The optional legacy Sandbox remains behind `CRUCE_SANDBOX=on` and `CRUCE_LEGACY_RUNTIME=on`; it is not a native setup requirement.

## Platform references

[Artifacts](https://developers.cloudflare.com/artifacts/), [Access JWT validation](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/), [MCP transport](https://developers.cloudflare.com/agents/model-context-protocol/protocol/transport/), [Jev](https://developers.cloudflare.com/ai/models/typesafe/jev/), [Codex MCP](https://developers.openai.com/codex/mcp/), [Claude MCP](https://code.claude.com/docs/en/mcp), [Cursor MCP](https://cursor.com/docs/mcp).
