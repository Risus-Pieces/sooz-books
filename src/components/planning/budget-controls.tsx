"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Archive, CircleCheck, Copy, Plus, Upload } from "lucide-react";

import { copyFromActuals, createVersion, importBudget, setVersionStatus } from "@/app/(app)/plan/actions";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/toast";

import type { BudgetVersionOption } from "./types";

type Open = "new" | "import" | "copy" | null;

/** New version, activate/archive, import and copy-from-actuals for the selected budget. */
export function BudgetControls({
  version,
  defaultYear,
  canEdit,
}: {
  version: BudgetVersionOption | null;
  defaultYear: number;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState<Open>(null);
  const [pending, startTransition] = React.useTransition();

  if (!canEdit) return null;

  const status = (next: "active" | "archived") => {
    if (version === null) return;
    startTransition(async () => {
      const result = await setVersionStatus(version.id, next);
      if (!result.ok) {
        toast.error("Budget not changed", { description: result.error.message });
        return;
      }
      toast.success(next === "active" ? `"${version.name}" is now the ${version.fiscalYear} budget` : `"${version.name}" archived`);
      router.refresh();
    });
  };

  const editable = version !== null && version.status !== "archived";

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        {version !== null && version.status === "draft" ? (
          <Button variant="secondary" size="sm" disabled={pending} onClick={() => status("active")}>
            <CircleCheck />
            Make active
          </Button>
        ) : null}
        {version !== null && version.status !== "archived" ? (
          <Button variant="ghost" size="sm" disabled={pending} onClick={() => status("archived")}>
            <Archive />
            Archive
          </Button>
        ) : null}
        {editable ? (
          <>
            <Button variant="secondary" size="sm" onClick={() => setOpen("import")}>
              <Upload />
              Import CSV
            </Button>
            <Button variant="secondary" size="sm" onClick={() => setOpen("copy")}>
              <Copy />
              Copy from actuals
            </Button>
          </>
        ) : null}
        <Button size="sm" onClick={() => setOpen("new")}>
          <Plus />
          New budget
        </Button>
      </div>

      {open === "new" ? <NewVersionDialog defaultYear={defaultYear} onClose={() => setOpen(null)} /> : null}
      {open === "import" && version !== null ? <ImportDialog version={version} onClose={() => setOpen(null)} /> : null}
      {open === "copy" && version !== null ? <CopyDialog version={version} onClose={() => setOpen(null)} /> : null}
    </>
  );
}

function NewVersionDialog({ defaultYear, onClose }: { defaultYear: number; onClose: () => void }) {
  const router = useRouter();
  const [name, setName] = React.useState("");
  const [year, setYear] = React.useState(String(defaultYear));
  const [notes, setNotes] = React.useState("");
  const [pending, startTransition] = React.useTransition();

  const submit = () => {
    startTransition(async () => {
      const result = await createVersion({ name, fiscalYear: Number(year), notes });
      if (!result.ok) {
        toast.error("Budget not created", { description: result.error.message });
        return;
      }
      toast.success(`"${name.trim()}" created`);
      onClose();
      router.push(`/plan/budget?version=${result.value.id}`);
      router.refresh();
    });
  };

  return (
    <Dialog open onOpenChange={(o) => (o ? undefined : onClose())}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>New budget</DialogTitle>
          <DialogDescription>
            Starts as a draft. Make it active when it is the plan to measure the year against.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="bv-name" required>Name</Label>
            <Input id="bv-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Launch plan" />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="bv-year" required>Fiscal year</Label>
            <Input id="bv-year" numeric inputMode="numeric" value={year} onChange={(e) => setYear(e.target.value)} className="w-28" />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="bv-notes">Notes</Label>
            <Textarea id="bv-notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose} disabled={pending}>Cancel</Button>
          <Button size="sm" onClick={submit} disabled={pending || name.trim() === "" || !/^\d{4}$/.test(year)}>
            Create budget
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ImportDialog({ version, onClose }: { version: BudgetVersionOption; onClose: () => void }) {
  const router = useRouter();
  const [text, setText] = React.useState("");
  const [fileName, setFileName] = React.useState<string | null>(null);
  const [replace, setReplace] = React.useState(false);
  const [problems, setProblems] = React.useState<string[]>([]);
  const [pending, startTransition] = React.useTransition();

  const readFile = async (file: File | undefined) => {
    if (file === undefined) return;
    setFileName(file.name);
    setText(await file.text());
    setProblems([]);
  };

  const submit = () => {
    startTransition(async () => {
      const result = await importBudget(version.id, text, replace);
      if (!result.ok) {
        setProblems(result.error.details ?? []);
        toast.error("Nothing was imported", { description: result.error.message });
        return;
      }
      toast.success(`${result.value.cellsWritten} cells imported from ${result.value.rowsRead} rows`);
      onClose();
      router.refresh();
    });
  };

  return (
    <Dialog open onOpenChange={(o) => (o ? undefined : onClose())}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>Import into {version.name}</DialogTitle>
          <DialogDescription>
            A header row with an Account column (a code, or a code and name) and one column per month named Jan–Dec or
            {` ${version.fiscalYear}`}-01. An optional Channel column takes DTC, AMAZON and the rest. Blank cells are left
            alone. A file with any bad row is refused whole.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="budget-file">CSV file</Label>
            <input
              id="budget-file"
              type="file"
              accept=".csv,text/csv"
              onChange={(e) => void readFile(e.target.files?.[0])}
              className="text-xs file:mr-3 file:rounded-sm file:border file:border-border-strong file:bg-surface-raised file:px-2.5 file:py-1 file:text-xs file:font-medium"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="budget-csv" hint={fileName === null ? "or paste it" : fileName}>Contents</Label>
            <Textarea
              id="budget-csv"
              value={text}
              onChange={(e) => setText(e.target.value)}
              className="num min-h-36 text-xs"
              placeholder={"Account,Jan,Feb,Mar\n6510,1500,1500,1500"}
            />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={replace} onCheckedChange={(v) => setReplace(v === true)} />
            Clear this budget&apos;s existing lines first
          </label>
          {problems.length > 0 ? (
            <ul className="flex max-h-40 flex-col gap-0.5 overflow-y-auto rounded-sm border border-negative/35 bg-negative/8 p-2.5 text-xs">
              {problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          ) : null}
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose} disabled={pending}>Cancel</Button>
          <Button size="sm" onClick={submit} disabled={pending || text.trim() === ""}>
            <Upload />
            Import
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Growth typed as a percent with up to two decimals → basis points, with no float in between. */
function percentToBps(text: string): number | null {
  const match = /^\s*([+-]?)(\d{1,3})(?:\.(\d{1,2}))?\s*%?\s*$/.exec(text);
  if (match === null) return null;
  const bps = Number(match[2]) * 100 + Number((match[3] ?? "").padEnd(2, "0"));
  return match[1] === "-" ? -bps : bps;
}

function CopyDialog({ version, onClose }: { version: BudgetVersionOption; onClose: () => void }) {
  const router = useRouter();
  const [sourceYear, setSourceYear] = React.useState(String(version.fiscalYear - 1));
  const [growth, setGrowth] = React.useState("0");
  const [replace, setReplace] = React.useState(false);
  const [pending, startTransition] = React.useTransition();
  const bps = percentToBps(growth);

  const submit = () => {
    if (bps === null) return;
    startTransition(async () => {
      const result = await copyFromActuals({ versionId: version.id, sourceYear: Number(sourceYear), growthBps: bps, replace });
      if (!result.ok) {
        toast.error("Nothing was copied", { description: result.error.message });
        return;
      }
      toast.success(
        result.value.cellsWritten === 0
          ? `${sourceYear} has no posted income or expense to copy`
          : `${result.value.cellsWritten} cells copied from ${sourceYear}`,
      );
      onClose();
      router.refresh();
    });
  };

  return (
    <Dialog open onOpenChange={(o) => (o ? undefined : onClose())}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>Copy from actuals</DialogTitle>
          <DialogDescription>
            Seeds each account and month of {version.name} from a year of posted income and expense, grown by a
            percentage. Only posted entries count; bank lines still in review do not.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-3">
          <div className="flex gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="copy-year" required>Source year</Label>
              <Input id="copy-year" numeric inputMode="numeric" value={sourceYear} onChange={(e) => setSourceYear(e.target.value)} className="w-24" />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="copy-growth" hint="e.g. 10 or -5">Growth %</Label>
              <Input id="copy-growth" numeric value={growth} invalid={bps === null} onChange={(e) => setGrowth(e.target.value)} className="w-24" />
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={replace} onCheckedChange={(v) => setReplace(v === true)} />
            Clear this budget&apos;s existing lines first
          </label>
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose} disabled={pending}>Cancel</Button>
          <Button size="sm" onClick={submit} disabled={pending || bps === null || !/^\d{4}$/.test(sourceYear)}>
            <Copy />
            Copy actuals
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
