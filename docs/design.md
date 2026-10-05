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

The early-development front door consists of the hero only: an oversized Inter statement on warm paper beside an explicitly illustrative repository diagram. The header contains the brand and one subdued Sign in text link, with a visible keyboard-focus outline and a generous touch target. A quiet footer says Coming soon and that Cruce is being developed toward open source. There is no How it works link, registration control, product walkthrough, workspace inspector or review demonstration.

The illustration presents the product in five chapters: independent work in durable workspaces, advisory awareness of shared paths, human review of one exact revision, sequential convergence as canonical moves and continuing workspaces reconcile, and common ground. A copper bracket marks a shared path while independent work keeps moving. A short dashed copper branch leads from Claude Code's exact revision to a circled check labelled human review; nothing passes between agents. The illustration is explicitly labelled as illustrative. Accepted contributions each reach their own dot on canonical, and its textual equivalents keep the promotion authority requirements. It does not claim agent messaging, autonomous promotion, conflict prevention, live activity or verified client interoperability.

One deterministic `fernloop / payment-api` repository supplies presentation data using existing workspace contracts. Canonical stays at the original base during awareness and review. Claude Code, Codex and Cursor then contribute distinct accepted revisions in that example order, using nested return curves without crossings. Between promotions, continuing writers explicitly fetch, incorporate and verify accepted source before publishing a new head. The straight canonical line shows acceptance order without flattening Git ancestry. The workspace starting revision remains immutable; a later publication still requires fresh review. Presentation never requests repository data, provisions resources or exercises authority.

Native browser animation effects draw the SVG paths with easing and retain their painted frame on pause; CSS handles mobile motion and focus transitions. No animation framework is added. Small markers carry independent work forward and a dashed return path carries the accepted update to continuing workspaces. Five selectable chapters encompass nine timed moments. The active progress step replaces its short chapter label with the current moment’s title and a subdued detail line. Inactive steps retain their chapter labels; narrow layouts show only the active title. The caption stays beneath its dot, outside the work paths, and reserved label height prevents layout shifts. Only the latest accepted revision hash appears, beside its canonical dot. Subtle path dimming guides attention while labels remain readable, and all paths return to equal emphasis at the end. Each moving dot stops before its own workspace endpoint. Fuller textual equivalents remain available to assistive technology. One quiet header text control switches between Pause, Play and Replay; it and the direct chapter controls remain ordinary keyboard-accessible buttons with touch targets. Pause freezes native motion and remaining stage time; offscreen and hidden-document motion pauses. Reduced motion starts static with immediate manual exploration. Below 720px the diagram becomes a vertical sequence, and root-container breakpoints preserve zoom reflow. Playback ends after one bounded cycle.

Sign in uses the existing login route and preserves saved repository and invitation destinations. Source and documentation URLs remain optional brand configuration; private destinations are not advertised. The authenticated console and its light theme are unchanged. The homepage is a product introduction during development, not evidence of hosted availability or verified tool interoperability.
