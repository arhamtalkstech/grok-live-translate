/**
 * Live check of Agents mode: two windows (seat a = Hindi support agent, seat b = German client)
 * join a room, the conversation starts, and the script prints every turn and checks routing.
 *
 *   npm run server &  npx tsx scripts/agents-e2e.ts [scenarioId] [maxTurns]
 */
import WebSocket from 'ws';
import { config } from '../src/server/config.js';
import { detectByScript } from '../src/shared/languages.js';
import type { RoomSnapshot, Segment, ServerMessage, Slot } from '../src/shared/protocol.js';

const scenarioId = process.argv[2] ?? 'stuck-payment';
const maxTurns = Number(process.argv[3] ?? 6);
const SERVER = process.env.E2E_SERVER ?? `ws://127.0.0.1:${config.port}/ws`;
const room = `agents-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

type Window = { slot: Slot; ws: WebSocket; audio: Map<string, number>; segments: Map<string, Segment>; room: RoomSnapshot | null };

function open(slot: Slot): Promise<Window> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(SERVER);
    const w: Window = { slot, ws, audio: new Map(), segments: new Map(), room: null };
    ws.on('open', () => {
      ws.send(
        JSON.stringify({
          type: 'join',
          room,
          mode: 'agents',
          slot,
          settings: { languages: { a: 'hi', b: 'de' }, keyterms: ['Vantorra Bank'] },
          participant: { name: '', voice: 'eve', endSilenceMs: 650, turnMode: 'auto' },
        }),
      );
    });
    ws.on('message', raw => {
      const m = JSON.parse(raw.toString()) as ServerMessage;
      if (m.type === 'joined') resolve(w);
      if (m.type === 'room' || m.type === 'joined') w.room = m.room;
      if (m.type === 'segment') w.segments.set(m.segment.id, m.segment);
      if (m.type === 'audio') {
        const k = `${m.segmentId}:${m.kind}`;
        w.audio.set(k, (w.audio.get(k) ?? 0) + (m.data.length * 3) / 4);
      }
      if (m.type === 'error') console.error(`[${slot}] error: ${m.message}`);
    });
    ws.on('error', reject);
  });
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const a = await open('a');
const b = await open('b');
a.ws.send(JSON.stringify({ type: 'agents_start', scenarioId, maxTurns }));
const t0 = Date.now();
let lastPhase = '';
while (Date.now() - t0 < 300_000) {
  const st = a.room?.agents;
  const phase = st ? `${st.phase}:${st.active ?? '-'}:${st.turns}` : '';
  if (phase !== lastPhase) {
    console.log(`${((Date.now() - t0) / 1000).toFixed(1).padStart(6)} s  ${phase}`);
    lastPhase = phase;
  }
  if (st && !st.running && st.phase === 'ended') break;
  await sleep(200);
}
console.log(`\nended: ${a.room?.agents?.endedReason}\n`);

let failures = 0;
const segs = [...a.segments.values()].sort((x, y) => x.startedAt - y.startedAt);
const check = (ok: boolean, what: string) => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${what}`);
};
for (const s of segs) {
  const own = s.slot === 'a' ? a : b;
  const other = s.slot === 'a' ? b : a;
  console.log(`[${s.speakerName} ${s.srcLang}→${s.dstLang}] latency ${s.latencyMs ?? '-'} ms`);
  console.log(`   said:  ${s.source}`);
  console.log(`   heard: ${s.translation}`);
  const expected = s.dstLang === 'de' ? 'de' : 'hi';
  check(detectByScript(s.translation, 'hi', 'de') === expected, 'translation is in the listener language');
  check((own.audio.get(`${s.id}:original`) ?? 0) > 0 && !(other.audio.get(`${s.id}:original`) ?? 0), "original voice plays only in the speaker's window");
  check((other.audio.get(`${s.id}:translation`) ?? 0) > 0 && !(own.audio.get(`${s.id}:translation`) ?? 0), "translation plays only in the listener's window");
}
check(segs.length >= 4, `at least four turns (${segs.length})`);
check(segs.every((s, i) => i === 0 || s.slot !== segs[i - 1]!.slot), 'speakers alternate');
check(segs[0]?.slot === 'b', 'the German client opens the call');
a.ws.close();
b.ws.close();
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
