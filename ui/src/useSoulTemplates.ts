// The launch form's soul templates (#65): agent-bot's `soul templates`,
// asked once when the form opens. An older bundle without the command, or
// no lister (a relaunch, the preview without fixtures), leaves the form as
// it was: the package path field alone. Never blocks the form.
import { useEffect, useState } from 'react';
import type { SoulTemplate, SoulTemplateList } from './bridge';

export type TemplateLister = () => Promise<SoulTemplateList>;

export interface SoulTemplatesApi {
  templates: SoulTemplate[];
  /** True once agent-bot answered a listing; false before, on an older bundle, or on failure. */
  supported: boolean;
  /**
   * Why the listing failed (never for an older bundle), or, beside a
   * listing, the packages agent-bot could not read, one per line.
   */
  error: string | null;
}

const NONE: SoulTemplatesApi = { templates: [], supported: false, error: null };

export function useSoulTemplates(lister: TemplateLister | undefined): SoulTemplatesApi {
  const [state, setState] = useState<SoulTemplatesApi>(NONE);
  useEffect(() => {
    setState(NONE);
    if (!lister) return;
    let current = true;
    lister().then(
      (list) => {
        if (!current) return;
        const error = list.errors.length > 0 ? list.errors.map((e) => (e.package ? `${e.package}: ${e.message}` : e.message)).join('\n') : null;
        setState({ templates: list.templates, supported: true, error });
      },
      (failure: unknown) => {
        if (!current) return;
        const e = failure as { code?: unknown; message?: unknown };
        const unsupported = e?.code === 'soul-templates-unsupported';
        setState({ ...NONE, error: unsupported ? null : typeof e?.message === 'string' ? e.message : String(failure) });
      },
    );
    return () => { current = false; };
  }, [lister]);
  return state;
}
