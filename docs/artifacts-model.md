# Artifact and source model

Local repositories coordinate without hosting. Explicit committed-source publication uploads a Git pack and preserves exact commits. Artifacts-hosted repositories additionally have a canonical source ref using their configured default branch. Immutable baseline snapshots support isolated session forks; these are execution details, not extra ownership containers.

Each artifact records workspace ID, repository ID, session ID, producing actor, exact source revision, content hash, storage address and evidence trust. Source snapshots preserve Git objects. Evidence artifacts preserve submitted content and are labelled reported unless independently attested or verified. Build outputs are a separate kind and must represent captured outputs; a Workers Builds success does not fabricate a downloadable build artifact.

Deployments always name a source artifact and derive their revision from it. Deploy repositories are separate from accepted source, enabling preview and explicit rollback without rewriting accepted history. Session end never deletes source referenced by an artifact or deployment. Reverse lineage connects the originating session and change to the deployed artifact.

Source browsing and diff requests require uploaded objects. Observed refs and agent-reported commits remain useful when source is unavailable, but they do not establish remote verification. Renaming a workspace handle or repository does not change storage identity.
