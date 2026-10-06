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

| Token | Value | Use |
| --- | --- | --- |
| Forest | `#17251F` | Header, primary text and decisive actions |
| Paper | `#F5F5EF` | Main canvas |
| White | `#FFFFFF` | Working surfaces and inputs |
| Lime | `#B5E86A` | Brand and selection against forest |
| Moss | `#879D7B` | Nonessential decorative palette; never body text on paper |
| Green | `#346345` | Links, retained source and positive state labels |
| Copper | `#8A5128` | Advisory intersections and human attention |
| Muted text | `#5C695F` | Supporting copy and metadata |
| Error | `#A12F34` | Failures and errors |

The main text, muted text, green and copper achieve contrast ratios of approximately 14.5, 5.3, 6.4 and 5.8 against paper. Input borders use `#7B8976` (approximately 3.4 against paper). Light dividers separate groups without carrying state. Color always accompanies text or shape.

Inter supplies headings and interface copy; JetBrains Mono identifies exact revisions, branches and paths. The scale uses 4px spacing increments, 6–8px corners, thin separators and minimal shadows. Page hierarchy comes from typography and space rather than nested cards. Repository names and paths wrap; code panes scroll internally.

## Status language

The console states facts in plain words, derived from controller decisions in [src/ui/status.ts](../src/ui/status.ts). Wording never grants authority; readiness, permissions and cleanup eligibility come from the controller snapshot.

| Thing | States shown | Meaning |
| --- | --- | --- |
| Change | Needs review, Has concerns, Ready to promote, Stale, Superseded by #n, Promotion in progress, Promoted, Closed | Stale: canonical moved past the change's pinned base. Superseded: its workspace proposed a newer change |
| Workspace | Active, Not reporting, Detached, Setting up, Completed, Cancelled | Not reporting is presence only; ownership and the attachment remain |
| Canonical relation | Up to date, Behind canonical, Canonical unavailable | Computed from accepted canonical source, never from reported heads |
| Overlap | "Shares path with workspace" | Advisory. Shared files are a heads-up, not a conflict |

Tool names are shown as the tool ("Codex", "Claude Code"), derived from the OAuth client label. A continued workspace reads "Started in Claude Code · continued in Codex". Labels are provenance, not identity. Status pills always carry text; colour supports them but never stands alone.

## Screens and interaction

The slim forest header uses a 56px content row with a smaller wordmark and inline repository search field. Avatar, scope controls and the unboxed mobile search icon retain 44px targets. Search follows the current scope (Home, namespace, or namespace and repository). The Cruce mark returns to unscoped Home. Scoped names are anchored searchable dropdowns, with native links, arrow-key selection, normal Tab navigation, Escape dismissal and trigger restoration. Repository search accepts typing directly in the header, and Command/Ctrl K focuses the same field; arrows and Enter select a result, while Escape, Tab and outside clicks dismiss the results without trapping focus. Loading, partial failures and retry stay in the result panel. On narrow screens the search icon reveals the field and results together in an anchored panel.

The avatar opens a compact profile card with name, email and Sign out, preserving the current page. Saved account links open it on Home with history replacement. The Alpha label sits quietly in the footer.

**Home** lists your repositories across namespaces, sorted by what needs a person (changes to review or promote, stale changes, workspaces behind canonical), then your namespaces. A namespace whose installation storage is unavailable says so, without asking users for provider credentials.

**A repository** opens on a header (name, canonical branch and revision, last promotion, Connect an agent, Clone) and an attention bar: one plain sentence per thing that needs someone, each linking to where it is handled, or "Nothing needs you right now". Four tabs follow:

- **Changes** lists changes that need attention first. Stale or superseded changes, and promoted or closed ones, are collapsed below. A change opens as a review: header, then one checklist (built on current canonical; each policy-required check, which a maintainer confirms in one click; concerns needing a resolution; approval of this exact revision), then **Promote to *branch***, which explains exactly which revisions it moves between. Approval and confirmation are single clicks with an optional note; raising a concern, recording a failure, resolving and closing ask for a reason. The diff loads straight away with the first file open, followed by evidence and reviews.
- **Workspaces** lists live workspaces with their state, canonical relation, overlaps and latest change; ended ones are collapsed. A workspace page shows its fixed baseline, reported head, canonical relation (with "See what changed on canonical" when behind), overlap in a sentence, its changes, reported files, and checkout and storage actions (Release checkout, Delete fork with the reasons it is unavailable).
- **History** shows canonical promotions as a timeline, published revisions, stored evidence and activity written as sentences. Records open with provenance, lineage, storage details and a read-only file and history browser at that exact revision; Browse files opens the current canonical revision.
- **Settings** holds the Connect an agent guide, the review policy (required checks, protected paths), access grants, rename, and the repository's IDs.

**Connect an agent** is a three-step guide with copyable commands: clone canonical, connect your tool (Claude Code, Codex or Cursor), and the sentence to give the tool. It states that Cruce does not run agents and that each workspace consumes a fork and budget operations.

**Namespace settings** show the Cloudflare account as a status card (Connected, label, account ID) with **Check connection**, which re-verifies the sealed token, and **Replace token**. The daily operation budget shows today's usage against the limit and when it resets, and policy rules use readable names.

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

The page uses presentation-only example data and requests no private repository data or provider resources. Sign in preserves repository and invitation destinations through the existing login route. The authenticated console and its light theme are unchanged; no dark theme exists today. The page introduces a product under development. It is not a live repository inspector or proof of hosted availability, and it does not claim automatic push observation or upstream forge integration.
