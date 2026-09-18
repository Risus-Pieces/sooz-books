"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

import { disputeDeductions, previewValidation, recoverOne, validateDeductions, writeOffOne } from "@/app/(app)/trade/actions";
import { MoneyInput, centsOf, textOf } from "@/components/arap/money-input";
import { Button } from "@/components/ui/button";
import { InfoButton } from "@/components/ui/info-button";
import { Checkbox } from "@/components/ui/checkbox";
import { DateInput } from "@/components/ui/date-input";
import { Input } from "@/components/ui/input";
import { Money } from "@/components/ui/money";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/toast";

import { longDate } from "./labels";
import { EntryPreview, Field, NoEntry } from "./parts";
import type { AccountLabel, EntryView, Option, ValidationPreview } from "./types";

export interface DeductionActionsProps {
  deductionId: string;
  deductionNo: string;
  openCents: number;
  deductionDate: string;
  /** The deadline a dispute filed now would carry. */
  disputeDeadline: string;
  reasonCode: string | null;
  validation: ValidationPreview;
  reasonOptions: Option[];
  depositOptions: AccountLabel[];
  accounts: { receivable: AccountLabel; writeOff: AccountLabel; undeposited: AccountLabel };
  today: string;
  alreadyDisputed: boolean;
}

function line(account: AccountLabel, debitCents: number, creditCents: number) {
  return { accountCode: account.code, accountName: account.name, debitCents, creditCents, memo: null };
}

/**
 * The four things a bookkeeper can do with an open deduction, each showing the entry it will
 * post before the button is pressed. Recovery and write-off entries are built here from the
 * amounts typed; validation is worked out by the server with the same routing the engine
 * posts from, and re-worked when the reason code changes.
 */
export function DeductionActions(props: DeductionActionsProps) {
  const needsCode = props.validation.kind === "needs_classification";
  return (
    <Tabs defaultValue={props.alreadyDisputed ? "recover" : needsCode ? "dispute" : "validate"}>
      <TabsList aria-label="Deduction actions" className="flex w-full [&>*]:flex-1">
        <TabsTrigger value="validate">Validate</TabsTrigger>
        <TabsTrigger value="dispute">Dispute</TabsTrigger>
        <TabsTrigger value="recover">Recover</TabsTrigger>
        <TabsTrigger value="writeoff">Write off</TabsTrigger>
      </TabsList>
      <TabsContent value="validate">
        <ValidatePanel {...props} />
      </TabsContent>
      <TabsContent value="dispute">
        <DisputePanel {...props} />
      </TabsContent>
      <TabsContent value="recover">
        <RecoverPanel {...props} />
      </TabsContent>
      <TabsContent value="writeoff">
        <WriteOffPanel {...props} />
      </TabsContent>
    </Tabs>
  );
}

function Preview({ entry, note, tone }: { entry: EntryView | null; note?: React.ReactNode; tone?: "neutral" | "red" }) {
  return entry === null ? <NoEntry tone={tone}>{note}</NoEntry> : <EntryPreview entry={entry} />;
}

/** The action's one-line name with its explanation behind the ⓘ. */
function Intro({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <p className="flex items-center gap-1 text-sm font-semibold">
      {title}
      <InfoButton label={`About ${title.toLowerCase()}`} align="start">
        <p>{children}</p>
      </InfoButton>
    </p>
  );
}

function useSubmit() {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const run = (label: string, fn: () => Promise<{ ok: true; message: string } | { ok: false; message: string }>) =>
    startTransition(async () => {
      const result = await fn();
      if (!result.ok) {
        toast.error(`Not ${label}`, { description: result.message });
        return;
      }
      toast.success(result.message);
      router.refresh();
    });
  return { pending, run };
}

function ValidatePanel(props: DeductionActionsProps) {
  const [date, setDate] = React.useState(props.today);
  const [code, setCode] = React.useState<string>("");
  const [memo, setMemo] = React.useState("");
  const [fetched, setFetched] = React.useState<{ key: string; value: ValidationPreview } | null>(null);
  const { pending, run } = useSubmit();
  const key = `${code}|${date}`;
  const initial = code === "" && date === props.today;
  const preview: ValidationPreview | null = initial ? props.validation : fetched?.key === key ? fetched.value : null;

  React.useEffect(() => {
    if (initial || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
    let live = true;
    void previewValidation(props.deductionId, code === "" ? null : code, date).then((result) => {
      if (!live) return;
      setFetched({ key, value: result.ok ? result.value : { kind: "needs_classification", message: result.error.message } });
    });
    return () => {
      live = false;
    };
  }, [initial, key, code, date, props.deductionId]);

  const submit = () =>
    run("validated", async () => {
      const result = await validateDeductions([props.deductionId], { date, reasonCode: code, memo });
      if (!result.ok) return { ok: false, message: result.error.message };
      const refused = result.value.refused[0];
      if (refused !== undefined) return { ok: false, message: refused.message };
      const done = result.value.done[0];
      return { ok: true, message: `Validated as entry #${done?.entryNo ?? ""}` };
    });

  return (
    <div className="flex flex-col gap-3">
      <Intro title="Entitled">
        The distributor was entitled to it. The open amount leaves 1210 for trade spend (its promotion’s accrual first), or gross sales for a shortage or pricing claim that was real.
      </Intro>
      <div className="grid gap-3 sm:grid-cols-[10rem_1fr]">
        <Field label="Date" htmlFor="validate-date">
          <DateInput id="validate-date" value={date} onValueChange={setDate} disabled={pending} />
        </Field>
        <Field label="Reason code" htmlFor="validate-code" required={props.reasonCode === null}>
          <Select value={code === "" ? "__keep" : code} onValueChange={(v) => setCode(v === "__keep" ? "" : v)} disabled={pending}>
            <SelectTrigger id="validate-code">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__keep">{props.reasonCode === null ? "Choose a reason code…" : `Keep ${props.reasonCode}`}</SelectItem>
              {props.reasonOptions.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      </div>
      <Field label="Memo" htmlFor="validate-memo">
        <Input id="validate-memo" value={memo} maxLength={200} onChange={(e) => setMemo(e.target.value)} disabled={pending} />
      </Field>
      {preview === null ? (
        <Preview entry={null} note="Working out the entry…" />
      ) : preview.kind === "entry" ? (
        <>
          {preview.chargedToAccrualCents > 0 ? (
            <p className="text-xs text-label2">
              <Money cents={preview.chargedToAccrualCents} currency plain className="font-semibold text-label" /> from the accrual
            </p>
          ) : null}
          <Preview entry={{ ...preview.entry, date, memo: memo.trim() === "" ? preview.entry.memo : memo.trim() }} />
        </>
      ) : (
        <Preview entry={null} note={preview.message} />
      )}
      <div className="flex justify-end">
        <Button onClick={submit} disabled={pending || preview === null || preview.kind !== "entry"}>
          {pending ? "Validating…" : "Validate and post"}
        </Button>
      </div>
    </div>
  );
}

function DisputePanel(props: DeductionActionsProps) {
  const [date, setDate] = React.useState(props.today);
  const [reference, setReference] = React.useState("");
  const [notes, setNotes] = React.useState("");
  const [code, setCode] = React.useState("");
  const { pending, run } = useSubmit();
  const late = date > props.disputeDeadline;

  const submit = () =>
    run("disputed", async () => {
      const result = await disputeDeductions([props.deductionId], { date, reference, notes, reasonCode: code });
      if (!result.ok) return { ok: false, message: result.error.message };
      const refused = result.value.refused[0];
      if (refused !== undefined) return { ok: false, message: refused.message };
      return { ok: true, message: `Dispute filed on ${props.deductionNo}` };
    });

  return (
    <div className="flex flex-col gap-3">
      <Intro title="Not entitled">
        The distributor was not entitled to it. Record the case you filed with them; the claim stays in 1210 until they repay it or you concede.
      </Intro>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Filed on" htmlFor="dispute-date">
          <DateInput id="dispute-date" value={date} onValueChange={setDate} disabled={pending} />
        </Field>
        <Field label="Case number" htmlFor="dispute-ref">
          <Input id="dispute-ref" value={reference} maxLength={80} onChange={(e) => setReference(e.target.value)} disabled={pending} />
        </Field>
      </div>
      {props.reasonCode === null ? (
        <Field label="Reason code" htmlFor="dispute-code">
          <Select value={code === "" ? "__none" : code} onValueChange={(v) => setCode(v === "__none" ? "" : v)} disabled={pending}>
            <SelectTrigger id="dispute-code">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__none">Leave unclassified</SelectItem>
              {props.reasonOptions.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      ) : null}
      <Field label="Notes" htmlFor="dispute-notes">
        <Textarea id="dispute-notes" rows={3} value={notes} maxLength={2000} onChange={(e) => setNotes(e.target.value)} disabled={pending} />
      </Field>
      <Preview
        entry={null}
        tone={late ? "red" : "neutral"}
        note={
          late ? (
            <>Window closed {longDate(props.disputeDeadline)}. Write it off or record a recovery.</>
          ) : (
            <>
              No entry · <Money cents={props.openCents} currency plain className="font-semibold text-label" /> stays in {props.accounts.receivable.code}{" "}
              {props.accounts.receivable.name}
            </>
          )
        }
      />
      <div className="flex justify-end">
        <Button variant="secondary" onClick={submit} disabled={pending || late}>
          {pending ? "Filing…" : props.alreadyDisputed ? "Update the dispute" : "File dispute"}
        </Button>
      </div>
    </div>
  );
}

function RecoverPanel(props: DeductionActionsProps) {
  const [date, setDate] = React.useState(props.today);
  const [amount, setAmount] = React.useState(textOf(props.openCents));
  const [deposit, setDeposit] = React.useState(props.accounts.undeposited.id);
  const [writeRest, setWriteRest] = React.useState(false);
  const [reference, setReference] = React.useState("");
  const { pending, run } = useSubmit();
  const cents = centsOf(amount);
  const rest = Math.max(0, props.openCents - cents);
  const account = props.depositOptions.find((d) => d.id === deposit) ?? props.accounts.undeposited;
  const valid = cents > 0 && cents <= props.openCents;
  const entry: EntryView | null = valid
    ? {
        date,
        memo: `Recovery on deduction ${props.deductionNo}${reference.trim() ? ` — ${reference.trim()}` : ""}`,
        lines: [
          line(account, cents, 0),
          ...(writeRest && rest > 0 ? [line(props.accounts.writeOff, rest, 0)] : []),
          line(props.accounts.receivable, 0, cents + (writeRest ? rest : 0)),
        ],
      }
    : null;

  const submit = () =>
    run("recorded", async () => {
      const result = await recoverOne(props.deductionId, { date, amount, depositAccountId: deposit, writeOffRemainder: writeRest, reference });
      return result.ok ? { ok: true, message: `Recovery posted as entry #${result.value.entryNo}` } : { ok: false, message: result.error.message };
    });

  return (
    <div className="flex flex-col gap-3">
      <Intro title="Paid back">
        The distributor paid it back, by check or as a repayment line. A repayment on a later remittance is matched automatically; use this for money that came any other way.
      </Intro>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Received" htmlFor="recover-date">
          <DateInput id="recover-date" value={date} onValueChange={setDate} disabled={pending} />
        </Field>
        <Field label="Amount" htmlFor="recover-amount" hint={`of ${textOf(props.openCents)}`}>
          <MoneyInput id="recover-amount" value={amount} onValueChange={setAmount} disabled={pending} invalid={amount !== "" && !valid} />
        </Field>
        <Field label="Landed in" htmlFor="recover-deposit">
          <Select value={deposit} onValueChange={setDeposit} disabled={pending}>
            <SelectTrigger id="recover-deposit">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {props.depositOptions.map((d) => (
                <SelectItem key={d.id} value={d.id}>
                  {d.code} {d.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field label="Reference" htmlFor="recover-ref">
          <Input id="recover-ref" value={reference} maxLength={80} onChange={(e) => setReference(e.target.value)} disabled={pending} />
        </Field>
      </div>
      {rest > 0 && valid ? (
        <label className="flex min-h-11 items-center gap-2.5 rounded-[12px] bg-card px-3.5 text-sm shadow-card">
          <Checkbox checked={writeRest} onCheckedChange={(v) => setWriteRest(v === true)} disabled={pending} />
          Write off the other <Money cents={rest} currency plain className="font-semibold" />
        </label>
      ) : null}
      <Preview entry={entry} note={`Enter an amount up to ${textOf(props.openCents)}.`} />
      <div className="flex justify-end">
        <Button onClick={submit} disabled={pending || !valid}>
          {pending ? "Posting…" : "Post recovery"}
        </Button>
      </div>
    </div>
  );
}

function WriteOffPanel(props: DeductionActionsProps) {
  const [date, setDate] = React.useState(props.today);
  const [amount, setAmount] = React.useState(textOf(props.openCents));
  const [reason, setReason] = React.useState("");
  const { pending, run } = useSubmit();
  const cents = centsOf(amount);
  const valid = cents > 0 && cents <= props.openCents;
  const memo = `Write off deduction ${props.deductionNo}${reason.trim() ? ` — ${reason.trim()}` : ""}`;
  const entry: EntryView | null = valid
    ? { date, memo, lines: [line(props.accounts.writeOff, cents, 0), line(props.accounts.receivable, 0, cents)] }
    : null;

  const submit = () =>
    run("written off", async () => {
      const result = await writeOffOne(props.deductionId, { date, amount, reason });
      return result.ok ? { ok: true, message: `Written off as entry #${result.value.entryNo}` } : { ok: false, message: result.error.message };
    });

  return (
    <div className="flex flex-col gap-3">
      <Intro title="Concede">
        Concede it: the dispute was denied, or the window closed. It is contra revenue the customer kept, not bad debt. A shortage that was real is a validation instead.
      </Intro>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Date" htmlFor="writeoff-date">
          <DateInput id="writeoff-date" value={date} onValueChange={setDate} disabled={pending} />
        </Field>
        <Field label="Amount" htmlFor="writeoff-amount" hint={`of ${textOf(props.openCents)}`}>
          <MoneyInput id="writeoff-amount" value={amount} onValueChange={setAmount} disabled={pending} invalid={amount !== "" && !valid} />
        </Field>
      </div>
      <Field label="Reason" htmlFor="writeoff-reason" required>
        <Input id="writeoff-reason" value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} disabled={pending} placeholder="Dispute denied by the distributor" />
      </Field>
      <Preview entry={entry} note={`Enter an amount up to ${textOf(props.openCents)}.`} />
      <div className="flex justify-end">
        <Button variant="danger-quiet" onClick={submit} disabled={pending || !valid || reason.trim() === ""}>
          {pending ? "Posting…" : "Write off and post"}
        </Button>
      </div>
    </div>
  );
}
