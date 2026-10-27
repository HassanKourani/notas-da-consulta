// Notas da Consulta — live meeting transcription that runs entirely in the browser.
// Flow: microphone -> audio-processor.js (16 kHz frames) -> voice-activity
// segmenter (here) -> worker.js (Whisper text + speaker fingerprint) ->
// speaker clustering (here) -> transcript.

const SR = 16000;
const FRAME = 512;
const STORE_KEY = 'notas-consulta:v1';
const QUALITY_KEY = 'notas-consulta:quality';

// Voice-print similarity (cosine). Synthetic test voices: same speaker 0.58-0.95
// (clean and with room noise), different <0.15. Real people vary more (tone,
// posture, distance), so a new speaker is only created when a clip is clearly
// unlike everyone so far; anything in between goes to the closest known voice.
const NEW_SPEAKER = 0.25;
// After the meeting, groups whose voices are at least this close are merged.
const MERGE_SPEAKERS = 0.35;
// Clips shorter than this ("sim", "uhum") give unreliable voice prints and
// never start a new speaker.
const MIN_NEW_SPEAKER_SECONDS = 2;
const SPEAKER_COLORS = ['#1F3A5F', '#0F6B5C', '#8A4B00', '#6B3FA0', '#A0325A', '#3F6B1F', '#5B616E'];

const CLAUDE_PROMPT = `Você é assistente de uma advogada brasileira. Abaixo está a transcrição automática de uma reunião presencial com cliente(s).

Atenção:
- A transcrição foi feita por reconhecimento de voz e pode conter erros de palavras.
- Os participantes aparecem como "Falante 1", "Falante 2" etc. (ou pelo nome, se a advogada os renomeou). A separação entre falantes é automática e pode ter erros. Pelo conteúdo, indique quem provavelmente é a advogada e quem é o cliente.
- Trechos com [MARCADO] foram destacados pela advogada como importantes durante a reunião.
- Não invente fatos, datas ou valores que não estejam na transcrição. Se algo estiver ambíguo, diga que está ambíguo.

Com base na transcrição, escreva em português do Brasil:

1. Resumo da reunião (5 a 8 linhas)
2. Pontos principais: fatos, datas, prazos, valores, pessoas e documentos mencionados
3. Próximos passos: quem faz o quê e até quando (separe o que é da advogada e o que é do cliente)
4. Pontos de atenção jurídica e riscos mencionados
5. Informações ou documentos que ainda faltam e perguntas para fazer ao cliente

TRANSCRIÇÃO
`;

// Whisper's well-known "phantom" outputs on silence or noise in Portuguese.
const JUNK = [
  /amara\.org/i,
  /legendas?\s+(pela|por|da|em)/i,
  /legendado\s+por/i,
  /obrigad[oa]s?\s+por\s+assistir/i,
  /inscreva-se/i,
  /se\s+inscreva/i,
  /deixe\s+(seu|o\s+seu)\s+like/i,
  /^[\s\p{P}]*$/u,
  /^(música|\[música\]|\(música\)|♪+)$/i,
];

// ---------- state ----------
const S = {
  status: 'idle', // idle | rec | paused | stopped
  title: 'Consulta com cliente',
  startedAt: null,
  samples: 0, // meeting audio samples captured, drives the clock and timestamps
  lines: [], // { id, t, text, spk, marked, emb }
  names: {}, // speaker number -> custom name
  nextId: 1,
  people: 0, // expected number of people in the room; 0 = detect automatically
};
const pending = new Map(); // segment id -> { t, marked }
let centroids = []; // index = speaker - 1; { sum: Float64Array, n }

// ---------- dom ----------
const $ = (id) => document.getElementById(id);
const el = {
  statusLabel: $('statusLabel'), recDot: $('recDot'), clock: $('clock'),
  title: $('mtitle'), meta: $('meta'),
  start: $('btnStart'), pause: $('btnPause'), mark: $('btnMark'), resume: $('btnResume'),
  stop: $('btnStop'), newMeeting: $('btnNew'), copy: $('btnCopy'), download: $('btnDownload'),
  claude: $('btnClaude'), counts: $('counts'), list: $('list'), empty: $('empty'), lines: $('lines'),
  listening: $('listening'), listeningText: $('listeningText'), pausedNote: $('pausedNote'),
  speakers: $('speakers'), noSpeakers: $('noSpeakers'),
  engineText: $('engineText'), progressWrap: $('progressWrap'), progressBar: $('progressBar'),
  quality: $('quality'), toast: $('toast'), people: $('people'),
};

// ---------- helpers ----------
const fmt = (s) => {
  s = Math.floor(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  const p = (n) => String(n).padStart(2, '0');
  return (h ? h + ':' : '') + p(m) + ':' + p(x);
};
const fmtDate = (d) => new Date(d).toLocaleDateString('pt-BR', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
const speakerName = (n) => S.names[n] || `Falante ${n}`;
const speakerColor = (n) => SPEAKER_COLORS[(n - 1) % SPEAKER_COLORS.length];
const seconds = () => S.samples / SR;

function normalize(v) {
  let s = 0;
  for (const x of v) s += x * x;
  s = Math.sqrt(s) || 1;
  return v.map((x) => x / s);
}
function cosine(a, b) {
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return d / (Math.sqrt(na * nb) || 1);
}

let toastT;
function flash(msg) {
  clearTimeout(toastT);
  el.toast.textContent = msg;
  el.toast.hidden = false;
  toastT = setTimeout(() => { el.toast.hidden = true; }, 2200);
}

function cleanText(t) {
  t = t.replace(/\s+/g, ' ').trim();
  // Collapse Whisper repetition loops ("sim, sim, sim, sim, sim...").
  t = t.replace(/(\b.{2,40}?)(?:[\s,.]*\1){3,}/gi, '$1');
  if (JUNK.some((r) => r.test(t))) return '';
  return t;
}

// ---------- speakers ----------
// How well a voice print matches each known speaker: the better of the
// speaker's average voice and their single closest earlier clip, so one person
// whose tone varies over the meeting still matches.
function speakerScores(v) {
  return centroids.map((c, i) => {
    if (!c.sum || !c.n) return { spk: i + 1, sim: -1 };
    let sim = cosine(v, c.sum);
    for (const l of S.lines) if (l.spk === i + 1 && l.emb) sim = Math.max(sim, cosine(v, l.emb));
    return { spk: i + 1, sim };
  });
}

function assignSpeaker(emb, dur) {
  const last = S.lines.length ? S.lines[S.lines.length - 1].spk : 0;
  if (!emb) return last || addCentroid(null);
  const v = normalize(emb);
  const best = speakerScores(v).reduce((a, b) => (b.sim > a.sim ? b : a), { spk: 0, sim: -1 });
  const full = S.people > 0 && centroids.length >= S.people;
  if (best.spk && (best.sim >= NEW_SPEAKER || dur < MIN_NEW_SPEAKER_SECONDS || full)) {
    const c = centroids[best.spk - 1];
    for (let i = 0; i < v.length; i++) c.sum[i] += v[i];
    c.n++;
    return best.spk;
  }
  return addCentroid(v);
}
function addCentroid(v) {
  centroids.push({ sum: v ? Float64Array.from(v) : null, n: v ? 1 : 0 });
  return centroids.length;
}
function rebuildCentroids() {
  const max = S.lines.reduce((m, l) => Math.max(m, l.spk), 0);
  centroids = Array.from({ length: max }, () => ({ sum: null, n: 0 }));
  for (const l of S.lines) {
    if (!l.emb) continue;
    const c = centroids[l.spk - 1];
    const v = normalize(l.emb);
    if (!c.sum) c.sum = new Float64Array(v.length);
    for (let i = 0; i < v.length; i++) c.sum[i] += v[i];
    c.n++;
  }
}

function mergeSpeaker(from, into) {
  for (const l of S.lines) if (l.spk === from) l.spk = into;
  if (!S.names[into] && S.names[from]) S.names[into] = S.names[from];
  delete S.names[from];
}

// After the meeting, with every voice sample in hand, re-check who said what.
function refineSpeakers() {
  const withEmb = S.lines.filter((l) => l.emb && !l.manual);
  if (withEmb.length < 3) return;
  const vecs = new Map(withEmb.map((l) => [l.id, normalize(l.emb)]));
  // 1. Move each clip to the voice it is closest to overall.
  for (let iter = 0; iter < 5; iter++) {
    rebuildCentroids();
    let changed = false;
    for (const l of withEmb) {
      const v = vecs.get(l.id);
      let best = l.spk, bestSim = -1;
      centroids.forEach((c, i) => {
        if (!c.sum || c.n === 0) return;
        const sim = cosine(v, c.sum);
        if (sim > bestSim) { bestSim = sim; best = i + 1; }
      });
      if (best !== l.spk) { l.spk = best; changed = true; }
    }
    if (!changed) break;
  }
  // 2. Merge the two closest voices while they sound alike, or while there
  //    are more speakers than people in the room.
  for (;;) {
    rebuildCentroids();
    const live = centroids.map((c, i) => ({ c, spk: i + 1 })).filter((x) => x.c.sum && x.c.n);
    let pair = null;
    for (let a = 0; a < live.length; a++) {
      for (let b = a + 1; b < live.length; b++) {
        const sim = cosine(live[a].c.sum, live[b].c.sum);
        if (!pair || sim > pair.sim) pair = { a: live[a], b: live[b], sim };
      }
    }
    if (!pair) break;
    const tooMany = S.people > 0 && live.length > S.people;
    if (pair.sim < MERGE_SPEAKERS && !tooMany) break;
    // Keep the speaker with more clips (and so the more reliable number/name).
    const [keep, drop] = pair.a.c.n >= pair.b.c.n ? [pair.a, pair.b] : [pair.b, pair.a];
    mergeSpeaker(drop.spk, keep.spk);
  }
  renumberSpeakers();
}

// Make speakers 1..k in order of first appearance, carrying names along.
function renumberSpeakers() {
  const map = new Map();
  for (const l of S.lines) if (!map.has(l.spk)) map.set(l.spk, map.size + 1);
  const names = {};
  for (const [oldN, newN] of map) if (S.names[oldN]) names[newN] = S.names[oldN];
  for (const l of S.lines) l.spk = map.get(l.spk);
  S.names = names;
  rebuildCentroids();
}

// ---------- segmenter (voice activity detection) ----------
const seg = {
  active: false, frames: [], voiced: 0, silence: 0, run: 0, start: 0,
  preroll: [], noise: 0.01, marked: false,
};
const PREROLL = 10; // ~320 ms kept before speech starts
const END_SILENCE = 22; // ~700 ms of quiet ends a sentence
const SOFT_END_SILENCE = 8; // after 12 s, ~250 ms of quiet is enough
const MAX_FRAMES = Math.round((20 * SR) / FRAME);
const SOFT_FRAMES = Math.round((12 * SR) / FRAME);
let level = 0;

function onFrame(frame) {
  if (S.status !== 'rec') return;
  let sum = 0;
  for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
  const rms = Math.sqrt(sum / frame.length);
  level = level * 0.8 + rms * 0.2;

  const threshold = Math.max(seg.noise * 3, 0.006);
  const speech = rms > threshold;
  if (!seg.active) {
    // Track the room's background level while nobody is talking.
    seg.noise = rms < seg.noise ? seg.noise * 0.9 + rms * 0.1 : seg.noise * 0.995 + rms * 0.005;
    seg.preroll.push(frame);
    if (seg.preroll.length > PREROLL) seg.preroll.shift();
    seg.run = speech ? seg.run + 1 : 0;
    if (seg.run >= 3) {
      seg.active = true;
      seg.frames = seg.preroll.slice();
      seg.start = S.samples - (seg.frames.length - 1) * FRAME;
      seg.voiced = seg.run;
      seg.silence = 0;
      seg.preroll = [];
    }
  } else {
    seg.frames.push(frame);
    if (speech) { seg.voiced++; seg.silence = 0; } else seg.silence++;
    const n = seg.frames.length;
    if (seg.silence >= END_SILENCE || n >= MAX_FRAMES || (n >= SOFT_FRAMES && seg.silence >= SOFT_END_SILENCE)) {
      flushSegment();
    }
  }
  S.samples += FRAME;
}

function flushSegment() {
  if (!seg.active) return;
  const keepTail = Math.max(0, seg.silence - 6); // leave ~200 ms of trailing quiet
  const frames = seg.frames.slice(0, seg.frames.length - keepTail);
  const voiced = seg.voiced;
  const t = Math.max(0, seg.start / SR);
  const marked = seg.marked;
  seg.active = false; seg.frames = []; seg.voiced = 0; seg.silence = 0; seg.run = 0; seg.marked = false;
  if (voiced < 10) return; // under ~0.3 s of actual voice: a cough or a click
  const audio = new Float32Array(frames.length * FRAME);
  frames.forEach((f, i) => audio.set(f, i * FRAME));
  const id = S.nextId++;
  pending.set(id, { t, marked, dur: audio.length / SR });
  worker.postMessage({ type: 'segment', id, audio }, [audio.buffer]);
  renderStatus();
}

// ---------- microphone ----------
let audioCtx = null, stream = null, wakeLock = null;

async function startMic() {
  stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  audioCtx = new AudioContext();
  await audioCtx.audioWorklet.addModule('audio-processor.js');
  const src = audioCtx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(audioCtx, 'downsampler');
  node.port.onmessage = (e) => onFrame(e.data);
  const mute = audioCtx.createGain();
  mute.gain.value = 0;
  src.connect(node).connect(mute).connect(audioCtx.destination);
}

function stopMic() {
  if (stream) stream.getTracks().forEach((t) => t.stop());
  if (audioCtx) audioCtx.close();
  stream = null; audioCtx = null;
}

async function keepAwake(on) {
  try {
    if (on && 'wakeLock' in navigator && !wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } else if (!on && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch { /* not supported or not allowed; harmless */ }
}

// ---------- actions ----------
async function start() {
  try {
    if (!audioCtx) await startMic();
    else await audioCtx.resume();
  } catch (e) {
    console.error(e);
    flash('Não foi possível acessar o microfone. Permita o acesso no navegador.');
    return;
  }
  if (!S.startedAt) S.startedAt = Date.now();
  S.status = 'rec';
  keepAwake(true);
  render();
  save();
}

async function pause() {
  flushSegment();
  S.status = 'paused';
  if (audioCtx) await audioCtx.suspend();
  keepAwake(false);
  render();
  save();
}

function stop() {
  flushSegment();
  S.status = 'stopped';
  stopMic();
  keepAwake(false);
  if (pending.size === 0) finish();
  render();
  save();
}

function finish() {
  refineSpeakers();
  renderAllLines();
  renderSpeakers();
  save();
}

function mark() {
  if (seg.active) {
    seg.marked = true;
    flash('Momento marcado');
    return;
  }
  const last = S.lines[S.lines.length - 1];
  const inFlight = [...pending.values()].pop();
  if (inFlight) { inFlight.marked = true; flash('Momento marcado'); return; }
  if (!last) { flash('Nada para marcar ainda'); return; }
  last.marked = true;
  renderLine(last);
  renderCounts();
  save();
  flash('Momento marcado');
}

function newMeeting() {
  if (S.lines.length && !confirm('Começar uma nova reunião? A transcrição atual será apagada desta tela. Baixe o .txt antes se quiser guardá-la.')) return;
  Object.assign(S, { status: 'idle', title: 'Consulta com cliente', startedAt: null, samples: 0, lines: [], names: {} });
  pending.clear();
  centroids = [];
  el.lines.innerHTML = '';
  lineEls.clear();
  el.title.value = S.title;
  render();
  save();
}

function asText() {
  const spk = [...new Set(S.lines.map((l) => l.spk))].map(speakerName);
  const out = [S.title, fmtDate(S.startedAt || Date.now()), 'Duração: ' + fmt(seconds())];
  if (spk.length) out.push('Participantes: ' + spk.join(', '));
  out.push('');
  for (const l of S.lines) {
    out.push(`[${fmt(l.t)}] ${speakerName(l.spk)}: ${l.text}${l.marked ? '  [MARCADO]' : ''}`);
  }
  return out.join('\n');
}

async function copyText(text, okMsg) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  flash(okMsg);
}

function download() {
  const blob = new Blob([asText()], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  const day = new Date(S.startedAt || Date.now()).toISOString().slice(0, 10);
  const slug = S.title.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'reuniao';
  a.href = URL.createObjectURL(blob);
  a.download = `${slug}-${day}.txt`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------- worker ----------
let worker;
const files = new Map();

function startWorker() {
  if (worker) worker.terminate();
  files.clear();
  worker = new Worker('worker.js?v=3', { type: 'module' });
  worker.onmessage = onWorker;
  worker.onerror = (e) => {
    console.error(e);
    el.engineText.textContent = 'Erro ao carregar o reconhecimento de voz. Recarregue a página.';
  };
  el.engineText.textContent = 'Preparando…';
  el.progressWrap.hidden = true;
  engineReady = false;
  worker.postMessage({ type: 'load', quality: el.quality.value });
}
let engineReady = false;
let engineDesc = '';

function onWorker(e) {
  const m = e.data;
  if (m.type === 'loading') {
    const size = m.quality === 'alta' ? '~600 MB' : '~300 MB';
    engineDesc = `${m.quality === 'alta' ? 'Alta' : 'Leve'} · ${m.device === 'webgpu' ? 'placa de vídeo' : 'processador'}`;
    el.engineText.textContent = m.cached
      ? 'Carregando o modelo de voz salvo neste computador…'
      : `Baixando o modelo de voz (${size}, só na primeira vez)…`;
  } else if (m.type === 'progress') {
    files.set(m.file, m);
    let loaded = 0, total = 0;
    for (const f of files.values()) { loaded += f.loaded; total += f.total; }
    el.progressWrap.hidden = false;
    el.progressBar.style.width = `${Math.round((loaded / total) * 100)}%`;
  } else if (m.type === 'ready') {
    engineReady = true;
    el.progressWrap.hidden = true;
    el.engineText.textContent = `Pronto · ${engineDesc}. Tudo é processado neste computador.`;
    renderStatus();
  } else if (m.type === 'error') {
    el.engineText.textContent = 'Erro ao carregar o reconhecimento de voz: ' + m.message;
  } else if (m.type === 'result') {
    onResult(m);
  }
}

function onResult(m) {
  const p = pending.get(m.id);
  pending.delete(m.id);
  if (m.error) console.warn('segment failed', m.error);
  const text = p ? cleanText(m.text) : '';
  if (text) {
    const line = { id: m.id, t: p.t, text, spk: assignSpeaker(m.emb, p.dur), d: p.dur, marked: p.marked, emb: m.emb ? m.emb.map((x) => Math.round(x * 1e4) / 1e4) : null };
    // Results arrive in order, but keep the transcript sorted by time anyway.
    S.lines.push(line);
    S.lines.sort((a, b) => a.t - b.t);
    renderLine(line);
    renderSpeakers();
    save();
  }
  if (S.status === 'stopped' && pending.size === 0) finish();
  render();
}

// ---------- rendering ----------
const lineEls = new Map();

function renderLine(line) {
  let node = lineEls.get(line.id);
  if (!node) {
    node = document.createElement('div');
    node.className = 'line';
    node.innerHTML = `
      <button class="line-time" title="Marcar / desmarcar"></button>
      <div class="line-body">
        <div class="line-head"><button class="spk" title="Trocar falante desta fala"></button><span class="badge" hidden>Marcado</span></div>
        <p class="line-text" contenteditable="plaintext-only" spellcheck="false" title="Clique para corrigir o texto"></p>
      </div>`;
    node.querySelector('.line-time').onclick = () => { line.marked = !line.marked; renderLine(line); renderCounts(); save(); };
    node.querySelector('.spk').onclick = (ev) => pickSpeaker(line, ev.currentTarget);
    const p = node.querySelector('.line-text');
    p.addEventListener('blur', () => {
      const t = p.textContent.trim();
      if (t && t !== line.text) { line.text = t; save(); }
      else p.textContent = line.text;
    });
    p.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); p.blur(); } });
    lineEls.set(line.id, node);
    // Insert in time order.
    const idx = S.lines.indexOf(line);
    const next = S.lines[idx + 1] && lineEls.get(S.lines[idx + 1].id);
    const nearBottom = el.list.scrollHeight - el.list.scrollTop - el.list.clientHeight < 80;
    el.lines.insertBefore(node, next || null);
    if (nearBottom) el.list.scrollTop = el.list.scrollHeight;
  }
  node.classList.toggle('marked', !!line.marked);
  node.querySelector('.line-time').textContent = fmt(line.t);
  const spk = node.querySelector('.spk');
  spk.textContent = speakerName(line.spk);
  spk.style.color = speakerColor(line.spk);
  node.querySelector('.badge').hidden = !line.marked;
  const p = node.querySelector('.line-text');
  if (document.activeElement !== p) p.textContent = line.text;
}

function renderAllLines() {
  S.lines.forEach(renderLine);
}

// Inline menu to move one line to another speaker (fixes diarization slips).
function pickSpeaker(line, anchor) {
  const sel = document.createElement('select');
  sel.className = 'spk';
  const count = Math.max(centroids.length, ...S.lines.map((l) => l.spk));
  for (let n = 1; n <= count; n++) sel.add(new Option(speakerName(n), n, false, n === line.spk));
  sel.add(new Option('+ Novo falante', count + 1));
  anchor.replaceWith(sel);
  sel.focus();
  let closed = false;
  const done = () => {
    if (closed) return;
    closed = true;
    const n = Number(sel.value);
    sel.replaceWith(anchor);
    if (n !== line.spk) {
      line.spk = n;
      line.manual = true;
      rebuildCentroids();
      renderLine(line);
      renderSpeakers();
      save();
    }
  };
  sel.addEventListener('change', done);
  sel.addEventListener('blur', done);
}

function renderSpeakers() {
  const counts = new Map();
  for (const l of S.lines) counts.set(l.spk, (counts.get(l.spk) || 0) + 1);
  const ids = [...counts.keys()].sort((a, b) => a - b);
  el.noSpeakers.hidden = ids.length > 0;
  const focused = document.activeElement && document.activeElement.dataset.spk;
  if (focused) return; // don't rebuild while the user is typing a name
  el.speakers.innerHTML = '';
  for (const n of ids) {
    const li = document.createElement('li');
    const sw = document.createElement('span');
    sw.className = 'swatch';
    sw.style.background = speakerColor(n);
    const input = document.createElement('input');
    input.value = speakerName(n);
    input.dataset.spk = n;
    input.setAttribute('aria-label', `Nome do Falante ${n}`);
    input.addEventListener('change', () => {
      const v = input.value.trim();
      if (v && v !== `Falante ${n}`) S.names[n] = v; else delete S.names[n];
      renderAllLines();
      save();
    });
    input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') input.blur(); });
    input.addEventListener('blur', () => setTimeout(renderSpeakers));
    const merge = document.createElement('select');
    merge.className = 'merge';
    merge.title = 'Se for a mesma pessoa, junte as falas';
    merge.setAttribute('aria-label', `Juntar ${speakerName(n)} com outro falante`);
    merge.add(new Option('Juntar com…', ''));
    for (const o of ids) if (o !== n) merge.add(new Option(speakerName(o), o));
    merge.hidden = ids.length < 2;
    merge.addEventListener('change', () => {
      const into = Number(merge.value);
      if (!into) return;
      mergeSpeaker(n, into);
      renumberSpeakers();
      renderAllLines();
      renderSpeakers();
      render();
      save();
      flash('Falantes unidos');
    });
    const c = document.createElement('span');
    c.className = 'muted';
    c.textContent = `${counts.get(n)} ${counts.get(n) === 1 ? 'fala' : 'falas'}`;
    li.append(sw, input, c, merge);
    el.speakers.append(li);
  }
}

function renderCounts() {
  const marks = S.lines.filter((l) => l.marked).length;
  el.counts.textContent = `${S.lines.length} ${S.lines.length === 1 ? 'fala' : 'falas'} · ${marks} ${marks === 1 ? 'marcada' : 'marcadas'}`;
}

function renderStatus() {
  const labels = { idle: 'Pronto', rec: 'Ouvindo', paused: 'Pausado', stopped: 'Encerrado' };
  const colors = { idle: '#5B616E', rec: '#C2362B', paused: '#8A4B00', stopped: '#1F3A5F' };
  el.statusLabel.textContent = labels[S.status];
  el.statusLabel.style.color = colors[S.status];
  el.recDot.hidden = S.status !== 'rec';
  el.clock.textContent = fmt(seconds());

  const waiting = pending.size;
  el.listening.hidden = !(S.status === 'rec' || waiting > 0);
  el.listening.querySelector('.eq').classList.toggle('quiet', S.status !== 'rec');
  if (!engineReady && S.status === 'rec') el.listeningText.textContent = 'Ouvindo… a transcrição começa assim que o modelo de voz terminar de baixar.';
  else if (S.status === 'rec') el.listeningText.textContent = waiting > 1 ? `Ouvindo… (${waiting} trechos sendo transcritos)` : 'Ouvindo…';
  else el.listeningText.textContent = `Finalizando a transcrição… (${waiting} ${waiting === 1 ? 'trecho' : 'trechos'})`;
  el.pausedNote.hidden = S.status !== 'paused';
}

function render() {
  const st = S.status;
  el.start.hidden = st !== 'idle';
  el.start.disabled = false;
  el.pause.hidden = st !== 'rec';
  el.mark.hidden = st !== 'rec';
  el.resume.hidden = st !== 'paused';
  el.stop.hidden = !(st === 'rec' || st === 'paused');
  el.newMeeting.hidden = st !== 'stopped';
  const none = S.lines.length === 0;
  el.copy.disabled = none;
  el.download.disabled = none;
  el.claude.disabled = none;
  el.empty.hidden = !none;
  el.quality.disabled = st === 'rec' || st === 'paused';
  el.meta.textContent = fmtDate(S.startedAt || Date.now()) + (S.lines.length ? ` · Participantes: ${[...new Set(S.lines.map((l) => l.spk))].sort((a, b) => a - b).map(speakerName).join(', ')}` : '');
  renderCounts();
  renderStatus();
}

// ---------- persistence ----------
let saveT;
function save() {
  clearTimeout(saveT);
  saveT = setTimeout(() => {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({
        title: S.title, startedAt: S.startedAt, samples: S.samples, lines: S.lines, people: S.people,
        names: S.names, nextId: S.nextId, status: S.status,
      }));
    } catch (e) { console.warn('save failed', e); }
  }, 300);
}

function restore() {
  try {
    const d = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
    if (!d) return;
    Object.assign(S, d);
    // The microphone can't survive a page reload; continue as paused.
    if (S.status === 'rec') S.status = 'paused';
    if (S.status === 'idle' && S.lines.length) S.status = 'paused';
    el.title.value = S.title;
    el.people.value = String(S.people || 0);
    rebuildCentroids();
    renderAllLines();
    renderSpeakers();
  } catch (e) { console.warn('restore failed', e); }
}

// ---------- wiring ----------
el.start.onclick = start;
el.resume.onclick = start;
el.pause.onclick = pause;
el.stop.onclick = stop;
el.mark.onclick = mark;
el.newMeeting.onclick = newMeeting;
el.copy.onclick = () => copyText(asText(), 'Transcrição copiada');
el.download.onclick = download;
el.claude.onclick = () => copyText(CLAUDE_PROMPT + '\n' + asText(), 'Copiado. Agora cole no Claude (Cmd/Ctrl + V).');
el.title.addEventListener('input', () => { S.title = el.title.value; save(); });
el.people.addEventListener('change', () => {
  S.people = Number(el.people.value);
  // Already more voices than people? Fold the closest ones together now.
  if (S.people && new Set(S.lines.map((l) => l.spk)).size > S.people) {
    refineSpeakers();
    renderAllLines();
    renderSpeakers();
    render();
  }
  save();
});

try { el.quality.value = localStorage.getItem(QUALITY_KEY) || 'auto'; } catch { /* ignore */ }
el.quality.addEventListener('change', () => {
  try { localStorage.setItem(QUALITY_KEY, el.quality.value); } catch { /* ignore */ }
  startWorker();
});

window.addEventListener('beforeunload', (e) => {
  if (S.status === 'rec' || pending.size) { e.preventDefault(); e.returnValue = ''; }
});
setInterval(() => { if (S.status === 'rec') renderStatus(); }, 500);

restore();
render();
startWorker();

// Test hook: /?debug then __feed('file.wav') runs a recording through the same pipeline.
if (new URLSearchParams(location.search).has('debug')) {
  window.__S = S;
  window.__feed = async (url) => {
    const buf = await (await fetch(url)).arrayBuffer();
    const decoded = await new AudioContext().decodeAudioData(buf);
    const off = new OfflineAudioContext(1, Math.ceil(decoded.duration * SR), SR);
    const src = off.createBufferSource();
    src.buffer = decoded;
    src.connect(off.destination);
    src.start();
    const mono = (await off.startRendering()).getChannelData(0);
    if (!S.startedAt) S.startedAt = Date.now();
    S.status = 'rec';
    render();
    for (let i = 0; i + FRAME <= mono.length; i += FRAME) onFrame(mono.slice(i, i + FRAME));
    stop();
  };
}
