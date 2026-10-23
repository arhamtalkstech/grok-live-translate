import type { ApiParam, BuilderConfig, ToolDef } from './types.js';

/** JSON-schema function definitions for the speech-to-speech session. */
export function toolSchema(name: string, def: ToolDef) {
  switch (def.type) {
    case 'api_request':
      return {
        type: 'function',
        name,
        description: def.description,
        parameters: {
          type: 'object',
          properties: Object.fromEntries(def.params.map((p: ApiParam) => [p.name, { type: 'string', description: p.description }])),
          required: def.params.filter(p => p.required).map(p => p.name),
        },
      };
    case 'transfer':
      return {
        type: 'function',
        name,
        description: def.description,
        parameters: {
          type: 'object',
          properties: {
            target: { type: 'string', enum: def.targets.map(t => t.label), description: 'The colleague who continues this call.' },
            note: {
              type: 'string',
              description:
                'The handoff note: labelled lines, not JSON. First line Language, then Purpose, Authenticated, Client, Email, Name, Password admin, Lending access, Account access, What happened.',
            },
          },
          required: ['target', 'note'],
        },
      };
    case 'end_call':
      return { type: 'function', name, description: def.description, parameters: { type: 'object', properties: {} } };
    case 'search_knowledge':
      return {
        type: 'function',
        name,
        description: def.description,
        parameters: {
          type: 'object',
          properties: { query: { type: 'string', description: 'What to look up in the attached guides.' } },
          required: ['query'],
        },
      };
  }
}

export type ToolRun = {
  output: string;
  ok: boolean;
  /** "live" = the real endpoint answered; "mock" = the stand-in was used; "local" = in-process. */
  source: 'live' | 'mock' | 'local';
  status?: number;
  ms: number;
};

const tokenCache = new Map<string, { token: string; until: number }>();

async function oauthToken(auth: NonNullable<Extract<ToolDef, { type: 'api_request' }>['auth']>): Promise<string | null> {
  const secret = process.env[auth.clientSecretEnv];
  if (!secret) return null;
  const hit = tokenCache.get(auth.tokenUrl);
  if (hit && hit.until > Date.now()) return hit.token;
  const res = await fetch(auth.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(8000),
    body: JSON.stringify({
      grant_type: 'client_credentials',
      client_id: auth.clientId,
      client_secret: secret,
      ...(auth.audience ? { audience: auth.audience } : {}),
    }),
  });
  if (!res.ok) throw new Error(`token endpoint HTTP ${res.status}`);
  const data: any = await res.json();
  tokenCache.set(auth.tokenUrl, { token: data.access_token, until: Date.now() + ((data.expires_in ?? 600) - 30) * 1000 });
  return data.access_token;
}

export async function runApiRequest(def: Extract<ToolDef, { type: 'api_request' }>, args: Record<string, string>): Promise<ToolRun> {
  const t0 = Date.now();
  let token: string | null = null;
  if (def.auth) {
    try {
      token = await oauthToken(def.auth);
    } catch (err) {
      if (def.mock) return { output: JSON.stringify(def.mock(args)), ok: true, source: 'mock', ms: Date.now() - t0 };
      return { output: `request failed: ${(err as Error).message}`, ok: false, source: 'live', ms: Date.now() - t0 };
    }
    if (!token && def.mock) return { output: JSON.stringify(def.mock(args)), ok: true, source: 'mock', ms: Date.now() - t0 };
  }
  const url = new URL(def.url);
  const body: Record<string, string> = { ...(def.staticBody ?? {}) };
  for (const p of def.params) {
    let v = args[p.name];
    if (v == null || v === '') continue;
    // Spoken emails often come back capitalised ("L.HARTMANN@example.com"); mailboxes are case-insensitive.
    if (p.normalize === 'email') v = String(v).trim().replace(/\s+/g, '').toLowerCase();
    if (p.location === 'query') url.searchParams.set(p.name, v);
    else body[p.name] = v;
  }
  const headers: Record<string, string> = { ...(def.headers ?? {}) };
  if (def.method === 'POST') headers['Content-Type'] ??= 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;

  let last = '';
  for (let attempt = 0; attempt <= (def.retries ?? 0); attempt++) {
    try {
      const res = await fetch(url, {
        method: def.method,
        headers,
        signal: AbortSignal.timeout(10_000),
        ...(def.method === 'POST' ? { body: JSON.stringify(body) } : {}),
      });
      const text = await res.text();
      if (res.status >= 500) {
        last = `request failed: HTTP ${res.status}`;
        continue;
      }
      return { output: text.slice(0, 4000), ok: res.ok, source: 'live', status: res.status, ms: Date.now() - t0 };
    } catch (err) {
      last = `error sending request: ${(err as Error).message}`;
    }
  }
  return { output: last, ok: false, source: 'live', ms: Date.now() - t0 };
}

/** Small keyword search over the agent's guides (stands in for a hosted collection). */
export function searchKnowledge(config: BuilderConfig, ids: string[], query: string, maxResults: number): ToolRun {
  const t0 = Date.now();
  const words = (s: string): string[] => s.toLowerCase().normalize('NFKD').match(/[\p{L}\p{N}]{3,}/gu) ?? [];
  const q = [...new Set(words(query))];
  const passages: { source: string; text: string; score: number }[] = [];
  for (const id of ids) {
    const doc = config.knowledge[id];
    if (!doc) continue;
    const paras = doc.text.split(/\n{2,}/).map(p => p.replace(/\s+/g, ' ').trim()).filter(p => p.length > 40);
    // Group short paragraphs into ~90-word passages.
    let buf: string[] = [];
    const flush = () => {
      if (!buf.length) return;
      const text = buf.join(' ');
      const toks = words(text);
      const score = q.reduce((s, w) => s + (toks.includes(w) ? 1 + Math.log(1 + toks.filter(t => t === w).length) : 0), 0);
      passages.push({ source: doc.title, text, score });
      buf = [];
    };
    for (const p of paras) {
      buf.push(p);
      if (buf.join(' ').split(' ').length > 90) flush();
    }
    flush();
  }
  const top = passages.filter(p => p.score > 0).sort((a, b) => b.score - a.score).slice(0, maxResults);
  const output = top.length
    ? JSON.stringify(top.map(p => ({ source: p.source, text: p.text })))
    : JSON.stringify({ results: [], note: 'No matching passage in the attached guides.' });
  return { output, ok: true, source: 'local', ms: Date.now() - t0 };
}
