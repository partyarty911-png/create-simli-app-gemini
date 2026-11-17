// Browser-side audio helpers for the Gemini Live <-> Simli bridge.
//
//   microphone (Float32, 44.1/48 kHz) -> PCM16 16 kHz -> Gemini      (startMicCapture)
//   Gemini (base64 PCM16 24 kHz)      -> PCM16 16 kHz -> Simli       (GeminiAudioToSimli)
//
// Simli takes raw PCM16 little-endian, 16 kHz, mono, no header.
// Gemini Live takes PCM16 16 kHz in ("audio/pcm;rate=16000") and sends PCM16 24 kHz out.
// https://aistudio.google.com/docs/live-api

/** Sample rate Simli expects, and the rate the microphone is sent to Gemini at. */
export const PCM_RATE_16K = 16000;

export const base64ToBytes = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

export function bytesToBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

/** "audio/pcm;rate=24000" -> 24000. Gemini's output is 24 kHz when the MIME type doesn't say. */
export function pcmRateFromMime(mimeType: string | undefined, fallback = 24000): number {
  const m = /rate=(\d+)/i.exec(mimeType ?? "");
  const rate = m ? Number(m[1]) : fallback;
  return rate >= 8000 && rate <= 96000 ? rate : fallback;
}

/**
 * Streaming sample-rate converter for mono PCM16 (windowed-sinc interpolation).
 *
 * Unlike per-chunk linear interpolation it keeps state between chunks, so there are
 * no clicks or dropped samples at chunk borders, and when downsampling it low-pass
 * filters first (cutoff just under the new Nyquist frequency), so 24 kHz audio
 * doesn't alias when converted to 16 kHz.
 *
 * Latency: `HALF` input samples (16 samples, under 1 ms at 24 kHz). Call flush() at the
 * end of an utterance to emit the last samples, and reset() to drop everything (barge-in).
 */
export class StreamingResampler {
  private static readonly HALF = 16; // taps on each side of the output position
  private static readonly PHASES = 256; // precomputed fractional positions

  private readonly step: number; // input samples per output sample (24k -> 16k: 1.5)
  private readonly kernel: Float32Array; // (PHASES + 1) rows of 2 * HALF taps, each row sums to 1
  private buf = new Float32Array(4096);
  private len = 0; // valid samples in buf
  private pos = 0; // position of the next output sample in buf (fractional)

  constructor(
    readonly fromRate: number,
    readonly toRate: number,
  ) {
    if (!(fromRate > 0 && toRate > 0)) throw new Error(`Invalid resampling rates ${fromRate} -> ${toRate}`);
    this.step = fromRate / toRate;
    this.kernel = StreamingResampler.buildKernel(Math.min(1, toRate / fromRate) * 0.92);
    this.reset();
  }

  /** Windowed-sinc taps for every fractional phase. `cutoff` is a fraction of the input Nyquist frequency. */
  private static buildKernel(cutoff: number): Float32Array {
    const { HALF, PHASES } = StreamingResampler;
    const taps = 2 * HALF;
    const kernel = new Float32Array((PHASES + 1) * taps);
    for (let p = 0; p <= PHASES; p++) {
      const frac = p / PHASES;
      let sum = 0;
      for (let j = 0; j < taps; j++) {
        // Distance from the output position to input sample j of the window.
        const d = j - HALF + 1 - frac;
        const x = Math.PI * cutoff * d;
        const sinc = x === 0 ? 1 : Math.sin(x) / x;
        const u = d / HALF; // in [-1, 1]
        const blackman = 0.42 + 0.5 * Math.cos(Math.PI * u) + 0.08 * Math.cos(2 * Math.PI * u);
        const w = Math.abs(u) <= 1 ? cutoff * sinc * blackman : 0;
        kernel[p * taps + j] = w;
        sum += w;
      }
      // Normalize so every phase has unity gain at DC (no level ripple between output samples).
      for (let j = 0; j < taps; j++) kernel[p * taps + j] /= sum;
    }
    return kernel;
  }

  /** Drops all buffered audio. The next sample pushed starts a fresh stream. */
  reset() {
    const { HALF } = StreamingResampler;
    // HALF samples of silence as history, so the first input sample can be the first output.
    this.buf.fill(0, 0, HALF);
    this.len = HALF;
    this.pos = HALF;
  }

  /** Converts the next chunk. The result may be a few samples shorter or longer than len * toRate / fromRate. */
  process(input: Int16Array): Int16Array {
    if (this.fromRate === this.toRate) return input.slice();
    this.append(input);
    return this.drain();
  }

  /** Emits the samples still held back for the filter window (pads with silence). */
  flush(): Int16Array {
    if (this.fromRate === this.toRate) return new Int16Array(0);
    this.append(new Int16Array(StreamingResampler.HALF));
    return this.drain();
  }

  private append(input: Int16Array) {
    if (this.len + input.length > this.buf.length) {
      const bigger = new Float32Array(Math.max(this.buf.length * 2, this.len + input.length));
      bigger.set(this.buf.subarray(0, this.len));
      this.buf = bigger;
    }
    for (let i = 0; i < input.length; i++) this.buf[this.len + i] = input[i];
    this.len += input.length;
  }

  private drain(): Int16Array {
    const { HALF, PHASES } = StreamingResampler;
    const taps = 2 * HALF;
    const buf = this.buf;
    const kernel = this.kernel;
    const out = new Int16Array(Math.max(0, Math.ceil((this.len - HALF - this.pos) / this.step) + 1));
    let n = 0;
    let pos = this.pos;
    // Output at `pos` needs input samples floor(pos) - HALF + 1 ... floor(pos) + HALF.
    while (Math.floor(pos) + HALF < this.len) {
      const i0 = Math.floor(pos);
      const row = Math.round((pos - i0) * PHASES) * taps;
      const start = i0 - HALF + 1;
      let acc = 0;
      for (let j = 0; j < taps; j++) acc += buf[start + j] * kernel[row + j];
      out[n++] = acc > 32767 ? 32767 : acc < -32768 ? -32768 : Math.round(acc);
      pos += this.step;
    }
    // Keep only the history the next output still needs.
    const keepFrom = Math.max(0, Math.floor(pos) - HALF + 1);
    if (keepFrom > 0) {
      buf.copyWithin(0, keepFrom, this.len);
      this.len -= keepFrom;
      pos -= keepFrom;
    }
    this.pos = pos;
    return n === out.length ? out : out.slice(0, n);
  }
}

/**
 * Turns Gemini's audio chunks (base64 PCM16 at the rate in their MIME type, normally
 * 24 kHz) into PCM16 16 kHz bytes for simliClient.sendAudioData.
 * One instance per conversation: it keeps resampler state across chunks.
 */
export class GeminiAudioToSimli {
  private resampler: StreamingResampler | null = null;
  private oddByte: number | null = null; // a PCM16 sample split across two chunks

  /** Returns 16 kHz PCM16 bytes to send to Simli (possibly empty). */
  push(base64: string, mimeType: string | undefined): Uint8Array {
    const rate = pcmRateFromMime(mimeType);
    let out: Uint8Array = new Uint8Array(0);
    if (this.resampler && this.resampler.fromRate !== rate) out = this.flush(); // rate changed mid-stream
    this.resampler ??= new StreamingResampler(rate, PCM_RATE_16K);

    let bytes: Uint8Array = base64ToBytes(base64);
    if (this.oddByte !== null) {
      const joined = new Uint8Array(bytes.length + 1);
      joined[0] = this.oddByte;
      joined.set(bytes, 1);
      bytes = joined;
      this.oddByte = null;
    }
    if (bytes.length % 2) {
      this.oddByte = bytes[bytes.length - 1];
      bytes = bytes.subarray(0, bytes.length - 1);
    }
    // base64ToBytes returns a fresh, aligned buffer; little-endian like every browser platform.
    const samples = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.length / 2);
    return concatBytes(out, int16ToBytes(this.resampler.process(samples)));
  }

  /** End of the model's turn: returns the last few samples held by the resampler. */
  flush(): Uint8Array {
    this.oddByte = null;
    if (!this.resampler) return new Uint8Array(0);
    const tail = int16ToBytes(this.resampler.flush());
    this.resampler.reset();
    return tail;
  }

  /** Barge-in: drop everything not yet converted. */
  reset() {
    this.oddByte = null;
    this.resampler?.reset();
  }
}

const int16ToBytes = (a: Int16Array) => new Uint8Array(a.buffer, a.byteOffset, a.byteLength);

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (!a.length) return b;
  if (!b.length) return a;
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

// AudioWorklet: mic Float32 frames -> PCM16 at `targetRate`, posted in `chunkSamples` chunks.
// If the AudioContext already runs at targetRate this is a plain conversion; otherwise it
// resamples linearly (fallback for browsers that refuse a 16 kHz context with a mic source).
const MIC_WORKLET = `
class PcmCapture extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.target = options.processorOptions.targetRate;
    this.step = sampleRate / this.target;
    this.pos = 0;
    this.prev = 0;
    this.buf = new Int16Array(options.processorOptions.chunkSamples);
    this.n = 0;
  }
  push(s) {
    s = Math.max(-1, Math.min(1, s));
    this.buf[this.n++] = Math.round(s * 32767);
    if (this.n === this.buf.length) { this.port.postMessage(this.buf.slice(0)); this.n = 0; }
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    if (this.step === 1) {
      for (let i = 0; i < ch.length; i++) this.push(ch[i]);
      return true;
    }
    while (this.pos < ch.length) {
      const i = Math.floor(this.pos);
      const f = this.pos - i;
      const a = i === 0 ? this.prev : ch[i - 1];
      const b = ch[i];
      this.push(a + (b - a) * f);
      this.pos += this.step;
    }
    this.pos -= ch.length;
    this.prev = ch[ch.length - 1];
    return true;
  }
}
registerProcessor("pcm-capture", PcmCapture);
`;

export type MicCapture = { stop: () => void };

/**
 * Captures an already-open microphone stream and calls `onChunk` with PCM16 mono at
 * `targetRate`, in chunks of `chunkMs` (Gemini recommends 20-40 ms).
 * The caller owns `stream` (opened with echoCancellation, so the avatar's voice from
 * the speakers isn't sent back to the model) and stops its tracks.
 */
export async function startMicCapture(
  stream: MediaStream,
  targetRate: number,
  chunkMs: number,
  onChunk: (pcm: Int16Array) => void,
): Promise<MicCapture> {
  let ctx: AudioContext | null = null;
  try {
    let source: MediaStreamAudioSourceNode;
    try {
      ctx = new AudioContext({ sampleRate: targetRate });
      source = ctx.createMediaStreamSource(stream);
    } catch {
      // Some browsers can't connect a mic to a context at a different rate: resample in the worklet.
      void ctx?.close();
      ctx = new AudioContext();
      source = ctx.createMediaStreamSource(stream);
    }
    const url = URL.createObjectURL(new Blob([MIC_WORKLET], { type: "application/javascript" }));
    try {
      await ctx.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }
    // numberOfOutputs: 0 makes it a sink: it is processed without being routed to the speakers.
    const node = new AudioWorkletNode(ctx, "pcm-capture", {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      channelCount: 1,
      processorOptions: { targetRate, chunkSamples: Math.round((targetRate * chunkMs) / 1000) },
    });
    node.port.onmessage = (e: MessageEvent<Int16Array>) => onChunk(e.data);
    source.connect(node);
    if (ctx.state === "suspended") await ctx.resume();

    const audioCtx = ctx;
    return {
      stop: () => {
        node.port.onmessage = null;
        source.disconnect();
        node.disconnect();
        void audioCtx.close().catch(() => {});
      },
    };
  } catch (err) {
    void ctx?.close().catch(() => {});
    throw err;
  }
}
