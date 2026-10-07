# Releases

[Documentation map](../README.md#documentation-map) · [Changelog](../CHANGELOG.md) · [Verification](local-verification.md)

Cruce's current alpha is **[0.1.0-alpha.3](https://github.com/acltabontabon/cruce/releases/tag/v0.1.0-alpha.3)**, released on 2026-10-07. Its [checked deployment](https://github.com/acltabontabon/cruce/actions/runs/37606862011) passed; [test environment](test-environment.md) records the Worker version and [verification](local-verification.md) records acceptance limits. This is experimental software; alpha interfaces may change.

## Versioning and changelog

- `package.json` is the version source for Cruce and its MCP interfaces.
- Use SemVer: `0.1.0-alpha.1`, `0.1.0-alpha.2`, `0.1.0-alpha.3`, then beta/rc versions as needed and `0.1.0` for the stable release.
- During `0.x`, increment the minor version for breaking changes and the patch for compatible fixes. From `1.0.0`, use major/minor/patch for breaking changes/features/fixes.
- Follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/): group brief user-facing changes under `[Unreleased]` using applicable `Added`, `Changed`, `Deprecated`, `Removed`, `Fixed` or `Security` headings; omit empty categories and maintain release/comparison links. Before release, move them into a heading matching the package version. Summarize user-facing changes; Git history and review descriptions retain implementation details. Keep current local/live verification evidence in [verification](local-verification.md).
- Release tags are `v` plus the exact package version. Never move or reuse a published tag; fix a release with a new version.

## Local client distribution

Every console build emits `/downloads/cruce-client.tgz`, an installable npm package with `cruce` and `cruce-git-credential` executables. The package uses an explicit source allowlist and the exact installed versions of its runtime dependencies. It excludes Worker code, installation configuration and credentials. No npm registry publication is needed: users install directly from their Cruce site. npm fetches the declared dependencies from its configured registry.

The Vite plugin generates this archive for both development and built console assets, including direct `cf build` and deployment builds. Local packaging tests run the extracted client outside the source checkout; hosted downloads and OAuth still require deployed acceptance.

## Interface compatibility

The MCP tool catalog ([`src/shared/tools.ts`](../src/shared/tools.ts)), the console HTTP API and the bridge command route are versioned together with `package.json`. MCP clients read the version from the server's `serverInfo`.

- A breaking change is a removed or renamed tool, field or route; a new required argument; a narrower accepted value; or a changed meaning or shape of a result. During `0.x`, a breaking change increments the minor version and is listed under `Changed` or `Removed` in the changelog with what clients must do.
- A new tool, a new optional argument or a new result field is compatible and increments the patch version.
- Prerelease versions (`-alpha.N`, `-beta.N`) may break interfaces between prereleases. The changelog still names every break.
- Cruce does not keep compatibility aliases or adapters for removed interfaces. A breaking change replaces the old interface in the same release.
- Stored coordination state is not an interface. Layout changes are converted on explicit mutation within the same domain, and never by reads.

`pnpm release:check` checks the version and changelog. `pnpm release:check v0.1.0-alpha.3` also checks the tag. A matching entry with release notes is required.

## One-time GitHub setup

The workflow in `.github/workflows/release.yml` deploys Cruce's own Worker, `cruce`, in the account supplied through `CLOUDFLARE_ACCOUNT_ID`. It hosts Cruce itself; it does not implement deployment for repositories coordinated by Cruce.

1. Configure the GitHub `production` environment. Add `CLOUDFLARE_API_TOKEN` as an environment secret, scoped to the existing Cloudflare account and the deployment permissions needed by this Worker and its bindings. The runtime Artifacts binding requires no customer API token. Never use an Artifacts repository Git token for deployment.
2. Set these environment variables in the GitHub `production` environment (Settings → Environments → production → Environment variables):

   | Variable | Value |
   | --- | --- |
   | `CLOUDFLARE_ACCOUNT_ID` | Your installation account ID |
   | `CRUCE_ARTIFACTS_NAMESPACE` | Stable storage namespace, e.g. `cruce` |
   | `CRUCE_WORKER_NAME` | Worker name, e.g. `cruce` |
   | `CRUCE_PUBLIC_ORIGIN` | Your installation HTTPS origin |
   | `CRUCE_ACCESS_ISSUER` | Existing Access team URL from `.env.test` |
   | `CRUCE_ACCESS_AUD` | Existing Access application audience from `.env.test` |

   These are configuration values, not secrets. Missing values stop deployment.
3. Keep `CRUCE_SECRET` configured on the existing Worker. The workflow preserves those server secrets; it does not upload secret files.
4. If Workers Builds is connected to Cruce's own repository, disable its automatic production deployment so a branch push cannot bypass release tags. External release systems for coordinated repositories remain outside Cruce.
5. Protect `main` and restrict release-tag creation to maintainers with a GitHub tag ruleset where your plan supports it. A human pushing a release tag is the decision to deploy. Optional environment reviewers add an approval if wanted.

GitHub Actions uses standard Ubuntu runners, Node 24 and pnpm 12.4.2 with the frozen lockfile. The deployment follows Cloudflare's [cf automation guide](https://developers.cloudflare.com/cf/ci/), using the project's installed CLI and deploying the same production build that passed the dry run. Only the deployment step receives the API token.

## Release

Commit the version and changelog with the intended release changes, merge into `main`, and verify the checks pass. From a clean, current `main` checkout:

```sh
release_tag="v$(node -p 'require("./package.json").version')"
pnpm release:check "$release_tag"
git tag -a "$release_tag" -m "Cruce $release_tag"
git push origin "$release_tag"
```

First set a new, unreleased package version and matching changelog entry. The commands derive that version; do not rerun them against the already released version.

Pull requests and pushes to `main` run checks and an offline build. Only pushed `v*` tags can deploy. A release must match the package version and changelog, be contained in `main`, and pass typecheck, lint, tests, demo verification and builds. Deployments are serialized and record the release tag and commit in the Cloudflare Worker version. Ordinary commits and GitHub draft releases do not deploy; pushing a tag does, even if a GitHub release remains a draft.

To restore older code, prepare a new version on `main` with a concise rollback changelog entry and push its new tag. Existing Cloudflare Worker version rollback is also available as an explicit human operation.

## Access branding

Access branding is account-level configuration, applied separately from Worker deployment. The [branding payload](../tools/access-login-branding.json) and [setup instructions](cloudflare-setup.md#access-login-branding) keep it reviewable. A release tag does not apply or reset Access branding or policies.

Since alpha.2, storage is deployment-managed: existing connected-account namespaces fail closed for resource operations. A release does not migrate retained source or authorize deleting or rebinding it. Plan that transition explicitly before using those namespaces with the new storage model. Alpha.3 also requires fresh human-maintainer approval for open changes with unqualified historical approvals; see [ADR 0006](decisions/0006-qualified-approval-and-publication-recovery.md).

## Direct test deployment without a release

An explicit request may update the single configured test Worker without bumping the package version or creating a release tag. Run the contributor checks, load `.env.test`, validate with `cf deploy --dry-run`, and use `pnpm deploy:test`. The account, Worker name, storage namespace and hostname come from installation environment variables; keep the origin and Access destinations consistent with that hostname. This manual path does not create a GitHub release or change any published tag. Record the source commit, deployment version and hosted verification limits in the test environment guide.
