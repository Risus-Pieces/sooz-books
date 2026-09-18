/**
 * The macOS menu material, shared by dropdown menus, selects, pop-up buttons and the command
 * palette: frosted glass, a 10px radius, rows that highlight in the accent with white text.
 */
export const menuSurface =
  "z-50 min-w-40 overflow-hidden rounded-[10px] vibrancy p-[5px] text-label shadow-glass outline-none data-[state=open]:anim-pop-in data-[state=closed]:anim-pop-out";

export const menuItem =
  "relative flex min-h-[26px] cursor-default items-center gap-2 rounded-[5px] px-2 py-[3px] text-sm outline-none select-none max-sm:min-h-11 data-[disabled]:pointer-events-none data-[disabled]:opacity-40 data-[highlighted]:bg-accent-fill data-[highlighted]:text-white [&_svg]:size-3.5 [&_svg]:shrink-0 [&_svg]:text-label2 data-[highlighted]:[&_svg]:text-white";

export const menuLabel = "px-2 pt-1.5 pb-1 text-2xs font-semibold text-label2";

export const menuSeparator = "mx-2 my-[5px] h-0 border-t-[0.5px] border-sep";

/** A macOS text field: white bezel, hairline, blue focus halo. 16px on a phone so iOS never zooms. */
export const fieldBase =
  "h-8 w-full rounded-[7px] bg-ctl px-2.5 text-sm text-label shadow-ctl transition-shadow duration-150 outline-none placeholder:text-label2 focus-visible:shadow-[0_0_0_3px_color-mix(in_srgb,var(--blue)_45%,transparent),0_0_0_0.5px_var(--blue)] focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50 max-sm:h-11 max-sm:text-[1rem]";

export const fieldInvalid =
  "shadow-[0_0_0_1px_var(--red)] focus-visible:shadow-[0_0_0_3px_color-mix(in_srgb,var(--red)_40%,transparent),0_0_0_1px_var(--red)]";
