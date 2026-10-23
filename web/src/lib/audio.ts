import { SAMPLE_RATE } from '../../../src/shared/protocol';

export type InputSource = 'mic' | 'tab';

// Runs on the audio thread: downmix, resample to 24 kHz with linear interpolation, emit 40 ms PCM16 frames.
const CAPTURE_WORKLET = `
class Capture extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.ratio = sampleRate / options.processorOptions.targetRate;
    this.frameSamples = options.processorOptions.frameSamples;
    this.frame = new Int16Array(this.frameSamples);
    this.fill = 0;
    this.pos = 0;
    this.prev = 0;
  }
  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const ch0 = input[0];
    const n = ch0.length;
    for (let i = 0; i < n; i++) {
      let s = ch0[i];
      if (input.length > 1) s = (s + input[1][i]) / 2;
      // Emit output samples that fall between prev and s.
      while (this.pos <= 1) {
        const v = this.prev + (s - this.prev) * this.pos;
        const c = Math.max(-1, Math.min(1, v));
        this.frame[this.fill++] = c < 0 ? c * 0x8000 : c * 0x7fff;
        if (this.fill === this.frame.length) {
          this.port.postMessage(this.frame.buffer, [this.frame.buffer]);
          // The posted buffer is transferred (detached), so size the next one from the saved length.
          this.frame = new Int16Array(this.frameSamples);
          this.fill = 0;
        }
        this.pos += this.ratio;
      }
      this.pos -= 1;
      this.prev = s;
    }
    return true;
  }
}
registerProcessor('lt-capture', Capture);
`;

export class AudioCapture {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private node: AudioWorkletNode | null = null;
  analyser: AnalyserNode | null = null;
  onEnded: (() => void) | null = null;

  async start(source: InputSource, onFrame: (pcm: Int16Array<ArrayBuffer>) => void): Promise<void> {
    this.stream =
      source === 'tab'
        ? await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true })
        : await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
          });
    const audioTracks = this.stream.getAudioTracks();
    if (audioTracks.length === 0) {
      this.stop();
      throw new Error('The shared tab has no audio. In Chrome, tick "Also share tab audio".');
    }
    // Tab capture needs a video track to start; we only use the audio.
    for (const t of this.stream.getVideoTracks()) t.stop();
    audioTracks[0]!.addEventListener('ended', () => this.onEnded?.());

    const ctx = new AudioContext();
    this.ctx = ctx;
    const url = URL.createObjectURL(new Blob([CAPTURE_WORKLET], { type: 'text/javascript' }));
    await ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    const src = ctx.createMediaStreamSource(new MediaStream(audioTracks));
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 256;
    this.analyser.smoothingTimeConstant = 0.8;
    this.node = new AudioWorkletNode(ctx, 'lt-capture', {
      processorOptions: { targetRate: SAMPLE_RATE, frameSamples: (SAMPLE_RATE * 40) / 1000 },
    });
    this.node.port.onmessage = e => onFrame(new Int16Array(e.data as ArrayBuffer));
    src.connect(this.analyser);
    src.connect(this.node);
    // Keep the worklet pulled without making the mic audible.
    const sink = ctx.createGain();
    sink.gain.value = 0;
    this.node.connect(sink).connect(ctx.destination);
    if (ctx.state === 'suspended') await ctx.resume();
  }

  stop(): void {
    this.node?.port.close();
    this.node?.disconnect();
    this.stream?.getTracks().forEach(t => t.stop());
    void this.ctx?.close();
    this.ctx = null;
    this.stream = null;
    this.node = null;
    this.analyser = null;
  }
}

/** Gapless playback of PCM16 24 kHz chunks, one segment after another. */
export class AudioPlayer {
  private ctx: AudioContext | null = null;
  private gain: GainNode | null = null;
  analyser: AnalyserNode | null = null;
  private nextTime = 0;
  private sources = new Set<AudioBufferSourceNode>();
  /** Segment id for each scheduled window, to highlight what is playing. */
  private schedule: { segmentId: string; start: number; end: number }[] = [];
  private volume = 1;

  /** 0–1. Simultaneous mode plays the original voice quietly under the interpretation. */
  setVolume(v: number): void {
    this.volume = v;
    if (this.gain) this.gain.gain.value = v;
  }

  /** Call from a click handler so browsers allow audio. */
  warmUp(): void {
    if (!this.ctx) {
      this.ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
      this.gain = this.ctx.createGain();
      this.gain.gain.value = this.volume;
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 256;
      this.analyser.smoothingTimeConstant = 0.8;
      this.gain.connect(this.analyser).connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
  }

  enqueue(segmentId: string, base64: string): void {
    this.warmUp();
    const ctx = this.ctx!;
    const bin = atob(base64);
    const n = bin.length >> 1;
    if (n === 0) return;
    const buf = ctx.createBuffer(1, n, SAMPLE_RATE);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < n; i++) {
      let v = bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8);
      if (v >= 0x8000) v -= 0x10000;
      ch[i] = v / 0x8000;
    }
    const start = Math.max(ctx.currentTime + 0.04, this.nextTime);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.gain!);
    src.start(start);
    src.onended = () => this.sources.delete(src);
    this.sources.add(src);
    this.nextTime = start + buf.duration;
    this.schedule.push({ segmentId, start, end: this.nextTime });
    if (this.schedule.length > 400) this.schedule.splice(0, 200);
  }

  /** Browsers start audio only after a user gesture. */
  get ready(): boolean {
    return this.ctx?.state === 'running';
  }

  get playing(): boolean {
    return this.ctx != null && this.ctx.currentTime < this.nextTime - 0.01;
  }

  /** `${segmentId}:${kind}` of the audio that is audible right now. */
  get currentSegment(): string | null {
    if (!this.ctx) return null;
    const t = this.ctx.currentTime;
    return this.schedule.find(s => t >= s.start && t < s.end)?.segmentId ?? null;
  }

  stopAll(): void {
    for (const s of this.sources) {
      try {
        s.stop();
      } catch {
        // already stopped
      }
    }
    this.sources.clear();
    this.schedule = [];
    this.nextTime = 0;
  }
}
