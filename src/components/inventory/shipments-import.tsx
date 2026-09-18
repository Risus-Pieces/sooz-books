"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Upload } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "@/components/ui/toast";
import { commitShipmentsAction, previewShipmentsAction } from "@/app/(app)/inventory/actions";

import { Field, NativeSelect } from "./fields";
import { BlockerList, FileField, IssueList, UnknownItems } from "./peasy-bits";
import { Table, TableScroll, Td, Th } from "./table";
import { formatUnits, type ChannelOption, type ProductToCreateInput, type ShipmentsPreviewData } from "./types";

/**
 * Loads a Peasy shipments export (units by SKU, channel and month). Preview
 * first, always: nothing is written until the preview has been read and every
 * unknown item has been confirmed.
 */
export function ShipmentsImport({ channels, variant = "default" }: { channels: readonly ChannelOption[]; variant?: "default" | "secondary" }) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [file, setFile] = React.useState<File | null>(null);
  const [channel, setChannel] = React.useState("");
  const [preview, setPreview] = React.useState<ShipmentsPreviewData | null>(null);
  const [create, setCreate] = React.useState<ProductToCreateInput[]>([]);
  const [replace, setReplace] = React.useState(false);
  const [pending, startTransition] = React.useTransition();

  const form = (): FormData => {
    const data = new FormData();
    if (file) data.set("file", file);
    data.set("defaultChannel", channel);
    data.set("createProducts", JSON.stringify(create));
    data.set("replaceExisting", replace ? "1" : "");
    return data;
  };

  const reset = () => {
    setPreview(null);
    setCreate([]);
    setReplace(false);
  };

  const runPreview = () => {
    startTransition(async () => {
      const result = await previewShipmentsAction(form());
      if (!result.ok) {
        toast.error("File not read", { description: result.error.message });
        return;
      }
      setPreview(result.value);
      setCreate([]);
    });
  };

  const commit = () => {
    startTransition(async () => {
      const result = await commitShipmentsAction(form());
      if (!result.ok) {
        toast.error("Shipments not imported", {
          description: [result.error.message, ...(result.error.details ?? [])].join(" "),
        });
        return;
      }
      toast.success(`Imported ${result.value.lines} lines across ${result.value.months} ${result.value.months === 1 ? "month" : "months"}`);
      setOpen(false);
      setFile(null);
      reset();
      router.refresh();
    });
  };

  const clashes = preview?.periods.filter((p) => p.hasExisting) ?? [];
  const unconfirmed = preview ? preview.unknownItems.filter((u) => !create.some((c) => c.key === u.key)).length : 0;
  const canCommit =
    preview !== null && preview.blockers.length === 0 && unconfirmed === 0 && (clashes.length === 0 || replace);

  return (
    <>
      <Button size="sm" variant={variant} onClick={() => setOpen(true)}>
        <Upload />
        Import shipments
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
            <DialogTitle>Import shipments from Peasy</DialogTitle>
            <DialogDescription>
              Units shipped by SKU, channel and month — a Peasy sales report or the Inventory History export. These are
              the quantities the month’s COGS batch values at cost.
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="flex flex-col gap-4">
            <div className="grid gap-3 sm:grid-cols-[2fr_1fr]">
              <Field id="ship-file" label="Peasy export" required>
                <FileField
                  id="ship-file"
                  disabled={pending}
                  onFile={(f) => {
                    setFile(f);
                    reset();
                  }}
                />
              </Field>
              <Field id="ship-channel" label="Channel for unmarked rows" note="Used only where a row names no channel or customer the importer recognises.">
                <NativeSelect
                  id="ship-channel"
                  value={channel}
                  onChange={(e) => {
                    setChannel(e.target.value);
                    reset();
                  }}
                >
                  <option value="">None — flag them</option>
                  {channels.map((c) => (
                    <option key={c.id} value={c.code}>
                      {c.name}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
            </div>

            {preview ? (
              <div className="flex flex-col gap-4">
                <p className="text-xs text-muted-foreground">
                  <span className="text-foreground">{preview.filename}</span> · {preview.rows.data} rows read,{" "}
                  {preview.rows.used} used, {preview.rows.excluded} excluded, {preview.rows.unreadable} unreadable
                </p>
                <BlockerList blockers={preview.blockers} />
                {preview.periods.length > 0 ? (
                  <div className="flex flex-wrap gap-2">
                    {preview.periods.map((p) => (
                      <Badge key={p.key} tone={p.cogsPosted ? "negative" : p.hasExisting ? "warning" : "outline"}>
                        {p.label} · <span className="num">{formatUnits(p.units)}</span> units
                        {p.cogsPosted ? " · COGS posted" : p.hasExisting ? " · replaces earlier import" : ""}
                      </Badge>
                    ))}
                  </div>
                ) : null}
                <UnknownItems items={preview.unknownItems} value={create} onChange={setCreate} />
                {preview.lines.length > 0 ? (
                  <div className="overflow-hidden rounded-sm border border-border">
                    <TableScroll className="max-h-72">
                      <Table caption="Shipments to import" className="min-w-[34rem]">
                        <thead>
                          <tr>
                            <Th>Month</Th>
                            <Th>Item</Th>
                            <Th>Channel</Th>
                            <Th align="right">Shipped</Th>
                            <Th align="right">Returned</Th>
                          </tr>
                        </thead>
                        <tbody>
                          {preview.lines.map((l) => (
                            <tr key={l.key} className="rule-row">
                              <Td className="num">{l.period}</Td>
                              <Td>
                                {l.productSku && l.productSku !== l.label ? <span className="num mr-2 text-xs text-muted-foreground">{l.productSku}</span> : null}
                                {l.label}
                                {l.productSku === null ? (
                                  <Badge tone="warning" size="sm" className="ml-2">
                                    new
                                  </Badge>
                                ) : null}
                              </Td>
                              <Td className="num text-xs">{l.channelCode}</Td>
                              <Td align="right" className="num">
                                {formatUnits(l.units)}
                              </Td>
                              <Td align="right" className="num text-muted-foreground">
                                {l.returns === 0 ? "—" : formatUnits(l.returns)}
                              </Td>
                            </tr>
                          ))}
                        </tbody>
                      </Table>
                    </TableScroll>
                  </div>
                ) : null}
                <IssueList issues={preview.issues} />
                {clashes.length > 0 ? (
                  <label className="flex items-start gap-2 text-xs">
                    <input
                      type="checkbox"
                      checked={replace}
                      onChange={(e) => setReplace(e.target.checked)}
                      className="mt-0.5 size-3.5 accent-[var(--color-primary)]"
                    />
                    <span>
                      Replace the shipments already imported for {clashes.map((c) => c.label).join(", ")}. Draft COGS for
                      those months will need redrafting.
                    </span>
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
              <Button size="sm" disabled={pending || file === null} onClick={runPreview}>
                Preview
              </Button>
            ) : (
              <>
                <Button variant="secondary" size="sm" disabled={pending} onClick={runPreview}>
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
