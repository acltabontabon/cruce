# Releases

Cruce's first alpha, **0.1.0-alpha.1**, was released on 2026-10-05. Future releases are deployed by pushing a checked release tag. This is experimental software; alpha interfaces may change.

## Versioning and changelog

- `package.json` is the version source for Cruce and its MCP interfaces.
- Use SemVer: `0.1.0-alpha.1`, `0.1.0-alpha.2`, then beta/rc versions as needed and `0.1.0` for the stable release.
- During `0.x`, increment the minor version for breaking changes and the patch for compatible fixes. From `1.0.0`, use major/minor/patch for breaking changes/features/fixes.
- Keep brief user-facing changes under `[Unreleased]` in `CHANGELOG.md`. Before release, move them into a heading matching the package version. Mention changes, not implementation history; use `docs/PROGRESS.md` for detailed work records.
- Release tags are `v` plus the exact package version. Never move or reuse a published tag; fix a release with a new version.

`pnpm release:check` checks the version and changelog. `pnpm release:check v0.1.0-alpha.1` also checks the tag. A matching entry with release notes is required.

## One-time GitHub setup

The workflow in `.github/workflows/release.yml` deploys Cruce's own Worker, `cruce`, in the account already named in `cloudflare.config.ts`. It does not change the canonical Artifacts repositories or the product's repository deployment decisions.

1. Configure the GitHub `production` environment. Add `CLOUDFLARE_API_TOKEN` as an environment secret, scoped to the existing Cloudflare account and the deployment permissions needed by this Worker and its bindings. Use a deployment token, not the namespace's connected-account credential or an Artifacts repository write token.
2. Set these environment variables in the GitHub `production` environment (Settings → Environments → production → Environment variables):

   | Variable | Value |
   | --- | --- |
   | `CRUCE_PUBLIC_ORIGIN` | `https://cruce.acltabontabon.workers.dev` |
   | `CRUCE_ACCESS_ISSUER` | Existing Access team URL from `.env.test` |
   | `CRUCE_ACCESS_AUD` | Existing Access application audience from `.env.test` |

   These are configuration values, not secrets. Missing values stop deployment.
3. Keep `CRUCE_SECRET` configured on the existing Worker. The workflow preserves those server secrets; it does not upload secret files.
4. If Workers Builds is connected to Cruce's own repository, disable its automatic production deployment so a branch push cannot bypass release tags. Repository preview/deployment repositories are separate.
5. Protect `main` and restrict release-tag creation to maintainers with a GitHub tag ruleset where your plan supports it. A human pushing a release tag is the decision to deploy. Optional environment reviewers add an approval if wanted.

GitHub Actions uses standard Ubuntu runners, Node 24 and pnpm 12.4.2 with the frozen lockfile. The deployment follows Cloudflare's [cf automation guide](https://developers.cloudflare.com/cf/ci/), using the project's installed CLI and deploying the same production build that passed the dry run. Only the deployment step receives the API token.

## Release

Commit the version and changelog with the intended release changes, merge into `main`, and verify the checks pass. From a clean, current `main` checkout:

```sh
pnpm release:check v0.1.0-alpha.1
git tag -a v0.1.0-alpha.1 -m "Cruce 0.1.0-alpha.1"
git push origin v0.1.0-alpha.1
```

For later releases, substitute the new version in all three commands.

Pull requests and pushes to `main` run checks and an offline build. Only pushed `v*` tags can deploy. A release must match the package version and changelog, be contained in `main`, and pass typecheck, lint, tests, demo verification and builds. Deployments are serialized and record the release tag and commit in the Cloudflare Worker version. Ordinary commits and GitHub draft releases do not deploy; pushing a tag does, even if a GitHub release remains a draft.

To restore older code, prepare a new version on `main` with a concise rollback changelog entry and push its new tag. Existing Cloudflare Worker version rollback is also available as an explicit human operation.
