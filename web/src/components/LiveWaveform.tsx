import { useEffect, useRef } from 'react';
import { cn } from '../lib/cn';

/**
 * Scrolling level meter: each column is the loudness of one ~33 ms slice of audio, newest on the
 * right. While waiting it shows a soft pulse travelling across; when idle, a row of small dots.
 */
export function LiveWaveform({
  active = false,
  processing = false,
  analyser,
  height = 28,
  column = 2.5,
  gap = 2,
  className,
}: {
  active?: boolean;
  processing?: boolean;
  analyser?: () => AnalyserNode | null;
  height?: number;
  column?: number;
  gap?: number;
  className?: string;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const paintRef = useRef<HTMLCanvasElement>(null);
  const flags = useRef({ active, processing });
  flags.current = { active, processing };

  useEffect(() => {
    const host = hostRef.current;
    const paint = paintRef.current;
    const ctx = paint?.getContext('2d');
    if (!host || !paint || !ctx) return;

    let levels: number[] = [];
    let phase = 0;
    let frame = 0;
    let last = 0;
    const samples = new Float32Array(1024);

    const fit = () => {
      const scale = window.devicePixelRatio || 1;
      const { width, height: h } = host.getBoundingClientRect();
      paint.width = Math.max(1, Math.round(width * scale));
      paint.height = Math.max(1, Math.round(h * scale));
      ctx.setTransform(scale, 0, 0, scale, 0, 0);
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(host);

    const loudness = (node: AnalyserNode): number => {
      const view = samples.length > node.fftSize ? samples.subarray(0, node.fftSize) : samples;
      node.getFloatTimeDomainData(view);
      let energy = 0;
      for (const v of view) energy += v * v;
      const rms = Math.sqrt(energy / view.length);
      // Map roughly -50…-6 dBFS onto 0…1.
      const db = 20 * Math.log10(rms + 1e-9);
      return Math.min(1, Math.max(0, (db + 50) / 44));
    };

    const tick = (now: number) => {
      frame = requestAnimationFrame(tick);
      if (now - last < 33) return;
      last = now;
      const w = host.clientWidth;
      const h = host.clientHeight;
      const pitch = column + gap;
      const slots = Math.max(1, Math.floor(w / pitch));
      const { active: on, processing: busy } = flags.current;
      const node = analyser?.();

      if (on && node) {
        levels.push(loudness(node));
      } else if (busy) {
        phase = (phase + 0.045) % 1.4;
        const centre = (phase - 0.2) * slots;
        levels = Array.from({ length: slots }, (_, i) => 0.12 + 0.5 * Math.exp(-(((i - centre) / (slots * 0.08)) ** 2)));
      } else {
        levels = levels.map(v => v * 0.85).filter((_, i, a) => a.length - i <= slots);
        if (levels.every(v => v < 0.02)) levels = [];
      }
      if (levels.length > slots) levels = levels.slice(levels.length - slots);

      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = getComputedStyle(paint).color || '#fff';
      const mid = h / 2;
      if (levels.length === 0) {
        // Idle: evenly spaced dots.
        ctx.globalAlpha = 0.35;
        for (let x = 0; x < w; x += pitch * 2) ctx.fillRect(x, mid - 1, 2, 2);
        ctx.globalAlpha = 1;
        return;
      }
      const offset = slots - levels.length;
      levels.forEach((v, i) => {
        const bar = Math.max(3, v * (h - 4));
        ctx.globalAlpha = 0.35 + 0.65 * v;
        ctx.beginPath();
        ctx.roundRect((offset + i) * pitch, mid - bar / 2, column, bar, column / 2);
        ctx.fill();
      });
      ctx.globalAlpha = 1;
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [analyser, column, gap]);

  return (
    <div
      ref={hostRef}
      className={cn('relative w-full', className)}
      style={{ height }}
      role="img"
      aria-label={active ? 'Audio level' : processing ? 'Waiting for audio' : 'No audio'}
    >
      <canvas ref={paintRef} className="block size-full" aria-hidden="true" />
    </div>
  );
}
