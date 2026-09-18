# Native Mac redesign — design spec

**Date:** 2026-09-18 · **Status:** approved by the owner (direction A, "Native Mac", chosen from three)

## Brief

"More beautiful. More graphic-centric, fewer words, intuitive, minimalistic. An Apple-native feeling."
The owner compared three high-fidelity directions on the real books and chose **A · Native Mac**, including
its two signature graphics: the **cash-out projection** and the **entry flow diagram**.

**Reference, the source of truth for look and feel:** `docs/design/native-mac/mockup.html` (open it; it toggles
Dashboard/Review and light/dark) and its renders in `docs/design/native-mac/shots/`.

This is a visual and UX redesign. Data, server actions, capabilities, accounting behaviour and URLs do not change.

## Principles

1. **Graphics carry the meaning.** Every summary is a shape first (ring, line, bar, flow), a number second, a word
   last. A page you can understand without reading is the bar.
2. **One or two words per label.** No explanatory sentences on screen. Explanations move into an ⓘ info button
   that opens a popover. The single exception: confirmations that move or reverse money state plainly what will
   happen, because a bookkeeping mistake costs more than a sentence.
3. **Progressive disclosure.** Lists show the minimum; detail lives in a detail pane (desktop) or a pushed view /
   sheet (phone); rarely used actions live in the toolbar or a ⋯ menu, not on every row.
4. **Native controls.** Sidebar, unified toolbar, segmented controls, pop-up buttons, search fields, inset grouped
   lists, sheets and popovers that look and behave like AppKit/UIKit.
5. **Colour means something.** System semantic colours only. Green money in, red money out, only where direction
   is the point. Each account category owns one colour and one glyph everywhere (see Category system).
6. **Light and dark are equal.** Follow the system; a toggle in the toolbar overrides it.

## Visual system

Extract exact values from the mockup into `src/app/globals.css` as semantic CSS variables. Replace the
current warm-paper/plum tokens entirely.

- **Type:** `-apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display", "Inter", system-ui, sans-serif`.
  Large Title 26–34 bold with tight tracking · Title 20–22 semibold · Headline 13–15 semibold · Body 13–15 ·
  Caption 11–12 secondary. Every number uses tabular figures.
- **Colour:** systemBlue accent; systemGreen, Red, Orange, Indigo, Purple, Teal, Cyan, Mint, Pink, Brown,
  Gray with light and dark variants; label / secondaryLabel / tertiaryLabel; separator (hairline, 0.5px on
  retina); grouped background vs card background.
- **Shape:** cards 12–14px radius, controls 6–8px, badges as rounded squares; restrained two-layer shadows;
  vibrancy (backdrop-filter) on the sidebar, toolbar, sheets and popovers.
- **Motion:** 150–250ms ease-out; respect `prefers-reduced-motion`.

## Shell

**Desktop (≥1024px).** A translucent sidebar with System-Settings-style coloured rounded-square icon badges:

- Home · **Review** (count badge)
- *Banking:* Accounts · Rules
- *Business:* Sales · Purchases · Channels · Trade · Inventory
- *Books:* Ledger · Reports · Close · Plan
- footer: Settings, and the company

A unified toolbar carries the page's large title on the left and the page's actions and search on the right.
Import and Reconcile live in the Accounts toolbar. No breadcrumbs row; the sidebar selection says where you are.

**Phone (<768px).** An iOS app: large title, inset grouped content, and a bottom **tab bar** with
Home · Review (badge) · Reports · More, where More is a grouped list of every other section. No fake status bar.

**Tablet (768–1023px).** A collapsible sidebar over the content.

URLs stay the same: Home is `/dashboard`, Review is `/banking/review`, Accounts is `/banking`. Only labels,
grouping and visibility change. Module nav files (`src/components/shell/modules/*.ts`) keep their role.

## Category system

`src/lib/ui/categories.ts` maps every postable account to a category with **one colour and one glyph**, derived
from the account's subtype and parent, never hand-assigned per page:
Raw Ingredients teal · Packaging brown · Formulation purple · Office & Supplies blue · Meals orange ·
Creative pink · Advertising indigo · Freight cyan · Software gray · Fees gray · Revenue green ·
Founder/Equity indigo · Inventory teal · Cash blue. Every chart legend, list dot, review row, pop-up button
and report row uses it, so a colour means the same thing on every screen.

## Signature graphics

- **Cash line with cash-out projection:** balance over time; past solid with a soft fill; "Today" marker; a
  dotted projection at the trailing burn rate down to $0 on the cash-out date, labelled with that date.
- **Runway ring:** days of cash; the ring shortens as runway falls; the colour moves green → orange → red.
- **Entry flow diagram:** in the review detail, `[bank glyph] Relay ··9726 —— $26.07 ——▶ [category glyph] Office
  Supplies`, labelled with plain "Credit" and "Debit" captions. It shows what posting will do. Use the same diagram
  wherever one entry is previewed before posting (journal entry, invoice, bill, payout, deduction).
- **Diverging in/out bars, category bars, sparkbars** as in the mockup.

## Patterns

- **Lists:** inset grouped rows: leading glyph or monogram, title plus one secondary line, trailing amount in
  tabular figures and a quiet date. Section headers by month. No zebra.
- **Detail pane / sheet:** the selected item's key facts as a grouped form (label left, value right), the flow
  diagram, then one primary button plus at most one secondary. Everything else goes in the toolbar.
- **Toolbar actions:** icon buttons in logical groups (Mail-style), tooltips giving the name and shortcut.
- **Forms:** System-Settings style grouped rows. Create and edit open as a sheet where the form is short; long
  documents (invoice, bill, journal entry) keep a page, laid out like Numbers.
- **Tables and reports:** Numbers-like. Hairline rows, sticky header, right-aligned tabular numbers, bold
  section totals, indentation instead of borders. Each report opens with one small chart that summarises it
  (P&L: revenue vs expense by month; Balance Sheet: assets vs liabilities + equity; Cash Flow: waterfall).
- **Empty states:** a large glyph, at most six words, one button.
- **Keyboard:** a key legend in the footer on screens that are keyboard-driven (Review), shortcuts in tooltips
  elsewhere.

## Known issues from the design critique, to fix in the build

- The phone "In & out" axis shows $3K / $1K / −$1K / −$3K. Include $0 and use even steps.
- The review detail toolbar is one run of seven icons. Group them the way Mail does.
- The desktop "In & out" chart is taller than its data needs.

## Non-negotiables carried over

Money through `<Money/>` and tabular figures · no behaviour or data changes · capability checks unchanged ·
real `<button>`/`<a>`/`<label>` elements, visible focus rings, 44px touch targets on phone · text contrast
4.5:1 in both appearances · every route verified at 1440px and 390px in light and dark with `scripts/shoot.ts`
against the local replica (`scripts/design-replica.ts`) · unit and end-to-end suites stay green.
