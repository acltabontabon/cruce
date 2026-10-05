# Cruce visual identity and console

[Contributor guide](../CONTRIBUTING.md) · [Architecture](architecture.md) · [Local walkthrough](local-demo.md)

Cruce's interface describes independent work around exact source revisions. Repository work is the center of the console; the namespace home is a compact way into it. “Agent work. Shared direction.” remains the brand line. Product language stays Namespace, Repository, Workspace, revision, artifact, review and promotion.

## Identity

The **interlaced junction** uses an apex and a returning strand, separated at their crossings. The geometry gives independent paths a common identity without erasing their origin. The apex offers a subtle salakot reference; it is not a literal hat or a cultural ornament. It does not describe a Git merge.

The [vector study](../public/brand/study.svg) records four directions: a direct junction, an abstract apex, the selected interlaced junction and a lettermark. The direct X loses provenance, the standalone apex is too literal, and the C/X forces the crossing into a letter. The selected mark keeps both crossing and separation legible at 16, 24 and 32px.

[Ink symbol](../public/brand/symbol-ink.svg) · [White symbol](../public/brand/symbol-white.svg) · [Lime symbol](../public/brand/symbol.svg) · [Wordmark](../public/brand/wordmark.svg) · [Reversed wordmark](../public/brand/wordmark-white.svg) · [Favicon](../public/favicon.svg)

Brand display name, tagline and application asset references live in `src/ui/brand.tsx`. When renaming, update that module and the editable SVG titles/wordmark text together with document titles. Standalone wordmarks embed the locally bundled Inter font, with its license retained in `public/brand/OFL.txt`; they require no third-party font request. The wordmark uses normal lettering while the symbol carries the topology.

## Materials and hierarchy

| Token | Value | Use |
| --- | --- | --- |
| Forest | `#17251F` | Sidebar, primary text and decisive actions |
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

Desktop keeps namespace/repository selection grouped in the forest sidebar. Repository navigation remains Overview, Code, Work, Artifacts and Settings. Namespace Members/Teams are shared-namespace controls; account settings remain separate. The repository finder retains Command/Ctrl K and keyboard selection.

Work separates Changes and Workspaces. Their existing deep links open focused details. Change detail presents pinned source, controller readiness, diff/artifact access, exact-revision evidence, reviews/concerns and the human decision area. Source approval, attestation and explicit promotion remain distinct actions. Artifacts separates the collection from focused provenance inspection; Code remains a read-only inspector.

Layout breakpoints use the available root container width, including reflow at 200% zoom. At narrow widths the sidebar becomes a modal navigation drawer with focus containment, Escape dismissal and trigger restoration. Repository tabs stay visible. At intermediate widths the decision queue follows topology; wider screens place them side by side. Forms, settings, empty states and account views use the same type, surface and control system.

Transitions run for 140–150ms. A changed observation receives one brief emphasis; mounting or polling unchanged state does not restart it. Reduced-motion preference disables animation and transitions. Every topology action has a normal keyboard-accessible button and a textual equivalent; SVG cues are supplemental.

## Verification

See [verification evidence](local-verification.md) for executed checks and their limits. The browser suite covers focused navigation, exact-revision authority, failed promotion retries, unavailable data, delayed responses, mobile focus, reduced motion, and screen captures at 1440, 1024 and 390px plus 200% CSS zoom. The fixture is isolated and cannot establish hosted publication/promotion verification.
