/**
 * The design's shadcn looks as class strings, for the panels with no Lovable
 * screen (starter, Remove services, update line, command-line tools), so
 * they match the cards around them instead of the old shared classes.
 */
const button = 'inline-flex min-h-7 items-center justify-center gap-1.5 rounded-md px-3 py-1 text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50';
/** shadcn Button, default variant (size sm). */
export const primaryButton = `${button} bg-primary text-primary-foreground shadow hover:bg-primary/90`;
/** shadcn Button, outline/secondary variant. */
export const secondaryButton = `${button} border border-border bg-secondary text-secondary-foreground hover:bg-accent`;
/** shadcn Button, destructive variant. */
export const destructiveButton = `${button} bg-destructive text-destructive-foreground shadow hover:bg-destructive/90`;
/** A text link, as the setup footer's. */
export const textLink = 'inline-flex items-center gap-1 rounded-sm text-xs text-info outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring';
/** A failure line under a control. */
export const errorLine = 'm-0 text-[11px] text-destructive';
/** A quiet status or hint line. */
export const mutedLine = 'm-0 text-xs text-muted-foreground';
/** A row of actions, right-aligned. */
export const actions = 'flex flex-wrap items-center justify-end gap-2';
