# Cruce visual identity and console

[Contributor guide](../CONTRIBUTING.md) · [Architecture](architecture.md) · [Local walkthrough](local-demo.md)

Cruce's interface describes independent work around exact source revisions. Repository work is the center of the console; the namespace home is a compact way into it. “Agent work. Shared direction.” remains the brand line. Product language stays Namespace, Repository, Workspace, published revision, evidence, review and promotion.

## Identity

The **interlaced junction** uses an apex and a returning strand, separated at their crossings. The geometry gives independent paths a common identity without erasing their origin. The apex offers a subtle salakot reference; it is not a literal hat or a cultural ornament. It does not describe a Git merge.

The [vector study](../public/brand/study.svg) records four directions: a direct junction, an abstract apex, the selected interlaced junction and a lettermark. The direct X loses provenance, the standalone apex is too literal, and the C/X forces the crossing into a letter. The selected mark keeps both crossing and separation legible at 16, 24 and 32px.

[Ink symbol](../public/brand/symbol-ink.svg) · [White symbol](../public/brand/symbol-white.svg) · [Lime symbol](../public/brand/symbol.svg) · [Wordmark](../public/brand/wordmark.svg) · [Reversed wordmark](../public/brand/wordmark-white.svg) · [Favicon](../public/favicon.svg)

Brand display name, tagline and application asset references live in `src/ui/brand.tsx`. When renaming, update that module and the editable SVG titles/wordmark text together with document titles. Standalone wordmarks embed the locally bundled Inter font, with its license retained in `public/brand/OFL.txt`; they require no third-party font request. The wordmark uses normal lettering while the symbol carries the topology.

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

## Topology semantics

- A workspace lane identifies one writer, including its immutable starting revision and reported head. It is a bounded relationship view, not a Git history reconstruction; its length does not encode time, commit count or completion.
- Circular endpoints mark revisions. A diamond labels retained source separately from the reported head. Publication proves retention, not correctness.
- Canonical has its own track, sourced only from `sourceHead`. Missing canonical state is unavailable; reported refs are never a fallback.
- A copper bracket identifies reported shared surfaces without joining the revision paths. The gutter shows the selected surface, or the first surface initially. The complete surface list remains visible; selecting one names its participating workspaces. Hover and keyboard focus highlight related information equally.
- Promotion continuation labels require a completed promotion record tied to the workspace's exact change revision. Approval and prepared/failed promotion cannot create one. These records describe past promotion, not a guarantee that the promoted revision remains the current canonical head.
- Disconnected writers remain present, with a dashed line and explicit state. Ended work remains available in Work. Read-only participants appear as observers rather than writer lanes.
- Overview displays six current writers in stable start-time/ID order. View all work exposes the full durable collection. Home miniatures display up to four active writers and three visible overlap brackets; adjacent counts always describe the complete summary. No relationships are invented between displayed workspaces.

Namespace summary topology is a minimal projection of already-authorized repository snapshots. It contains workspace IDs, modes and states, and overlap IDs/membership. It does not add source fetches, infrastructure operations or a second authority model. Snapshot permissions, readiness and cleanup decisions remain authoritative.

## Screens and interaction

The slim forest header uses a 56px content row with a smaller wordmark and inline repository search field. Avatar, scope controls and the unboxed mobile search icon retain 44px targets. Search uses a compact 300px desktop result panel and tighter result rows; the mobile panel uses a 40px input. It follows the current scope: Home, namespace, or namespace/repository. The Cruce mark returns to unscoped Home, where namespace cards provide the selection surface. Scoped names are anchored searchable dropdowns, with native links, arrow-key selection, normal Tab navigation, Escape dismissal and trigger restoration. Navigation does not require a modal or a second All namespaces action. Repository navigation remains Overview, Code, Work and Settings; namespace tabs appear only at namespace level, with Members/Teams limited to shared namespaces. Repository search accepts typing directly in the header, with namespace-labelled results underneath. Command/Ctrl K focuses this same field; arrows and Enter select a result, while Escape, Tab and outside clicks dismiss the results without trapping focus or changing the page. Loading, partial failures and retry stay in the result panel. On narrow screens the search icon reveals the field and results together in an anchored panel under the header.

The avatar opens a compact profile card: a forest cap carries the junction watermark, an initial tile anchors the name and email, and a pale action row contains Sign out while preserving the current page and URL. Namespace selection stays in Home and the scope dropdown; the identity menu does not duplicate namespace membership or introduce an account page. Saved account links open the menu on Home with history replacement. Authentication identity and namespace/repository authority remain separate. The Alpha label sits quietly in the footer; the header carries only navigation and identity.

Work separates Changes, Workspaces and Revision evidence. Deep links open focused change, workspace and evidence details. Change detail presents pinned source, controller readiness, diff/revision access, exact-revision evidence, reviews/concerns and the human decision area. Stored evidence is associated by workspace and exact revision, or an explicit revision-matched verification link; unrelated or stale reports do not appear on a change. Work also lists evidence stored before a change is proposed. Code lists Published revisions and provides focused provenance inspection plus read-only source, history and diff controls. Overview highlights the latest published source revision, independently of evidence publication. Source approval, attestation and explicit promotion remain distinct actions.

Layout breakpoints use the available root container width, including reflow at 200% zoom. At narrow widths the scoped names move to a second header row; anchored dropdowns stay within the viewport, including at 320px. Repository tabs stay visible. Explicit creation forms use dialogs with focus containment; search and scope navigation stay anchored to the header. At intermediate widths the decision queue follows topology; wider screens place them side by side. Forms, settings, empty states and identity menus use the same type, surface and control system.

Transitions run for 140–150ms. A changed observation receives one brief emphasis; mounting or polling unchanged state does not restart it. Reduced-motion preference disables animation and transitions. Every topology action has a normal keyboard-accessible button and a textual equivalent; SVG cues are supplemental.

## Verification

See [verification evidence](local-verification.md) for executed checks and their limits. The browser suite covers focused navigation, exact-revision authority, failed promotion retries, unavailable data, delayed responses, mobile focus, reduced motion, and screen captures at 1440, 1024 and 390px plus 200% CSS zoom. The fixture is isolated and cannot establish hosted publication/promotion verification.

## Public homepage

The early-development front door consists of the hero only: an oversized Inter statement on warm paper beside an explicitly illustrative repository diagram. The header contains the brand and one subdued Sign in text link, with a visible keyboard-focus outline and a generous touch target. A quiet footer says Coming soon and that Cruce is being developed toward open source. There is no How it works link, registration control, product walkthrough, workspace inspector or review demonstration.

The illustration presents the [coordination vision](product-thesis.md#the-coordination-loop) in five beats: independent work, shared awareness, agents aligning routine work, reviewed convergence and accepted changes feeding back to continuing writers. A copper advisory becomes an exchange between agents; independent work keeps moving. A small conditional side branch routes unresolved decisions to the developer, rather than putting human supervision on the routine path. The illustration is explicitly labeled as a vision. Accepted contributions each reach their own dot on canonical; its textual equivalents retain the current promotion authority requirements. It does not claim autonomous promotion, conflict prevention guarantees, live activity or verified client interoperability.

One deterministic `fernloop / payment-api` repository supplies presentation data using existing workspace contracts. Canonical stays at the original base during awareness and alignment. Claude Code, Codex and Cursor then contribute distinct accepted revisions in that example order, using nested return curves without crossings. Between promotions, continuing writers explicitly fetch, incorporate and verify accepted source before publishing a new head. The straight canonical line shows acceptance order without flattening Git ancestry. The workspace starting revision remains immutable; a later publication still requires fresh review. Presentation never requests repository data, provisions resources or exercises authority.

Native browser animation effects draw the SVG paths with easing and retain their painted frame on pause; CSS handles mobile motion and focus transitions. No animation framework is added. Small markers carry independent work forward, signals exchange context between affected agents, and a dashed return path carries the accepted update upstream. Five selectable chapters encompass nine timed moments. The active progress step replaces its short chapter label with the current moment’s title and a subdued detail line. Inactive steps retain their chapter labels; narrow layouts show only the active title. The caption stays beneath its dot, outside the work paths, and reserved label height prevents layout shifts. Only the latest accepted revision hash appears, beside its canonical dot. Subtle path dimming guides attention while labels remain readable, and all paths return to equal emphasis at the end. Each moving dot stops before its own workspace endpoint; one signal represents the advisory exchange. Fuller textual equivalents remain available to assistive technology. One quiet header text control switches between Pause, Play and Replay; it and the direct chapter controls remain ordinary keyboard-accessible buttons with touch targets. Pause freezes native motion and remaining stage time; offscreen and hidden-document motion pauses. Reduced motion starts static with immediate manual exploration. Below 720px the diagram becomes a vertical sequence, and root-container breakpoints preserve zoom reflow. Playback ends after one bounded cycle.

Sign in uses the existing login route and preserves saved repository and invitation destinations. Source and documentation URLs remain optional brand configuration; private destinations are not advertised. The authenticated console and its light theme are unchanged. The homepage is a product introduction during development, not evidence of hosted availability or verified tool interoperability.
