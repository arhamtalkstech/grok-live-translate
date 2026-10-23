/**
 * Live check of the Agent builder tab: a scripted caller (xAI TTS) calls the multi-agent line
 * on one speech-to-speech session; the script prints the call, every handoff, and every tool call.
 *
 *   npm run server &  npx tsx scripts/builder-e2e.ts [scriptId]
 */
import WebSocket from 'ws';
import { config } from '../src/server/config.js';
import type { BuilderEvent, BuilderLine, BuilderState, ServerMessage } from '../src/shared/protocol.js';

const scriptId = process.argv[2] ?? 'password-reset';
const SERVER = process.env.E2E_SERVER ?? `ws://127.0.0.1:${config.port}/ws`;
const room = `builder-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

const lines = new Map<string, BuilderLine>();
const events: BuilderEvent[] = [];
let state: BuilderState | null = null;
let audioChunks = 0;

const ws = new WebSocket(SERVER);
await new Promise<void>((resolve, reject) => {
  ws.on('open', () =>
    ws.send(
      JSON.stringify({
        type: 'join',
        room,
        mode: 'builder',
        slot: 'a',
        settings: { languages: { a: 'en', b: 'de' }, keyterms: [] },
        participant: { name: '', voice: 'eve', endSilenceMs: 650, turnMode: 'auto' },
      }),
    ),
  );
  ws.on('message', raw => {
    const m = JSON.parse(raw.toString()) as ServerMessage;
    if (m.type === 'joined') resolve();
    if (m.type === 'builder_state') state = m.state;
    if (m.type === 'builder_event') {
      events.push(m.event);
      const e = m.event;
      const tag = e.kind === 'tool' ? `[${e.source}${e.ok === false ? ' FAILED' : ''} ${e.ms ?? 0} ms]` : '';
      console.log(`  ⟡ ${e.kind.toUpperCase()} ${e.title} ${tag}`);
      if (e.kind === 'tool') console.log(`      args ${JSON.stringify((e.data as any)?.args)}\n      → ${(e.detail ?? '').slice(0, 200)}`);
      if (e.kind === 'handoff') console.log(`      note: ${(e.detail ?? '').replace(/\n/g, ' | ')}`);
      if (e.kind === 'error' || e.kind === 'end') console.log(`      ${e.detail}`);
    }
    if (m.type === 'builder_line') {
      const prev = lines.get(m.line.id);
      lines.set(m.line.id, m.line);
      if (m.line.final && !prev?.final && !m.line.removed && m.line.text.trim()) {
        console.log(`${m.line.role === 'caller' ? 'CALLER' : `AGENT (${m.line.agentName})`}: ${m.line.text}`);
      }
    }
    if (m.type === 'audio') audioChunks++;
    if (m.type === 'error') console.log(`  ! error: ${m.message}`);
  });
  ws.on('error', reject);
});

ws.send(JSON.stringify({ type: 'builder_start', configId: 'vantorra-bank', caller: 'script', scriptId }));
const t0 = Date.now();
while (Date.now() - t0 < 300_000) {
  await new Promise(r => setTimeout(r, 300));
  if ((state as BuilderState | null)?.phase === 'ended') break;
}
const st = state as BuilderState | null;
console.log(`\nended: ${st?.endedReason} after ${((Date.now() - t0) / 1000).toFixed(0)} s, ${audioChunks} audio chunks`);
const handoffs = events.filter(e => e.kind === 'handoff').map(e => e.title);
const tools = events.filter(e => e.kind === 'tool').map(e => `${e.title}:${e.source}${e.ok === false ? ':fail' : ''}`);
console.log(`handoffs: ${handoffs.join(', ') || 'none'}`);
console.log(`tools: ${tools.join(', ') || 'none'}`);
ws.close();
process.exit(0);
