/**
 * Live check of Simultaneous mode: one window joins, the agents call starts, and the script
 * measures how far the translation runs behind each speaker and whether it overlaps the speech.
 *
 *   npm run server &  npx tsx scripts/live-e2e.ts [scenarioId] [maxTurns]
 */
import WebSocket from 'ws';
import { config } from '../src/server/config.js';
import { detectByScript } from '../src/shared/languages.js';
import type { RoomSnapshot, Segment, ServerMessage } from '../src/shared/protocol.js';

const scenarioId = process.argv[2] ?? 'stuck-payment';
const maxTurns = Number(process.argv[3] ?? 4);
const SERVER = process.env.E2E_SERVER ?? `ws://127.0.0.1:${config.port}/ws`;
const room = `live-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
const BYTES_PER_MS = 48;

type Track = { first: number; bytes: number };
const tracks = new Map<string, { original?: Track; translation?: Track }>();
const segments = new Map<string, Segment>();
let snapshot: RoomSnapshot | null = null;

const ws = new WebSocket(SERVER);
await new Promise<void>((resolve, reject) => {
  ws.on('open', () =>
    ws.send(
      JSON.stringify({
        type: 'join',
        room,
        mode: 'live',
        slot: 'a',
        settings: { languages: { a: 'hi', b: 'de' }, keyterms: ['Vantorra Bank'] },
        participant: { name: '', voice: 'eve', endSilenceMs: 650, turnMode: 'auto' },
      }),
    ),
  );
  ws.on('message', raw => {
    const m = JSON.parse(raw.toString()) as ServerMessage;
    if (m.type === 'joined') resolve();
    if (m.type === 'room' || m.type === 'joined') snapshot = m.room;
    if (m.type === 'segment') segments.set(m.segment.id, m.segment);
    if (m.type === 'audio') {
      const t = tracks.get(m.segmentId) ?? {};
      const k = t[m.kind] ?? { first: Date.now(), bytes: 0 };
      k.bytes += (m.data.length * 3) / 4;
      t[m.kind] = k;
      tracks.set(m.segmentId, t);
    }
    if (m.type === 'error') console.error(`error: ${m.message}`);
  });
  ws.on('error', reject);
});

ws.send(JSON.stringify({ type: 'agents_start', scenarioId, maxTurns }));
const t0 = Date.now();
let last = '';
while (Date.now() - t0 < 400_000) {
  const st = (snapshot as RoomSnapshot | null)?.agents;
  const phase = st ? `${st.phase}:${st.active ?? '-'}:${st.turns}` : '';
  if (phase !== last) {
    console.log(`${((Date.now() - t0) / 1000).toFixed(1).padStart(6)} s  ${phase}`);
    last = phase;
  }
  if (st && !st.running && st.phase === 'ended') break;
  await new Promise(r => setTimeout(r, 200));
}
console.log(`\nended: ${(snapshot as RoomSnapshot | null)?.agents?.endedReason}\n`);

let failures = 0;
const check = (ok: boolean, what: string) => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${what}`);
};
const lags: number[] = [];
for (const s of [...segments.values()].sort((x, y) => x.startedAt - y.startedAt)) {
  const t = tracks.get(s.id) ?? {};
  const origMs = (t.original?.bytes ?? 0) / BYTES_PER_MS;
  const transStart = t.translation && t.original ? t.translation.first - t.original.first : null;
  const transMs = (t.translation?.bytes ?? 0) / BYTES_PER_MS;
  // Playback is sequential per track from its first chunk; translation playback can only finish
  // after its last fragment arrives, which this approximates as start + total length.
  const behindAtEnd = transStart != null ? transStart + transMs - origMs : null;
  if (transStart != null) lags.push(transStart);
  console.log(`[${s.speakerName} ${s.srcLang}→${s.dstLang}] speech ${(origMs / 1000).toFixed(1)} s, translation starts ${transStart != null ? (transStart / 1000).toFixed(1) : '-'} s after speech, ends ~${behindAtEnd != null ? (behindAtEnd / 1000).toFixed(1) : '-'} s after it`);
  console.log(`   said:  ${s.source}`);
  console.log(`   heard: ${s.translation}`);
  check(detectByScript(s.translation, 'hi', 'de') === (s.dstLang === 'de' ? 'de' : 'hi'), 'translation in the listener language');
  check(transStart != null && transStart < origMs, 'translation starts while the speaker is still talking');
}
const sorted = lags.sort((x, y) => x - y);
if (sorted.length) console.log(`\nmedian start lag ${(sorted[Math.floor(sorted.length / 2)]! / 1000).toFixed(2)} s`);
check(segments.size >= 3, `at least three turns (${segments.size})`);
ws.close();
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
