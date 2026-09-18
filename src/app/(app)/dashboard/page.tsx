import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";

import {
  CashLine,
  CategoryBars,
  DivergingBars,
  Responsive,
  RunwayRing,
  Sparkbars,
  SplitBar,
  runwayTint,
} from "@/components/charts";
import type {
  CategoryBarRow,
  DivergingColumn,
  DivergingSeries,
} from "@/components/charts";
import { PageToolbar } from "@/components/shell/page-toolbar";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Glyph } from "@/components/ui/glyph";
import { Dot, IconBadge, LegendItem } from "@/components/ui/icon-badge";
import { InfoButton } from "@/components/ui/info-button";
import { InsetGroup } from "@/components/ui/inset-group";
import { Money } from "@/components/ui/money";
import { ToolbarGroup, ToolbarLink } from "@/components/ui/toolbar";
import { can } from "@/lib/auth/roles";
import { requireUser } from "@/lib/auth/session";
import { queueCounts } from "@/lib/banking/queue";
import { cn } from "@/lib/cn";
import { categoryForCode, type CategoryKey } from "@/lib/ui/categories";
import {
  dollars,
  monthInitial,
  monthLong,
  monthShort,
  shortDate,
} from "@/lib/ui/format";
import type { GlyphName } from "@/lib/ui/glyphs";
import type { Tint } from "@/lib/ui/tints";

import {
  bankRows,
  cashSeries,
  founderContributions,
  inventoryCapitalized,
  monthlyFlows,
  reviewQueue,
  runwayForecast,
  squareClearing,
} from "./queries";

export const metadata: Metadata = {
  title: "Home",
};

export const dynamic = "force-dynamic";

/** "Relay — Operating Expenses" → "Operating Expenses": the bank is in the glyph, the mask beside it. */
function accountName(name: string): string {
  return name.replace(/^[^—]*—\s*/, "").replace(/\s*••\d+$/, "") || name;
}

const IN_OUT_UP: DivergingSeries[] = [
  { key: "founder", label: "Founder", tint: "indigo" },
  { key: "sales", label: "Sales", tint: "green" },
];
const IN_OUT_DOWN: DivergingSeries[] = [
  { key: "spend", label: "Spend", tint: "red" },
];

/**
 * Home: the owner's first screen, as the approved mockup draws it. Cash over time with the cash-out
 * projection, the runway ring, four KPI tiles, money in and out by month, and what is waiting in
 * review by category. Every figure is a query; explanations live behind the ⓘ buttons.
 */
export default async function HomePage() {
  const user = await requireUser("/dashboard");
  // Sequential on purpose: the connection pool this app shares is small.
  const banks = await bankRows();
  const queue = await reviewQueue();
  const counts = await queueCounts();
  const forecast = await runwayForecast();
  const founder = await founderContributions();
  const inventory = await inventoryCapitalized();
  const square = await squareClearing();
  const series = await cashSeries(forecast.asOf);
  const flows = await monthlyFlows(forecast.asOf);

  const actions = (
    <ToolbarGroup>
      {can(user.role, "bank.import") ? (
        <ToolbarLink
          href="/banking/import"
          glyph="import"
          label="Import statement"
        />
      ) : null}
      {can(user.role, "ledger.post") ? (
        <ToolbarLink href="/ledger/new" glyph="plus" label="New entry" />
      ) : null}
    </ToolbarGroup>
  );
  const hasActions =
    can(user.role, "bank.import") || can(user.role, "ledger.post");

  if (banks.length === 0) {
    return (
      <div className="flex flex-col gap-3.5">
        <PageToolbar title="Home" actions={hasActions ? actions : undefined} />
        <EmptyState
          glyph="bank"
          title="No bank accounts yet"
          action={
            can(user.role, "bank.import") ? (
              <Button asChild>
                <Link href="/banking/import">Import</Link>
              </Button>
            ) : undefined
          }
        />
      </div>
    );
  }

  const lines = new Map(banks.map((b) => [b.bankAccountId, b.lineCount]));
  const accounts = forecast.opening.accounts.filter(
    (a) => a.cashCents !== 0 || (lines.get(a.bankAccountId) ?? 0) > 0,
  );
  const cash = forecast.opening.cashCents;
  const burn = forecast.burn;
  const tint = runwayTint(burn.runwayDays);
  // The ring is the trailing burn with nothing coming in; the 13-week forecast (when anything is
  // planned) sits under it, so an alarming ring never stands alone.
  const planned = forecast.weeks.some((w) => w.flows.length > 0);
  const forecastSafe = forecast.runway.firstNegativeWeekStart === null;

  const reviewCount = counts.byStage.review;
  const founderCents =
    founder.postedCents + founder.pendingCents + founder.unbookedOpeningCents;
  const inventoryCents = inventory.postedCents + inventory.pendingCents;
  const ingredientsCents =
    inventory.ingredients.postedCents + inventory.ingredients.pendingCents;
  const packagingCents =
    inventory.packaging.postedCents + inventory.packaging.pendingCents;

  const columns = (compact: boolean): DivergingColumn[] =>
    flows.map((m) => ({
      label: compact ? monthInitial(m.month) : monthShort(m.month),
      name: `${monthLong(m.month)} ${m.year}`,
      up: { founder: m.founderCents, sales: m.salesCents },
      down: { spend: m.spendCents },
    }));

  const pending = pendingByCategory(queue.bySuggestion);
  const infoCash = (
    <p>
      Money in the bank as the books will count it once every imported line is
      posted: the posted balance plus lines still waiting in review. The line
      shows each month end; the dotted part continues today&apos;s burn to $0.
    </p>
  );
  const infoRunway = (
    <>
      <p>
        Days of cash left if the last {burn.windowDays} days of operating spend
        continue: cash divided by the trailing net burn. Founder money is not
        counted as income.
      </p>
      {burn.suggestedCents > 0 ? (
        <p className="text-label2">
          {dollars(burn.suggestedCents)} of that burn is still waiting in
          review.
        </p>
      ) : null}
    </>
  );

  return (
    <div className="flex flex-col gap-3.5 max-md:gap-3">
      <PageToolbar title="Home" actions={hasActions ? actions : undefined} />

      <div className="grid gap-3.5 max-md:gap-3 md:grid-cols-2 lg:grid-cols-12">
        {/* Cash */}
        <section className="rounded-2xl bg-card px-5 pt-[18px] pb-4 shadow-card max-md:rounded-[22px] max-md:p-4 md:col-span-2 lg:col-span-8">
          <div className="mb-1.5 flex items-start justify-between gap-5">
            <div>
              <h2 className="flex items-center gap-1 text-sm font-semibold text-label2">
                Cash
                <InfoButton label="About cash" align="start">
                  {infoCash}
                </InfoButton>
              </h2>
              <Money
                cents={cash}
                currency
                plain
                className="mt-0.5 block text-5xl leading-[1.05] font-bold tracking-[-0.03em] max-md:text-[2.5rem]"
              />
            </div>
            <ul className="grid min-w-[260px] gap-1.5 pt-1 max-md:hidden">
              {accounts.map((a, i) => (
                <li key={a.bankAccountId}>
                  <Link
                    href={`/banking?account=${a.bankAccountId}`}
                    className="flex items-center gap-2 rounded-[6px] text-sm text-label2 hover:text-label"
                  >
                    <Dot tint={i === 0 ? "blue" : "quiet"} />
                    <span className="text-label">{accountName(a.name)}</span>
                    {a.mask ? (
                      <span className="text-xs">••{a.mask}</span>
                    ) : null}
                    <Money
                      cents={a.cashCents}
                      currency
                      plain
                      className="ml-auto pl-4 font-semibold text-label"
                    />
                  </Link>
                </li>
              ))}
            </ul>
          </div>
          <Responsive
            desktop={
              <CashLine
                points={series}
                cashOutDate={burn.cashOutDate}
                title="Cash at each month end, projected"
              />
            }
            phone={
              <div className="mt-2.5">
                <CashLine
                  points={series}
                  cashOutDate={burn.cashOutDate}
                  width={342}
                  height={150}
                  compact
                  title="Cash at each month end, projected"
                />
              </div>
            }
          />
        </section>

        {/* Accounts, phone: their own inset group under the cash card. */}
        <InsetGroup className="md:hidden" separatorInset={34}>
          {accounts.map((a, i) => (
            <Link
              key={a.bankAccountId}
              href={`/banking?account=${a.bankAccountId}`}
              className="relative flex h-[46px] items-center gap-2.5 px-4 text-lg before:absolute before:top-0 before:right-0 before:left-[34px] before:border-t-[0.5px] before:border-sep first:before:hidden"
            >
              <Dot tint={i === 0 ? "blue" : "quiet"} />
              <span>{accountName(a.name)}</span>
              {a.mask ? (
                <span className="text-sm text-label2">••{a.mask}</span>
              ) : null}
              <Money
                cents={a.cashCents}
                currency
                plain
                className="ml-auto font-semibold"
              />
            </Link>
          ))}
        </InsetGroup>

        {/* Runway, desktop card */}
        <section className="flex flex-col rounded-2xl bg-card px-5 pt-[18px] pb-4 shadow-card max-md:hidden lg:col-span-4">
          <div className="mb-2.5 flex items-center gap-2">
            <h2 className="flex-1 text-lg font-semibold tracking-[-0.01em]">
              Runway
            </h2>
            <InfoButton label="About runway">{infoRunway}</InfoButton>
          </div>
          <RunwayRing days={burn.runwayDays} className="mx-auto mt-1 mb-1.5" />
          <p className="mb-2.5 text-center text-xs font-medium text-label2">At current burn</p>
          <dl className="mt-auto grid rounded-[11px] bg-inset">
            <div className="flex h-9 items-center justify-between px-3">
              <dt className="font-medium text-label2">Burn</dt>
              <dd className="font-semibold">
                <Money cents={burn.monthlyBurnCents} currency plain />
                <small className="text-xs font-medium text-label2">/mo</small>
              </dd>
            </div>
            <div className="flex h-9 items-center justify-between hairline-t px-3">
              <dt className="font-medium text-label2">Cash out at burn</dt>
              <dd
                className={cn(
                  "font-semibold",
                  tint === "green"
                    ? "text-label"
                    : tint === "red"
                      ? "text-ink-red"
                      : "text-ink-orange",
                )}
              >
                {burn.cashOutDate ? shortDate(burn.cashOutDate) : "—"}
              </dd>
            </div>
            {planned ? (
              <Link
                href="/plan/forecast"
                className="flex h-9 items-center justify-between hairline-t px-3 transition-colors hover:bg-fill2 focus-ring-inset"
              >
                <span className="font-medium text-label2">Forecast low</span>
                <span
                  className={cn(
                    "inline-flex items-center gap-1 font-semibold",
                    forecastSafe ? "text-ink-green" : "text-ink-red",
                  )}
                >
                  <Glyph name={forecastSafe ? "check-circle" : "warning"} size={14} />
                  <Money cents={forecast.runway.lowestClosingCents} currency plain />
                </span>
              </Link>
            ) : null}
          </dl>
        </section>

        {/* Phone widgets: runway and review side by side. */}
        <div className="grid grid-cols-2 gap-3 md:hidden">
          <Link
            href="/plan/forecast"
            className="flex min-h-[170px] flex-col gap-1.5 rounded-[22px] bg-card p-3.5 shadow-card"
          >
            <TileHead glyph="target" tint={tint} label="Runway" />
            <RunwayRing
              days={burn.runwayDays}
              size={96}
              className="mx-auto mt-0.5"
            />
            <p
              className={cn(
                "text-center text-sm font-semibold",
                tint === "green"
                  ? "text-label2"
                  : tint === "red"
                    ? "text-ink-red"
                    : "text-ink-orange",
              )}
            >
              {burn.cashOutDate ? shortDate(burn.cashOutDate) : "No burn"}
            </p>
            {planned ? (
              <p
                className={cn(
                  "-mt-1 inline-flex items-center justify-center gap-1 text-xs font-semibold",
                  forecastSafe ? "text-ink-green" : "text-ink-red",
                )}
              >
                <Glyph name={forecastSafe ? "check-circle" : "warning"} size={12} />
                Low <Money cents={forecast.runway.lowestClosingCents} currency plain whole />
              </p>
            ) : null}
          </Link>
          <ReviewTile
            count={reviewCount}
            flagged={counts.flagged}
            inCents={queue.unreviewedInCents}
            outCents={queue.unreviewedOutCents}
            phone
          />
        </div>

        {/* KPI tiles */}
        <div className="max-md:hidden lg:col-span-3">
          <ReviewTile
            count={reviewCount}
            flagged={counts.flagged}
            inCents={queue.unreviewedInCents}
            outCents={queue.unreviewedOutCents}
          />
        </div>
        <div className="grid grid-cols-2 gap-3 md:contents">
          <Tile
            href="/ledger/accounts"
            glyph="person"
            tint="indigo"
            label="Founder"
            cap="Equity"
            className="lg:col-span-3"
          >
            <Figure cents={founderCents} />
            <Sparks
              values={flows.map((m) => m.founderCents)}
              tint="indigo"
              label="Founder money in by month"
            />
          </Tile>
          <Tile
            href="/channels/payouts"
            glyph="tag"
            tint="green"
            label="Sales"
            cap={`${square.depositsCount} ${square.depositsCount === 1 ? "payout" : "payouts"}`}
            className="lg:col-span-3"
          >
            <Figure cents={square.depositsCents} />
            <Sparks
              values={flows.map((m) => m.salesCents)}
              tint="green"
              label="Sales money in by month"
            />
          </Tile>
        </div>
        <Tile
          href="/inventory"
          glyph="cube"
          tint="brown"
          label="Inventory"
          cap={inventory.pendingCents > 0 ? "To capitalize" : "Held"}
          className="md:col-span-2 lg:col-span-3"
        >
          <Figure cents={inventoryCents} />
          <div className="mt-auto flex flex-col gap-2 max-md:mt-1">
            <SplitBar
              label={`Ingredients ${dollars(ingredientsCents)}, packaging ${dollars(packagingCents)}`}
              segments={[
                { label: "Ingredients", value: ingredientsCents, tint: "teal" },
                { label: "Packaging", value: packagingCents, tint: "brown" },
              ]}
            />
            <div
              aria-hidden
              className="flex justify-between gap-2 text-xs font-medium text-label2"
            >
              <span className="inline-flex items-center gap-1 truncate">
                <Dot tint="teal" size={7} />
                Ingredients <WholeDollars cents={ingredientsCents} />
              </span>
              <span className="inline-flex items-center gap-1 truncate">
                <Dot tint="brown" size={7} />
                Packaging <WholeDollars cents={packagingCents} />
              </span>
            </div>
          </div>
        </Tile>

        {/* In & out */}
        <section className="min-w-0 md:col-span-2 lg:col-span-8">
          <h2 className="px-1 pt-6 pb-2 text-xl font-bold tracking-[-0.02em] md:hidden">
            In &amp; out
          </h2>
          <div className="flex flex-col rounded-2xl bg-card px-5 pt-[18px] pb-4 shadow-card max-md:rounded-[22px] max-md:p-4 lg:h-full">
            <div className="mb-2.5 flex flex-wrap items-center gap-x-2 gap-y-1">
              <h2 className="flex-1 text-lg font-semibold tracking-[-0.01em] max-md:hidden">
                In &amp; out
              </h2>
              <div className="flex gap-3.5">
                {[...IN_OUT_UP, ...IN_OUT_DOWN].map((s) => (
                  <LegendItem key={s.key} tint={s.tint}>
                    {s.label}
                  </LegendItem>
                ))}
              </div>
            </div>
            <div className="flex flex-1 flex-col justify-center">
              <Responsive
                desktop={
                  <DivergingBars
                    columns={columns(false)}
                    upSeries={IN_OUT_UP}
                    downSeries={IN_OUT_DOWN}
                    title="Money in and out by month"
                  />
                }
                phone={
                  <DivergingBars
                    columns={columns(true)}
                    upSeries={IN_OUT_UP}
                    downSeries={IN_OUT_DOWN}
                    width={342}
                    compact
                    title="Money in and out by month"
                  />
                }
              />
            </div>
          </div>
        </section>

        {/* Pending spend */}
        <section className="min-w-0 md:col-span-2 lg:col-span-4">
          <h2 className="px-1 pt-6 pb-2 text-xl font-bold tracking-[-0.02em] md:hidden">
            Pending spend
          </h2>
          <div className="rounded-2xl bg-card px-5 pt-[18px] pb-3 shadow-card max-md:rounded-[22px] max-md:p-4 max-md:pt-2 lg:h-full">
            <div className="mb-1.5 flex items-center gap-2 max-md:hidden">
              <h2 className="flex-1 text-lg font-semibold tracking-[-0.01em]">
                Pending spend
              </h2>
              <Link
                href="/banking/review"
                aria-label="Open review"
                className="grid size-6 place-items-center rounded-full text-label3 hover:text-label2"
              >
                <Glyph name="chevron-right" size={14} weight={2.2} />
              </Link>
            </div>
            {pending.length === 0 ? (
              <p className="py-8 text-center text-sm text-label2">
                Nothing waiting
              </p>
            ) : (
              <>
                <div className="max-md:hidden">
                  <CategoryBars rows={pending} />
                </div>
                <div className="md:hidden">
                  <CategoryBars rows={pending} size="lg" />
                </div>
              </>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ pieces */

function pendingByCategory(
  groups: Array<{
    code: string | null;
    name: string;
    count: number;
    netCents: number;
  }>,
): CategoryBarRow[] {
  const byKey = new Map<CategoryKey, CategoryBarRow>();
  for (const g of groups) {
    if (g.netCents >= 0) continue;
    const category = categoryForCode(g.code);
    const row = byKey.get(category.key) ?? {
      key: category.key,
      label: category.label,
      tint: category.tint,
      cents: 0,
      count: 0,
      href: "/banking/review",
    };
    row.cents += -g.netCents;
    row.count = (row.count ?? 0) + g.count;
    byKey.set(category.key, row);
  }
  return [...byKey.values()].sort((a, b) => b.cents - a.cents);
}

function TileHead({
  glyph,
  tint,
  label,
  cap,
  chevron,
}: {
  glyph: GlyphName;
  tint: Tint;
  label: string;
  cap?: string;
  chevron?: boolean;
}) {
  return (
    <div className="flex min-w-0 items-center gap-2 text-sm font-semibold max-md:text-lg">
      <IconBadge
        glyph={glyph}
        tint={tint}
        className="max-md:size-5 max-md:rounded-[5.5px]"
      />
      <span className="truncate">{label}</span>
      {cap ? (
        <span className="ml-auto shrink-0 rounded-[6px] bg-fill2 px-[7px] py-0.5 text-2xs font-semibold text-label2 max-md:hidden">
          {cap}
        </span>
      ) : null}
      {chevron ? (
        <Glyph
          name="chevron-right"
          size={12}
          weight={2.4}
          className="ml-auto text-label3 max-md:hidden"
        />
      ) : null}
    </div>
  );
}

function Tile({
  href,
  glyph,
  tint,
  label,
  cap,
  className,
  children,
}: {
  href: string;
  glyph: GlyphName;
  tint: Tint;
  label: string;
  cap?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Link
      href={href}
      className={cn(
        "flex min-h-[148px] min-w-0 flex-col gap-2 rounded-2xl bg-card px-[18px] py-4 shadow-card transition-shadow hover:shadow-glass",
        "max-md:min-h-0 max-md:rounded-[22px] max-md:p-3.5",
        className,
      )}
    >
      <TileHead glyph={glyph} tint={tint} label={label} cap={cap} />
      {children}
    </Link>
  );
}

function Figure({ cents }: { cents: number }) {
  return (
    <Money
      cents={cents}
      currency
      plain
      className="block text-3xl leading-[1.1] font-bold tracking-[-0.028em] max-md:text-2xl max-md:tracking-[-0.022em]"
    />
  );
}

/** A legend caption, rounded to the dollar; the exact figure is on the tile and in the bar's label. */
function WholeDollars({ cents }: { cents: number }) {
  return <Money cents={cents} currency plain whole />;
}

function Sparks({
  values,
  tint,
  label,
}: {
  values: number[];
  tint: Tint;
  label: string;
}) {
  return (
    <div className="mt-auto">
      <Responsive
        desktop={
          <Sparkbars
            values={values}
            tint={tint}
            label={label}
            format={dollars}
          />
        }
        phone={
          <Sparkbars
            values={values}
            tint={tint}
            width={130}
            height={26}
            label={label}
            format={dollars}
          />
        }
      />
    </div>
  );
}

function ReviewTile({
  count,
  flagged,
  inCents,
  outCents,
  phone,
}: {
  count: number;
  flagged: number;
  inCents: number;
  outCents: number;
  phone?: boolean;
}) {
  return (
    <Link
      href="/banking/review"
      className={cn(
        "flex h-full min-w-0 flex-col gap-2 rounded-2xl bg-card shadow-card transition-shadow hover:shadow-glass",
        phone
          ? "min-h-[170px] gap-1.5 rounded-[22px] p-3.5"
          : "min-h-[148px] px-[18px] py-4",
      )}
    >
      <TileHead glyph="tray" tint="orange" label="Review" chevron />
      <div
        className={cn(
          "flex gap-2.5",
          phone ? "flex-col gap-1" : "items-baseline",
        )}
      >
        <span
          className={cn(
            "num leading-[1.1] font-bold",
            phone
              ? "text-[2.5rem] tracking-[-0.03em]"
              : "text-3xl tracking-[-0.028em]",
          )}
        >
          {count}
          <span className="sr-only"> to review</span>
        </span>
        {flagged > 0 ? (
          <span className="inline-flex items-center gap-[3px] text-sm font-semibold text-ink-orange">
            <Glyph name="flag" size={13} />
            <span className="num">{flagged}</span>
            <span className="sr-only"> flagged</span>
          </span>
        ) : null}
      </div>
      <SplitBar
        className="mt-auto"
        label={`In ${dollars(inCents)}, out ${dollars(outCents)}`}
        segments={[
          { label: "In", value: inCents, tint: "green" },
          { label: "Out", value: outCents, tint: "red", muted: true },
        ]}
      />
      {phone ? (
        <Money
          cents={-outCents}
          currency
          plain
          className="text-sm font-semibold text-label2"
        />
      ) : (
        <div className="flex justify-between text-xs font-medium text-label2">
          <span className="inline-flex items-center gap-1 text-ink-green">
            <Glyph name="arrow-in" size={12} weight={2.2} />
            <span className="sr-only">In </span>
            <Money cents={inCents} currency plain />
          </span>
          <span className="inline-flex items-center gap-1">
            <Glyph name="arrow-out" size={12} weight={2.2} />
            <span className="sr-only">Out </span>
            <Money cents={outCents} currency plain />
          </span>
        </div>
      )}
    </Link>
  );
}
