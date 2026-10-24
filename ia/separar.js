// Hum · perfect karaoke: separates the voice from a song with AI (HTDemucs, MIT license), on this device.
// Runs in the background (a worker) so the app never freezes. The music without voice is made as
// "original minus voice": the instruments stay exactly as in your file, untouched by the AI.
// In: { type: "sep", id, left, right } (44.1 kHz). Out: progress messages, then { type: "done", id, wav, aac }.
import * as ort from "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/ort.webgpu.min.mjs";
import { DemucsProcessor } from "./demucs/index.js";

const MODEL = "https://huggingface.co/timcsy/demucs-web-onnx/resolve/main/htdemucs_embedded.onnx";
const CACHE = "hum-ia-v1";
ort.env.wasm.numThreads = 1;
ort.env.wasm.wasmPaths = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/";

let proc = null, loading = null, gpu = false, noGpu = false;
const say = m => postMessage(m);

// The model is downloaded once (181 MB) in 8 MB pieces. Each piece is kept on this device as soon as it
// arrives, so a dropped connection or a closed app continues where it stopped instead of starting over,
// and a piece that stalls is tried again. Only one copy of the model is ever in memory.
const SIZE = 180534758, PART = 8 * 1024 * 1024, PARTS = Math.ceil(SIZE / PART);
const partKey = i => `https://hum.local/ia/htdemucs/${SIZE}/part-${i}`;
async function fetchPart(i){
  const from = i * PART, to = Math.min(SIZE, from + PART) - 1;
  for (let attempt = 1; ; attempt++){
    const ctl = new AbortController(); let timer = setTimeout(() => ctl.abort(), 45000); // 45 s without data: try again
    try {
      const r = await fetch(MODEL, { headers: { range: `bytes=${from}-${to}` }, signal: ctl.signal });
      if (r.status !== 206 && !(r.status === 200 && PARTS === 1)) throw new Error("model " + r.status);
      const rd = r.body.getReader(), chunks = []; let got = 0;
      for (;;){
        const { done, value } = await rd.read(); if (done) break;
        chunks.push(value); got += value.length; clearTimeout(timer); timer = setTimeout(() => ctl.abort(), 45000);
        say({ type: "progress", phase: "model", p: Math.min(1, (from + got) / SIZE), mb: Math.round((from + got) / 1e6), total: Math.round(SIZE / 1e6) });
      }
      clearTimeout(timer);
      if (got !== to - from + 1) throw new Error("short");
      return new Blob(chunks);
    } catch (e){
      clearTimeout(timer);
      if (attempt >= 4) throw new Error(navigator.onLine === false ? "offline" : "stalled");
      await new Promise(r => setTimeout(r, 2000 * attempt));
    }
  }
}
async function modelBytes(){
  let c = null; try { c = await caches.open(CACHE); } catch {}
  // a model saved whole by the previous version of Hum
  const old = c && await c.match(MODEL); if (old) return old.arrayBuffer();
  if (c && navigator.storage && navigator.storage.estimate){
    try { const { quota, usage } = await navigator.storage.estimate(); if (quota - usage < SIZE * 1.3) throw new Error("space"); } catch (e){ if (e.message === "space") throw e; }
  }
  const out = new Uint8Array(SIZE);
  for (let i = 0; i < PARTS; i++){
    let blob = c && await c.match(partKey(i)).then(r => r && r.blob()).catch(() => null);
    if (!blob || blob.size !== Math.min(SIZE, (i + 1) * PART) - i * PART){
      blob = await fetchPart(i);
      if (c) try { await c.put(partKey(i), new Response(blob)); } catch {}
    } else say({ type: "progress", phase: "model", p: Math.min(1, (i + 1) * PART / SIZE), mb: Math.round(Math.min(SIZE, (i + 1) * PART) / 1e6), total: Math.round(SIZE / 1e6) });
    out.set(new Uint8Array(await blob.arrayBuffer()), i * PART);
  }
  return out.buffer;
}
function load(){
  if (proc) return Promise.resolve(proc);
  return loading || (loading = (async () => {
    try { gpu = !noGpu && !!(self.navigator && navigator.gpu && await navigator.gpu.requestAdapter()); } catch { gpu = false; }
    const p = new DemucsProcessor({ ort, sessionOptions: { executionProviders: gpu ? ["webgpu"] : ["wasm"] },
      onProgress: i => say({ type: "progress", phase: "sep", p: i.progress }) });
    const bytes = await modelBytes();
    say({ type: "progress", phase: "load", p: 0 }); // starting the AI on this device: the first time takes a little longer
    await p.loadModel(bytes);
    proc = p; return p;
  })().catch(e => { loading = null; throw e; }));
}

// --- saving: lossless WAV for this device, high-quality AAC (256 kbps) for your other devices
function wav16(L, R, rate){
  const n = L.length, b = new ArrayBuffer(44 + n * 4), v = new DataView(b), w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, "RIFF"); v.setUint32(4, 36 + n * 4, true); w(8, "WAVE"); w(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 2, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 4, true); v.setUint16(32, 4, true); v.setUint16(34, 16, true); w(36, "data"); v.setUint32(40, n * 4, true);
  // light dither (TPDF) so quiet fades stay smooth in 16 bits
  for (let i = 0, o = 44; i < n; i++, o += 4){
    const d = () => (Math.random() - Math.random()) / 32768;
    v.setInt16(o, Math.max(-32768, Math.min(32767, Math.round((L[i] + d()) * 32767))), true);
    v.setInt16(o + 2, Math.max(-32768, Math.min(32767, Math.round((R[i] + d()) * 32767))), true);
  }
  return new Blob([b], { type: "audio/wav" });
}
async function aac(L, R, rate){
  if (typeof AudioEncoder === "undefined") return null;
  let cfg = null; // the highest quality this device can make (Windows goes up to 192 kbps; both are transparent to the ear)
  for (const bitrate of [256000, 192000, 160000]){
    const c = { codec: "mp4a.40.2", sampleRate: rate, numberOfChannels: 2, bitrate };
    try { if ((await AudioEncoder.isConfigSupported(c)).supported){ cfg = c; break; } } catch {}
  }
  if (!cfg) return null;
  const frames = []; let err = null;
  const enc = new AudioEncoder({ output: c => { const d = new Uint8Array(c.byteLength); c.copyTo(d); frames.push(d); }, error: e => { err = e; } });
  enc.configure(cfg);
  const CH = 4096, n = L.length;
  for (let i = 0; i < n; i += CH){
    const len = Math.min(CH, n - i), data = new Float32Array(len * 2);
    data.set(L.subarray(i, i + len), 0); data.set(R.subarray(i, i + len), len);
    enc.encode(new AudioData({ format: "f32-planar", sampleRate: rate, numberOfFrames: len, numberOfChannels: 2, timestamp: Math.round(i / rate * 1e6), data }));
    if (enc.encodeQueueSize > 64) await new Promise(r => setTimeout(r, 0));
  }
  await enc.flush(); enc.close();
  if (err || !frames.length) return null;
  // each frame gets its ADTS header, so the file plays on any phone (AAC-LC, 44.1/48 kHz, stereo)
  const idx = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000].indexOf(rate); if (idx < 0) return null;
  const out = frames.map(f => {
    const len = f.length + 7, h = new Uint8Array(7);
    h[0] = 0xFF; h[1] = 0xF1; h[2] = (1 << 6) | (idx << 2) | (2 >> 2); h[3] = ((2 & 3) << 6) | (len >> 11);
    h[4] = (len >> 3) & 0xFF; h[5] = ((len & 7) << 5) | 0x1F; h[6] = 0xFC;
    return [h, f];
  }).flat();
  return new Blob(out, { type: "audio/aac" });
}

function consistency(res, mix){ // how far the sum of the parts is from your song (0 = exact)
  const n = mix.length, step = Math.max(1, Math.floor(n / 400000)); let e = 0, s = 0;
  for (let i = 0; i < n; i += step){ const sum = res.drums.left[i] + res.bass.left[i] + res.other.left[i] + res.vocals.left[i], d = sum - mix[i]; e += d * d; s += mix[i] * mix[i]; }
  return s > 0 ? Math.sqrt(e / s) : 0;
}
onmessage = async e => {
  const m = e.data;
  if (!m || m.type !== "sep") return;
  try {
    say({ type: "progress", phase: "model", p: 0 });
    noGpu = !!m.noGpu;
    let p = await load();
    say({ type: "progress", phase: "sep", p: 0, gpu });
    const t0 = performance.now();
    let res = await p.separate(m.left, m.right);
    // quality check: the four parts must add back up to your song. Some graphics chips compute this model
    // wrong; if so, it is done again on the processor (slower, always right) and this device remembers it.
    const off = consistency(res, m.left);
    if (off > .08 && gpu){
      say({ type: "gpu-bad" }); noGpu = true; proc = null; loading = null;
      p = await load(); say({ type: "progress", phase: "sep", p: 0, gpu });
      res = await p.separate(m.left, m.right);
    }
    if (consistency(res, m.left) > .08) throw new Error("quality");
    const v = res.vocals, n = m.left.length, L = new Float32Array(n), R = new Float32Array(n);
    let peak = 0;
    for (let i = 0; i < n; i++){ L[i] = m.left[i] - v.left[i]; R[i] = m.right[i] - v.right[i]; peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i])); }
    // without the voice, a few peaks can go over the top: the file is stored a little lower (never clipped) and the
    // player raises it back by exactly the same amount, so it sounds as loud as your song
    let gain = 1;
    if (peak > .999){ gain = .999 / peak; for (let i = 0; i < n; i++){ L[i] *= gain; R[i] *= gain; } }
    say({ type: "progress", phase: "save", p: 0 });
    const wav = wav16(L, R, 44100), compressed = await aac(L, R, 44100);
    say({ type: "done", id: m.id, wav, aac: compressed, gain, secs: (performance.now() - t0) / 1000, gpu });
  } catch (err){
    say({ type: "error", id: m.id, msg: String(err && err.message || err).slice(0, 200) });
  }
};
