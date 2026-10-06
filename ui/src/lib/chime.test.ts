import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface FakeOsc { frequency: { value: number }; type: string; start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>; connect: (n: unknown) => unknown }

function installFakeAudio() {
  const oscillators: FakeOsc[] = [];
  const peaks: number[] = [];
  class FakeAudioContext {
    currentTime = 10;
    destination = {};
    createOscillator() {
      const osc: FakeOsc = { frequency: { value: 0 }, type: '', start: vi.fn(), stop: vi.fn(), connect: (n) => n };
      oscillators.push(osc);
      return osc;
    }
    createGain() {
      return {
        gain: {
          setValueAtTime: vi.fn(),
          linearRampToValueAtTime: vi.fn((v: number) => { peaks.push(v); }),
          exponentialRampToValueAtTime: vi.fn(),
        },
        connect: (n: unknown) => n,
      };
    }
  }
  vi.stubGlobal('AudioContext', FakeAudioContext);
  return { oscillators, peaks };
}

describe('chime (#122)', () => {
  beforeEach(() => { vi.resetModules(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('plays "ask" as two rising sine notes 0.12 s apart', async () => {
    const audio = installFakeAudio();
    const { chime } = await import('./chime');
    chime('ask');
    expect(audio.oscillators.map((o) => o.frequency.value)).toEqual([660, 880]);
    expect(audio.oscillators.every((o) => o.type === 'sine')).toBe(true);
    expect(audio.oscillators.map((o) => o.start.mock.calls[0][0])).toEqual([10, 10.12]);
    expect(audio.peaks).toEqual([0.08, 0.08]);
  });

  it('plays "done" as two falling notes', async () => {
    const audio = installFakeAudio();
    const { chime } = await import('./chime');
    chime('done');
    expect(audio.oscillators.map((o) => o.frequency.value)).toEqual([784, 523]);
  });

  it('does not throw when AudioContext is missing', async () => {
    vi.stubGlobal('AudioContext', undefined);
    const { chime } = await import('./chime');
    expect(() => chime('ask')).not.toThrow();
  });
});
