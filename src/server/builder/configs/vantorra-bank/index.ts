import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../../../config.js';
import type { AgentDef, BuilderConfig, ToolDef } from '../../types.js';

/**
 * Vantorra Bank corporate support line (a fictional bank). A front desk answers and checks the
 * email on the account, then hands the same call to one of seven colleagues.
 *
 * Edit freely: voices, greetings, which tools and guardrails each agent gets, handoff targets.
 * Prompts, guardrails, tool descriptions, and guides are the Markdown files next to this one.
 */

const here = dirname(fileURLToPath(import.meta.url));
const md = (path: string) => readFileSync(join(here, path), 'utf8').trim();

/** The bank API the tools call: the mock built into this server unless MOCK_BANK_URL is set. */
const BANK = process.env.MOCK_BANK_URL || `http://127.0.0.1:${config.port}/mock-bank`;

/** Handoff labels, as the prompts use them ("Continue — password"). */
const LABEL: Record<string, string> = {
  password: 'Continue — password',
  'key-app': 'Continue — key app',
  'access-manager': 'Continue — access manager',
  financing: 'Continue — financing',
  'follow-up': 'Continue — follow-up',
  'not-verified': 'Continue — not verified',
  human: 'Continue — human',
};

/** One transfer tool per agent, listing every colleague except itself. */
function transfer(self: string): ToolDef {
  return {
    type: 'transfer',
    description: md('tools/continue_this_request.md'),
    targets: Object.keys(LABEL)
      .filter(id => id !== self)
      .map(agent => ({ agent, label: LABEL[agent]! })),
  };
}

const ALL = ['honesty', 'voice-and-tone', 'data-sharing', 'same-call-handoff'];
const VOICE = 'eve';

const agents: AgentDef[] = [
  {
    id: 'front-desk',
    name: 'Front desk',
    voice: VOICE,
    greeting: 'Thank you for calling Vantorra Bank corporate support. How can I help?',
    instructions: md('agents/front-desk.md'),
    tools: ['lookup_user', 'continue_this_request', 'end_call'],
    guardrails: ALL,
    timezone: 'Europe/London',
  },
  {
    id: 'password',
    name: 'Password reset',
    voice: VOICE,
    instructions: md('agents/password.md'),
    tools: ['create_case', 'continue_this_request_password', 'end_call'],
    guardrails: ALL,
  },
  {
    id: 'key-app',
    name: 'Vantorra Key app',
    voice: VOICE,
    instructions: md('agents/key-app.md'),
    tools: ['search_guides', 'continue_this_request_key_app', 'end_call'],
    guardrails: ALL,
    knowledge: ['key-app-guide'],
  },
  {
    id: 'access-manager',
    name: 'Access Manager',
    voice: VOICE,
    instructions: md('agents/access-manager.md'),
    tools: ['search_guides', 'continue_this_request_access_manager', 'end_call'],
    guardrails: ALL,
    knowledge: ['access-manager-faq'],
  },
  {
    id: 'financing',
    name: 'Financing',
    voice: VOICE,
    instructions: md('agents/financing.md'),
    tools: ['client_insights', 'create_case', 'continue_this_request_financing', 'end_call'],
    guardrails: [...ALL, 'financing-internal-data'],
  },
  {
    id: 'follow-up',
    name: 'Follow-up',
    voice: VOICE,
    instructions: md('agents/follow-up.md'),
    tools: ['continue_this_request_follow_up', 'end_call'],
    guardrails: ALL,
  },
  {
    id: 'not-verified',
    name: 'Not verified',
    voice: VOICE,
    instructions: md('agents/not-verified.md'),
    tools: ['lookup_user', 'continue_this_request_not_verified', 'end_call'],
    guardrails: ALL,
  },
  {
    id: 'human',
    name: 'Jacob (human agent)',
    voice: 'rex',
    instructions: md('agents/human.md'),
    tools: ['continue_this_request_human', 'end_call'],
    guardrails: ['honesty', 'data-sharing'],
  },
];

const tools: Record<string, ToolDef> = {
  lookup_user: {
    type: 'api_request',
    description: md('tools/lookup_user.md'),
    method: 'GET',
    url: `${BANK}/users`,
    params: [{ name: 'email', description: 'The email address the caller confirmed.', location: 'query', required: true, normalize: 'email' }],
    retries: 1,
  },
  create_case: {
    type: 'api_request',
    description: md('tools/create_case.md'),
    method: 'POST',
    url: `${BANK}/cases`,
    params: [
      { name: 'title', description: '"Password reset" or "Relationship manager follow-up".', location: 'body', required: true },
      { name: 'summary', description: "One to three sentences: the caller's name and what they asked for.", location: 'body', required: true },
      { name: 'userEmail', description: 'The confirmed email from the handoff context.', location: 'body', required: true, normalize: 'email' },
    ],
    retries: 1,
  },
  client_insights: {
    type: 'api_request',
    description: md('tools/client_insights.md'),
    method: 'POST',
    url: `${BANK}/insights`,
    params: [
      { name: 'client_id', description: 'Client from the handoff context.', location: 'body', required: true },
      { name: 'question', description: 'A one-line question about the request.', location: 'body', required: true },
    ],
    retries: 1,
  },
  search_guides: { type: 'search_knowledge', description: md('tools/search_guides.md'), maxResults: 4 },
  end_call: { type: 'end_call', description: md('tools/end_call.md') },
  continue_this_request: transfer('front-desk'),
  continue_this_request_password: transfer('password'),
  continue_this_request_key_app: transfer('key-app'),
  continue_this_request_access_manager: transfer('access-manager'),
  continue_this_request_financing: transfer('financing'),
  continue_this_request_follow_up: transfer('follow-up'),
  continue_this_request_not_verified: transfer('not-verified'),
  continue_this_request_human: transfer('human'),
};

const guardrail = (name: string, file: string) => ({ name, text: md(`guardrails/${file}.md`) });

export const vantorraBank: BuilderConfig = {
  id: 'vantorra-bank',
  title: 'Vantorra Bank corporate support line',
  description: 'A front desk checks the email on the account; seven colleagues handle passwords, the Key app, Access Manager, financing, follow-ups, failed checks, and a human agent.',
  startAgent: 'front-desk',
  reasoningEffort: 'high',
  agents,
  tools,
  guardrails: {
    honesty: guardrail('Honesty and escalation', 'honesty'),
    'voice-and-tone': guardrail('Voice and tone', 'voice-and-tone'),
    'data-sharing': guardrail('Data sharing', 'data-sharing'),
    'same-call-handoff': guardrail('Same-call handoff', 'same-call-handoff'),
    'financing-internal-data': guardrail('Financing — internal data', 'financing-internal-data'),
  },
  knowledge: {
    'key-app-guide': { title: 'Vantorra Key app guide', text: md('knowledge/key-app-guide.md') },
    'access-manager-faq': { title: 'Access Manager FAQ', text: md('knowledge/access-manager-faq.md') },
  },
  keyterms: ['Vantorra', 'Vantorra Key', 'Vantorra Online', 'Access Manager', 'PayDesk', 'Okafor', 'Hartmann', 'Rinaldi', 'Kowalska', 'example.com', 'example.org'],
  scripts: [
    {
      id: 'password-reset',
      title: 'Wrong email, then a colleague (password reset)',
      opening: 'I am an existing customer. My name is Daniel Okafor, that is O, K, A, F, O, R. I need a password reset.',
      persona: `You are Daniel Okafor, an existing Vantorra Bank corporate customer. You need a password reset.
When asked for the email on the account, first give d.okafor@example.com, spelled: "d, dot, o, k, a, f, o, r, at example dot com".
If they say that email is not on file or ask for another, give d.okafor16@example.com, spelled: "d, dot, o, k, a, f, o, r, one, six, at example dot com".
After they confirm the reset, ask whether you can also reset the password for a colleague.
Then you have nothing else.`,
      listenFor: 'First email not found, second one works, reset email sent, the colleague must call themselves.',
    },
    {
      id: 'financing-then-key-app',
      title: 'One person, two jobs (financing, then the Key app)',
      opening: "I am an existing customer. We've grown fast and need more working capital.",
      persona: `You are Lena Hartmann, CFO of an existing Vantorra Bank corporate client.
The email on the account is l.hartmann@example.com, spelled: "l, dot, h, a, r, t, m, a, n, n, at example dot com".
You need about five million euros of working capital for two years because of new orders. None of it is being raised elsewhere.
After the financing part is wrapped up, ask how to activate the Vantorra Key app on your phone.
Follow the steps they give and confirm each one is done.
Then you have nothing else.`,
      listenFor: 'Financing questions one at a time, a case for a relationship manager, then the app steps one by one. No figures read out.',
    },
    {
      id: 'german-key-app',
      title: 'German, then a clean no (PayDesk)',
      language: 'de',
      opening: 'Könnten wir auf Deutsch sprechen? Ich bin Bestandskundin. Wie melde ich mich mit der Vantorra Key App an?',
      persona: `Du bist Lena Hartmann, Bestandskundin der Vantorra Bank. Du sprichst nur Deutsch.
Die E-Mail auf dem Konto ist l.hartmann@example.com, buchstabiert: "l, Punkt, h, a, r, t, m, a, n, n, at example Punkt com".
Folge den Schritten zur Anmeldung und bestätige jeden.
Danach fragst du, wie du in Vantorra PayDesk eine Zahlung freigeben kannst.
Danach hast du nichts mehr.`,
      listenFor: 'German from the first reply, the login steps, then PayDesk payments politely declined and noted.',
    },
    {
      id: 'add-user',
      title: 'Add a user, then their permissions',
      opening: 'I am an existing customer. How do I add a new user in Access Manager?',
      persona: `You are Marco Rinaldi, an administrator at an existing Vantorra Bank corporate client.
The email on the account is marco.rinaldi@example.org, spelled: "m, a, r, c, o, dot, r, i, n, a, l, d, i, at example dot org".
Follow the steps for adding a user and confirm each one is done. Then ask how to change permissions for this user.
Then you have nothing else.`,
      listenFor: 'Copy from existing user, four-eyes approval, then bulk edit of permissions.',
    },
    {
      id: 'polish-password',
      title: 'Polish caller (password reset)',
      language: 'pl',
      opening: 'Jestem obecną klientką. Chcę zresetować hasło.',
      persona: `Jesteś Ewą Kowalską, obecną klientką Vantorra Bank. Mówisz tylko po polsku.
E-mail na koncie to ewa.kowalska@example.com, przeliteruj: "e, w, a, kropka, k, o, w, a, l, s, k, a, małpa example kropka com".
Chcesz zresetować hasło. Potem nie masz nic więcej.`,
      listenFor: 'Polish from the first reply, including the email read-back and the reset confirmation.',
    },
  ],
};
