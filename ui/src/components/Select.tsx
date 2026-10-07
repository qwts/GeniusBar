import type { SelectHTMLAttributes } from 'react';
import { ChevronDown } from 'lucide-react';

/**
 * A native select drawn as the design's Select trigger (Lovable
 * components/ui/select.tsx): rounded, input border, transparent, a soft
 * shadow, and its ChevronDown at half opacity instead of the system arrow.
 * `className` sizes the trigger (height, text, padding; room on the right
 * for the chevron unless it sets its own `pr-`), `wrapperClassName` places
 * it, and `chevronClassName` moves the chevron.
 */
export function Select({ className = '', wrapperClassName = '', chevronClassName = 'right-2', children, ...props }: SelectHTMLAttributes<HTMLSelectElement> & {
  wrapperClassName?: string; chevronClassName?: string;
}) {
  const room = /(^|\s)pr-/.test(className) ? '' : 'pr-7';
  return (
    <span className={`relative inline-flex ${wrapperClassName}`}>
      <select {...props}
        className={`w-full appearance-none rounded-md border border-input bg-transparent text-foreground shadow-sm ${room} ${className}`}>
        {children}
      </select>
      <ChevronDown className={`pointer-events-none absolute top-1/2 h-4 w-4 -translate-y-1/2 opacity-50 ${chevronClassName}`} aria-hidden />
    </span>
  );
}
