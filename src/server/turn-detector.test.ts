import { describe, expect, it } from 'vitest';
import { detectByScript } from '../shared/languages.js';
import { oneWayPrompt, twoWayPrompt } from './prompts.js';
import { TurnDetector, type TurnEvent } from './turn-detector.js';

const RATE = 24000;
const ms = (n: number) => Math.round((RATE * n) / 1000);

function tone(durationMs: number, amplitude = 6000): Int16Array {
  const out = new Int16Array(ms(durationMs));
  for (let i = 0; i < out.length; i++) out[i] = Math.round(amplitude * Math.sin((2 * Math.PI * 220 * i) / RATE));
  return out;
}
const silence = (durationMs: number) => new Int16Array(ms(durationMs));

function run(det: TurnDetector, ...chunks: Int16Array[]): TurnEvent['type'][] {
  const types: TurnEvent['type'][] = [];
  for (const c of chunks) {
    // Feed in 40 ms pieces like the browser does.
    for (let i = 0; i < c.length; i += ms(40)) {
      for (const e of det.push(c.subarray(i, i + ms(40)))) if (e.type !== 'audio') types.push(e.type);
    }
  }
  return types;
}

describe('TurnDetector', () => {
  it('opens on speech and ends after the configured silence', () => {
    const det = new TurnDetector({ sampleRate: RATE, endSilenceMs: 600 });
    expect(run(det, silence(500), tone(1200), silence(400))).toEqual(['start']);
    expect(run(det, silence(300))).toEqual(['end']);
  });

  it('includes preroll audio from before the onset', () => {
    const det = new TurnDetector({ sampleRate: RATE, endSilenceMs: 600, prerollMs: 300 });
    det.push(silence(1000));
    const events = det.push(tone(200));
    const start = events.find(e => e.type === 'start');
    expect(start?.type).toBe('start');
    if (start?.type === 'start') expect(start.preroll.length).toBeGreaterThanOrEqual(10);
  });

  it('discards very short noises', () => {
    const det = new TurnDetector({ sampleRate: RATE, endSilenceMs: 400, minSpeechMs: 240 });
    expect(run(det, silence(500), tone(100), silence(800))).toEqual(['start', 'discard']);
  });

  it('chunks long monologues at a short pause', () => {
    const det = new TurnDetector({ sampleRate: RATE, endSilenceMs: 800, chunkAfterMs: 3000, chunkPauseMs: 300 });
    const types = run(det, silence(300), tone(3500), silence(350), tone(1000), silence(900));
    expect(types).toEqual(['start', 'end', 'start', 'end']);
  });

  it('flush ends an open turn (push-to-talk release)', () => {
    const det = new TurnDetector({ sampleRate: RATE, endSilenceMs: 600 });
    run(det, silence(200), tone(800));
    expect(det.flush().map(e => e.type)).toEqual(['end']);
  });

  it('ignores steady background noise once the floor adapts', () => {
    const det = new TurnDetector({ sampleRate: RATE, endSilenceMs: 600 });
    const noise = new Int16Array(ms(3000));
    for (let i = 0; i < noise.length; i++) noise[i] = Math.round((Math.random() - 0.5) * 200);
    expect(run(det, noise)).toEqual([]);
  });
});

describe('detectByScript', () => {
  it('tells Hindi from German by script', () => {
    expect(detectByScript('नमस्ते, मेरा payment pending है', 'hi', 'de')).toBe('hi');
    expect(detectByScript('Guten Tag, Herr Sharma', 'hi', 'de')).toBe('de');
  });
  it('returns null for languages that share a script', () => {
    expect(detectByScript('Bonjour', 'fr', 'de')).toBeNull();
  });
});

describe('prompts', () => {
  it('one-way prompt names both languages and keeps the safety rules', () => {
    const p = oneWayPrompt('hi', 'de', ['Rahul Sharma']);
    expect(p).toContain('Hindi speaker');
    expect(p).toContain('natural spoken German');
    expect(p).toMatch(/Never answer questions/);
    expect(p).toMatch(/numbers?.*as words/i);
    expect(p).toContain('Rahul Sharma');
  });
  it('two-way prompt maps each language to the other', () => {
    const p = twoWayPrompt('hi', 'de');
    expect(p).toContain('If you hear Hindi');
    expect(p).toContain('say the translation in German');
    expect(p).toContain('If you hear German, say the translation in Hindi');
  });
});
