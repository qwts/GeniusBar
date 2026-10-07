/**
 * A quiet dashed border while a `.soul` package is dragged over a window
 * (#98); no Lovable screen draws one. `fill` covers the whole window, else
 * it covers its positioned parent (a team card).
 */
export function DropCue({ fill = false }: { fill?: boolean }) {
  return (
    <div data-testid="soul-drop-cue" aria-hidden="true"
      className={`pointer-events-none z-50 rounded-lg border-2 border-dashed border-primary/60 ${fill ? 'fixed inset-1' : 'absolute inset-0'}`} />
  );
}
