// Runs Whisper (speech to text) and WeSpeaker (voice fingerprint) entirely in
// the browser. Audio never leaves the machine; only model files are
// downloaded once from Hugging Face and cached by the browser.
import {
  pipeline,
  AutoProcessor,
  AutoModel,
  env,
} from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.2.0/dist/transformers.min.js';

env.allowLocalModels = false;

const SPEAKER_MODEL = 'onnx-community/wespeaker-voxceleb-resnet34-LM';
const SR = 16000;
// Whisper always encodes a 30 s window (~1.5 s on a laptop GPU) however short
// the audio, so lines waiting in the queue are joined into one pass (7 lines:
// 2.8 s joined vs 12.3 s one by one), with a short pause between them. Word
// timestamps then give each line its own words. When nothing is waiting a line
// is sent on its own straight away. Longer joins (24 s, 10 lines) made Whisper
// skip whole sentences, so batches stay short and any line that comes back
// with far too few words is transcribed again on its own.
const MAX_BATCH = 12;
const GAP = 0.5;
const MIN_WORDS_PER_SEC = 0.8; // normal speech is ~2.5 words/s

let asr = null;
let spkProcessor = null;
let spkModel = null;
const queue = [];
let partial = null; // latest live-preview request; only the newest is kept
let busy = false;
// Segments can arrive while models are still downloading; they wait here.
let markReady;
const ready = new Promise((r) => { markReady = r; });

async function webgpuInfo() {
  if (!navigator.gpu) return { webgpu: false, f16: false };
  try {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) return { webgpu: false, f16: false };
    return { webgpu: true, f16: adapter.features.has('shader-f16') };
  } catch {
    return { webgpu: false, f16: false };
  }
}

// 'alta' = Whisper large-v3-turbo (best Portuguese, needs WebGPU, ~560-760 MB once)
// 'leve' = Whisper small (smaller download, also runs without a GPU). With word
// timestamps it was slower than turbo on a GPU (90 s of speech: 79 s vs 22 s)
// and less accurate, so 'auto' only picks it when there is no WebGPU.
async function pickConfig(quality) {
  const gpu = await webgpuInfo();
  const q = quality === 'auto' ? (gpu.webgpu ? 'alta' : 'leve') : quality;
  if (q === 'alta' && gpu.webgpu) {
    return {
      quality: 'alta',
      model: 'onnx-community/whisper-large-v3-turbo_timestamped',
      device: 'webgpu',
      // 4-bit weights: ~560 MB (f16) / ~760 MB instead of 1.6 GB for fp16,
      // which crashed a test browser while loading.
      dtype: gpu.f16
        ? { encoder_model: 'q4f16', decoder_model_merged: 'q4f16' }
        : { encoder_model: 'q4', decoder_model_merged: 'q4' },
    };
  }
  if (gpu.webgpu) {
    return {
      quality: 'leve',
      model: 'onnx-community/whisper-small_timestamped',
      device: 'webgpu',
      dtype: { encoder_model: gpu.f16 ? 'fp16' : 'fp32', decoder_model_merged: 'q4' },
    };
  }
  return { quality: 'leve', model: 'onnx-community/whisper-small_timestamped', device: 'wasm', dtype: 'q8' };
}

// transformers.js keeps downloaded model files in this Cache Storage bucket.
async function isCached(model) {
  try {
    const cache = await caches.open('transformers-cache');
    const keys = await cache.keys();
    return keys.some((r) => r.url.includes(model) && r.url.includes('.onnx'));
  } catch {
    return false;
  }
}

function progress(p) {
  if (p.status === 'progress' && p.total) {
    self.postMessage({ type: 'progress', file: p.file, loaded: p.loaded, total: p.total });
  }
}

async function load(quality) {
  const cfg = await pickConfig(quality);
  self.postMessage({ type: 'loading', ...cfg, cached: await isCached(cfg.model) });
  asr = await pipeline('automatic-speech-recognition', cfg.model, {
    device: cfg.device,
    dtype: cfg.dtype,
    progress_callback: progress,
  });
  spkProcessor = await AutoProcessor.from_pretrained(SPEAKER_MODEL, { progress_callback: progress });
  // The voice-print model on the CPU costs ~0.1 s per second of speech; try the GPU first.
  try {
    if (!(await webgpuInfo()).webgpu) throw new Error('no webgpu');
    spkModel = await AutoModel.from_pretrained(SPEAKER_MODEL, { device: 'webgpu', dtype: 'fp32', progress_callback: progress });
    await embed(new Float32Array(SR));
  } catch {
    spkModel = await AutoModel.from_pretrained(SPEAKER_MODEL, { device: 'wasm', dtype: 'fp32', progress_callback: progress });
  }
  // Warm up so the first real sentence isn't slow.
  await asr(new Float32Array(16000), { language: 'portuguese', task: 'transcribe' });
  markReady();
  self.postMessage({ type: 'ready', ...cfg });
  dropOldModels();
}

// Earlier versions used Whisper builds without word timestamps and a pyannote
// model; free that disk space (~600 MB) once the new model works.
async function dropOldModels() {
  try {
    const cache = await caches.open('transformers-cache');
    for (const r of await cache.keys()) {
      if (/\/(whisper-large-v3-turbo|whisper-small|pyannote-segmentation-3\.0)\/resolve\//.test(r.url)) await cache.delete(r);
    }
  } catch { /* nothing to clean */ }
}

async function embed(audio) {
  const inputs = await spkProcessor(audio);
  const out = await spkModel(inputs);
  const t = out.embeddings ?? out.last_hidden_state ?? Object.values(out)[0];
  return Array.from(t.data);
}

async function transcribe(audio) {
  const r = await asr(audio, { language: 'portuguese', task: 'transcribe' });
  return (r.text || '').trim();
}

// Transcribe one or more lines in a single Whisper pass and give each line the
// words spoken inside it (by word timestamp).
async function transcribeBatch(batch, ms) {
  const texts = new Map(batch.map((job) => [job, []]));
  let t0 = performance.now();
  if (batch.length === 1) {
    texts.get(batch[0]).push(await transcribe(batch[0].audio));
  } else {
    const spans = [];
    let offset = 0;
    for (const job of batch) {
      spans.push({ job, from: offset, to: offset + job.audio.length / SR });
      offset += job.audio.length / SR + GAP;
    }
    const joined = new Float32Array(Math.ceil(offset * SR));
    for (const s of spans) joined.set(s.job.audio, Math.round(s.from * SR));
    const r = await asr(joined, { language: 'portuguese', task: 'transcribe', return_timestamps: 'word' });
    for (const w of r.chunks || []) {
      const s = w.timestamp[0] ?? 0;
      const mid = (s + (w.timestamp[1] ?? s)) / 2;
      // The line this word was spoken in (or the nearest one, for words Whisper
      // places in the pause between two lines).
      let best = spans[0], bestD = Infinity;
      for (const sp of spans) {
        const d = mid < sp.from ? sp.from - mid : mid > sp.to ? mid - sp.to : 0;
        if (d < bestD) { bestD = d; best = sp; }
      }
      texts.get(best.job).push(w.text);
    }
    for (const job of batch) {
      const dur = job.audio.length / SR;
      if (dur >= 0.8 && texts.get(job).length < dur * MIN_WORDS_PER_SEC) {
        texts.set(job, [await transcribe(job.audio)]);
        ms.retry = (ms.retry || 0) + 1;
      }
    }
  }
  ms.asr += performance.now() - t0;
  t0 = performance.now();
  const out = new Map();
  for (const job of batch) {
    const text = texts.get(job).join('').replace(/\s+/g, ' ').trim();
    out.set(job, text ? [{ start: 0, end: job.audio.length / SR, text, emb: await embed(job.audio) }] : []);
  }
  ms.emb += performance.now() - t0;
  return out;
}

async function work() {
  if (busy) return;
  busy = true;
  await ready;
  while (queue.length || partial) {
    if (!queue.length) {
      // Idle: give a quick preview of the sentence still being spoken.
      const job = partial;
      partial = null;
      try {
        self.postMessage({ type: 'partial', id: job.id, text: await transcribe(job.audio) });
      } catch { /* a preview is optional */ }
      continue;
    }
    const batch = [queue.shift()];
    let total = batch[0].audio.length / SR;
    while (queue.length && total + GAP + queue[0].audio.length / SR <= MAX_BATCH) {
      total += GAP + queue[0].audio.length / SR;
      batch.push(queue.shift());
    }
    const ms = { asr: 0, emb: 0, batch: batch.length };
    try {
      const out = await transcribeBatch(batch, ms);
      for (const job of batch) self.postMessage({ type: 'result', id: job.id, pieces: out.get(job), ms, pending: queue.length });
    } catch (e) {
      for (const job of batch) self.postMessage({ type: 'result', id: job.id, pieces: [], ms, error: String(e), pending: queue.length });
    }
  }
  busy = false;
}

self.onmessage = async (e) => {
  const m = e.data;
  if (m.type === 'load') {
    try {
      await load(m.quality);
    } catch (err) {
      self.postMessage({ type: 'error', message: String(err && err.message ? err.message : err) });
    }
  } else if (m.type === 'segment') {
    queue.push(m);
    if (partial && partial.id <= m.id) partial = null;
    work();
  } else if (m.type === 'partial') {
    partial = m;
    work();
  }
};
