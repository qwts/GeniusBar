import { useEffect, useRef, useState } from 'react';
import { Check, MoreHorizontal } from 'lucide-react';
import { useI18n } from '../lib/i18n';
import { menuKeys } from '../lib/keys';

export type FooterItem = {
  label: string; run: () => void; destructive?: boolean;
  /** A switch (#223): a checkable item, ticked while on. */
  checked?: boolean;
} | 'separator';

/**
 * The G menu footer's ⋯ (Lovable 20.03.42): a floating menu of the
 * actions the design keeps out of sight. Falsy items are skipped, and a
 * separator only shows between items. Up / Down / Home / End move between
 * the items (as Radix DropdownMenu); Escape closes it and hands focus back
 * to ⋯, as does a click outside.
 */
export function FooterMenu({ items }: { items: readonly (FooterItem | false | null | undefined | '')[] }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const first = useRef<HTMLButtonElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    first.current?.focus();
    const away = (e: PointerEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [open]);
  const shown = items.filter((item): item is FooterItem => Boolean(item))
    .filter((item, i, all) => item !== 'separator' || (i > 0 && i < all.length - 1 && all[i - 1] !== 'separator'));
  let firstSet = false;
  return (
    <div ref={root} className="relative" onKeyDown={(e) => { if (e.key === 'Escape' && open) { setOpen(false); trigger.current?.focus(); } }}>
      <button ref={trigger} type="button" aria-label={t('more')} title={t('more')} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}
        className={`rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none ${open ? 'bg-accent text-foreground' : ''}`}>
        <MoreHorizontal className="size-3.5" aria-hidden />
      </button>
      {open && (
        <div role="menu" aria-label={t('more')} onKeyDown={menuKeys}
          className="absolute right-0 bottom-full z-50 mb-1 grid w-52 rounded-md border border-border bg-popover p-1 text-xs shadow-md">
          {shown.map((item, i) => {
            if (item === 'separator') return <div key={`sep-${i}`} role="separator" className="-mx-1 my-1 h-px bg-border" />;
            const ref = firstSet ? undefined : first;
            firstSet = true;
            return (
              <button key={item.label} ref={ref} type="button" role={item.checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
                aria-checked={item.checked}
                onClick={() => { setOpen(false); item.run(); }}
                className={`flex items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent focus-visible:bg-accent focus-visible:outline-none ${item.destructive ? 'text-destructive' : ''}`}>
                {item.checked !== undefined && <Check className={`size-3.5 shrink-0 ${item.checked ? '' : 'invisible'}`} aria-hidden />}
                {item.label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
