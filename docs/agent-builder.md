# Agent builder tab: a multi-agent voice line on one speech-to-speech session

The *Agent builder* tab shows how to build a multi-agent voice line (agents with personas, guardrails, tools, and same-call handoffs) with nothing but the speech-to-speech API. The example is the corporate support line of **Vantorra Bank, a fictional bank**: a front desk checks the caller's email, then hands the same call to one of seven colleagues.

## How each concept maps to speech-to-speech

| Concept | Speech-to-speech |
|---|---|
| Agent (instructions, voice, greeting) | `session.update` with `instructions` and `voice`; the greeting is a `force_message` item (spoken verbatim) |
| Guardrails | Appended to the agent's instructions under `# Guardrails` |
| API tool | A `function` tool; the server makes the HTTP call and returns the body as `function_call_output` |
| Knowledge search | A `function` tool backed by a small local search over the agent's guides (a hosted collection via `file_search` also works) |
| Handoff to another agent | A `function` tool with `target` (enum of labels) and `note`. On call: `session.update` with the target's instructions (the note on top), tools, and voice → function output → `response.create`. The history stays: it is one session, one call. |
| End call | A `function` tool; the server hangs up after the goodbye has played |
| Reasoning effort, timezone | `reasoning.effort` on the session; the current time in the agent's timezone is added to its instructions |

There is no handoff primitive in speech-to-speech: a handoff is a new system context on the same live session. The caller hears one continuous call, and the new agent sees everything said so far plus the note.

## Where to change things

`src/server/builder/configs/vantorra-bank/`:

- `index.ts`: the wiring. Per agent: `voice`, `greeting`, `tools`, `guardrails`, `knowledge`, `timezone`. Per tool: URL, method, parameters. Handoff labels and targets, `reasoningEffort`, recognition `keyterms`, and the simulated callers.
- `agents/*.md`, `guardrails/*.md`, `tools/*.md`: prompts, guardrail texts, and tool descriptions.
- `knowledge/*.md`: the product guides the Key app and Access Manager agents search.

The format is typed in `src/server/builder/types.ts`. To add another line, write a new `BuilderConfig` and list it in `src/server/builder/index.ts`.

## The mock bank API

The tools call a small in-memory API built into the server (`src/server/mock-bank.ts`), so they make real HTTP requests without any external system. Set `MOCK_BANK_URL` to point them at your own service.

| Endpoint | Used by |
|---|---|
| `GET /mock-bank/users?email=` | `lookup_user` (front desk, not verified) |
| `POST /mock-bank/cases`, `GET /mock-bank/cases` | `create_case` (password reset, financing) |
| `POST /mock-bank/insights` | `client_insights` (financing) |

Test users (all fictional, reserved `example.com` / `example.org` domains):

| Name | Email | Notes |
|---|---|---|
| Daniel Okafor | `d.okafor16@example.com` | password admin |
| Lena Hartmann | `l.hartmann@example.com` | password admin, lending access |
| Marco Rinaldi | `marco.rinaldi@example.org` | administrator, no lending access |
| Ewa Kowalska | `ewa.kowalska@example.com` | password admin |
| Rahul Sharma | `rahul.sharma@example.com` | not a password admin |

## Callers

Pick *You (microphone)* to call the line yourself (headphones recommended), or one of five simulated callers. A simulated caller is a persona agent on its own speech-to-speech session: it hears the line at real-time pace, confirms read-backs, and spells its email, like a person on the phone.

Run one from the terminal: `npm run e2e:builder -- password-reset` (server running).

## Tips

- Spelled emails are the weakest link in speech recognition. Recognition `keyterms` for names and domains help.
- Emails are trimmed and lowercased before lookups; models often capitalise spoken emails.
- The handoff's function output tells the next agent to continue without announcing a transfer; with a plain "transferred" result agents tend to say "you're now with our lending team".
