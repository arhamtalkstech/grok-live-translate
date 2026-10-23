/**
 * A multi-agent voice setup expressed as plain code, with the same building blocks as a voice
 * agent builder: agents (persona, voice, greeting), tools, guardrails, knowledge, and handoffs.
 * The runtime (`call.ts`) runs it on one speech-to-speech session: a handoff swaps the
 * session's instructions, tools, and voice with `session.update`.
 */

export type ApiParam = {
  name: string;
  description: string;
  location: 'query' | 'body';
  required?: boolean;
  /** Clean the value before the request: `email` trims, removes spaces, and lowercases. */
  normalize?: 'email';
};

export type ToolDef =
  | {
      /** HTTP call made by the server; the JSON response goes back to the model. */
      type: 'api_request';
      description: string;
      method: 'GET' | 'POST';
      url: string;
      params: ApiParam[];
      headers?: Record<string, string>;
      staticBody?: Record<string, string>;
      /** OAuth client credentials; the secret comes from an env var. */
      auth?: { type: 'oauth_client_credentials'; tokenUrl: string; clientId: string; clientSecretEnv: string; audience?: string };
      /** Used when the real call cannot be made (e.g. no secret configured). Results are labelled mock. */
      mock?: (args: Record<string, string>) => unknown;
      /** Retries on transport errors / 5xx, like the builder's own behaviour. */
      retries?: number;
    }
  | {
      /** Same-call handoff to another agent. */
      type: 'transfer';
      description: string;
      targets: { agent: string; label: string }[];
    }
  | { type: 'end_call'; description: string }
  | { type: 'search_knowledge'; description: string; maxResults: number };

export type AgentDef = {
  id: string;
  name: string;
  /** xAI voice id (see GET /v1/tts/voices). */
  voice: string;
  /** Spoken verbatim when the call starts on this agent. */
  greeting?: string;
  instructions: string;
  /** Tool names from `BuilderConfig.tools`. A transfer tool may be listed per agent. */
  tools: string[];
  /** Guardrail ids from `BuilderConfig.guardrails`, appended to the instructions. */
  guardrails: string[];
  /** Knowledge ids searched by this agent's `search_knowledge` tool. */
  knowledge?: string[];
  timezone?: string;
};

/** A simulated caller: a persona agent on its own speech-to-speech session that phones the line. */
export type CallerScript = {
  id: string;
  title: string;
  /** Spoken word for word as the caller's first turn (after the greeting). */
  opening: string;
  /** Who the caller is, what they want, and the facts they can give. */
  persona: string;
  /** What a good run sounds like (shown in the UI). */
  listenFor?: string;
  voice?: string;
  /** Language the caller speaks (BCP-47), also the language it hears. */
  language?: string;
  maxTurns?: number;
};

export type BuilderConfig = {
  id: string;
  title: string;
  description: string;
  startAgent: string;
  agents: AgentDef[];
  tools: Record<string, ToolDef>;
  guardrails: Record<string, { name: string; text: string }>;
  knowledge: Record<string, { title: string; text: string }>;
  /** Reasoning effort for the line's session; defaults to VOICE_REASONING_EFFORT. */
  reasoningEffort?: 'none' | 'high';
  /** Words the line's speech recognition should expect (products, names). */
  keyterms?: string[];
  scripts: CallerScript[];
};
