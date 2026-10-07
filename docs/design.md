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

The console has two themes on one token set in [styles.css](../src/ui/styles.css). **Midnight** is the dark theme and **Daylight** the light one. With no saved preference the console matches the system; the avatar menu's Appearance control chooses System, Dark or Light per browser, applied before first paint. The public homepage and the session screen keep their own paper palette whatever the console appearance.

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

The avatar opens a compact profile card with name, email, the Appearance control and Sign out, preserving the current page. Saved account links open it on Home with history replacement. The Alpha label sits quietly in the footer.

**Home** leads with **Needs you**: decisions you can make now across your repositories, each with its repository, owner, exact revision and comparison basis, primary blocker and your action. Groups read recovery first, then ready promotions, human review, preparation and reconciliation; this order guides attention and never sequences work. **Waiting on others** follows, collapsed. Repository summaries are capped at eight items, so a capped list says "Showing 5 of 8 in payment-service" with **Open the full list**. **Heads-up** lists facts that need no decision: quiet checkouts, shared reported paths and workspaces whose ancestry is unavailable. Your repositories follow, sorted by what needs a person, each with a small sketch of canonical and its live workspaces; your namespaces sit beside them. A namespace whose installation storage is unavailable says so, without asking users for provider credentials.

**A repository** opens on a header (name, canonical branch and revision, last promotion, Connect an agent, Attach local checkout, Clone) and an attention strip: one count and plain words per attention group, reconciliation split between changes and workspaces, then shared paths, unavailable ancestry and quiet checkouts. Each count opens its filtered list, or the strip says "Nothing needs attention right now". Four tabs follow:

- **Changes** groups current changes by next action, each row with its owner, exact revision on its review base, primary blocker and the viewer's action or who it waits on. **All open** and **Needs you** filters, and group filters from the attention strip, live in the URL. Superseded changes, and promoted or closed ones, are collapsed below. A change opens as a review: header leading with owner, revision and review base, the next step and every blocker, then one checklist drawn down its workspace's lane colour (built on current canonical; each policy-required check, distinguishing missing, failed, reported and attested evidence; concerns needing a resolution; approval of this exact revision), then **Promote to *branch***, which explains exactly which revisions it moves between. Approval and confirmation are single clicks with an optional note; raising a concern, recording a failure, resolving and closing ask for a reason. The diff loads straight away with the first file open, followed by evidence and reviews.
- **Workspaces** opens on the **lane map**: canonical drawn as a trunk of recorded promotions, and each live workspace as a coloured lane leaving it at its fixed baseline, through its reported head, published revision and change, to its relation with canonical. The horizontal axis is lifecycle stage, not time or distance. A baseline that is not a recorded canonical revision gets a dashed, unattached lane rather than a guessed junction; quiet checkouts are dashed; shared paths are a dashed advisory bracket. Hovering a lane highlights its row and the reverse. Each lane is labelled with its owner. Below it, **All**, **Mine** and **Needs reconciliation** filters, plus an owner filter when several people own work, precede live workspaces listing their owner, attachment provenance, report age, state, canonical relation, blocker, overlaps and latest change, each row carrying its lane colour; ended ones are collapsed. A workspace page opens on its own lane drawing (canonical, baseline, reported head, observed pushed ref, published revision and change) and shows owner, current attachment, fixed baseline, published revision ("No published revision" when there is none), decision state, reported head (noting when it differs from the observed pushed ref), canonical relation (with "See what changed on canonical" when behind or diverged), **Continue this workspace** (what travels, detach, `cruce resume`, and that detaching does not revoke the old connection's Git access), overlap in a sentence, its changes, reported files, and checkout and storage actions (Release checkout, Delete fork with the reasons it is unavailable).
- **History** shows canonical promotions as a timeline, each with the approving human, the promoting human, the source workspace and owner, the previous canonical revision and passing evidence, published revisions, stored evidence and activity written as sentences. Records open with provenance, lineage, storage details and a read-only file and history browser at that exact revision; Browse files opens the current canonical revision.
- **Settings** holds the Connect an agent guide, the review policy (required checks, protected paths), access grants, rename, and the repository's IDs.

**Connect an agent** is a three-step guide with copyable commands: clone canonical, connect your tool (Claude Code, Codex or Cursor), and the sentence to give the tool. It states that Cruce does not run agents and that each workspace consumes a fork and storage operations.

**Namespace settings** show the Cloudflare account as a status card (Connected, label, account ID) with **Check connection**, which re-verifies the sealed token, and **Replace token**. Storage operations lists who may run each resource operation, with readable names.

Retired routes (`overview`, `code`, `work`, `artifacts`) resolve to Changes, Workspaces or History with history replacement, so saved links keep working. Deep links, Back, retries and late-response protection are preserved.

Layout breakpoints use the root container width, including reflow at 200% zoom and at 320px. Rows wrap their status pills on narrow screens; tabs stay visible. Creation forms use dialogs with focus containment. Reduced-motion preference disables animation and transitions.

## Verification

See [verification evidence](local-verification.md) for executed checks and their limits. The browser suite covers focused navigation, exact-revision authority, failed promotion retries, unavailable data, delayed responses, mobile focus, reduced motion, and screen captures at 1440, 1024 and 390px plus 200% CSS zoom. The fixture is isolated and cannot establish hosted publication/promotion verification.

## Public homepage

The logged-out page sells the idea before the mechanism, in three sections and a footer. It stays on warm paper with ink linework, uses colour only to tell workspace paths apart, and avoids feature grids, logos, testimonials and availability claims.

**Context first.** The hero, “Code is written in parallel now. The decision is still yours.”, places Cruce in three generations of software development: *written* (one author; Git and review suffice), *assisted* (one agent at a time; the pull request still fits) and *agentic* (many heterogeneous agents at once). Each generation is a small hand-drawn Git specimen with one plain sentence. In the third, overlapping strands from one intent pass through a dark Cruce band before canonical advances one promotion at a time. A single line states the shift in the human job: from writing every line to deciding what becomes canonical.

**How it works.** “Many paths. One history.” sits beside an animated Git graph. Three named workspaces (auth, billing, deps) branch from an explicitly labelled immutable baseline. Workspace names and exact revisions carry the hierarchy; Claude Code, Codex and Cursor appear only as italic “via … · local work” annotations. Seven selectable stages (Baseline, Work, Overlap, Review, Promote, Reconcile, Continue) show independent commits at different paces, an advisory shared path (“advisory · not a conflict”), a proposal approved by a human at one revision, canonical advancing to exactly that revision with a non-forced update, explicit `git merge` reconciliation that leaves the baseline fixed, a second promotion, and work that keeps going. Small revision tokens ride their own Git paths: the baseline into each workspace, approved revisions into canonical, accepted canonical into the reconciling workspace. Nothing moves between workspaces, and no motion represents agent messaging, scheduling or automatic acceptance. Lanes report their head and relation to canonical (“3 behind canonical”), computed from the example’s actual Git history. The boundary appears as three plain statements: runs no agents, replaces no Git, lands nothing without a human.

**What stays true.** Three plates: *Durable* (session, laptop, checkout and tool are not the workspace; the workspace keeps its baseline, pushed revision and provenance), *Exact* (a two-lane ledger in which the reviewed, approved and promoted revision is the same hash) and *Composable* (execution, Cruce coordination and Git as strata; there is no `cruce push`; canonical lives in Cloudflare Artifacts). The footer says Cruce is in early development and built toward open source.

Motion is explanation, not decoration. The story waits until it is visible, pauses when hidden or offscreen, plays once and offers Replay. Paths draw with native SVG animations that hold their painted frame when paused. The generations draw on load and the plates draw once as they scroll in. Reduced motion starts everything static. Stage notes share one grid cell, so the tallest reserves the space and the controls never shift. Revision-bound text equivalents describe each stage for assistive technology, and the ledger has a text alternative. Below 720px a smaller graph shows two workspaces and names the third in text. Breakpoints use the root container width, supporting 320px screens and 200% zoom.

The page uses presentation-only example data and requests no private repository data or provider resources. Sign in preserves repository and invitation destinations through the existing login route. The page keeps its paper palette and Inter type even when the console uses Midnight. The page introduces a product under development. It is not a live repository inspector or proof of hosted availability, and it does not claim automatic push observation or upstream forge integration.

## Hardening interaction rules

Clone, Attach local checkout and Connect an agent share one setup guide. Each header action opens its corresponding method, and Settings links to that guide. Clone includes Git authorization and its credential helper. Existing-checkout setup preserves files, branch and remotes, adds a separate fork remote, and discloses resource consumption. The guide never launches an agent or uploads history.

Review leads with the next controller-derived blocker. Completed checks collapse into expandable details. Effective review/evidence IDs determine attribution; earlier superseded decisions remain in the timeline. Authorized reviewers can raise a concern after approval, and evidence authors can record updated outcomes for the same revision. Confirmation remains a human attestation rather than a Cruce-executed check. File modes, symlink conversions and submodule pointers remain visible even without a textual diff.

Authorization denial clears the scoped private view and controls. Transient refresh failures retain explicitly dated data. Identity loading has a working retry. Polling never overlaps for a resource; forced refreshes and navigation reject stale responses. Partial repository reads preserve available summaries and label incomplete counts, with an explicit retry. Clipboard failures show a manual-copy alternative. Presence and report freshness have distinct wording; unknown report times never appear fresh.
