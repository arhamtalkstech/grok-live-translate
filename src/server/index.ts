import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import WebSocket, { WebSocketServer } from 'ws';
import { assertConfig, config, PROJECT_ROOT } from './config.js';
import { dropIfEmpty, getOrCreateRoom, type Room } from './room.js';
import { BUILDER_CONFIGS, describeConfig } from './builder/index.js';
import { handleMockBank } from './mock-bank.js';
import { SCENARIOS } from './scenarios.js';
import { LANGUAGES, isLanguage } from '../shared/languages.js';
import type { ClientMessage, RoomSettings } from '../shared/protocol.js';

assertConfig();

const DIST = resolve(PROJECT_ROOT, 'web/dist');
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.js.map': 'application/json',
};

type Voice = { voice_id: string; name: string; gender?: string };
let voicesCache: { at: number; voices: Voice[] } | null = null;

async function listVoices(): Promise<Voice[]> {
  if (voicesCache && Date.now() - voicesCache.at < 10 * 60_000) return voicesCache.voices;
  try {
    const res = await fetch(`${config.apiBase}/tts/voices`, {
      headers: { Authorization: `Bearer ${config.apiKey}` },
      signal: AbortSignal.timeout(10_000),
    });
    const data: any = await res.json();
    const voices: Voice[] = (data.voices ?? data ?? []).map((v: any) => ({
      voice_id: v.voice_id,
      name: v.name ?? v.voice_id,
      gender: v.gender,
    }));
    if (voices.length) voicesCache = { at: Date.now(), voices };
    return voices;
  } catch {
    return voicesCache?.voices ?? [
      { voice_id: 'eve', name: 'Eve', gender: 'female' },
      { voice_id: 'rex', name: 'Rex', gender: 'male' },
    ];
  }
}

let resolvedModel: Promise<string> | null = null;

/** Ask the API which model `grok-voice-latest` resolves to (read from session.created; no audio is sent). */
function resolveModel(): Promise<string> {
  resolvedModel ??= new Promise<string>(resolve => {
    const ws = new WebSocket(`${config.realtimeUrl}?model=${encodeURIComponent(config.model)}`, {
      headers: { Authorization: `Bearer ${config.apiKey}` },
    });
    const done = (m: string) => {
      clearTimeout(timer);
      ws.removeAllListeners();
      ws.on('error', () => {});
      ws.close();
      resolve(m);
    };
    const timer = setTimeout(() => done(config.model), 8_000);
    ws.on('message', raw => {
      try {
        const e = JSON.parse(raw.toString());
        if (e.type === 'session.created') done(e.session?.model ?? config.model);
      } catch {
        // ignore
      }
    });
    ws.on('error', () => done(config.model));
  }).then(m => {
    if (m === config.model) resolvedModel = null; // retry next time
    return m;
  });
  return resolvedModel;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function onRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname === '/api/config') {
    return json(res, 200, {
      model: await resolveModel(),
      requestedModel: config.model,
      reasoningEffort: config.reasoningEffort,
      languages: LANGUAGES,
      voices: await listVoices(),
      scenarios: SCENARIOS.map(s => ({
        id: s.id,
        title: s.title,
        description: s.description,
        opening: s.opening,
        starter: s.starter,
        agents: { a: { name: s.agents.a.name, role: s.agents.a.role }, b: { name: s.agents.b.name, role: s.agents.b.role } },
      })),
    });
  }
  if (url.pathname === '/api/health') return json(res, 200, { ok: true });
  if (await handleMockBank(req, res, url)) return;
  if (url.pathname === '/api/builder') return json(res, 200, { configs: BUILDER_CONFIGS.map(describeConfig) });

  if (!existsSync(DIST)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return void res.end('Web build not found. Run `npm run dev` (Vite on :5174) or `npm run build` first.');
  }
  const rel = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
  let file = join(DIST, rel);
  if (!file.startsWith(DIST) || !existsSync(file) || statSync(file).isDirectory()) file = join(DIST, 'index.html');
  res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' });
  createReadStream(file).pipe(res);
}

const server = createServer((req, res) => {
  onRequest(req, res).catch(err => json(res, 500, { error: (err as Error).message }));
});

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 1 << 20 });

wss.on('connection', (ws: WebSocket) => {
  let room: Room | null = null;

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      if (room) room.audio(ws, data as Buffer);
      return;
    }
    let msg: ClientMessage;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (msg.type === 'join') {
      if (room) room.leave(ws);
      const languages = {
        a: isLanguage(msg.settings?.languages?.a) ? msg.settings!.languages!.a : 'hi',
        b: isLanguage(msg.settings?.languages?.b) ? msg.settings!.languages!.b : 'de',
      };
      const settings: RoomSettings = {
        languages: languages.a === languages.b ? { a: 'hi', b: 'de' } : languages,
        keyterms: (msg.settings?.keyterms ?? []).filter(k => typeof k === 'string').slice(0, 100),
      };
      const roomId = String(msg.room || 'default').slice(0, 64);
      const mode = msg.mode === 'pair' || msg.mode === 'agents' || msg.mode === 'live' || msg.mode === 'builder' ? msg.mode : 'same';
      room = getOrCreateRoom(roomId, mode, settings);
      room.join(ws, msg.slot === 'b' ? 'b' : 'a', {
        name: String(msg.participant?.name ?? '').slice(0, 40),
        voice: String(msg.participant?.voice || 'eve'),
        endSilenceMs: clamp(Number(msg.participant?.endSilenceMs) || 650, 300, 2000),
        turnMode: msg.participant?.turnMode === 'ptt' ? 'ptt' : 'auto',
      });
      if (msg.settings?.names) room.handle(ws, { type: 'room', settings: { names: msg.settings.names } });
      return;
    }
    if (room) room.handle(ws, msg);
  });

  ws.on('close', () => {
    if (!room) return;
    room.leave(ws);
    dropIfEmpty(room);
  });
});

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

server.listen(config.port, config.host, () => {
  console.log(
    `Live Translation server on http://${config.host}:${config.port}  (model ${config.model}, reasoning ${config.reasoningEffort})`,
  );
});
