import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { AgentSession } from '../agent.js';
import { config } from '../config.js';
import { Pacer } from '../pacer.js';
import type { BuilderEvent, BuilderLine, BuilderState, ServerMessage } from '../../shared/protocol.js';
import { runApiRequest, searchKnowledge, toolSchema, type ToolRun } from './tools.js';
import type { AgentDef, BuilderConfig, CallerScript } from './types.js';

const DEBUG = process.env.LT_DEBUG === '1';
const ts = () => new Date().toISOString().slice(11, 23);

/** The full system prompt for an agent: handoff note on top (as the builder does), then instructions, then guardrails. */
export function composeInstructions(cfg: BuilderConfig, agent: AgentDef, note: string | null): string {
  const parts: string[] = [];
  if (note) parts.push(`# Handoff context\n${note.trim()}`);
  parts.push(agent.instructions);
  const rails = agent.guardrails.map(id => cfg.guardrails[id]).filter(Boolean);
  if (rails.length) parts.push(`# Guardrails\n\n${rails.map(g => `## ${g!.name}\n${g!.text}`).join('\n\n')}`);
  const now = new Date().toLocaleString('en-GB', { timeZone: agent.timezone ?? 'Europe/London', dateStyle: 'full', timeStyle: 'short' });
  parts.push(`Current date and time (${agent.timezone ?? 'Europe/London'}): ${now}.`);
  return parts.join('\n\n');
}

export type BuilderHost = {
  send(msg: ServerMessage): void;
};

type CallerMode = { kind: 'mic' } | { kind: 'script'; script: CallerScript };

type FnCall = { name: string; call_id: string; arguments: string };

/**
 * One phone call through a multi-agent setup on a single Grok Voice speech-to-speech session.
 *
 * - Agent = system instructions + tools + voice. The call starts on `startAgent` (greeting via force_message).
 * - Handoff = the agent calls its transfer tool → `session.update` with the target agent's
 *   instructions (handoff note on top), tools, and voice → function output → `response.create`.
 *   The conversation history stays: it is the same call.
 * - API tools are real HTTP calls made by this server; knowledge search runs locally.
 * - The caller is the browser mic (server VAD) or a scripted caller (xAI TTS, paced, manual turns).
 */
export class BuilderCall {
  state: BuilderState;
  private ws: WebSocket | null = null;
  private agent: AgentDef;
  private lines = new Map<string, BuilderLine>();
  private responseLine: string | null = null;
  /** When the agent audio sent so far will have finished playing in the browser. */
  private playUntil = 0;
  private ending = false;
  private stopped = false;
  /** Simulated caller: its voice → the line (paced), the agent's voice → its ears (paced). */
  private callerAgent: AgentSession | null = null;
  private feed: Pacer | null = null;
  private ears: Pacer | null = null;
  private callerLine: string | null = null;
  private callerHungUp = false;
  private step = 0;
  private timers = new Set<NodeJS.Timeout>();
  private sessionUpdated: (() => void) | null = null;

  constructor(
    private readonly cfg: BuilderConfig,
    private readonly host: BuilderHost,
    private readonly caller: CallerMode,
  ) {
    this.agent = this.getAgent(cfg.startAgent);
    this.state = {
      running: true,
      configId: cfg.id,
      activeAgent: this.agent.id,
      caller: caller.kind,
      scriptId: caller.kind === 'script' ? caller.script.id : undefined,
      step: 0,
      phase: 'connecting',
      model: null,
    };
  }

  private getAgent(id: string): AgentDef {
    const a = this.cfg.agents.find(x => x.id === id);
    if (!a) throw new Error(`Unknown agent ${id}`);
    return a;
  }

  private later(ms: number, fn: () => void) {
    const t = setTimeout(() => {
      this.timers.delete(t);
      if (!this.stopped) fn();
    }, Math.max(0, ms));
    this.timers.add(t);
  }

  private setState(patch: Partial<BuilderState>) {
    this.state = { ...this.state, ...patch };
    this.host.send({ type: 'builder_state', state: this.state });
  }

  private event(e: Omit<BuilderEvent, 'id' | 'at'>) {
    this.host.send({ type: 'builder_event', event: { id: randomUUID(), at: Date.now(), ...e } });
  }

  private line(id: string, patch: Partial<BuilderLine> & Pick<BuilderLine, 'role'>) {
    const prev = this.lines.get(id);
    const next: BuilderLine = { id, text: '', final: false, at: Date.now(), ...prev, ...patch };
    this.lines.set(id, next);
    this.host.send({ type: 'builder_line', line: next });
  }

  private send(msg: Record<string, unknown>) {
    if (DEBUG) console.log(`${ts()} [builder-app] ${String(msg.type)}`);
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private sessionFor(agent: AgentDef, note: string | null) {
    return {
      instructions: composeInstructions(this.cfg, agent, note),
      voice: agent.voice,
      reasoning: { effort: this.cfg.reasoningEffort ?? config.reasoningEffort },
      tools: agent.tools.map(name => toolSchema(name, this.cfg.tools[name]!)),
      turn_detection: this.caller.kind === 'mic' ? { type: 'server_vad' } : { type: null },
      audio: {
        input: {
          format: { type: 'audio/pcm', rate: 24000 },
          transport: 'binary',
          // No language hint: the bank line follows whatever language the caller speaks.
          transcription: { model: 'grok-transcribe', ...(this.cfg.keyterms?.length ? { keyterms: this.cfg.keyterms } : {}) },
        },
        output: { format: { type: 'audio/pcm', rate: 24000 } },
      },
    };
  }

  private updateSession(agent: AgentDef, note: string | null): Promise<void> {
    return new Promise(resolve => {
      this.sessionUpdated = resolve;
      this.send({ type: 'session.update', session: this.sessionFor(agent, note) });
    });
  }

  async start(): Promise<void> {
    const ws = new WebSocket(`${config.realtimeUrl}?model=${encodeURIComponent(config.model)}`, {
      headers: { Authorization: `Bearer ${config.apiKey}` },
    });
    this.ws = ws;
    ws.on('message', raw => {
      try {
        this.onEvent(JSON.parse(raw.toString()));
      } catch (err) {
        if (DEBUG) console.error(err);
      }
    });
    ws.on('close', () => {
      if (!this.stopped) this.stop('The Grok Voice session closed');
    });
    ws.on('error', err => this.event({ kind: 'error', title: 'Session error', detail: err.message }));
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    await this.updateSession(this.agent, null);
    this.event({
      kind: 'session',
      agentId: this.agent.id,
      title: `Call starts on ${this.agent.name}`,
      detail: `session.update · voice ${this.agent.voice} · tools ${this.agent.tools.join(', ')} · guardrails ${this.agent.guardrails.length}`,
    });
    if (this.caller.kind === 'script') await this.startCaller(this.caller.script);
    this.setState({ phase: 'agent' });
    if (this.agent.greeting) {
      this.send({
        type: 'conversation.item.create',
        item: { type: 'force_message', role: 'assistant', content: [{ type: 'output_text', text: this.agent.greeting }] },
      });
    } else if (this.caller.kind === 'script') this.callerTurn();
  }

  /** Browser mic audio (mic mode). */
  micAudio(pcm: Buffer) {
    if (this.caller.kind === 'mic' && this.ws?.readyState === WebSocket.OPEN && !this.stopped) this.ws.send(pcm);
  }

  stop(reason: string) {
    if (this.stopped) return;
    this.stopped = true;
    for (const t of this.timers) clearTimeout(t);
    this.feed?.stop();
    this.ears?.stop();
    this.callerAgent?.removeAllListeners();
    this.callerAgent?.close();
    this.ws?.close();
    this.event({ kind: 'end', title: 'Call ended', detail: reason });
    this.setState({ running: false, phase: 'ended', endedReason: reason });
  }

  // --- simulated caller -------------------------------------------------------------------

  private async startCaller(script: CallerScript) {
    const lang = script.language ?? 'en';
    const caller = new AgentSession(`builder-caller-${script.id}`, callerInstructions(script), script.voice ?? 'rex', lang);
    this.callerAgent = caller;
    this.feed = new Pacer(frame => this.ws?.readyState === WebSocket.OPEN && this.ws.send(frame));
    this.ears = new Pacer(frame => caller.hear(Buffer.from(frame)));
    caller.on('audio', b64 => {
      if (!this.callerLine) {
        this.callerLine = randomUUID();
        this.line(this.callerLine, { role: 'caller', text: '' });
      }
      this.host.send({ type: 'audio', segmentId: this.callerLine, kind: 'original', data: b64 });
      this.feed!.push(Buffer.from(b64, 'base64'));
    });
    caller.on('transcript', delta => {
      if (!this.callerLine) {
        this.callerLine = randomUUID();
        this.line(this.callerLine, { role: 'caller', text: '' });
      }
      const l = this.lines.get(this.callerLine);
      this.line(this.callerLine, { role: 'caller', text: (l?.text ?? '') + delta });
    });
    caller.on('endCall', () => (this.callerHungUp = true));
    caller.on('done', transcript => {
      const id = this.callerLine;
      this.callerLine = null;
      if (id) this.line(id, { role: 'caller', text: transcript || this.lines.get(id)?.text || '', final: true });
      if (!id) {
        // Only a hang-up, no words.
        if (this.callerHungUp) this.stop('The caller hung up');
        return;
      }
      // The caller's words reach the line in real time; when they have, the agent answers.
      this.feed!.push(Buffer.alloc(24_000 * 2 * 0.25));
      this.feed!.whenDrained(() => {
        if (this.stopped) return;
        this.send({ type: 'input_audio_buffer.commit' });
        this.send({ type: 'response.create' });
        this.setState({ phase: 'agent' });
      });
    });
    caller.on('error', message => this.event({ kind: 'error', title: 'Caller session', detail: message }));
    await caller.connect();
  }

  /** The caller speaks: the scripted opening first, then free replies to what it heard. */
  private callerTurn() {
    const caller = this.callerAgent;
    if (!caller || this.stopped || this.caller.kind !== 'script') return;
    const max = this.caller.script.maxTurns ?? 24;
    if (this.callerHungUp) return this.stop('The caller hung up');
    if (this.step >= max) return this.stop('Turn limit reached');
    this.step++;
    this.setState({ phase: 'caller', step: this.step });
    // Commit what the caller heard first; an uncommitted buffer counts as speech in progress.
    caller.reply(this.step === 1 ? this.caller.script.opening : undefined);
  }

  /** After the agent's turn has finished playing (and been heard), the caller answers. */
  private afterAgentTurn() {
    if (this.caller.kind !== 'script') return;
    this.ears!.push(Buffer.alloc(24_000 * 2 * 0.25));
    this.ears!.whenDrained(() => this.later(Math.max(300, this.playUntil + 300 - Date.now()), () => this.callerTurn()));
  }

  // --- session events ---------------------------------------------------------------------

  private onEvent(e: Record<string, any>) {
    if (DEBUG && !String(e.type).endsWith('.delta')) console.log(`${ts()} [builder ${this.agent.id}] ${e.type}`, e.type === 'error' ? e.error?.message : '');
    switch (e.type) {
      case 'session.created':
        this.setState({ model: e.session?.model ?? null });
        break;
      case 'session.updated':
        this.sessionUpdated?.();
        this.sessionUpdated = null;
        break;
      case 'input_audio_buffer.speech_started':
        if (this.caller.kind === 'mic') this.host.send({ type: 'barge_in' });
        break;
      case 'conversation.item.input_audio_transcription.updated':
      case 'conversation.item.input_audio_transcription.completed':
        if (this.caller.kind === 'mic' && e.item_id && typeof e.transcript === 'string' && e.transcript.trim()) {
          this.line(`in-${e.item_id}`, { role: 'caller', text: e.transcript, final: e.type.endsWith('completed') });
        }
        break;
      case 'response.created':
        this.responseLine = randomUUID();
        this.line(this.responseLine, { role: 'agent', agentId: this.agent.id, agentName: this.agent.name, text: '' });
        break;
      case 'response.output_audio_transcript.delta':
        if (this.responseLine && e.delta) {
          const l = this.lines.get(this.responseLine);
          this.line(this.responseLine, { role: 'agent', text: (l?.text ?? '') + e.delta });
        }
        break;
      case 'response.output_audio.delta':
        if (e.delta) {
          this.playUntil = Math.max(this.playUntil, Date.now() + 60) + (e.delta.length * 3) / 4 / 48;
          this.host.send({ type: 'audio', segmentId: this.responseLine ?? 'agent', kind: 'translation', data: e.delta });
          this.ears?.push(Buffer.from(e.delta, 'base64'));
        }
        break;
      case 'response.done':
        void this.onResponseDone(e.response);
        break;
      case 'error': {
        const msg: string = e.error?.message ?? 'error';
        if (/active response|item not found/i.test(msg)) break;
        this.event({ kind: 'error', title: 'Grok Voice error', detail: msg });
      }
    }
  }

  private async onResponseDone(response: any) {
    if (this.responseLine) {
      const l = this.lines.get(this.responseLine);
      if (l && !l.text.trim()) {
        this.lines.delete(this.responseLine);
        this.host.send({ type: 'builder_line', line: { ...l, text: '', final: true, removed: true } });
      } else if (l) this.line(this.responseLine, { role: 'agent', final: true });
    }
    const calls: FnCall[] = (response?.output ?? []).filter((o: any) => o.type === 'function_call');
    if (response?.status === 'cancelled' && calls.length === 0) return;
    if (calls.length === 0) {
      if (this.ending) return this.finishCall();
      return this.afterAgentTurn();
    }

    let handoff: { agent: AgentDef; note: string; from: AgentDef } | null = null;
    for (const call of calls) {
      let args: Record<string, string> = {};
      try {
        args = JSON.parse(call.arguments || '{}');
      } catch {
        // leave empty
      }
      const def = this.cfg.tools[call.name];
      let run: ToolRun;
      if (!def || !this.agent.tools.includes(call.name)) {
        run = { output: `error: tool ${call.name} is not available to ${this.agent.name}`, ok: false, source: 'local', ms: 0 };
      } else if (def.type === 'transfer') {
        const target = def.targets.find(t => t.label === args.target);
        if (!target) {
          run = { output: `error: unknown target ${args.target}`, ok: false, source: 'local', ms: 0 };
        } else {
          handoff = { agent: this.getAgent(target.agent), note: args.note ?? '', from: this.agent };
          // Worded so the next agent carries on as the same voice instead of narrating a transfer.
          run = {
            output: JSON.stringify({
              status: 'ok',
              instruction:
                'You now continue this same call; your instructions and the handoff context are in effect. Your next sentence is the next step for the caller, in their language. Do not mention a transfer, a colleague, a team, or a specialist.',
            }),
            ok: true,
            source: 'local',
            ms: 0,
          };
        }
      } else if (def.type === 'end_call') {
        this.ending = true;
        run = { output: JSON.stringify({ status: 'ending' }), ok: true, source: 'local', ms: 0 };
      } else if (def.type === 'search_knowledge') {
        run = searchKnowledge(this.cfg, this.agent.knowledge ?? [], args.query ?? '', def.maxResults);
      } else {
        this.setState({ phase: 'tool' });
        run = await runApiRequest(def, args);
      }
      if (this.stopped) return;
      if (!handoff || def?.type !== 'transfer') {
        this.event({
          kind: 'tool',
          agentId: this.agent.id,
          title: call.name,
          detail: run.output.length > 600 ? `${run.output.slice(0, 600)}…` : run.output,
          data: { args },
          source: run.source,
          ok: run.ok,
          ms: run.ms,
          status: run.status,
        });
      }
      this.send({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: call.call_id, output: run.output } });
    }

    if (handoff) {
      // The handoff: same call, same session — new instructions, tools, and voice.
      this.agent = handoff.agent;
      await this.updateSession(handoff.agent, handoff.note);
      this.event({
        kind: 'handoff',
        agentId: handoff.agent.id,
        title: `${handoff.from.name} → ${handoff.agent.name}`,
        detail: handoff.note,
        data: { voice: handoff.agent.voice, tools: handoff.agent.tools, guardrails: handoff.agent.guardrails.map(g => this.cfg.guardrails[g]?.name ?? g) },
      });
      this.setState({ activeAgent: handoff.agent.id });
    }
    if (this.stopped) return;
    if (this.ending && !handoff) return this.finishCall();
    this.setState({ phase: 'agent' });
    this.send({ type: 'response.create' });
  }

  private finishCall() {
    // Let the goodbye finish playing, then hang up.
    this.later(this.playUntil + 800 - Date.now(), () => this.stop(`${this.agent.name} ended the call`));
  }
}

/** The simulated caller's prompt: persona plus how a real caller behaves on the phone. */
function callerInstructions(script: CallerScript): string {
  return `${script.persona}

# How you behave on this call
- You are the caller on a phone call to the bank's corporate support line. You hear the bank agent and answer them.
- Speak one or two short, natural sentences per turn. Answer what you were just asked. Do not give information you were not asked for, except your request.
- When the agent reads something back that is correct, say yes. If it is wrong, correct it.
- When you give an email address, spell it exactly as written in your instructions.
- When they walk you through steps, say you have done each step.
- Only bring up the things in your instructions, in that order.
- When everything is done and they ask if there is anything else, say no, thank you. When they ask whether it is all right to end the call, say yes and goodbye, then call end_call.
- Never mention that you are an AI, a simulation, or a test.`;
}
