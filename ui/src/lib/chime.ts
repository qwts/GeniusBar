// Ported as is from the Lovable design's src/lib/chime.ts (#122).
let ctx: AudioContext | null = null;

/** Soft two-note cue. "ask" rises (needs you), "done" falls (finished). */
export function chime(kind: "ask" | "done") {
  if (typeof window === "undefined") return;
  try {
    ctx ??= new AudioContext();
    const notes = kind === "ask" ? [660, 880] : [784, 523];
    notes.forEach((freq, i) => {
      const osc = ctx!.createOscillator();
      const gain = ctx!.createGain();
      const t = ctx!.currentTime + i * 0.12;
      osc.frequency.value = freq;
      osc.type = "sine";
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(0.08, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
      osc.connect(gain).connect(ctx!.destination);
      osc.start(t);
      osc.stop(t + 0.32);
    });
  } catch {
    /* audio unavailable */
  }
}
