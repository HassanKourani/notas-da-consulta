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

let asr = null;
let spkProcessor = null;
let spkModel = null;
const queue = [];
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

// 'alta' = Whisper large-v3-turbo (best Portuguese, needs WebGPU, ~1.6 GB once)
// 'leve' = Whisper small (works everywhere, ~250-400 MB once)
async function pickConfig(quality) {
  const gpu = await webgpuInfo();
  const q = quality === 'auto' ? (gpu.webgpu && gpu.f16 ? 'alta' : 'leve') : quality;
  if (q === 'alta' && gpu.webgpu) {
    return {
      quality: 'alta',
      model: 'onnx-community/whisper-large-v3-turbo',
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
      model: 'onnx-community/whisper-small',
      device: 'webgpu',
      dtype: { encoder_model: gpu.f16 ? 'fp16' : 'fp32', decoder_model_merged: 'q4' },
    };
  }
  return { quality: 'leve', model: 'onnx-community/whisper-small', device: 'wasm', dtype: 'q8' };
}

function progress(p) {
  if (p.status === 'progress' && p.total) {
    self.postMessage({ type: 'progress', file: p.file, loaded: p.loaded, total: p.total });
  }
}

async function load(quality) {
  const cfg = await pickConfig(quality);
  self.postMessage({ type: 'loading', ...cfg });
  asr = await pipeline('automatic-speech-recognition', cfg.model, {
    device: cfg.device,
    dtype: cfg.dtype,
    progress_callback: progress,
  });
  spkProcessor = await AutoProcessor.from_pretrained(SPEAKER_MODEL, { progress_callback: progress });
  spkModel = await AutoModel.from_pretrained(SPEAKER_MODEL, {
    device: 'wasm',
    dtype: 'fp32',
    progress_callback: progress,
  });
  // Warm up so the first real sentence isn't slow.
  await asr(new Float32Array(16000), { language: 'portuguese', task: 'transcribe' });
  markReady();
  self.postMessage({ type: 'ready', ...cfg });
}

async function embed(audio) {
  const inputs = await spkProcessor(audio);
  const out = await spkModel(inputs);
  const t = out.embeddings ?? out.last_hidden_state ?? Object.values(out)[0];
  return Array.from(t.data);
}

async function work() {
  if (busy) return;
  busy = true;
  await ready;
  while (queue.length) {
    const job = queue.shift();
    try {
      const r = await asr(job.audio, { language: 'portuguese', task: 'transcribe' });
      const text = (r.text || '').trim();
      const emb = text ? await embed(job.audio) : null;
      self.postMessage({ type: 'result', id: job.id, text, emb, pending: queue.length });
    } catch (e) {
      self.postMessage({ type: 'result', id: job.id, text: '', emb: null, error: String(e), pending: queue.length });
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
    work();
  }
};
