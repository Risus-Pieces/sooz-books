"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowRight,
  CircleCheck,
  CircleDashed,
  CircleX,
  Lock,
  RefreshCw,
  SkipForward,
  TriangleAlert,
  Undo2,
} from "lucide-react";

import {
  closeMonthFromChecklist,
  markCloseTaskDone,
  rerunCloseChecks,
  skipTask,
  startClose,
  undoCloseTask,
} from "@/app/(app)/close/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/toast";
import { cn } from "@/lib/cn";

import type { CloseTaskRow } from "./types";

export interface CloseWorkspaceProps {
  year: number;
  month: number;
  monthLabel: string;
  checklistId: string | null;
  periodStatus: "open" | "closed";
  tasks: readonly CloseTaskRow[];
  canWork: boolean;
}

/** Would this task let the month close, as things stand? */
function isReady(task: CloseTaskRow): boolean {
  if (task.state === "skipped") return true;
  // Closing re-runs every automatic check, so what it finds now is what counts.
  if (task.automatic && task.live !== null) return task.live.ok;
  return task.state === "done";
}

type Tone = "positive" | "negative" | "warning" | "muted";

function taskTone(task: CloseTaskRow, closed: boolean): Tone {
  if (task.state === "skipped") return "warning";
  if (closed) return "positive";
  // A live check outranks the recorded status: the books may have moved since the last run.
  if (task.automatic && task.live !== null) return task.live.ok ? "positive" : "negative";
  if (task.state === "done") return "positive";
  if (task.state === "blocked") return "negative";
  return "muted";
}

const TONE_TEXT: Record<Tone, string> = {
  positive: "text-positive",
  negative: "text-negative",
  warning: "text-warning",
  muted: "text-muted-foreground",
};

const TONE_FILL: Record<Tone, string> = {
  positive: "bg-positive",
  negative: "bg-negative",
  warning: "bg-warning",
  muted: "bg-transparent",
};

const STATE_LABEL: Record<CloseTaskRow["state"], string> = {
  not_started: "Not started",
  pending: "To do",
  in_progress: "In progress",
  done: "Done",
  skipped: "Skipped",
  blocked: "Blocked",
};

function StateIcon({ tone, className }: { tone: Tone; className?: string }) {
  const Icon = tone === "positive" ? CircleCheck : tone === "negative" ? CircleX : tone === "warning" ? SkipForward : CircleDashed;
  return <Icon aria-hidden className={cn("size-4 shrink-0", TONE_TEXT[tone], className)} />;
}

/**
 * The month-end close for one month: the standard tasks in the order they are
 * worked, each automatic one with what its check finds in the books right now,
 * and the Close button that re-runs every check before it locks anything.
 */
export function CloseWorkspace({
  year,
  month,
  monthLabel,
  checklistId,
  periodStatus,
  tasks,
  canWork,
}: CloseWorkspaceProps) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [skipping, setSkipping] = React.useState<CloseTaskRow | null>(null);
  const [ticking, setTicking] = React.useState<CloseTaskRow | null>(null);
  const [blockers, setBlockers] = React.useState<string[]>([]);

  const closed = periodStatus === "closed";
  const blocking = tasks.filter((t) => t.blocking);
  const ready = blocking.filter(isReady).length;
  const outstanding = blocking.filter((t) => !isReady(t));

  const run = (work: () => Promise<{ ok: boolean; error?: { message: string; details?: string[] } }>, success: string) => {
    startTransition(async () => {
      const result = await work();
      if (!result.ok) {
        toast.error("Not done", { description: result.error?.message });
        setBlockers(result.error?.details ?? []);
        router.refresh();
        return;
      }
      setBlockers([]);
      toast.success(success);
      router.refresh();
    });
  };

  return (
    <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_19rem]">
      <Card className="min-w-0">
        <CardHeader>
          <div className="min-w-0">
            <CardTitle>Checklist · {monthLabel}</CardTitle>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {closed
                ? "This month is closed. Its checklist is kept as the record of how it was closed."
                : checklistId === null
                  ? "Each automatic check below has just been run against the books. Start the close to record results and work the manual tasks."
                  : "Automatic results below are live. The status on the right is the last recorded run."}
            </p>
          </div>
          {canWork && !closed && checklistId !== null ? (
            <Button
              variant="secondary"
              size="sm"
              disabled={pending}
              onClick={() => run(() => rerunCloseChecks(checklistId), "Checks recorded")}
            >
              <RefreshCw />
              Re-run checks
            </Button>
          ) : null}
        </CardHeader>

        <ol className="flex flex-col">
          {tasks.map((task, index) => {
            const tone = taskTone(task, closed);
            const message = task.live?.message ?? task.recorded?.message ?? null;
            return (
              <li key={task.key} className="rule-row grid grid-cols-[1.75rem_minmax(0,1fr)] gap-x-2 px-4 py-3 sm:grid-cols-[1.75rem_minmax(0,1fr)_auto]">
                <div className="flex flex-col items-center gap-1 pt-0.5">
                  <span className="num text-2xs text-muted-foreground">{String(index + 1).padStart(2, "0")}</span>
                  <StateIcon tone={tone} />
                </div>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <p className="text-sm font-medium text-foreground">{task.label}</p>
                    {task.automatic ? (
                      <Badge tone="neutral" size="sm">auto</Badge>
                    ) : (
                      <Badge tone="outline" size="sm">manual</Badge>
                    )}
                    {!task.blocking ? <Badge tone="info" size="sm">optional</Badge> : null}
                  </div>
                  <p className="mt-0.5 text-xs text-muted-foreground">{task.description}</p>
                  {message !== null && task.automatic ? (
                    <p className={cn("mt-1.5 text-xs", tone === "negative" ? "text-negative" : "text-foreground")}>
                      {message}
                    </p>
                  ) : null}
                  {task.state === "skipped" && task.notes ? (
                    <p className="mt-1.5 text-xs text-warning">Skipped: {task.notes}</p>
                  ) : task.notes && task.state === "done" && !task.automatic ? (
                    <p className="mt-1.5 text-xs text-muted-foreground">Note: {task.notes}</p>
                  ) : null}
                  {task.fix !== null && !closed && !isReady(task) ? (
                    <Link
                      href={task.fix.href}
                      className="mt-1.5 inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
                    >
                      {task.fix.label}
                      <ArrowRight className="size-3" aria-hidden />
                    </Link>
                  ) : null}
                </div>
                <div className="col-start-2 mt-2 flex flex-wrap items-center gap-1.5 sm:col-start-3 sm:mt-0 sm:flex-col sm:items-end">
                  <span className={cn("text-2xs font-semibold tracking-wider uppercase", TONE_TEXT[task.state === "not_started" ? "muted" : tone])}>
                    {STATE_LABEL[task.state]}
                    {task.completedLabel !== null && (task.state === "done" || task.state === "skipped") ? (
                      <span className="ml-1 font-normal tracking-normal normal-case text-muted-foreground">{task.completedLabel}</span>
                    ) : null}
                  </span>
                  {canWork && !closed && task.id !== null ? (
                    <div className="flex flex-wrap gap-1.5">
                      {task.state === "done" || task.state === "skipped" ? (
                        task.automatic && task.state === "done" ? null : (
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={pending}
                            onClick={() => {
                              const id = task.id;
                              if (id !== null) run(() => undoCloseTask(id), `${task.label}: back to do`);
                            }}
                          >
                            <Undo2 />
                            Undo
                          </Button>
                        )
                      ) : (
                        <>
                          {!task.automatic ? (
                            <Button variant="secondary" size="sm" disabled={pending} onClick={() => setTicking(task)}>
                              <CircleCheck />
                              Mark done
                            </Button>
                          ) : null}
                          <Button variant="ghost" size="sm" disabled={pending} onClick={() => setSkipping(task)}>
                            <SkipForward />
                            Skip
                          </Button>
                        </>
                      )}
                    </div>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ol>
      </Card>

      <Card className="order-first lg:sticky lg:top-4 lg:order-last">
        <CardHeader>
          <CardTitle>{closed ? `${monthLabel} is closed` : `Close ${monthLabel}`}</CardTitle>
        </CardHeader>
        <div className="flex flex-col gap-3 p-4">
          <div>
            <p className="flex items-baseline justify-between text-xs text-muted-foreground">
              <span className="eyebrow">Blocking tasks ready</span>
              <span className="num text-sm font-semibold text-foreground">
                {closed ? blocking.length : ready} / {blocking.length}
              </span>
            </p>
            {/* One cell per blocking task, in checklist order: the ledger's tick column. */}
            <div className="mt-2 flex gap-0.5" aria-hidden>
              {blocking.map((task) => {
                const tone = taskTone(task, closed);
                return (
                  <span
                    key={task.key}
                    title={task.label}
                    className={cn("h-2 flex-1 rounded-[1px] border border-border-strong/60", TONE_FILL[tone])}
                  />
                );
              })}
            </div>
          </div>

          {closed ? (
            <p className="flex items-start gap-2 text-xs text-muted-foreground">
              <Lock className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              Nothing can post into this month. Corrections go into a later month as reversing entries. An owner can
              reopen it from the history below.
            </p>
          ) : (
            <>
              {outstanding.length > 0 ? (
                <div className="flex flex-col gap-1.5">
                  <p className="eyebrow">Standing in the way</p>
                  <ul className="flex flex-col gap-1">
                    {outstanding.map((task) => (
                      <li key={task.key} className="flex items-start gap-1.5 text-xs">
                        <StateIcon tone={taskTone(task, false) === "negative" ? "negative" : "muted"} className="mt-px size-3.5" />
                        <span>{task.label}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : (
                <p className="text-xs text-positive">Every blocking task is done or skipped with a reason.</p>
              )}

              {blockers.length > 0 ? (
                <div className="flex flex-col gap-1 rounded-sm border border-negative/35 bg-negative/8 p-2.5">
                  <p className="flex items-center gap-1.5 text-xs font-semibold text-negative">
                    <TriangleAlert className="size-3.5" aria-hidden />
                    The close was refused
                  </p>
                  <ul className="flex flex-col gap-0.5 text-xs text-foreground">
                    {blockers.map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {canWork ? (
                checklistId === null ? (
                  <Button disabled={pending} onClick={() => run(() => startClose(year, month), `${monthLabel} close started`)}>
                    Start the close
                  </Button>
                ) : (
                  <Button
                    disabled={pending}
                    variant={outstanding.length > 0 ? "secondary" : "default"}
                    onClick={() => run(() => closeMonthFromChecklist(checklistId), `${monthLabel} closed`)}
                  >
                    <Lock />
                    Close {monthLabel}
                  </Button>
                )
              ) : (
                <p className="text-xs text-muted-foreground">Your role can read the close but not work it.</p>
              )}
              <p className="text-2xs text-muted-foreground">
                Closing re-runs every automatic check first and refuses while any blocking task is neither done nor
                skipped with a reason.
              </p>
            </>
          )}
        </div>
      </Card>

      {skipping === null ? null : (
        <NoteDialog
          key={`skip-${skipping.key}`}
          title={`Skip "${skipping.label}"`}
          description="A skipped blocking task lets the month close without it. The reason is kept as the record of that decision."
          label="Why is it being skipped?"
          required
          confirm="Skip task"
          pending={pending}
          onClose={() => setSkipping(null)}
          onSubmit={(note) => {
            const id = skipping.id;
            if (id === null) return;
            setSkipping(null);
            run(() => skipTask(id, note), `${skipping.label}: skipped`);
          }}
        />
      )}
      {ticking === null ? null : (
        <NoteDialog
          key={`done-${ticking.key}`}
          title={`Mark "${ticking.label}" done`}
          description={ticking.description}
          label="Note (optional)"
          confirm="Mark done"
          pending={pending}
          onClose={() => setTicking(null)}
          onSubmit={(note) => {
            const id = ticking.id;
            if (id === null) return;
            setTicking(null);
            run(() => markCloseTaskDone(id, note), `${ticking.label}: done`);
          }}
        />
      )}
    </div>
  );
}

function NoteDialog({
  title,
  description,
  label,
  required,
  confirm,
  pending,
  onClose,
  onSubmit,
}: {
  title: string;
  description: string;
  label: string;
  required?: boolean;
  confirm: string;
  pending: boolean;
  onClose: () => void;
  onSubmit: (note: string) => void;
}) {
  const [note, setNote] = React.useState("");
  const empty = note.trim() === "";
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-1.5">
          <Label htmlFor="close-note" required={required}>
            {label}
          </Label>
          <Textarea id="close-note" value={note} onChange={(e) => setNote(e.target.value)} disabled={pending} />
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button size="sm" disabled={pending || (required === true && empty)} onClick={() => onSubmit(note)}>
            {confirm}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

