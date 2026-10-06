// The launch form's soul picker (#65, Lovable launch dialog "1 · Soul"):
// one choice per agent-bot soul template, keyed by its package path, plus
// "Custom soul", which is the package path field the form always had.
import type { SoulTemplate } from '../bridge';

/** The "Custom soul" choice: launch the package path typed or opened. */
export const CUSTOM_SOUL = 'custom';

/**
 * The choice before the owner picks one: "Custom soul" when a package was
 * opened (Finder, a copied folder) or a path was already typed, else the
 * first template, as the design preselects a soul.
 */
export function initialChoice(templates: readonly SoulTemplate[], packagePath: string, opened: boolean): string {
  if (opened || packagePath.trim() !== '' || templates.length === 0) return CUSTOM_SOUL;
  return templates[0].package;
}

/** The template a choice names, or null for "Custom soul" or one no longer listed. */
export function chosenTemplate(templates: readonly SoulTemplate[], choice: string): SoulTemplate | null {
  if (choice === CUSTOM_SOUL) return null;
  return templates.find((t) => t.package === choice) ?? null;
}
