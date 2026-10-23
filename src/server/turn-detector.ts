/**
 * Energy-based end-of-turn detector that runs on the server for each mic stream.
 *
 * The app decides turn boundaries itself (turn_detection: null) because the Realtime API's
 * server VAD assumes the speaker hears the assistant: in testing it dropped ~19% of turns that
 * started while the previous translation was still playing on the listener's side.
 */

export type TurnDetectorOptions = {
  sampleRate: number;
  /** Silence that ends a turn. */
  endSilenceMs: number;
  /** Audio kept from before speech onset so the first syllable is not clipped. */
  prerollMs?: number;
  /** Turns with less voiced audio than this are discarded (coughs, clicks). */
  minSpeechMs?: number;
  /** After this long, a shorter pause also ends the turn so long monologues are translated in chunks. */
  chunkAfterMs?: number;
  chunkPauseMs?: number;
  /** Hard cap; the turn is committed even without a pause. */
  maxTurnMs?: number;
};

export type TurnEvent =
  | { type: 'start'; preroll: Int16Array[] }
  | { type: 'audio'; frame: Int16Array }
  | { type: 'end'; reason: 'silence' | 'chunk' | 'max'; speechMs: number }
  | { type: 'discard'; speechMs: number };

const FRAME_MS = 20;

export class TurnDetector {
  private readonly opts: Required<TurnDetectorOptions>;
  private readonly frameSamples: number;
  private pending = new Int16Array(0);
  private preroll: Int16Array[] = [];
  private noiseFloorDb = -60;
  private inTurn = false;
  private onsetFrames = 0;
  private silenceMs = 0;
  private speechMs = 0;
  private turnMs = 0;

  constructor(opts: TurnDetectorOptions) {
    this.opts = {
      prerollMs: 300,
      minSpeechMs: 240,
      chunkAfterMs: 9_000,
      chunkPauseMs: 320,
      maxTurnMs: 15_000,
      ...opts,
    };
    this.frameSamples = Math.round((opts.sampleRate * FRAME_MS) / 1000);
  }

  get speaking(): boolean {
    return this.inTurn;
  }

  setEndSilence(ms: number): void {
    this.opts.endSilenceMs = ms;
  }

  /** Feed any number of samples; returns the events they produced in order. */
  push(samples: Int16Array): TurnEvent[] {
    const merged = new Int16Array(this.pending.length + samples.length);
    merged.set(this.pending);
    merged.set(samples, this.pending.length);
    const events: TurnEvent[] = [];
    let off = 0;
    for (; off + this.frameSamples <= merged.length; off += this.frameSamples) {
      this.frame(merged.slice(off, off + this.frameSamples), events);
    }
    this.pending = merged.slice(off);
    return events;
  }

  /** Force the current turn to end (push-to-talk release, mic stop). */
  flush(): TurnEvent[] {
    if (!this.inTurn) return [];
    return [this.finish('silence')];
  }

  reset(): void {
    this.inTurn = false;
    this.onsetFrames = 0;
    this.silenceMs = 0;
    this.speechMs = 0;
    this.turnMs = 0;
    this.preroll = [];
    this.pending = new Int16Array(0);
  }

  private frame(frame: Int16Array, events: TurnEvent[]): void {
    const db = levelDb(frame);
    const threshold = Math.max(this.noiseFloorDb + 10, -52);
    const voiced = db > threshold;

    if (!this.inTurn) {
      this.trackNoise(db);
      this.preroll.push(frame);
      const maxPre = Math.ceil(this.opts.prerollMs / FRAME_MS);
      if (this.preroll.length > maxPre) this.preroll.shift();
      this.onsetFrames = voiced ? this.onsetFrames + 1 : Math.max(0, this.onsetFrames - 1);
      if (this.onsetFrames >= 4) {
        this.inTurn = true;
        this.silenceMs = 0;
        this.speechMs = this.onsetFrames * FRAME_MS;
        this.turnMs = this.preroll.length * FRAME_MS;
        events.push({ type: 'start', preroll: this.preroll });
        this.preroll = [];
      }
      return;
    }

    events.push({ type: 'audio', frame });
    this.turnMs += FRAME_MS;
    // A little hysteresis so trailing syllables keep the turn open.
    if (db > threshold - 4) {
      this.speechMs += FRAME_MS;
      this.silenceMs = 0;
    } else {
      this.silenceMs += FRAME_MS;
    }

    if (this.turnMs >= this.opts.maxTurnMs) {
      events.push(this.finish('max'));
    } else if (this.turnMs >= this.opts.chunkAfterMs && this.silenceMs >= this.opts.chunkPauseMs) {
      events.push(this.finish('chunk'));
    } else if (this.silenceMs >= this.opts.endSilenceMs) {
      events.push(this.finish('silence'));
    }
  }

  private finish(reason: 'silence' | 'chunk' | 'max'): TurnEvent {
    const speechMs = this.speechMs;
    this.inTurn = false;
    this.onsetFrames = 0;
    this.silenceMs = 0;
    this.speechMs = 0;
    this.turnMs = 0;
    if (speechMs < this.opts.minSpeechMs) return { type: 'discard', speechMs };
    return { type: 'end', reason, speechMs };
  }

  private trackNoise(db: number): void {
    // Falls quickly to quiet levels, rises slowly so speech does not raise the floor.
    const rate = db < this.noiseFloorDb ? 0.3 : 0.01;
    this.noiseFloorDb += (db - this.noiseFloorDb) * rate;
    this.noiseFloorDb = Math.min(Math.max(this.noiseFloorDb, -90), -30);
  }
}

export function levelDb(frame: Int16Array): number {
  let sum = 0;
  for (let i = 0; i < frame.length; i++) sum += frame[i]! * frame[i]!;
  const rms = Math.sqrt(sum / Math.max(1, frame.length));
  return rms <= 0 ? -100 : 20 * Math.log10(rms / 32768);
}
