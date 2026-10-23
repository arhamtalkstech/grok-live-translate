import { describe, expect, it } from 'vitest';
import { Pacer } from './pacer.js';

describe('Pacer', () => {
  it('forwards a burst at real-time pace in 40 ms frames and reports drain', async () => {
    const frames: { at: number; bytes: number }[] = [];
    const t0 = Date.now();
    const pacer = new Pacer(f => frames.push({ at: Date.now() - t0, bytes: f.length }));
    pacer.push(Buffer.alloc(24000 * 2 * 0.4)); // 400 ms of audio at once
    const drainedAt = await new Promise<number>(r => pacer.whenDrained(() => r(Date.now() - t0)));
    expect(frames).toHaveLength(10);
    expect(frames.every(f => f.bytes === 1920)).toBe(true);
    // Ten frames 40 ms apart: the last one goes out about 360 ms after the first.
    expect(frames.at(-1)!.at - frames[0]!.at).toBeGreaterThanOrEqual(330);
    expect(drainedAt).toBeGreaterThanOrEqual(380);
  });

  it('calls whenDrained immediately when idle', () => {
    let called = false;
    new Pacer(() => {}).whenDrained(() => (called = true));
    expect(called).toBe(true);
  });
});
