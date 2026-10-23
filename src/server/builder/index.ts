import { composeInstructions } from './call.js';
import { vantorraBank } from './configs/vantorra-bank/index.js';
import type { BuilderConfig } from './types.js';

/** Configs available in the Agent builder tab. Add another BuilderConfig here to offer it. */
export const BUILDER_CONFIGS: BuilderConfig[] = [vantorraBank];

export function getBuilderConfig(id: string | undefined): BuilderConfig {
  return BUILDER_CONFIGS.find(c => c.id === id) ?? BUILDER_CONFIGS[0]!;
}

/** What the UI shows: the wiring, plus each agent's full system prompt as the session receives it. */
export function describeConfig(cfg: BuilderConfig) {
  return {
    id: cfg.id,
    title: cfg.title,
    description: cfg.description,
    startAgent: cfg.startAgent,
    agents: cfg.agents.map(a => ({
      id: a.id,
      name: a.name,
      voice: a.voice,
      greeting: a.greeting ?? null,
      timezone: a.timezone ?? null,
      knowledge: (a.knowledge ?? []).map(k => cfg.knowledge[k]?.title ?? k),
      guardrails: a.guardrails.map(g => cfg.guardrails[g]?.name ?? g),
      tools: a.tools.map(name => {
        const t = cfg.tools[name]!;
        return {
          name,
          type: t.type,
          ...(t.type === 'api_request' ? { method: t.method, url: t.url, auth: t.auth ? 'oauth' : null, mock: Boolean(t.mock) } : {}),
          ...(t.type === 'transfer' ? { targets: t.targets.map(x => x.label) } : {}),
        };
      }),
      instructions: composeInstructions(cfg, a, a.id === cfg.startAgent ? null : 'Language: …\nPurpose: …\n(handoff note written by the previous agent)'),
    })),
    scripts: cfg.scripts.map(s => ({ id: s.id, title: s.title, opening: s.opening, language: s.language ?? 'en', listenFor: s.listenFor ?? null })),
  };
}
