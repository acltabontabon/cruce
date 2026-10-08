# Cruce visual identity and console

[Contributor guide](../CONTRIBUTING.md) · [Architecture](architecture.md) · [Local walkthrough](local-demo.md)

Cruce's interface makes concurrent Git work legible: what is happening, who or what is advancing it, where each workspace started, what overlaps, what is stale, what can be reviewed and what reached canonical. Repository work is the center of the console, and Home lists your repositories by what needs attention. Product language follows the [domain vocabulary](domain-model.md#vocabulary): Namespace, Repository, Workspace, baseline, published revision, evidence, change, review and promotion. The console stays developer-native and progressively disclosed; it is not a dashboard of cards, and it never presents a client brand as more than a label. Copy is operational and plain: it says what happened, what is blocked and what to do next, never a tagline.

## Identity

The **interlaced junction** uses an apex and a returning strand, separated at their crossings. The geometry gives independent paths a common identity without erasing their origin. The apex offers a subtle salakot reference; it is not a literal hat or a cultural ornament. It does not describe a Git merge.

The [vector study](../public/brand/study.svg) records four directions: a direct junction, an abstract apex, the selected interlaced junction and a lettermark. The direct X loses provenance, the standalone apex is too literal, and the C/X forces the crossing into a letter. The selected mark keeps both crossing and separation legible at 16, 24 and 32px.

[Ink symbol](../public/brand/symbol-ink.svg) · [White symbol](../public/brand/symbol-white.svg) · [Lime symbol](../public/brand/symbol.svg) · [Wordmark](../public/brand/wordmark.svg) · [Reversed wordmark](../public/brand/wordmark-white.svg) · [Favicon](../public/favicon.svg)

Brand display name and application asset references live in `src/ui/brand.tsx`. When renaming, update that module and the editable SVG titles/wordmark text together with document titles. Standalone wordmarks embed the locally bundled Inter font, with its license retained in `public/brand/OFL.txt`; they require no third-party font request. The wordmark uses normal lettering while the symbol carries the topology.

The Cloudflare Access sign-in uses the ink symbol, paper background and forest text, with a **Sign in to Cruce** header and brief email-code guidance. Cloudflare owns the form layout and OTP flow. Account-level branding values live in [the Access payload](../tools/access-login-branding.json); [setup](cloudflare-setup.md#access-login-branding) explains their team-wide scope and preservation of authentication settings. Include this payload when renaming the product.

## Materials and hierarchy

The console has two themes on one token set in [styles.css](../src/ui/styles.css). **Midnight** is the dark theme and **Daylight** the light one. With no saved preference the console matches the system; the avatar menu's Appearance control chooses System, Dark or Light per browser, applied before first paint. The public homepage and the session screen use the same tokens, type and inline Cruce mark, so a visitor sees the palette the console will use. The OAuth connection page uses the same tokens and mark; only the Cloudflare Access sign-in keeps the earlier paper palette.

| Token | Midnight | Daylight | Use |
| --- | --- | --- | --- |
| `--bg` | `#0F111A` | `#F5F6F9` | Page canvas |
| `--surface` | `#151826` | `#FFFFFF` | Inputs, menus and framed objects |
| `--border` / `--border-subtle` | `#2A2F46` / `#1F2336` | `#DCE0E8` / `#E7EAF0` | Section rules and row dividers; they carry no state |
| `--text` / `--text-muted` | `#DCE1F5` / `#9CA5C7` | `#151925` / `#535B70` | Copy and metadata |
| `--accent` | `#82A6FF` | `#2C58D0` | Primary actions, links, focus and exact revisions |
| `--canonical` | `#E9ECF8` | `#151925` | The canonical branch: trunk, branch chip and history |
| `--tone-success` / `--tone-warning` / `--tone-danger` | `#7DD3A0` / `#F0B36A` / `#FF8A9A` | `#1C7A4F` / `#A0570C` / `#C0304A` | Status. Warning marks advisory facts and human attention |
| `--lane-1` … `--lane-6` | teal, violet, orange, pink, gold, sky | darker counterparts | Telling parallel workspaces apart |

Every text and tone colour reaches WCAG AA on its own theme's canvas and surfaces. A workspace's lane colour comes from its start order among all the repository's workspaces, so it never changes while the workspace exists; it never carries state, and every lane also shows its title. Colour always accompanies text or shape.

Geist supplies interface copy; JetBrains Mono identifies exact revisions, branches, paths and page titles. Both are bundled locally. Lists sit open on the page between hairline rules, with generous space between sections; only real objects, the lane map, diffs and source, get a frame. Repository names and paths wrap; code panes scroll internally. Theme switches apply in one frame without animated transitions.

## Status language

The console states facts in plain words, derived from controller decisions in [src/ui/status.ts](../src/ui/status.ts). Wording never grants authority; readiness, permissions and cleanup eligibility come from the controller snapshot.

| Thing | States shown | Meaning |
| --- | --- | --- |
| Change | Operation needs attention, Ready to promote, Needs human review, Needs preparation, Needs reconciliation, Superseded by #n, Promotion not settled, Promoted, Closed | Groups come from the controller's attention projection. Preparation: required evidence is missing or failing. Reconciliation: canonical moved past the change's pinned review base. Superseded: its workspace proposed a newer change |
| Blocker | "Required tests evidence missing", "Tests reported passing; human attestation required", "Tests failing for this revision", "Change based on C0; accepted canonical is C1", "Human approval required for this revision", "Another promotion must be reconciled first" | Worded from structured blockers, never parsed from reason strings. Rows show the primary blocker and "N more blockers"; the checklist shows them all |
| Workspace | Active, Not reporting, Detached, Setting up, Completed, Cancelled | Not reporting is presence only: "Not reporting; checkout remains attached" |
| Canonical relation | Up to date, Ahead of canonical, Behind canonical, Diverged from canonical, Unrelated to canonical, Ancestry unavailable | Computed from published ancestry against accepted canonical, never from reported heads. A published revision behind canonical is already contained in it; unavailable ancestry is missing knowledge, never reassurance |
| Overlap | "Shares reported paths … with workspace" | Advisory. Shared paths are a heads-up, not a conflict |

Ownership leads: rows and pages read "Owner: Maya", resolved from namespace identity by stable user ID, with "(you)" for the viewer and "Owner name unavailable" when the name cannot be resolved. A tool is never shown as the owner. Tool names appear as provenance ("Codex", "Claude Code", derived from the OAuth client label): "Worktree attached through Codex", "Started through Claude Code · attached through Codex", "published through Codex, Maya's connection". Status pills always carry text; colour supports them but never stands alone.

**Needs you** contains only items where the viewer has an eligible action beyond inspection: attest evidence, resolve a concern, approve, promote or reconcile their own interrupted promotion as a human maintainer, or prepare or reconcile their own workspace's work in their own tools. Everything else visible is **Waiting on others**, naming an authority class ("Waiting on the owner", "Waiting on a maintainer"), never an assigned person. Avoid "safe to merge", "idle agent", "agent owner" and similar.

## Screens and interaction

The slim header uses a 56px content row with the junction mark, the name and an inline repository search field. Avatar, scope controls and the unboxed mobile search icon retain 44px targets. Search follows the current scope (Home, namespace, or namespace and repository). The Cruce mark returns to unscoped Home. Scoped names are anchored searchable dropdowns, with native links, arrow-key selection, normal Tab navigation, Escape dismissal and trigger restoration. Repository search accepts typing directly in the header, and Command/Ctrl K focuses the same field; arrows and Enter select a result, while Escape, Tab and outside clicks dismiss the results without trapping focus. Loading, partial failures and retry stay in the result panel. On narrow screens the search icon reveals the field and results together in an anchored panel.

The avatar opens a compact profile card with name, email, the Appearance control, **Local setup** and Sign out, preserving the current page. Saved account links open it on Home with history replacement. The Alpha label sits quietly in the footer.

| Screen | Presentation |
| --- | --- |
| Home | **Needs you** lists eligible actions with repository, owner, exact revision and primary blocker. **Waiting on others** folds other work; **Heads-up** names advisory facts. Repository summaries disclose truncation and link to the full list |
| Namespace | Repository attention and activity, inherited storage status and Settings. Members/Teams exist only for shared namespaces |
| Workspaces | Each workspace once with open changes beneath it. Owner, relation, report age, attachment provenance and shared paths stay on their rows. Filters carry counts and appear only when they narrow the list. A quiet line names unavailable ancestry, degraded observation or operations rows cannot show |
| Change | One next step and one primary action, with a compact controller checklist ending in Promote. Completed checks fold. Exact-revision files show likely review targets first, supporting files folded, and notes beside their lines or beneath them on narrow screens |
| Workspace | Current next step, baseline and distinct reported/observed/published revisions, owner, attachment, overlap and continuation guidance. Identifiers fold. Release checkout permits continuation; Delete workspace confirms end/withdrawal/retention-checked cleanup while preserving history/local files |
| History | Canonical promotions, published source, evidence, activity and Earlier work. Records name approver/promoter/owner, exact revisions, lineage and read-only source |
| Repository Settings | Review policy, grants, rename, lifecycle actions, unfinished resource operations and IDs |
| Local setup | Once-per-machine install/login/connect commands and the copyable request for the user's tool. Connections list all/chosen repository access, permissions and Revoke |
| Namespace Settings | Inherited Git storage readiness and operation policy. No provider-token form. Owner-confirmed shared namespace deletion; personal namespaces cannot use it |

Changes default to what changed since the last reviewed revision; Full change compares with the pinned base. Concern notes follow superseding changes and remain unresolved until a human resolves them with a reason. Answered concerns lead to **Check the answers**; the owner can copy **Hand to your agent**. A stale base withholds approval/attestation until reconciliation. Promotion names workspaces it left behind as information, not assigned work.

Settled/detached work folds only when nothing remains to decide; explicit filters reveal matches. An open change stays visible even after its workspace ends. Continue guidance explains that only pushed source travels and detaching does not revoke the former connection's Git authority. Unpublished fork refs block deletion and are listed for explicit Git/publication action.

Retired routes (`overview`, `code`, `work`, `artifacts`, and the `changes` list) resolve to Workspaces, a change's review or History, so saved links keep working. Deep links, Back, retries and late-response protection are preserved.

Layout breakpoints use the root container width, including reflow at 200% zoom and at 320px. Repository rows use aligned name, sketch, attention and arrow columns; the sketch contracts to its drawn content when there are no workspaces and hides before it would crowd text. On phones, repository attention sits below the title with the same left edge, and decision actions sit below their copy instead of squeezing it into a narrow column. Namespace rows align initials and arrows with the title, followed by separate role, repository-count and storage-status lines. Shared row metadata wraps as inline text with joined separators. Prefixed and ordinary form controls share label spacing and line height. Rows wrap their status pills on narrow screens; tabs stay visible. Creation forms use dialogs with focus containment. Reduced-motion preference disables animation and transitions.

## Verification

See [verification evidence](local-verification.md) for executed checks and their limits. The browser suite covers focused navigation, exact-revision authority, failed promotion retries, unavailable data, delayed responses, mobile focus, reduced motion, and screen captures at 1440, 1024 and 390px plus 200% CSS zoom. The fixture is isolated and cannot establish hosted publication/promotion verification.

## Public homepage

The public page uses the console themes, locally bundled type and Cruce mark. Its illustrated Git story explains independent workspace baselines, advisory overlap, exact human review and promotion, and explicit reconciliation. It uses presentation-only data and requests no private repository data or provider resources. Current copy and example history live in [landing.tsx](../src/ui/landing.tsx) and [landing-example.ts](../src/ui/landing-example.ts); keep screenshots aligned with them rather than treating example wording as a domain contract.

Motion waits until visible, pauses while hidden or offscreen, and respects reduced motion. Replay and stage selection remain keyboard accessible; diagrams have text alternatives. Small screens and 200% zoom keep the actions and story readable. Sign in goes directly to Access while preserving same-origin repository and invitation destinations.

## Tool authorization

The OAuth connection page uses the console palette in the saved or system appearance, with the inline Cruce mark, in a narrow, responsive column. It leads with the requesting tool and signed-in account, then **Repository access**: **All repositories you can access** (selected by default, including repositories created or shared later) or **Choose repositories**, which reveals a searchable picker. Namespace labels sit above repository names, and long names wrap. Selections survive filtering; choosing requires a selection, checked by the server too. With no repositories yet, choosing is unavailable and connecting with all stays possible.

Permissions use plain language in an expandable section, preserving the requested defaults and mandatory read scope. Technical scope identifiers, the client-supplied name disclosure, callback address and cloud resource policy appear in Connection details. Human promotion approval and connection revocation remain visible. Native forms, checkboxes and disclosure controls keep keyboard operation and submission working without JavaScript. Expired consent uses the same page styling with Start again and Cancel. This presentation does not change OAuth authority or repository-approval filtering.

## Hardening interaction rules

The canonical control's **Clone** is the only way into the repository's setup guide. It offers only what the repository needs: **Clone** (the clone command and the sentence for a connected tool) and **Existing checkout** (`git remote add cruce` for connected tools, or `cruce human` to work yourself), both disabled until canonical Git is ready. A "First time on this machine?" line links to Local setup for installing, authorizing Git and connecting tools once. Existing-checkout setup preserves files, branch and remotes, and the guide discloses resource consumption. It never launches an agent or uploads history.

Review leads with the next controller-derived blocker. Completed checks collapse into expandable details. Effective review/evidence IDs determine attribution; earlier superseded decisions remain in the timeline. Authorized reviewers can raise a concern after approval, and evidence authors can record updated outcomes for the same revision. Confirmation remains a human attestation rather than a Cruce-executed check. File modes, symlink conversions and submodule pointers remain visible even without a textual diff.

Authorization denial clears the scoped private view and controls. Transient refresh failures retain explicitly dated data. Identity loading has a working retry. Polling never overlaps for a resource; forced refreshes and navigation reject stale responses. Partial repository reads preserve available summaries and label incomplete counts, with an explicit retry. Clipboard failures show a manual-copy alternative. Presence and report freshness have distinct wording; unknown report times never appear fresh.

## Workspace map motion and scale

The lane map pulses only an active execution attachment; its legend names this as connection presence, never a commit or agent messaging. A changed reported head produces one short arrival highlight on that workspace's own horizontal lane, and a newly published revision briefly accents its retained-source ring. Initial snapshots do not invent activity. Quiet, preparing and detached work stays still. Motion pauses outside the viewport, when the document is hidden, or through Pause motion, and reduced motion removes animated highlights.

Detached lanes are folded by default with an explicit count and Show control. Their workspace rows live in a separate native disclosure retaining owner, revision and change details; explicit owner/reconciliation filters open the group so matching work is not hidden. Attached and disconnected lanes remain visible. The map uses a bounded keyboard-scrollable canvas, tighter spacing above five lanes, and pages of twelve with exact displayed totals; no workspace is silently dropped. Owner names occupy a separate line so ten parallel lanes remain legible.
