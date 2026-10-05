# Local Git and bridge setup

Use Node 22.18+ and install Cruce's dependencies. The launcher is `node /absolute/path/to/cruce/runner/cruce.mjs`; it loads its own dependencies regardless of the participant repository.

1. Sign into the console with Access. Create/select a personal or shared workspace.
2. Choose Open local repository and set its real default branch. Copy the stable workspace and repository IDs. This registration does not read your filesystem, upload commits, alter remotes or provision Artifacts.
3. From the existing checkout, run `cruce connect --server URL --workspace ID --repository ID --client codex` (using the launcher above). Authorize the requested repositories/scopes in the browser. Supported client configuration targets are codex, claude and cursor.
4. Start a session through MCP or `cruce start --title "Describe the work"`. The agent's returned directory is an isolated worktree and branch. Move there before editing. Cruce does not launch the agent.
5. Run `cruce watch` for terminal participation; MCP maintains a heartbeat automatically. Presence is renewed every 30 seconds and becomes disconnected after 90 seconds without contact. This does not discard work or transfer the checkout lock.
6. Commit normally with Git. `cruce publish --title "Describe this revision"` explicitly publishes exact committed history as a source artifact. Cloud setup is needed only at this resource boundary. Propose/review the artifact through Work/MCP.
7. `cruce end` releases participation. `cruce end --cleanup` additionally removes an owned clean context whose head is published or unchanged from the baseline. Dirty, unpublished and unowned checkouts are retained.

`cruce human --server URL --workspace ID --repository ID` requests a browser-approved human terminal connection. Human sessions may attach an existing checkout; another writer is rejected. `--read` starts an observer. Human credentials cannot be used by agent MCP and cannot approve production. Re-run `human` in the session checkout to renew an expired credential.

`cruce resume` reattaches a prepared session after interruption. `cruce refresh` imports an uploaded revision and preserves working changes; it never resets or silently discards files. `cruce report-ref --ref BRANCH` records a local observation after normal external Git operations. Cruce does not infer that a remote push was verified. `cruce checkout --workspace ID --repository ID --server URL --directory EMPTY_DIRECTORY` exports an available uploaded revision for a fresh checkout.

Repository connections and session state live under the resolved Git worktree metadata. Each agent bridge process has its own connection state; each worktree records its actor connection. Persistent writer locks have no time-based takeover. OAuth credentials live in the user's private configuration directory with mode 0600; no Artifacts write token reaches the bridge.

Other checkouts must attach by stable Cruce repository ID, even if remote URLs match. Local credentials and existing remotes remain under ordinary Git control. If source was never published, Code and pinned repository instructions report that they are unavailable.
