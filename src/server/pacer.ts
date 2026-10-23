/**
 * Forwards PCM16 audio at real-time pace in 40 ms frames.
 *
 * Model audio arrives several times faster than real time. The Realtime API consumes input
 * audio at real-time speed, so a burst made the following commit wait behind it (up to ~20 s
 * in testing). Pacing it like a live microphone keeps commits and live captions on time.
 */
export class Pacer {
  private pending: Buffer = Buffer.alloc(0);
  private timer: NodeJS.Timeout | null = null;
  private next = 0;
  private drained: (() => void)[] = [];
  private stopped = false;
  private readonly frameBytes: number;

  constructor(
    private readonly sink: (frame: Buffer) => void,
    sampleRate = 24000,
    private readonly frameMs = 40,
  ) {
    this.frameBytes = Math.round((sampleRate * 2 * frameMs) / 1000);
  }

  push(buf: Buffer): void {
    if (this.stopped || buf.length === 0) return;
    this.pending = this.pending.length ? Buffer.concat([this.pending, buf]) : buf;
    if (!this.timer) {
      this.next = Date.now();
      this.tick();
    }
  }

  /** Run `cb` once everything pushed so far has been sent. */
  whenDrained(cb: () => void): void {
    if (!this.timer && this.pending.length === 0) cb();
    else this.drained.push(cb);
  }

  /** Audio still queued, in milliseconds. */
  get queuedMs(): number {
    return (this.pending.length / this.frameBytes) * this.frameMs;
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pending = Buffer.alloc(0);
    this.drained = [];
  }

  private tick = (): void => {
    this.timer = null;
    if (this.stopped) return;
    if (this.pending.length === 0) {
      const cbs = this.drained.splice(0);
      for (const cb of cbs) cb();
      return;
    }
    const n = Math.min(this.frameBytes, this.pending.length);
    this.sink(this.pending.subarray(0, n));
    this.pending = this.pending.subarray(n);
    this.next += this.frameMs;
    this.timer = setTimeout(this.tick, Math.max(0, this.next - Date.now()));
  };
}
