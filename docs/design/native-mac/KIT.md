# Native Mac kit — how to build a screen

For the six module agents. Read the spec (`docs/superpowers/specs/2026-09-18-native-mac-redesign.md`)
once, then build from this. `/dashboard` (`src/app/(app)/dashboard/page.tsx`) is the worked example of
everything below.

## 1. The page skeleton

The shell (sidebar, phone tab bar, More sheet, ⌘K search) is drawn by `(app)/layout.tsx`. A page draws
its **toolbar as its first child**, then its content. The document scrolls; the toolbar sticks.

```tsx
import { PageToolbar } from '@/components/shell/page-toolbar';
import { ToolbarGroup, ToolbarButton, ToolbarLink } from '@/components/ui/toolbar';

export default async function BillsPage() {
  return (
    <div className="flex flex-col gap-3.5 max-md:gap-3">
      <PageToolbar
        title="Bills"                                  // the page's one <h1>
        subtitle={<>12 · <Money cents={-450000} currency plain /></>}  // optional quiet figure
        info="Bills you owe. Paying one posts…"        // the page's explanation → ⓘ popover
        back={{ href: '/purchases', label: 'Purchases' }}              // nested pages only
        search={<SearchField appearance="toolbar" name="q" />}         // page search, optional
        actions={
          <>
            <ToolbarGroup>
              <ToolbarLink href="/purchases/bills/new" glyph="plus" label="New bill" shortcut="⌘N" />
            </ToolbarGroup>
            <ToolbarGroup>
              <ToolbarButton glyph="export" label="Export CSV" onClick={…} />
            </ToolbarGroup>
          </>
        }
      />
      {/* content: cards, inset groups, a SplitView */}
    </div>
  );
}
```

Rules:
- `PageToolbar` adds the sidebar toggle (tablet / hidden sidebar), the search button (below 1024px) and
  the appearance menu itself. Do not add them.
- Group toolbar actions the way Mail does: one `ToolbarGroup` per kind of action (create · file · state),
  two to four buttons each. Icon-only by default (`label` is the tooltip and the accessible name);
  `showLabel` for a text-and-icon item. Destructive: `tone="danger"`.
- Only when a page cannot be icon-only (a long form's Save), put a `<Button>` in `actions`.
- `PageHeader` still works (it renders `PageToolbar`; `description` → ⓘ, `meta` → subtitle,
  `breadcrumbs` → before the title, `tabs` → under the toolbar). New code uses `PageToolbar`.
- Page content spacing: `gap-3.5` between blocks (12px on phone). The shell supplies the 20px/16px side
  gutters — never add page-level horizontal padding.

### List + detail (master/detail)

```tsx
import { SplitView, DetailPane, DetailMeta } from '@/components/ui/detail-pane';
import { InsetGroup, ListRow, GroupRow } from '@/components/ui/inset-group';

<SplitView
  list={
    <InsetGroup variant="plain" header="September" separatorInset={57}>
      {rows.map((r) => (
        <ListRow key={r.id} href={`?id=${r.id}`} selected={r.id === selectedId}
          leading={<Monogram name={r.payee} />}
          title={r.payee}
          subtitle={<><Dot tint={cat.tint} size={7} />{cat.label}</>}
          trailing={<Money cents={r.amountCents} currency plain signed />}
          detail={shortDate(r.date)} />
      ))}
    </InsetGroup>
  }
  detail={
    <DetailPane
      leading={<Monogram name="Amazon" size="lg" />}
      title="Amazon"
      meta={['Aug 29, 2026', <><Glyph name="bank" size={14} />Relay ••9726</>]}
      amount={<Money cents={-2607} currency plain />}
      status={<Pill tone="orange" glyph="flag">Mixed use</Pill>}
      actions={<><Button>Accept <Kbd>⏎</Kbd></Button><Button variant="secondary">Personal</Button></>}
      footer={<KeyLegend items={[{ keys: '↑↓', label: 'Move' }, { keys: '⏎', label: 'Accept' }]} />}
    >
      <InsetGroup>
        <GroupRow label="Account"><PopUpButton aria-label="Account" options={…} value={…} /></GroupRow>
        <GroupRow label="Same account" href="…">47 more · $786.57</GroupRow>
      </InsetGroup>
      <Card className="px-5 py-[18px]"><FlowDiagram from={…} to={[…]} /></Card>
    </DetailPane>
  }
/>
```

`SplitView` shows the detail only from 1024px (sticky under the toolbar). Below that, show the same
`DetailPane` in a `<Sheet>` (or a page) when a row is chosen.

## 2. Components (`src/components/ui`)

| Need | Use |
| --- | --- |
| Icon | `<Glyph name="tray" size={16} />` — names in `src/lib/ui/glyphs.ts`; no lucide in new code, no emoji |
| Coloured System-Settings badge | `<IconBadge glyph="bank" tint="green" size="md" />` (sm 20 · md 22 · lg 28 · xl 36) · `<CategoryBadge category={c} />` |
| Colour dot / legend | `<Dot tint="teal" />` · `<LegendItem tint="red">Spend</LegendItem>` |
| Initials | `<Monogram name="Lab Alley" />` (md 36, lg 56) |
| Card surface | `<Card>` + `CardHeader` / `CardTitle` / `CardContent` (16px radius, 22 on phone, no borders) |
| Grouped rows | `<InsetGroup header="August">` with `<ListRow>` (lists) or `<GroupRow label>` (facts, forms) |
| Explanation | `<InfoButton label="About runway">…sentences…</InfoButton>` — the only home for sentences |
| One of 2–5 views | `<SegmentedControl aria-label options value onValueChange />`; URL-driven: `<SegmentedNav items current />` |
| One of many (a value) | `<PopUpButton aria-label options value onValueChange />` (bezel in rows; `appearance="toolbar"` in a toolbar group); in a form `Select`/`SelectTrigger` |
| Toolbar | `ToolbarGroup`, `ToolbarButton`, `ToolbarLink` |
| Search | `<SearchField name="q" />` (grey, list headers) · `appearance="toolbar"` (glass capsule) |
| Status | `<Pill tone="orange" glyph="flag">Mixed use</Pill>` (capsule) · `<Badge tone="warning">Draft</Badge>` (rounded square tag) |
| Shortcut | `<Kbd>E</Kbd>` · `<KeyLegend items />` footer on keyboard-driven screens (hidden on phone) |
| Empty | `<EmptyState glyph="tray" title="Nothing to review" action={<Button>Import</Button>} />` — ≤6 words; `description` goes behind an ⓘ |
| Short create/edit form, row detail on phone | `<Sheet><SheetTrigger/><SheetContent title="New vendor">…</SheetContent></Sheet>` (right panel on desktop, bottom sheet on phone) |
| Confirmation that moves money | `<Dialog>` with `DialogTitle` + a plain `DialogDescription` of what will happen, `danger` button when it reverses/excludes |
| KPI | `<StatTile label badge={<IconBadge…/>} hint="Equity" value={<Money…/>} sparkline={<Sparkbars…/>} />` |
| Tables / reports | `<DataTable>` (Numbers-style: hairline rows, sticky header, `meta.align: 'right'` for money) |
| Money | always `<Money cents currency plain? signed? whole? />`; `plain` unless the sign colour is the point |

Buttons: `<Button>` default is the one blue button per view; `secondary` (white bezel), `ghost`, `danger`,
`danger-quiet`, `link`. Sizes grow to 44px on a phone automatically.

## 3. Tokens (Tailwind classes)

Surfaces `bg-bg` (page) · `bg-card` · `bg-inset` (grey well inside a card) · `bg-fill` / `bg-fill2` (control
tints) · `bg-ctl` (bezel). Text `text-label` · `text-label2` (secondary; the lowest text tier — `label3` is
for glyphs and rules only). Tints `bg-tint-{blue,green,red,orange,indigo,teal,purple,pink,brown,cyan,mint,gray}`
(glyphs, bars, dots — **not text**). Text in colour: `text-ink-{green,red,orange,blue}` (4.5:1 safe).
Filled accent: `bg-accent-fill`; destructive fill: `bg-danger-fill`. Material: `vibrancy` (glass),
`vibrancy-bar` (toolbar), `shadow-card`, `shadow-glass`, `shadow-ctl`. Hairlines: `hairline-t/-b/-l/-r`,
`border-sep`. Figures: `num` (tabular; body already defaults to tabular).

Type (Tailwind names): `text-2xs` 11 · `xs` 12 · `sm` 13 (body) · `lg` 15 (headline) · `xl` 20 ·
`2xl` 22 (toolbar title) · `3xl` 28 (tile figure) · `4xl` 34 (phone large title) · `5xl` 44 (hero).
Weights: 500 labels, 600 headlines/values, 700 titles and figures; tighten large text
(`tracking-[-0.022em]`). Radii: controls `rounded-[7px]`–`[9px]`, cards `rounded-2xl`, capsules `rounded-full`.

Legacy names (`bg-surface`, `text-muted-foreground`, `text-negative`, `rule-row`, `eyebrow`…) map onto
the new values so old screens render; don't use them in new code.

## 4. Categories (`src/lib/ui/categories.ts`)

Every account has one category → one tint and one glyph, everywhere.

```ts
import { categoryFor, categoryForCode } from '@/lib/ui/categories';
const c = categoryFor({ code: a.code, subtype: a.subtype, parentCode: a.parentCode, type: a.type });
// c = { key: 'office', label: 'Office Supplies', tint: 'blue', glyph: 'paperclip' }
categoryForCode('1320'); // when you only have the code: { label: 'Raw Ingredients', tint: 'teal', … }
```

Use `c.tint` for dots, bars and legends, `<CategoryBadge category={c} />` for badges and flow-diagram
ends, `c.label` when grouping by category (the account's own name stays the row title). `tintVar(tint)`
from `src/lib/ui/tints.ts` gives `var(--teal)` for SVG and inline styles.

## 5. Charts (`src/components/charts`)

All SVG, server-renderable, light/dark, each with a title and the numbers in a `<desc>`/label for
screen readers. Fixed-viewBox charts get one drawing per width via `<Responsive desktop phone />`.

```tsx
import { CashLine, RunwayRing, DivergingBars, CategoryBars, Sparkbars, SplitBar, FlowDiagram, Responsive } from '@/components/charts';

<Responsive
  desktop={<CashLine points={[{ date: '2026-01-31', cents: 80880 }, …, { date: today, cents }]} cashOutDate="2026-09-29" />}
  phone={<CashLine points={…} cashOutDate={…} width={342} height={150} compact />}
/>
<RunwayRing days={11} />                      // size 172 card / 96 widget; tint by runwayTint(days)
<DivergingBars columns={[{ label: 'Jan', name: 'January 2026', up: { founder, sales }, down: { spend } }]}
  upSeries={[{ key: 'founder', label: 'Founder', tint: 'indigo' }, …]} downSeries={[…]} />  // $0 + even steps
<CategoryBars rows={[{ key, label, tint, cents, count, href }]} />     // ranked list = the chart
<Sparkbars values={[…cents by month]} tint="indigo" label="Founder money in by month" format={dollars} />
<SplitBar label="Ingredients $3,265.48, packaging $432.14" segments={[{ label, value, tint }]} />
<FlowDiagram from={{ label: 'Relay ••9726', glyph: 'bank', tint: 'green' }}
  to={[{ label: 'Office Supplies', glyph: 'paperclip', tint: 'blue', cents: 2607 }]} />   // on a card
```

`FlowDiagram` is the preview wherever one entry is shown before it posts (review, journal entry,
invoice, bill, payout, deduction). Several `to` targets draw a split. Each report opens with one small
chart (P&L: `DivergingBars` revenue vs expense; Balance Sheet: `SplitBar`s; Cash Flow: bars).

Axis/legend labels: `axisMoney`, `shortDate`, `monthShort`, `dollars` in `src/lib/ui/format.ts` (integer
arithmetic, 'YYYY-MM-DD' strings). Ticks: `evenTicks` / `divergingTicks` in `src/lib/ui/scale.ts`.

## 6. Words

- Labels, headers, buttons: one or two words. Sentence case. No colons, no "Please".
- No paragraph on screen. Anything explanatory goes in `info` (toolbar) or an `<InfoButton>`.
- Empty states: glyph + ≤6 words + one button.
- Exception: a confirmation that posts, reverses, excludes or closes money says plainly what will
  happen (`DialogDescription`), e.g. "Posts $26.07 from Relay ••9726 to Office Supplies. Posted entries
  can only be reversed."
- Numbers speak first: a shape, then the figure, then a word.

## 7. Phone

Below 768px: the toolbar becomes a 34pt large title with round action buttons; lists become inset
groups with 16px text; rows are ≥44px; the tab bar (Home · Review · Reports · More) is drawn by the
shell — leave `pb` alone. Detail opens in a `<Sheet>`; long documents stay pages. Test at 390px.

## 8. Verify

```
DATABASE_URL='postgres://sooz_app:sooz-e2e-local@127.0.0.1:54331/sooz_design' DB_POOL_MAX=3 \
  NEXT_DIST_DIR=.next/<label> npx next dev -p <port>
npx tsx scripts/shoot.ts http://localhost:<port> /your/route --mobile --dark --out /tmp/shots-<label>
```

Open every PNG. Compare with `docs/design/native-mac/shots/` and `/dashboard`.
