"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import {
  closeMonthFromChecklist,
  markCloseTaskDone,
  rerunCloseChecks,
  skipTask,
  startClose,
  undoCloseTask,
} from "@/app/(app)/close/actions";
import type { CloseTaskRow } from "@/components/planning/types";
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
import { Glyph, type GlyphName } from "@/components/ui/glyph";
import { InfoButton } from "@/components/ui/info-button";
import { InsetGroup } from "@/components/ui/inset-group";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/toast";
import { cn } from "@/lib/cn";

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

const TONE_VAR: Record<Tone, string> = {
  positive: "var(--green)",
  negative: "var(--red)",
  warning: "var(--orange)",
  muted: "var(--fill)",
};

const TONE_GLYPH: Record<Tone, GlyphName> = {
  positive: "check",
  negative: "xmark",
  warning: "arrow-right",
  muted: "minus",
};

const STATE_LABEL: Record<CloseTaskRow["state"], string> = {
  not_started: "Not started",
  pending: "To do",
  in_progress: "In progress",
  done: "Done",
  skipped: "Skipped",
  blocked: "Blocked",
};

/** A tick: the task's state as a filled disc — green check, red cross, orange skip, empty ring. */
function Tick({ tone, size = 26 }: { tone: Tone; size?: number }) {
  return (
    <span
      aria-hidden
      className={cn(
        "grid shrink-0 place-items-center rounded-full text-white transition-colors duration-200",
        tone === "muted" && "shadow-[inset_0_0_0_1.5px_var(--label3)]",
      )}
      style={{ width: size, height: size, background: tone === "muted" ? "transparent" : TONE_VAR[tone] }}
    >
      {tone === "muted" ? null : <Glyph name={TONE_GLYPH[tone]} size={Math.round(size * 0.5)} weight={2.6} />}
    </span>
  );
}

/** The blocking tasks as one ring: a segment each, filled in as they are ticked off. */
function TaskRing({ tones, ready, total, size = 132 }: { tones: Tone[]; ready: number; total: number; size?: number }) {
  const stroke = 12;
  const r = size / 2 - stroke / 2 - 1;
  const circumference = 2 * Math.PI * r;
  const n = Math.max(tones.length, 1);
  const gap = n > 1 ? 5 : 0;
  const seg = circumference / n - gap;
  return (
    <div
      role="img"
      aria-label={`${ready} of ${total} blocking tasks ready`}
      className="relative grid shrink-0 place-items-center max-sm:self-center"
      style={{ width: size, height: size }}
    >
      <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size} aria-hidden>
        {tones.map((tone, i) => (
          <circle
            key={i}
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke={TONE_VAR[tone]}
            strokeWidth={stroke}
            strokeDasharray={`${Math.max(seg, 1)} ${circumference}`}
            strokeDashoffset={-(i * (seg + gap))}
            transform={`rotate(-90 ${size / 2} ${size / 2})`}
            className="transition-[stroke] duration-200"
          />
        ))}
      </svg>
      <div aria-hidden className="absolute inset-0 grid place-content-center text-center">
        <span className="num text-3xl leading-none font-bold tracking-[-0.03em]">
          {ready}
          <span className="text-lg text-label2">/{total}</span>
        </span>
        <span className="mt-1 text-xs font-medium text-label2">ready</span>
      </div>
    </div>
  );
}

/**
 * The month-end close for one month: a ring of the blocking tasks, the one Close button, and the
 * checklist as a list of ticks — each automatic one showing what its check finds in the books
 * right now.
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
  const ready = closed ? blocking.length : blocking.filter(isReady).length;
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
    <>
      {/* The month at a glance: the ring, what stands in the way, and the one button. */}
      <section className="flex items-center gap-6 rounded-2xl bg-card px-6 py-5 shadow-card max-sm:flex-col max-sm:items-stretch max-sm:gap-4 max-sm:rounded-[22px] max-sm:px-4">
        <TaskRing
          tones={blocking.map((t) => (closed ? "positive" : taskTone(t, false)))}
          ready={ready}
          total={blocking.length}
          size={132}
        />
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          <div className="flex items-center gap-2">
            {closed ? <Glyph name="lock" size={20} className="text-ink-green" /> : null}
            <h2 className="text-xl font-bold tracking-[-0.02em]">
              {closed ? `${monthLabel} is closed` : monthLabel}
            </h2>
            <InfoButton label="About closing" align="start">
              <p>
                Closing freezes the month: nothing posts into it, and corrections go into a later month as reversing
                entries. It re-runs every automatic check first and refuses while any blocking task is neither done nor
                skipped with a reason.
              </p>
            </InfoButton>
          </div>

          {closed ? (
            <p className="text-sm text-label2">Nothing posts into it</p>
          ) : (
            <>
              {outstanding.length > 0 ? (
                <div className="flex flex-col gap-1.5">
                  <p className="text-xs font-semibold text-label2">Blocking</p>
                  <ul aria-label="Standing in the way" className="flex flex-wrap gap-1.5">
                    {outstanding.map((task) => (
                      <li
                        key={task.key}
                        className={cn(
                          "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold",
                          taskTone(task, false) === "negative" ? "bg-tint-red/12 text-ink-red" : "bg-fill2 text-label",
                        )}
                      >
                        {task.label}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : (
                <p className="flex items-center gap-1.5 text-sm font-semibold text-ink-green">
                  <Glyph name="check-circle" size={16} />
                  Ready to close
                </p>
              )}

              {blockers.length > 0 ? (
                <div className="flex flex-col gap-1 rounded-[11px] bg-[color-mix(in_srgb,var(--red)_9%,var(--card))] px-3 py-2.5">
                  <p className="flex items-center gap-1.5 text-xs font-semibold text-ink-red">
                    <Glyph name="warning" size={13} />
                    The close was refused
                  </p>
                  <ul className="flex flex-col gap-0.5 text-xs text-label">
                    {blockers.map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </>
          )}
        </div>

        {!closed ? (
          <div className="flex shrink-0 flex-col items-end gap-2 max-sm:items-stretch">
            {canWork ? (
              checklistId === null ? (
                <Button size="lg" disabled={pending} onClick={() => run(() => startClose(year, month), `${monthLabel} close started`)}>
                  <Glyph name="list" size={16} />
                  Start the close
                </Button>
              ) : (
                <Button
                  size="lg"
                  disabled={pending}
                  variant={outstanding.length > 0 ? "secondary" : "default"}
                  onClick={() => run(() => closeMonthFromChecklist(checklistId), `${monthLabel} closed`)}
                >
                  <Glyph name="lock" size={16} />
                  Close {monthLabel}
                </Button>
              )
            ) : (
              <p className="text-xs text-label2">Read-only role</p>
            )}
          </div>
        ) : null}
      </section>

      <InsetGroup
        header={`Checklist · ${monthLabel}`}
        headerAccessory={
          canWork && !closed && checklistId !== null ? (
            <Button
              variant="ghost"
              size="sm"
              disabled={pending}
              className="text-ink-blue"
              onClick={() => run(() => rerunCloseChecks(checklistId), "Checks recorded")}
            >
              <Glyph name="refresh" size={14} />
              Re-run checks
            </Button>
          ) : undefined
        }
      >
        <ol className="flex flex-col">
          {tasks.map((task) => {
            const tone = taskTone(task, closed);
            const message = task.live?.message ?? task.recorded?.message ?? null;
            const meta = [task.automatic ? "Auto" : "Manual", task.blocking ? null : "Optional"]
              .filter((part): part is string => part !== null)
              .join(" · ");
            return (
              <li
                key={task.key}
                className="relative flex items-start gap-3 px-4 py-3 before:pointer-events-none before:absolute before:top-0 before:right-0 before:left-[54px] before:border-t-[0.5px] before:border-sep first:before:hidden max-sm:flex-wrap"
              >
                <span className="pt-px">
                  <Tick tone={tone} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <p className="text-sm font-semibold max-sm:text-[0.9375rem]">{task.label}</p>
                    <InfoButton label={`About ${task.label}`} align="start">
                      <p>{task.description}</p>
                      {message !== null && task.automatic && tone !== "negative" ? (
                        <p className="text-label2">{message}</p>
                      ) : null}
                    </InfoButton>
                  </div>
                  <p className="text-xs text-label2">
                    {meta}
                    {task.state !== "not_started" ? ` · ${STATE_LABEL[task.state]}` : ""}
                    {task.completedLabel !== null && (task.state === "done" || task.state === "skipped")
                      ? ` · ${task.completedLabel}`
                      : ""}
                  </p>
                  {message !== null && task.automatic && tone === "negative" ? (
                    <p className="mt-1 text-xs font-medium text-ink-red">
                      {message}
                    </p>
                  ) : null}
                  {task.state === "skipped" && task.notes ? (
                    <p className="mt-1 text-xs text-ink-orange">Skipped: {task.notes}</p>
                  ) : task.notes && task.state === "done" && !task.automatic ? (
                    <p className="mt-1 text-xs text-label2">Note: {task.notes}</p>
                  ) : null}
                  {task.fix !== null && !closed && !isReady(task) ? (
                    <Link
                      href={task.fix.href}
                      className="mt-1 inline-flex items-center gap-0.5 text-xs font-semibold text-ink-blue hover:underline"
                    >
                      {task.fix.label}
                      <Glyph name="chevron-right" size={10} weight={2.4} />
                    </Link>
                  ) : null}
                </div>
                {canWork && !closed && task.id !== null ? (
                  <div className="flex shrink-0 flex-wrap items-center gap-1.5 max-sm:w-full max-sm:pl-[38px]">
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
                          <Glyph name="undo" size={14} />
                          Undo
                        </Button>
                      )
                    ) : (
                      <>
                        {!task.automatic ? (
                          <Button variant="secondary" size="sm" disabled={pending} onClick={() => setTicking(task)}>
                            <Glyph name="check" size={14} />
                            Mark done
                          </Button>
                        ) : null}
                        <Button variant="ghost" size="sm" disabled={pending} onClick={() => setSkipping(task)}>
                          Skip
                        </Button>
                      </>
                    )}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ol>
      </InsetGroup>

      {skipping === null ? null : (
        <NoteDialog
          key={`skip-${skipping.key}`}
          title={`Skip "${skipping.label}"`}
          description="The month can then close without this task. The reason is kept as the record of that decision."
          label="Reason"
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
          label="Note"
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
    </>
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
          <Button variant="ghost" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button disabled={pending || (required === true && empty)} onClick={() => onSubmit(note)}>
            {confirm}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
