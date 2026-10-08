import { describe, expect, it } from 'vitest';
import type { RuntimeInstall, SoulEnvironment } from '../bridge';
import { sampleEnvironments } from './fixtures';
import {
  componentRows, environmentActions, environmentState, failedStep, harnessRows, historySummary, installOutcome, installProgress, installReducer, installSummary,
  memoryContinuity, migrationRequired, missingRuntimes, nextStep, planInstall, providerRows, runtimeRows, secretRows, toolSignIns, type InstallRun,
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
  it('offers install, adopt and migrate only with the capability and the engine-listed action', () => {
    expect(environmentActions(luna)).toEqual({ install: [{ name: 'node', version: '24.11.1', reason: 'not provisioned' }], adopt: 'codex', migrateSpace: true });
    // The older engine lists the same missing runtime but no capability: nothing is offered.
    expect(environmentActions(scout)).toEqual({ install: null, adopt: null, migrateSpace: false });
    expect(environmentActions(withCaps(luna, ['env', 'runtimes']))).toEqual({ install: [{ name: 'node', version: '24.11.1', reason: 'not provisioned' }], adopt: null, migrateSpace: false });
    // A capability without the problem listing its action offers nothing either.
    expect(environmentActions({ ...luna, readiness: { ready: true, problems: [] } })).toEqual({ install: null, adopt: null, migrateSpace: false });
    const noAction = { ...luna, readiness: { ...luna.readiness, problems: luna.readiness.problems.map((p) => ({ ...p, action: null })) } };
    expect(environmentActions(noAction)).toEqual({ install: null, adopt: null, migrateSpace: false });
  });

  it('never gates on the engine version', () => {
    expect(environmentActions({ ...withCaps(luna, []), engine: { ...luna.engine, version: '99.0.0', capabilities: [] } })).toEqual({ install: null, adopt: null, migrateSpace: false });
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
