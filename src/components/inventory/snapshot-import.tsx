"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Upload } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DateInput } from "@/components/ui/date-input";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Money } from "@/components/ui/money";
import { toast } from "@/components/ui/toast";
import { commitSnapshotAction, previewSnapshotAction } from "@/app/(app)/inventory/actions";

import { Field, NativeSelect } from "./fields";
import { BlockerList, FileField, IssueList, UnknownItems } from "./peasy-bits";
import { Table, TableScroll, Td, Th } from "./table";
import {
  formatUnits,
  STAGE_KEYS,
  STAGE_LABELS,
  type ProductToCreateInput,
  type SnapshotPreviewData,
  type StageKey,
} from "./types";

const SOURCE_LABEL = { file: "Peasy cost", product_cost: "Book unit cost", none: "No cost" } as const;

/**
 * Loads a Peasy inventory position as the counted side of the tie-out. The
 * preview shows every line, the stage it will be compared under (changeable per
 * item, since Peasy has no stage field of its own), and what the file could not
 * be sure of. Nothing is written until the preview is accepted.
 */
export function SnapshotImport({ variant = "default" }: { variant?: "default" | "secondary" }) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [file, setFile] = React.useState<File | null>(null);
  const [snapshotDate, setSnapshotDate] = React.useState("");
  const [defaultStage, setDefaultStage] = React.useState<"" | StageKey>("");
  const [overrides, setOverrides] = React.useState<Record<string, StageKey>>({});
  const [preview, setPreview] = React.useState<SnapshotPreviewData | null>(null);
  const [create, setCreate] = React.useState<ProductToCreateInput[]>([]);
  const [replace, setReplace] = React.useState(false);
  const [pending, startTransition] = React.useTransition();

  const form = (withOverrides: Record<string, StageKey>): FormData => {
    const data = new FormData();
    if (file) data.set("file", file);
    data.set("snapshotDate", snapshotDate);
    data.set("defaultStage", defaultStage);
    data.set("stageOverrides", JSON.stringify(withOverrides));
    data.set("createProducts", JSON.stringify(create));
    data.set("replaceExisting", replace ? "1" : "");
    return data;
  };

  const runPreview = (withOverrides = overrides) => {
    startTransition(async () => {
      const result = await previewSnapshotAction(form(withOverrides));
      if (!result.ok) {
        toast.error("File not read", { description: result.error.message });
        return;
      }
      setPreview(result.value);
    });
  };

  const changeStage = (key: string, stage: StageKey) => {
    const next = { ...overrides, [key]: stage };
    setOverrides(next);
    runPreview(next);
  };

  const reset = () => {
    setPreview(null);
    setCreate([]);
    setReplace(false);
    setOverrides({});
  };

  const commit = () => {
    startTransition(async () => {
      const result = await commitSnapshotAction(form(overrides));
      if (!result.ok) {
        toast.error("Count not imported", {
          description: [result.error.message, ...(result.error.details ?? [])].join(" "),
        });
        return;
      }
      toast.success(`Peasy count for ${result.value.snapshotDate} imported`, {
        description: `${result.value.lineCount} lines. Record the tie-out to compare it with the ledger.`,
      });
      setOpen(false);
      setFile(null);
      reset();
      router.refresh();
    });
  };

  const unconfirmed = preview ? preview.unknownItems.filter((u) => !create.some((c) => c.key === u.key)).length : 0;
  const canCommit = preview !== null && preview.blockers.length === 0 && unconfirmed === 0 && (!preview.replacesExisting || replace);

  return (
    <>
      <Button size="sm" variant={variant} onClick={() => setOpen(true)}>
        <Upload />
        Import a Peasy count
      </Button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) reset();
        }}
      >
        <DialogContent size="xl">
          <DialogHeader>
            <DialogTitle>Import a Peasy inventory count</DialogTitle>
            <DialogDescription>
              Inventory as of a date, from Peasy (Reports › Inventory as of a date › Download CSV). Clear any search or
              filter first, or the file is partial.
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="flex flex-col gap-4">
            <div className="grid gap-3 sm:grid-cols-[2fr_1fr_1fr]">
              <Field id="snap-file" label="Peasy export" required>
                <FileField
                  id="snap-file"
                  disabled={pending}
                  onFile={(f) => {
                    setFile(f);
                    reset();
                  }}
                />
              </Field>
              <Field id="snap-date" label="Count date" note="Needed when the file carries no date.">
                <DateInput
                  id="snap-date"
                  value={snapshotDate}
                  onValueChange={(v) => {
                    setSnapshotDate(v);
                    setPreview(null);
                  }}
                  className="w-full"
                />
              </Field>
              <Field id="snap-stage" label="Stage for unmarked items" note="Peasy has no stage field; unmarked rows are refused without one.">
                <NativeSelect
                  id="snap-stage"
                  value={defaultStage}
                  onChange={(e) => {
                    setDefaultStage(e.target.value as "" | StageKey);
                    setPreview(null);
                  }}
                >
                  <option value="">None — flag them</option>
                  {STAGE_KEYS.map((s) => (
                    <option key={s} value={s}>
                      {STAGE_LABELS[s]}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
            </div>

            {preview ? (
              <div className="flex flex-col gap-4">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="text-xs text-muted-foreground">
                    <span className="text-foreground">{preview.filename}</span>
                    {preview.snapshotDate ? (
                      <>
                        {" "}
                        · counted <span className="num text-foreground">{preview.snapshotDate}</span>
                      </>
                    ) : null}{" "}
                    · {preview.rows.data} rows, {preview.rows.used} used, {preview.rows.excluded} excluded,{" "}
                    {preview.rows.unreadable} unreadable
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {STAGE_KEYS.filter((s) => preview.totalsByStage[s] !== undefined).map((s) => (
                      <Badge key={s} tone="outline">
                        {STAGE_LABELS[s]} <Money cents={preview.totalsByStage[s] ?? 0} plain />
                      </Badge>
                    ))}
                  </div>
                </div>
                <BlockerList blockers={preview.blockers} />
                <UnknownItems items={preview.unknownItems} value={create} onChange={setCreate} />
                {preview.lines.length > 0 ? (
                  <div className="overflow-hidden rounded-sm border border-border">
                    <TableScroll className="max-h-80">
                      <Table caption="Inventory lines to import" className="min-w-[42rem]">
                        <thead>
                          <tr>
                            <Th>Item</Th>
                            <Th>Location</Th>
                            <Th className="w-44">Stage</Th>
                            <Th align="right">Quantity</Th>
                            <Th align="right">Value</Th>
                            <Th>Valued at</Th>
                          </tr>
                        </thead>
                        <tbody>
                          {preview.lines.map((l) => (
                            <tr key={l.key} className="rule-row">
                              <Td>
                                {l.productSku && l.productSku !== l.label ? (
                                  <span className="num mr-2 text-xs text-muted-foreground">{l.productSku}</span>
                                ) : null}
                                {l.label}
                                {l.productSku === null ? (
                                  <Badge tone="warning" size="sm" className="ml-2">
                                    new
                                  </Badge>
                                ) : null}
                              </Td>
                              <Td className="text-muted-foreground">{l.location}</Td>
                              <Td>
                                <NativeSelect
                                  aria-label={`Stage for ${l.label}`}
                                  value={l.stage}
                                  disabled={pending}
                                  onChange={(e) => changeStage(l.overrideKey, e.target.value as StageKey)}
                                  className="h-7 text-xs"
                                >
                                  {STAGE_KEYS.map((s) => (
                                    <option key={s} value={s}>
                                      {STAGE_LABELS[s]}
                                    </option>
                                  ))}
                                </NativeSelect>
                              </Td>
                              <Td align="right" className="num">
                                {formatUnits(l.quantity)}
                              </Td>
                              <Td align="right">
                                <Money cents={l.valueCents} plain />
                              </Td>
                              <Td className={l.valueSource === "none" ? "text-xs text-warning" : "text-xs text-muted-foreground"}>
                                {SOURCE_LABEL[l.valueSource]}
                              </Td>
                            </tr>
                          ))}
                          <tr className="font-semibold">
                            <Td className="rule-subtotal" colSpan={4}>
                              {preview.lines.length} lines
                            </Td>
                            <Td align="right" className="rule-subtotal rule-total">
                              <Money cents={preview.totalValueCents} currency plain />
                            </Td>
                            <Td className="rule-subtotal" />
                          </tr>
                        </tbody>
                      </Table>
                    </TableScroll>
                  </div>
                ) : null}
                <IssueList issues={preview.issues} />
                {preview.replacesExisting ? (
                  <label className="flex items-start gap-2 text-xs">
                    <input
                      type="checkbox"
                      checked={replace}
                      onChange={(e) => setReplace(e.target.checked)}
                      className="mt-0.5 size-3.5 accent-[var(--color-primary)]"
                    />
                    <span>A count for {preview.snapshotDate} is already imported. Replace it with this file.</span>
                  </label>
                ) : null}
              </div>
            ) : null}
          </DialogBody>
          <DialogFooter>
            <Button variant="ghost" size="sm" disabled={pending} onClick={() => setOpen(false)}>
              Cancel
            </Button>
            {preview === null ? (
              <Button size="sm" disabled={pending || file === null} onClick={() => runPreview()}>
                Preview
              </Button>
            ) : (
              <>
                <Button variant="secondary" size="sm" disabled={pending} onClick={() => runPreview()}>
                  Preview again
                </Button>
                <Button size="sm" disabled={pending || !canCommit} onClick={commit}>
                  Import {preview.lines.length} lines
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
