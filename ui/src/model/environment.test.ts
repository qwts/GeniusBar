import { describe, expect, it } from 'vitest';
import type { RuntimeInstall, SoulCleanRow, SoulEnvironment } from '../bridge';
import { sampleEnvironments, sampleLifeExport, sampleLifeImport } from './fixtures';
import {
  classificationRows, cleanGroups, componentRows, defaultExportPath, environmentActions, environmentState, exportSummary, failedStep, formatBytes, harnessRows, historySummary, importChoices,
  installOutcome, installProgress, installReducer, installSummary, linkedWorkspaces, manifestClassifications, manifestPointers,
  memoryContinuity, migrationRequired, migrationStepStatus, missingRuntimes, nextStep, pendingMigrationSteps, planInstall, providerRows, refusalOf, runtimeRows, secretRows, toolSignIns, type InstallRun,
} from './environment';

const luna = sampleEnvironments.agent_p;
const scout = sampleEnvironments.agent_s;
const withCaps = (env: SoulEnvironment, capabilities: string[]): SoulEnvironment => ({ ...env, engine: { ...env.engine, capabilities } });

describe('the five environment states (#268)', () => {
  it('keeps offline, unsupported, partial errors, migration required and ready distinct', () => {
    expect(environmentState({ env: null, error: { code: 'soul-env-unavailable', message: 'no sidecar' } })).toBe('offline');
    expect(environmentState({ env: null, error: { code: 'soul-env-failed', message: 'EACCES' } })).toBe('offline');
    expect(environmentState({ env: null, error: null })).toBe('offline');
    expect(environmentState({ env: null, error: { code: 'soul-env-unsupported', message: 'old bundle' } })).toBe('unsupported');
    // luna has a partial-read error and a pending migration: the error comes first, the migration still shows.
    expect(environmentState({ env: luna, error: null })).toBe('partial-errors');
    expect(migrationRequired(luna)).toBe(true);
    expect(environmentState({ env: { ...luna, errors: [] }, error: null })).toBe('migration-required');
    expect(environmentState({ env: scout, error: null })).toBe('migration-required');
    const done = { ...scout, migration: { ...scout.migration, status: 'none', steps: [{ id: 'space-into-soul', status: 'done', from: null, to: null }] } };
    expect(environmentState({ env: done, error: null })).toBe('ready');
  });

  it('counts an interrupted step as migration still required, never as loss', () => {
    const interrupted = { ...scout, migration: { ...scout.migration, status: 'none', steps: [{ id: 'space-into-soul', status: 'copying', from: null, to: null }] } };
    expect(migrationRequired(interrupted)).toBe(true);
    const failed = { ...scout, migration: { ...scout.migration, status: 'none', steps: [{ id: 'space-into-soul', status: 'failed', from: null, to: null }] } };
    expect(migrationRequired(failed)).toBe(true);
  });
});

describe('rows from the descriptor', () => {
  it('lists every component with both dimensions, from the descriptor only', () => {
    const rows = componentRows(luna);
    expect(rows).toHaveLength(luna.components.length);
    expect(rows.find((r) => r.id === 'generated')).toEqual({ id: 'generated', path: null, classification: 'generated', retention: 'reconstructible', present: true, entries: null, paths: 3 });
    expect(rows.find((r) => r.id === 'skills')).toMatchObject({ classification: 'definition', retention: 'durable', present: true, entries: 1 });
    expect(rows.find((r) => r.id === 'host-tools')).toMatchObject({ classification: 'external', retention: null, present: true, entries: 2 });
    expect(rows.find((r) => r.id === 'hooks')).toMatchObject({ present: false });
  });

  it('names the runtimes the engine lists as declared but missing, nothing inferred', () => {
    expect(missingRuntimes(luna)).toEqual([{ name: 'node', version: '24.11.1', reason: 'not provisioned' }]);
    expect(missingRuntimes({ ...luna, runtimes: { ...luna.runtimes, missing: [{ version: '1' }, { name: '' }] } })).toEqual([]);
  });

  it('puts declared against installed for harnesses and runtimes, the selected harness first', () => {
    expect(harnessRows(luna)).toEqual([{ name: 'codex', declared: '0.52.0', installed: '0.52.0', status: 'installed', reason: null }]);
    expect(runtimeRows(luna)).toEqual([{ name: 'node', declared: '24.11.1', installed: null, status: 'missing', reason: 'not provisioned' }]);
    const env = { ...luna, harnesses: { ...luna.harnesses, selected: 'claude', declared: [{ name: 'claude', version: '2.0.0' }, { name: 'codex', version: '0.52.0' }], installed: [{ name: 'codex', version: '0.52.0' }] },
      runtimes: { declared: { python: { version: '3.12' }, go: '1.27' }, installed: [{ name: 'python', version: '3.12.15' }], missing: [], unsupported: [{ name: 'go', version: '1.27', reason: 'no download for this host' }] } };
    expect(harnessRows(env).map((r) => [r.name, r.status])).toEqual([['claude', 'missing'], ['codex', 'installed']]);
    expect(runtimeRows(env)).toEqual([
      { name: 'go', declared: '1.27', installed: null, status: 'unsupported', reason: 'no download for this host' },
      { name: 'python', declared: '3.12', installed: '3.12.15', status: 'installed', reason: null },
    ]);
  });

  it('reads sign-in state per harness from the tool-state component, existence only', () => {
    expect(toolSignIns(luna)).toEqual([{ harness: 'codex', signIn: 'not-signed-in', hostSignIn: 'signed-in', containment: 'shared-host', hostPath: '/Users/user/.codex' }]);
    expect(toolSignIns(scout)).toEqual([{ harness: 'claude', signIn: 'unknown', hostSignIn: 'unknown', containment: 'shared-host', hostPath: '/Users/user/.claude' }]);
    expect(toolSignIns({ ...luna, components: luna.components.filter((c) => c.id !== 'tool-state') })).toEqual([]);
  });

  it('shows secret status only: set, missing or unknown, never a value', () => {
    expect(secretRows(luna)).toEqual([{ name: 'openai-key', store: 'keychain', status: 'missing', usedBy: ['codex'] }]);
    const rows = secretRows({ ...luna, providers: { secrets: [{ name: 'a', status: 'present', value: 'sk-SHOULD-NEVER-SHOW' }, { name: 'b', status: 'unreadable' }] } });
    expect(rows).toEqual([{ name: 'a', store: null, status: 'set', usedBy: [] }, { name: 'b', store: null, status: 'unknown', usedBy: [] }]);
    expect(JSON.stringify(rows)).not.toContain('SHOULD-NEVER-SHOW');
    expect(providerRows(luna)).toEqual([{ harness: 'codex', id: 'openai', name: 'OpenAI', status: 'secret-missing', credential: 'openai-key' }]);
    expect(providerRows(scout)).toEqual([]);
  });

  it('says whether memory travels with the soul, from the memory component and the capability', () => {
    expect(memoryContinuity(luna)).toBe('needs-migration');
    expect(memoryContinuity(scout)).toBe('unsupported');
    const inside = { ...luna, components: luna.components.map((c) => (c.id === 'memory' ? { ...c, location: 'inside' } : c)), migration: { status: 'none', journal: null, steps: [] } };
    expect(memoryContinuity(inside)).toBe('ready');
    expect(memoryContinuity({ ...inside, errors: [{ area: 'memory', message: 'Agent Space could not be inspected.' }] })).toBe('unavailable');
    expect(memoryContinuity({ ...inside, components: inside.components.filter((c) => c.id !== 'memory') })).toBe('unavailable');
    expect(historySummary(luna)).toEqual({ mirrored: true, turns: 42, revisions: 3, external: [{ what: 'revision journal', present: true }, { what: 'task turns', present: true }] });
    expect(historySummary(scout)).toBeNull();
  });
});

describe('capability-gated actions', () => {
  const none = { install: null, adopt: null, migrateSpace: false, clean: false, complete: false, export: false, import: false };

  it('offers install, adopt and migrate only with the capability and the engine-listed action', () => {
    expect(environmentActions(luna)).toEqual({ install: [{ name: 'node', version: '24.11.1', reason: 'not provisioned' }], adopt: 'codex', migrateSpace: true, clean: true, complete: true, export: true, import: true });
    // The older engine lists the same missing runtime but no capability: nothing is offered.
    expect(environmentActions(scout)).toEqual(none);
    expect(environmentActions(withCaps(luna, ['env', 'runtimes']))).toEqual({ ...none, install: [{ name: 'node', version: '24.11.1', reason: 'not provisioned' }] });
    // A capability without the problem listing its action offers nothing either.
    expect(environmentActions({ ...withCaps(luna, ['env', 'runtimes', 'tool-homes', 'memory']), readiness: { ready: true, problems: [] } })).toEqual(none);
    const noAction = { ...withCaps(luna, ['env', 'runtimes', 'tool-homes', 'memory']), readiness: { ...luna.readiness, problems: luna.readiness.problems.map((p) => ({ ...p, action: null })) } };
    expect(environmentActions(noAction)).toEqual(none);
  });

  it('offers the clean on its capability alone, and the completion only with a step still to finish', () => {
    expect(environmentActions(withCaps(luna, ['env-clean']))).toEqual({ ...none, clean: true });
    expect(environmentActions(withCaps(luna, ['migrate-complete']))).toEqual({ ...none, complete: true });
    const finished = { ...withCaps(luna, ['migrate-complete']), migration: { ...luna.migration, steps: luna.migration.steps.map((s) => ({ ...s, status: s.id === 'space-into-soul' ? 'done' : 'skipped' })) } };
    expect(environmentActions(finished)).toEqual(none);
    expect(pendingMigrationSteps(luna).map((s) => s.id)).toEqual(['space-into-soul', 'adopt-host-signin:codex']);
    expect(pendingMigrationSteps(finished)).toEqual([]);
    // An interrupted phase is still pending.
    expect(pendingMigrationSteps({ ...luna, migration: { ...luna.migration, steps: [{ id: 'space-into-soul', status: 'copying', from: null, to: null }] } }).length).toBe(1);
  });

  it('offers the export and the import each on its own capability (slice 7)', () => {
    expect(environmentActions(withCaps(luna, ['env-export']))).toEqual({ ...none, export: true });
    expect(environmentActions(withCaps(luna, ['env-import']))).toEqual({ ...none, import: true });
    expect(environmentActions(withCaps(luna, ['env-export', 'env-import', 'env-clean']))).toEqual({ ...none, export: true, import: true, clean: true });
  });

  it('never gates on the engine version', () => {
    expect(environmentActions({ ...withCaps(luna, []), engine: { ...luna.engine, version: '99.0.0', capabilities: [] } })).toEqual(none);
  });
});

describe('the clean and completion helpers', () => {
  const row = (component: string, relative: string, files: number | null, bytes: number | null): SoulCleanRow =>
    ({ component, relative, path: `/s/${relative}`, classification: 'cache', retention: 'reconstructible', kind: 'cache-entry', files, bytes, reason: null, error: null });

  it('groups the rows by component with the counts summed from the rows, in the engine order', () => {
    const groups = cleanGroups([row('cache', 'a', 1, 12), row('runtimes', 'r', 3, 900), row('cache', 'b', 2, 30), row('temp', 't', null, null)]);
    expect(groups.map((g) => [g.component, g.files, g.bytes, g.rows.map((r) => r.relative)])).toEqual([
      ['cache', 3, 42, ['a', 'b']], ['runtimes', 3, 900, ['r']], ['temp', 0, 0, ['t']],
    ]);
    expect(cleanGroups([])).toEqual([]);
  });

  it('formats sizes for a line of text, never inventing one', () => {
    expect([formatBytes(null), formatBytes(0), formatBytes(1023), formatBytes(1024), formatBytes(1_572_864), formatBytes(48_234_496), formatBytes(5 * 1024 ** 3)])
      .toEqual(['—', '0 B', '1023 B', '1.0 KB', '1.5 MB', '46 MB', '5.0 GB']);
  });

  it("keeps the engine's refusal with its action, and leaves the action out when the engine named none", () => {
    expect(refusalOf({ code: 'soul-running', message: 'agent_p is running', action: 'agent-bot soul stop agent_p' })).toEqual({ code: 'soul-running', message: 'agent_p is running', action: 'agent-bot soul stop agent_p' });
    expect(refusalOf({ code: 'clean-component-durable', message: 'memory is durable', action: '' })).toEqual({ code: 'clean-component-durable', message: 'memory is durable', action: null });
    expect(refusalOf(new Error('boom'))).toEqual({ code: 'failed', message: 'boom', action: null });
  });

  it("maps a migration step's status to the handoff's four states, anything else shown as the engine said", () => {
    expect(['done', 'failed', 'skipped', 'pending', 'copying', null].map(migrationStepStatus)).toEqual(['completed', 'failed', 'skipped', 'not-started', 'other', 'other']);
  });
});

describe('the install run', () => {
  const report = (overrides: Partial<RuntimeInstall> = {}): RuntimeInstall => ({ agentId: 'agent_p', ready: true, installed: [], skipped: [], runtimes: [], harnesses: [], ...overrides });

  it('plans one step per missing runtime, all not started, and runs them in order', () => {
    let run: InstallRun = planInstall([{ name: 'uv', version: '0.12.23', reason: null }, { name: 'python', version: '3.12.15', reason: null }]);
    expect(run).toEqual({ phase: 'plan', current: null, ready: null, steps: [
      { runtime: 'uv', version: '0.12.23', status: 'not-started', message: null }, { runtime: 'python', version: '3.12.15', status: 'not-started', message: null }] });
    expect(installSummary(run)).toBeNull();
    expect(installProgress(run)).toBeNull();
    expect(nextStep(run)).toBe(0);
    run = installReducer(run, { type: 'begin', index: 0 });
    expect(run.phase).toBe('running');
    expect(installProgress(run)).toEqual({ step: 1, total: 2 });
    run = installReducer(run, { type: 'finish', index: 0, outcome: 'completed', message: null, ready: false });
    expect(run.phase).toBe('running');
    expect(nextStep(run)).toBe(1);
    run = installReducer(run, { type: 'begin', index: 1 });
    expect(installProgress(run)).toEqual({ step: 2, total: 2 });
    run = installReducer(run, { type: 'finish', index: 1, outcome: 'completed', message: null, ready: true });
    expect(run.phase).toBe('finished');
    expect(run.steps.map((s) => s.status)).toEqual(['completed', 'completed']);
    expect(installSummary(run)).toBe('success');
  });

  it('stops at a failure, leaves the rest not started, claims no rollback, and Retry re-runs the failed step', () => {
    let run = planInstall([{ name: 'uv', version: null, reason: null }, { name: 'python', version: null, reason: null }]);
    run = installReducer(run, { type: 'begin', index: 0 });
    run = installReducer(run, { type: 'finish', index: 0, outcome: 'failed', message: 'could not download', ready: null });
    expect(run.phase).toBe('finished');
    expect(run.steps.map((s) => s.status)).toEqual(['failed', 'not-started']);
    expect(installSummary(run)).toBe('failure');
    expect(failedStep(run)).toEqual({ runtime: 'uv', version: null, status: 'failed', message: 'could not download' });
    run = installReducer(run, { type: 'retry' });
    expect(run.phase).toBe('running');
    expect(run.steps.map((s) => s.status)).toEqual(['not-started', 'not-started']);
    expect(nextStep(run)).toBe(0);
  });

  it('reports an unknown outcome as such, and success only when the engine said ready', () => {
    let run = planInstall([{ name: 'node', version: null, reason: null }]);
    run = installReducer(run, { type: 'begin', index: 0 });
    const unknown = installReducer(run, { type: 'finish', index: 0, outcome: 'unknown', message: null, ready: null });
    expect(installSummary(unknown)).toBe('unknown');
    const notReady = installReducer(run, { type: 'finish', index: 0, outcome: 'completed', message: null, ready: false });
    expect(installSummary(notReady)).toBe('done-not-ready');
    const silent = installReducer(run, { type: 'finish', index: 0, outcome: 'completed', message: null, ready: null });
    expect(installSummary(silent)).toBe('unknown');
  });

  it('reads each outcome from the engine report alone', () => {
    expect(installOutcome(report({ installed: ['node'] }), 'node')).toEqual({ outcome: 'completed', message: null });
    expect(installOutcome(report({ skipped: ['node'] }), 'node')).toEqual({ outcome: 'completed', message: null });
    expect(installOutcome(report({ runtimes: [{ name: 'node', status: 'installed', version: '24.11.1', lastError: null }] }), 'node')).toEqual({ outcome: 'completed', message: null });
    expect(installOutcome(report({ runtimes: [{ name: 'node', status: 'missing', version: '24.11.1', lastError: { code: 'runtime-checksum-mismatch', message: 'the download is corrupt' } }] }), 'node'))
      .toEqual({ outcome: 'failed', message: 'the download is corrupt' });
    expect(installOutcome(report({ harnesses: [{ name: 'opencode', status: 'installed', version: '1.2.3', lastError: null }] }), 'opencode')).toEqual({ outcome: 'completed', message: null });
    expect(installOutcome(report(), 'node')).toEqual({ outcome: 'unknown', message: null });
  });
});

describe("the life export and import helpers (slice 7)", () => {
  const manifest = sampleLifeExport.manifest;

  it('sums the manifest per classification from entries that carry bytes, in the manifest\'s order, and the engine\'s totals as they are', () => {
    expect(manifestClassifications(manifest)).toEqual([
      { classification: 'definition', files: 4, bytes: 6_260 },
      { classification: 'private-home', files: 4, bytes: 48_735 },
      { classification: 'memory', files: 2, bytes: 7_520 },
      { classification: 'history', files: 2, bytes: 133_120 },
      { classification: 'workspace', files: 5, bytes: 5_056 },
    ]);
    // A directory row and a pointer without an entry carry no bytes.
    expect(manifestClassifications({ ...manifest, components: [{ ...manifest.components[0], kind: 'dir' }, { ...manifest.components[0], entry: null }, { ...manifest.components[0], classification: null }] }))
      .toEqual([{ classification: 'unclassified', files: 1, bytes: 1_204 }]);
    expect(exportSummary(manifest)).toEqual({ files: 17, bytes: 200_209, excluded: 5, linked: 1, pointers: 1, journalEntries: 3 });
    expect(exportSummary({ ...manifest, totals: { files: null, bytes: null }, journal: { entries: null }, excluded: [], workspaces: [] })).toEqual({ files: 0, bytes: 0, excluded: 0, linked: 0, pointers: 1, journalEntries: 0 });
    expect(manifestPointers(manifest).map((p) => [p.relative, p.target])).toEqual([['.soul-state/space', '/Users/user/space/luna']]);
    expect(linkedWorkspaces(manifest.workspaces).map((w) => w.name)).toEqual(['site']);
    expect(classificationRows(sampleLifeImport.restored.byClassification)[0]).toEqual({ classification: 'definition', files: 4, bytes: 6_260 });
  });

  it('offers the identity choices the engine leaves open: none for a moved life, replace or fork for an active ID, fork only for a retired one', () => {
    expect(importChoices(sampleLifeImport, null)).toEqual([]);
    expect(importChoices(null, { code: 'import-id-active', message: 'active', action: 'add --replace or --fork' })).toEqual(['replace', 'fork']);
    expect(importChoices(null, { code: 'import-id-retired', message: 'retired', action: 'add --fork' })).toEqual(['fork']);
    expect(importChoices(null, { code: 'import-unsafe-archive', message: 'a symlink', action: null })).toEqual([]);
    expect(importChoices(null, null)).toEqual([]);
    const active = { status: 'active', soulDir: '/s' };
    expect(importChoices({ ...sampleLifeImport, identity: { decision: 'replace', agentId: 'agent_p', importedFrom: 'agent_p', existing: active } }, null)).toEqual(['replace', 'fork']);
    expect(importChoices({ ...sampleLifeImport, identity: { decision: 'fork', agentId: null, importedFrom: 'agent_p', existing: active } }, null)).toEqual(['replace', 'fork']);
    expect(importChoices({ ...sampleLifeImport, identity: { decision: 'fork', agentId: null, importedFrom: 'agent_p', existing: { status: 'retired', soulDir: null } } }, null)).toEqual(['fork']);
    expect(importChoices({ ...sampleLifeImport, identity: { decision: 'fork', agentId: null, importedFrom: 'agent_p', existing: null } }, null)).toEqual([]);
  });

  it('names the default destination after the soul, on the Desktop, file-safe', () => {
    expect(defaultExportPath('luna', 'agent_p')).toBe('~/Desktop/luna.soul-life.tar.gz');
    expect(defaultExportPath('Luna Two / Beta', 'agent_p')).toBe('~/Desktop/Luna-Two-Beta.soul-life.tar.gz');
    expect(defaultExportPath(null, 'agent_p')).toBe('~/Desktop/agent_p.soul-life.tar.gz');
    expect(defaultExportPath('///', 'agent_p')).toBe('~/Desktop/agent_p.soul-life.tar.gz');
  });
});
