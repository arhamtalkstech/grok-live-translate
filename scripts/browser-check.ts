/**
 * Browser check with real speech through Chrome's fake microphone.
 *
 * Builds WAV files from xAI TTS speech, launches Chrome with that WAV as the mic, clicks Start,
 * and checks the transcript cards, latency badges, received audio, and controls. Screenshots go
 * to /tmp/lt-browser/. Needs `npm run dev` running (web on :5174, server on :8787).
 *
 *   npx tsx scripts/browser-check.ts            # same device + two devices
 *   npx tsx scripts/browser-check.ts same       # one scenario
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { config } from '../src/server/config.js';

const WEB = process.env.LT_WEB_URL ?? 'http://127.0.0.1:5174';
const OUT = '/tmp/lt-browser';
const CACHE = join(tmpdir(), 'live-translation-e2e');
mkdirSync(OUT, { recursive: true });
mkdirSync(CACHE, { recursive: true });

async function tts(text: string, language: string, voice: string): Promise<Buffer> {
  const file = join(CACHE, `${createHash('sha1').update(text).digest('hex').slice(0, 16)}-${voice}.pcm`);
  if (existsSync(file)) return readFileSync(file);
  const res = await fetch(`${config.apiBase}/tts`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, voice_id: voice, language, output_format: { codec: 'pcm', sample_rate: 24000 } }),
  });
  if (!res.ok) throw new Error(`TTS ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(file, buf);
  return buf;
}

const silence = (s: number) => Buffer.alloc(Math.round(24000 * 2 * s));

function wav(pcm: Buffer, path: string): string {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(24000, 24);
  h.writeUInt32LE(48000, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(pcm.length, 40);
  writeFileSync(path, Buffer.concat([h, pcm]));
  return path;
}

async function launch(wavPath: string): Promise<Browser> {
  return chromium.launch({
    channel: 'chrome',
    headless: true,
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-audio-capture=${wavPath}%noloop`,
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
}

let failures = 0;
function check(ok: boolean, what: string) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${what}`);
  if (!ok) failures++;
}

async function cardText(page: Page, index: number): Promise<string> {
  return page.locator('section').nth(index).innerText();
}

async function waitFor(page: Page, fn: () => Promise<boolean>, ms: number) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return true;
    await page.waitForTimeout(500);
  }
  return false;
}

async function sameDevice() {
  console.log('\n— Same device (one mic, Hindi then German) —');
  const hi = await tts('नमस्ते, मेरा नाम राहुल शर्मा है। मेरा पेमेंट अभी तक नहीं पहुँचा है।', 'hi', 'rex');
  const de = await tts('Guten Tag, Herr Sharma. Ich prüfe die Zahlung sofort für Sie.', 'de', 'eve');
  // Gap long enough for the Hindi translation to finish playing (mic is paused while it plays).
  const file = wav(Buffer.concat([silence(2.5), hi, silence(11), de, silence(14)]), join(OUT, 'same.wav'));
  const browser = await launch(file);
  const page = await browser.newPage({ viewport: { width: 1360, height: 860 } });
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => m.type() === 'error' && errors.push(m.text()));
  await page.goto(WEB);
  await page.getByRole('button', { name: 'Start' }).click();
  check(await waitFor(page, async () => (await page.getByTestId('input-bar').innerText()).includes('Listening'), 10_000), 'Start connects and shows Listening');

  const gotBoth = await waitFor(
    page,
    async () => (await page.locator('article[data-kind="translation"]').count()) >= 2 && !(await page.getByLabel('Translating').count()),
    50_000,
  );
  check(gotBoth, 'two translated turns appear');
  const left = await cardText(page, 0);
  const right = await cardText(page, 1);
  await page.screenshot({ path: join(OUT, 'same-desktop.png') });
  check(/राहुल|Rahul/.test(left) && /[\u0900-\u097F]/.test(left), 'left (Hindi) card shows the Hindi original');
  check(/Sharma|Rahul/i.test(right) && /Zahlung|Name|Hallo/i.test(right), 'right (German) card shows the German translation');
  check(/Guten Tag/i.test(right), 'right card shows the German original');
  check(/शर्मा/.test(left) && /भुगतान|पेमेंट|जाँच|जांच|चेक/.test(left), 'left card shows the Hindi translation of the German turn');
  check(/\d\.\d\d s/.test(right) && /\d\.\d\d s/.test(left), 'latency badges are shown');
  check(((await page.evaluate(() => (globalThis as any).__ltAudioChunks)) ?? 0) > 5, 'translated audio reached the browser');
  check(/Median response/.test(await page.locator('footer').innerText()), 'footer shows median response time');

  // Controls: settings menu, push-to-talk toggle, language and voice pickers.
  await page.getByRole('button', { name: 'Translation settings' }).click();
  await page.getByRole('switch', { name: 'Push to talk' }).click();
  check(await page.getByRole('button', { name: 'Hold to talk' }).isVisible(), 'push-to-talk shows Hold to talk button');
  await page.getByRole('switch', { name: 'Push to talk' }).click();
  await page.locator('textarea').fill('Rahul Sharma, Vantorra Bank, Halvorsen');
  await page.screenshot({ path: join(OUT, 'same-settings.png') });
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Right language' }).click();
  await page.getByRole('option', { name: 'English' }).click();
  check(await waitFor(page, async () => (await page.getByRole('button', { name: 'Right language' }).innerText()).includes('English'), 5_000), 'right language can be changed to English');
  check(/English/.test(await page.locator('header p').first().innerText()), 'subheading follows the language change');
  await page.getByRole('button', { name: 'Right language' }).click();
  await page.getByRole('option', { name: 'German' }).click();
  await page.getByRole('button', { name: 'Interpreter voice' }).click();
  await page.getByRole('option', { name: /Ara/ }).click();
  check((await page.getByRole('button', { name: 'Interpreter voice' }).innerText()).includes('Ara'), 'voice picker selects Ara');
  await page.getByRole('button', { name: 'Stop' }).click();
  check(await waitFor(page, () => page.getByRole('button', { name: 'Start' }).isVisible(), 5_000), 'Stop returns to Start');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: join(OUT, 'same-mobile.png'), fullPage: true });
  check(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
  await browser.close();
}

async function twoDevices() {
  console.log('\n— Two devices (Hindi seat a, German seat b) —');
  const hi = await tts('मैंने पिछले मंगलवार को पंद्रह हज़ार यूरो ट्रांसफर किए थे।', 'hi', 'rex');
  const de = await tts('Danke. Ich sehe die Überweisung über fünfzehntausend Euro.', 'de', 'eve');
  const fileA = wav(Buffer.concat([silence(3), hi, silence(30)]), join(OUT, 'seat-a.wav'));
  const fileB = wav(Buffer.concat([silence(14), de, silence(20)]), join(OUT, 'seat-b.wav'));
  const [ba, bb] = await Promise.all([launch(fileA), launch(fileB)]);
  const pa = await ba.newPage({ viewport: { width: 1360, height: 860 } });
  await pa.goto(WEB);
  await pa.getByRole('tab', { name: 'Two devices' }).click();
  const invite = await pa.getByTestId('invite-url').innerText();
  check(/seat=b/.test(invite), 'invite link is shown while the other seat is empty');
  await pa.screenshot({ path: join(OUT, 'pair-waiting.png') });

  const pb = await bb.newPage({ viewport: { width: 1360, height: 860 } });
  await pb.goto(invite.replace(/^https?:\/\/[^/]+/, WEB));
  check(await waitFor(pa, () => pa.getByTestId('invite-url').isHidden(), 10_000), 'invite card hides when the guest joins');
  check((await pb.getByRole('button', { name: 'Your language' }).innerText()).includes('German'), 'guest seat speaks German');
  // Start both mics at once so the WAV timelines line up.
  await Promise.all([pa.getByRole('button', { name: 'Start' }).click(), pb.getByRole('button', { name: 'Start' }).click()]);

  const done = await waitFor(
    pa,
    async () => (await pa.locator('article').count()) >= 4 && !(await pa.getByLabel('Translating').count()),
    60_000,
  );
  check(done, 'both turns visible on the host page');
  const aLeft = await cardText(pa, 0);
  const aRight = await cardText(pa, 1);
  const bLeft = await cardText(pb, 0);
  const bRight = await cardText(pb, 1);
  check(/पंद्रह|15/.test(aLeft) && /fünfzehntausend|15/i.test(aRight), 'host: Hindi original left, German translation right');
  check(/fünfzehntausend|Überweisung/i.test(bLeft) && /[\u0900-\u097F]/.test(bRight), 'guest: German original left, Hindi translation right');
  const audioA = (await pa.evaluate(() => (globalThis as any).__ltAudioChunks)) ?? 0;
  const audioB = (await pb.evaluate(() => (globalThis as any).__ltAudioChunks)) ?? 0;
  check(audioA > 0 && audioB > 0, `each seat received the other side's translated audio (a=${audioA}, b=${audioB} chunks)`);
  await pa.screenshot({ path: join(OUT, 'pair-host.png') });
  await pb.screenshot({ path: join(OUT, 'pair-guest.png') });
  await Promise.all([ba.close(), bb.close()]);
}

async function agentsMode() {
  console.log('\n— Agents (two windows, Hindi support agent ↔ German client agent) —');
  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 860 } });
  const pa = await ctx.newPage();
  const errors: string[] = [];
  pa.on('pageerror', e => errors.push(e.message));
  await pa.goto(WEB);
  await pa.getByRole('tab', { name: 'Agents' }).click();
  const invite = await pa.getByTestId('invite-url').innerText();
  check(/mode=agents/.test(invite) && /seat=b/.test(invite), 'agents mode shows a link for the German window');
  const pb = await ctx.newPage();
  pb.on('pageerror', e => errors.push(e.message));
  await pb.goto(invite.replace(/^https?:\/\/[^/]+/, WEB));
  check(await waitFor(pa, () => pa.getByTestId('invite-url').isHidden(), 10_000), 'invite hides once the German window is open');
  check(!(await pb.getByRole('button', { name: /Start conversation/ }).count()), 'only the Hindi window has Start conversation');
  const enable = pb.getByRole('button', { name: 'Enable audio' });
  if (await enable.count()) await enable.click();

  await pa.getByRole('button', { name: 'Scenario' }).click();
  await pa.getByRole('option', { name: /Stuck payment/ }).click();
  await pa.getByLabel('Maximum turns').fill('4');
  await pa.screenshot({ path: join(OUT, 'agents-scenario.png') });
  await pa.keyboard.press('Escape');
  await pa.getByRole('button', { name: /Start conversation/ }).click();
  const sawSpeaking = await waitFor(pa, async () => /is speaking/.test(await pa.getByTestId('agent-status').innerText()), 30_000);
  check(sawSpeaking, 'status shows which agent is speaking');
  await pa.waitForTimeout(4000);
  await pb.screenshot({ path: join(OUT, 'agents-german-live.png') });
  const ended = await waitFor(pa, async () => /Call ended/.test(await pa.getByTestId('agent-status').innerText()), 180_000);
  check(ended, 'conversation runs to the turn limit or a goodbye');
  await pa.waitForTimeout(500);
  const aLeft = await cardText(pa, 0);
  const aRight = await cardText(pa, 1);
  const bLeft = await cardText(pb, 0);
  const bRight = await cardText(pb, 1);
  check(/Thomas/.test(aLeft) && /Priya/.test(aLeft) && /[\u0900-\u097F]/.test(aLeft), 'Hindi window: Hindi card has Priya originals and Thomas translations');
  check(/Guten Tag/.test(aRight) && /Thomas/.test(bLeft) && /[\u0900-\u097F]/.test(bRight), 'German window mirrors the conversation in German / Hindi');
  check((await pa.locator('article').count()) >= 8, 'at least four turns, each with original and translation');
  const ca = (await pa.evaluate(() => (globalThis as any).__ltAudioChunks)) ?? 0;
  const cb = (await pb.evaluate(() => (globalThis as any).__ltAudioChunks)) ?? 0;
  check(ca > 0 && cb > 0, `both windows played audio (hindi=${ca}, german=${cb} chunks)`);
  await pa.screenshot({ path: join(OUT, 'agents-hindi.png') });
  await pb.screenshot({ path: join(OUT, 'agents-german.png') });
  check(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
  await browser.close();
}

async function simultaneous() {
  console.log('\n— Simultaneous (Hindi window + German window, interpretation while the agent speaks) —');
  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 860 } });
  const pa = await ctx.newPage();
  const errors: string[] = [];
  pa.on('pageerror', e => errors.push(e.message));
  await pa.goto(WEB);
  await pa.getByRole('tab', { name: 'Simultaneous' }).click();
  const invite = await pa.getByTestId('invite-url').innerText();
  check(/mode=live/.test(invite) && /seat=b/.test(invite), 'Simultaneous shows the Open German window link');
  check(await pa.getByRole('button', { name: 'Open window' }).isVisible(), 'Open window button is there');
  check(/Interpretation 100% · original 5%/.test(await pa.getByTestId('output-bar').innerText()), 'interpretation at 100%, original voice at 5%');
  await pa.getByRole('button', { name: 'Translation settings' }).click();
  check(await pa.getByLabel('Original voice volume').isVisible(), 'settings has the original voice volume');
  await pa.keyboard.press('Escape');

  const pb = await ctx.newPage();
  pb.on('pageerror', e => errors.push(e.message));
  await pb.goto(invite.replace(/^https?:\/\/[^/]+/, WEB));
  check(await waitFor(pa, () => pa.getByTestId('invite-url').isHidden(), 10_000), 'link hides once the German window is open');
  check((await pb.getByRole('button', { name: 'Your language' }).innerText()).includes('German'), 'second window is the German side');
  const enable = pb.getByRole('button', { name: 'Enable audio' });
  if (await enable.count()) await enable.click();

  await pa.getByRole('button', { name: 'Scenario' }).click();
  await pa.getByLabel('Maximum turns').fill('4');
  await pa.keyboard.press('Escape');
  await pa.getByRole('button', { name: /Start conversation/ }).click();
  // While Thomas speaks: his voice plays (quietly) in the German window and the Hindi
  // interpretation plays in the Hindi window at the same moment.
  const overlap = await waitFor(
    pa,
    async () =>
      (await pa.locator('article[data-kind="translation"] [aria-label="Playing"]').count()) > 0 &&
      (await pb.locator('article[data-kind="original"] [aria-label="Playing"]').count()) > 0,
    60_000,
  );
  check(overlap, 'German window plays Thomas while the Hindi window plays his interpretation, at the same time');
  check(/interpreting into .* live/.test(await pa.getByTestId('agent-status').innerText()), 'status says it is interpreting live');
  await pa.screenshot({ path: join(OUT, 'live-hindi.png') });
  await pb.screenshot({ path: join(OUT, 'live-german.png') });
  const ended = await waitFor(pa, async () => /Call ended/.test(await pa.getByTestId('agent-status').innerText()), 240_000);
  check(ended, 'call runs to the end');
  const aLeft = await cardText(pa, 0);
  const bLeft = await cardText(pb, 0);
  check(/Priya/.test(aLeft) && /[\u0900-\u097F]/.test(aLeft), 'Hindi window: Hindi card filled');
  check(/Thomas/.test(bLeft) && /Guten Tag/.test(bLeft), 'German window: German card filled');
  check(/s behind/.test(aLeft) && /s behind/.test(bLeft), 'interpreted lines show how far they ran behind');
  const ca = (await pa.evaluate(() => (globalThis as any).__ltAudioChunks)) ?? 0;
  const cb = (await pb.evaluate(() => (globalThis as any).__ltAudioChunks)) ?? 0;
  check(ca > 0 && cb > 0, `both windows played audio (hindi=${ca}, german=${cb} chunks)`);
  check(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
  await browser.close();

  console.log('\n— Simultaneous, single window (no German window opened) —');
  const b2 = await chromium.launch({ channel: 'chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
  const p1 = await b2.newPage({ viewport: { width: 1360, height: 860 } });
  await p1.goto(WEB + '/?mode=live');
  await p1.getByRole('button', { name: 'Scenario' }).click();
  await p1.getByLabel('Maximum turns').fill('4');
  await p1.keyboard.press('Escape');
  await p1.getByRole('button', { name: /Start conversation/ }).click();
  check(await waitFor(p1, async () => (await p1.getByLabel('Playing').count()) >= 2, 60_000), 'one window plays the original and the interpretation together');
  await p1.getByRole('button', { name: 'Stop' }).click();
  await b2.close();
}

async function agentBuilder() {
  console.log('\n— Agent builder (simulated caller, handoffs, tools) —');
  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(WEB);
  await page.getByRole('tab', { name: 'Agent builder' }).click();
  await page.waitForSelector('[data-agent="front-desk"]');
  check((await page.locator('[data-agent]').count()) === 8, 'eight agents listed');
  await page.locator('[data-agent="password"] button').first().click();
  await page.getByText('Show the system prompt').click();
  check(/# Guardrails/.test(await page.locator('pre').first().innerText()), 'agent shows its full system prompt with guardrails');
  await page.getByRole('button', { name: /Start call/ }).click();
  const handoff = await waitFor(page, async () => (await page.locator('[data-testid="builder-events"] [data-kind="handoff"]').count()) > 0, 150_000);
  check(handoff, 'a handoff happens (session.update)');
  check((await page.locator('[data-testid="builder-events"] [data-kind="tool"]').count()) > 0, 'tool calls are logged');
  check(((await page.evaluate(() => (globalThis as any).__ltAudioChunks)) ?? 0) > 10, 'call audio reached the browser');
  await page.screenshot({ path: join(OUT, 'builder.png') });
  await page.getByRole('button', { name: /Hang up/ }).click();
  check(await waitFor(page, async () => /Call ended/.test(await page.getByTestId('builder-status').innerText()), 10_000), 'Hang up ends the call');
  check(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
  await browser.close();
}

const which = process.argv[2];
if (!which || which === 'same') await sameDevice();
if (!which || which === 'pair') await twoDevices();
if (!which || which === 'agents') await agentsMode();
if (!which || which === 'live') await simultaneous();
if (!which || which === 'builder') await agentBuilder();
console.log(failures ? `\n${failures} check(s) failed` : '\nall browser checks passed');
process.exit(failures ? 1 : 0);
