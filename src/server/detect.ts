import { config } from './config.js';
import { detectByScript, getLanguage } from '../shared/languages.js';

/**
 * Decide which of the two room languages a transcript is in. Uses the writing system when the
 * languages differ in script (Hindi vs German), else asks grok-4.3. Only the UI placement
 * depends on this; translation audio never waits for it.
 */
export async function detectLanguage(text: string, a: string, b: string): Promise<string | null> {
  const byScript = detectByScript(text, a, b);
  if (byScript || getLanguage(a).script !== getLanguage(b).script) return byScript;
  if (!text.trim()) return null;
  try {
    const res = await fetch(`${config.apiBase}/responses`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(15_000),
      body: JSON.stringify({
        model: 'grok-4.3',
        reasoning: { effort: 'none' },
        input: [
          {
            role: 'system',
            content: `Reply with exactly one code: "${a}" if the text is ${getLanguage(a).promptName}, "${b}" if it is ${getLanguage(b).promptName}.`,
          },
          { role: 'user', content: text },
        ],
      }),
    });
    if (!res.ok) return null;
    const data: any = await res.json();
    const out: string =
      data.output_text ??
      data.output?.flatMap((o: any) => o.content ?? []).map((c: any) => c.text ?? '').join('') ??
      '';
    if (out.includes(a)) return a;
    if (out.includes(b)) return b;
    return null;
  } catch {
    return null;
  }
}
