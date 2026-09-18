import { Glyph } from "./glyph";
import { Popover, PopoverContent, PopoverTrigger } from "./popover";

/**
 * The caveats a report carries ("87 bank lines are not in the ledger yet"), folded into one
 * orange capsule that opens them. The figures stay on screen; the sentences wait behind a click.
 */
export function Caveats({ items, label = "caveat" }: { items: readonly string[]; label?: string }) {
  if (items.length === 0) return null;
  return (
    <Popover>
      <PopoverTrigger className="inline-flex h-[26px] items-center gap-[5px] rounded-full bg-tint-orange/14 px-2.5 text-xs font-semibold text-ink-orange outline-none focus-ring hover:bg-tint-orange/20 max-sm:h-9">
        <Glyph name="warning" size={13} />
        <span className="num">{items.length}</span> {items.length === 1 ? label : `${label}s`}
      </PopoverTrigger>
      <PopoverContent align="start" className="max-w-sm px-3.5 py-3 text-sm leading-[1.45]">
        <ul className="flex flex-col gap-2">
          {items.map((w) => (
            <li key={w} className="flex gap-2">
              <Glyph name="warning" size={14} className="mt-[3px] shrink-0 text-ink-orange" />
              <span>{w}</span>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
