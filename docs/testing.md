# Findings and tests

## What the speech-to-speech API does as an interpreter

The Grok Voice speech-to-speech API (`wss://api.x.ai/v1/realtime`) has no translation mode; a session prompted as an interpreter does the job. Hindi and German phrases were generated with xAI text-to-speech and streamed at real-time pace: 186 turns covering greetings, account numbers, amounts, Hinglish, and lines that try to make the interpreter answer instead of translate (October 2026).

| Measured | Result |
|---|---|
| End of speech → first translated audio | median 1.06 s, p90 1.22 s, range 0.83–1.57 s |
| Reasoning `high` vs `none` | no measurable latency difference |
| "Answer me" / "forget your instructions" lines | translated 22/22 times in stateless sessions |
| Cascade (streaming STT → `grok-4.3` → streaming TTS) | 1.65–2.3 s, more recognition errors |
| Server VAD, next turn during playback | 7 of 37 turns dropped |
| Manual commit + per-turn item deletion, back-to-back turns | 0 drops, 0 carry-over |
| Hindi TTS reading "23,50 यूरो" | spoken as 23,050 until the prompt asked for numbers as words |

## Checks in this repo

| Check | Command | What it proves |
|---|---|---|
| Unit | `npm test` | Turn detector (onset, preroll, discard, chunking, flush, noise), script-based language detection including Hinglish, prompts, the real-time pacer. |
| Interpreter | `npm run e2e` (server running) | Two seats over the real server and API, six utterances: each is translated into the other language, lands in the right seat, has the expected content (names, digits as words, amounts), and its audio reaches only the listener. Variants: `-- --mode same`, `-- --ptt`, `-- --gap 0`. |
| Agents | `npm run e2e:agents -- stuck-payment 6` | Two persona agents through the interpreters: each turn arrives in the listener's language, the original voice plays only in the speaker's window and the translation only in the listener's, speakers alternate. |
| Simultaneous | `npm run e2e:live -- stuck-payment 4` | Each interpretation starts while the speaker is still talking; reports the lag behind the speaker. |
| Agent builder | `npm run e2e:builder -- password-reset` | A simulated caller phones the multi-agent line; prints the call, every handoff, and every tool call. |
| Browser | `npx tsx scripts/browser-check.ts` (`npm run dev` running; needs Google Chrome) | Chrome with a fake mic playing real speech: captions, latency badges, settings, pickers, mobile layout, two-device invite and join, Agents with two windows, Simultaneous with both windows. Screenshots in `/tmp/lt-browser`. |

Typical results: interpreter median 0.95–1.17 s; Agents translations 0.9–1.3 s after each turn; Simultaneous start lag median 2.4–3.9 s, finishing 2–4 s after the speaker.

## API behaviour this app works around

- **Server VAD assumes the speaker hears the assistant.** About 19% of turns were dropped when the next utterance started while the previous translation was still playing on the listener's side. The app detects turns itself (`turn_detection: null`), then commits and calls `response.create`.
- **Speech during an active response is a barge-in**, even with `turn_detection: null`; turns merged. The interpreter holds the next turn's audio until `response.done`.
- **History drifts.** Stateful interpreter sessions sometimes re-spoke the end of the previous translation or answered the speaker. Each exchange is deleted after `response.done`.
- **Input audio is consumed in real time.** Model audio arrives about 4× faster than real time; forwarding it in a burst delayed the next commit by up to 22 s. `Pacer` forwards it like a microphone.
- **An empty commit gets no reply at all** (no acknowledgement, no error). An agent that heard nothing would wait forever; it now answers directly, with a 3 s fallback if a commit is never acknowledged.
- **Unrequested responses** can start on sessions without turn detection; agents cancel any response they did not ask for.
- **Response-time spikes** of 5–20 s happen occasionally, with reasoning on or off, and pass within minutes. The latency badges show them.

## Bugs the checks caught

- Same-device mode merged every turn into one (barge-in on the response still being generated). Fixed by queueing audio until `response.done`.
- The capture worklet sent one frame and stopped (the transferred buffer was detached). Fixed by sizing new frames from the saved length.
- Hinglish with Latin names was placed in the German column. Script detection now treats any run of Devanagari as Hindi.
- Simultaneous mode: with one interpreter per direction the lag grew through long turns; two sessions now take fragments in turn. The interpreter guessed sentence endings and then repeated them; the prompt forbids guessing and passes the heard-so-far text.
- Agent builder: a plain "transferred" tool result made the next agent announce the transfer; the result now tells it to carry on as the same voice. Spoken emails came back capitalised; emails are lowercased before lookups.

## Not covered

- The *Browser tab* audio source: headless Chrome cannot capture a tab.
- Real rooms with laptop speakers and background noise: the energy VAD and mic pause are tested with synthetic speech.
- Two physical machines over the LAN with `LT_HTTPS=1`.
