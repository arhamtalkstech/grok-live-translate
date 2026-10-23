import { config as loadEnv } from 'dotenv';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

// .env.local first, then .env (dotenv never overrides a value already set in the shell).
for (const file of [resolve(PROJECT_ROOT, '.env.local'), resolve(PROJECT_ROOT, '.env')]) {
  if (existsSync(file)) loadEnv({ path: file, quiet: true });
}

function num(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && process.env[name] !== '' && process.env[name] != null ? v : fallback;
}

export const config = {
  apiKey: process.env.XAI_API_KEY ?? '',
  apiBase: process.env.XAI_API_BASE ?? 'https://api.x.ai/v1',
  realtimeUrl: process.env.XAI_REALTIME_URL ?? 'wss://api.x.ai/v1/realtime',
  /** `grok-voice-latest` points at the newest Grok Voice model; the resolved name is shown in the UI. */
  model: process.env.VOICE_MODEL ?? 'grok-voice-latest',
  // Interpreting and short call turns do not need reasoning; set VOICE_REASONING_EFFORT=high to turn it on.
  reasoningEffort: (process.env.VOICE_REASONING_EFFORT === 'high' ? 'high' : 'none') as 'none' | 'high',
  // Namespaced so a generic HOST/PORT in the shell or the shared env file does not expose the key on the LAN.
  host: process.env.LT_HOST || '127.0.0.1',
  port: num('LT_PORT', 8787),
  /** Hard cap on one turn before it is committed anyway (long monologues). */
  maxTurnMs: num('MAX_TURN_MS', 15_000),
};

export function assertConfig(): void {
  if (!config.apiKey) {
    console.error(
      'XAI_API_KEY is not set. Copy .env.example to .env.local and add your key (https://console.x.ai).',
    );
    process.exit(1);
  }
}
