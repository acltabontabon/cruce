# Artifact and source model

Every Cruce repository has canonical Cloudflare Artifacts storage. Each writer workspace owns a direct canonical fork. Its actor, task title, immutable starting commit, lifecycle and fork identity are durable repository records, separate from the local checkout and presence heartbeat.

Forks are mutable Git repositories. Source artifacts are retained in a separate per-repository Artifacts repository with unique artifact refs. This lets agents use ordinary Git on their own fork without losing review/deployment source. Publication fetches an exact pushed fork ref, validates ancestry and protected paths, and seals that revision for review. No baseline repository or second Git command language is needed.

Explicit cleanup requires an ended workspace and checks every remote ref against retained canonical/artifact history. Unretained commits, annotated tags and non-commit refs conservatively block deletion. Deletion intent survives retries; provider absence completes deletion. Workspace metadata and immutable artifacts remain. Local cleanup separately checks ownership, dirty files and unpublished commits.

Each artifact records namespace ID, repository ID, workspace ID, producing actor, exact source revision, content hash, storage address and evidence trust. Source snapshots preserve Git objects. Evidence artifacts preserve submitted content and are labelled reported unless independently attested or verified. Build outputs are a separate kind and must represent captured outputs; a Workers Builds success does not fabricate a downloadable build artifact.

New source publications also pin a review base validated against Git ancestry. It can advance after explicit upstream integration while the Workspace's original starting revision stays fixed. Proposals use the artifact's pinned base; subsequent integration does not rewrite earlier artifacts or reviews. Uncertain publication retries preserve that same base even if upstream advances again.

Deployments always name a source artifact and derive their revision from it. Deploy repositories are separate from accepted source, enabling preview and explicit rollback without rewriting accepted history. Workspace end never deletes source referenced by an artifact or deployment. Reverse lineage connects the originating workspace and change to the deployed artifact.

Source browsing and diff requests require uploaded objects. Observed refs and agent-reported commits remain useful when source is unavailable, but they do not establish remote verification. Renaming a namespace handle or repository does not change storage identity.
