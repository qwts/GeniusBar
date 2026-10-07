import { describe, expect, it } from 'vitest';
import { translate } from '../lib/i18n';
import { en } from './en';
import { es } from './es';

describe('locales', () => {
  it('gives Spanish exactly the English keys, none empty', () => {
    expect(Object.keys(es).sort()).toEqual(Object.keys(en).sort());
    expect(Object.values(es).every((text) => text.trim() !== '')).toBe(true);
  });

  it('keeps every placeholder in each translation', () => {
    const holes = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const key of Object.keys(en) as (keyof typeof en)[]) expect(holes(es[key]), key).toEqual(holes(en[key]));
  });

  it('fills placeholders', () => {
    expect(translate('en', 'bar.showAll', { count: 3 })).toBe('Show all hidden (3)');
    expect(translate('es', 'composerLabel', { name: 'luna' })).toBe('Mensaje para luna');
  });

  it('speaks the design\'s Spanish (T1-T13, S8)', () => {
    expect(es['menu.view']).toBe('Vista');
    expect(es['setup.needs']).toContain('en este equipo');
    expect(es['status.checking']).toBe('Comprobando conexión…');
    expect(es['sandbox.desc']).toContain('separada');
    expect(translate('es', 'sandbox.ready', { account: 'gb-luna' })).toBe('La cuenta “gb-luna” está lista');
    expect(es['sandbox.inherit']).toBe('Usar ajuste de GeniusBar ({value})');
    expect(es['menu.resetLayout']).toBe('Restablecer escritorio');
    expect(es['harness.none']).toBe('Ninguno — preguntar siempre');
    expect(es.desktopHint).toBe('Arrastra los equipos por su título. Clic derecho para ocultar. ⌘K para saltar.');
    expect([es['comms.on'], es['comms.off']]).toEqual(['Activado', 'Desactivado']);
    expect(en.emptyChat).toContain("they'll");
    expect(es['field.parent']).toBe('Superior');
  });

  it('calls a harness "arnés", a template "Alma" and a left companion "Desconectado" (T2-T4)', () => {
    const spanish = Object.values(es).join('\n').replaceAll('{harness}', '');
    expect(spanish).not.toMatch(/\bharness/i);
    expect(es['harness.defaultTitle']).toBe('Arnés predeterminado');
    expect(es['launch.harnessHint']).toBe('GeniusBar no ejecuta modelos — lo hace el arnés.');
    expect(es['launch.template']).toBe('Alma');
    expect(es['presence.left']).toBe('Desconectado');
  });
});
