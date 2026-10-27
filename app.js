// Notas da Consulta — live meeting transcription that runs entirely in the browser.
// Flow: microphone -> audio-processor.js (16 kHz frames) -> voice-activity
// segmenter (here) -> worker.js (Whisper text + speaker fingerprint) ->
// speaker clustering (here) -> transcript.

const SR = 16000;
const FRAME = 512;
const STORE_KEY = 'notas-consulta:v1';
const QUALITY_KEY = 'notas-consulta:quality';

// Voice prints (cosine) of two groups of sentences at least this alike are the
// same person. Real Portuguese speakers through a 48 kHz mic path: 0.15-0.20
// separated 2, 3 and 4 speakers with no errors; 0.25+ starts splitting people,
// 0.10 merges them. See README "Tested".
const SAME_SPEAKER = 0.18;
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
function dot(a, b) {
  let d = 0;
  for (let i = 0; i < a.length; i++) d += a[i] * b[i];
  return d;
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
// Who said what is decided by grouping every voice print heard so far
// (average-linkage agglomerative clustering), re-run as each sentence arrives.
// Deciding one sentence at a time failed on real voices: short clips give noisy
// prints (same person 0.12-0.9, different people up to 0.23), so early guesses
// locked people into the wrong speaker. User fixes are respected:
// - a single line moved by hand ("manual") is left out and keeps its speaker;
// - speakers joined with "Juntar com…" ("anchor") start as one group that
//   new sentences can still join, and never merges with another anchor.
function clusterSpeakers() {
  const items = S.lines.filter((l) => l.emb && !l.manual);
  if (!items.length) return false;
  const vecs = items.map((l) => normalize(l.emb));

  // Start with one group per joined speaker plus one per other sentence.
  const groups = [];
  const pinned = new Map();
  items.forEach((l, i) => {
    if (l.anchor) {
      if (!pinned.has(l.anchor)) { pinned.set(l.anchor, groups.length); groups.push({ m: [], pin: l.anchor }); }
      groups[pinned.get(l.anchor)].m.push(i);
    } else groups.push({ m: [i], pin: 0 });
  });

  // Pairwise group similarity (average of member similarities).
  const n = groups.length;
  const sim = Array.from({ length: n }, () => new Float64Array(n));
  for (let a = 0; a < n; a++) {
    for (let b = a + 1; b < n; b++) {
      let s = 0;
      for (const i of groups[a].m) for (const j of groups[b].m) s += dot(vecs[i], vecs[j]);
      sim[a][b] = sim[b][a] = s / (groups[a].m.length * groups[b].m.length);
    }
  }
  const alive = new Set(groups.keys());
  const canMerge = (a, b) => !(groups[a].pin && groups[b].pin && groups[a].pin !== groups[b].pin);
  const best = new Int32Array(n).fill(-1);
  const findBest = (a) => {
    best[a] = -1;
    for (const b of alive) if (b !== a && canMerge(a, b) && (best[a] < 0 || sim[a][b] > sim[a][best[a]])) best[a] = b;
  };
  for (const a of alive) findBest(a);

  for (;;) {
    let a = -1;
    for (const x of alive) if (best[x] >= 0 && (a < 0 || sim[x][best[x]] > sim[a][best[a]])) a = x;
    if (a < 0) break;
    const b = best[a];
    const tooMany = S.people > 0 && alive.size > S.people;
    if (sim[a][b] < SAME_SPEAKER && !tooMany) break;
    // Merge b into a; average linkage update.
    const na = groups[a].m.length, nb = groups[b].m.length;
    for (const k of alive) {
      if (k === a || k === b) continue;
      sim[a][k] = sim[k][a] = (na * sim[a][k] + nb * sim[b][k]) / (na + nb);
    }
    groups[a].m.push(...groups[b].m);
    groups[a].pin = groups[a].pin || groups[b].pin;
    alive.delete(b);
    for (const k of alive) if (k === a || best[k] === a || best[k] === b || !canMerge(k, best[k])) findBest(k);
    for (const k of alive) if (k !== a && canMerge(k, a) && best[k] >= 0 && sim[k][a] > sim[k][best[k]]) best[k] = a;
  }

  // Name groups: joined speaker first, then whichever current label
  // most of the group already has, so numbers and renames stay put.
  const final = [...alive].map((g) => groups[g]);
  const taken = new Set();
  const label = new Map();
  for (const g of final) if (g.pin) { label.set(g, g.pin); taken.add(g.pin); }
  const votes = [];
  for (const g of final) {
    if (g.pin) continue;
    const c = new Map();
    for (const i of g.m) c.set(items[i].spk, (c.get(items[i].spk) || 0) + 1);
    for (const [spk, k] of c) votes.push({ g, spk, k });
  }
  votes.sort((x, y) => y.k - x.k);
  for (const v of votes) if (!label.has(v.g) && !taken.has(v.spk)) { label.set(v.g, v.spk); taken.add(v.spk); }
  // Brand-new groups skip numbers hand-moved lines already use.
  const handLabels = new Set(S.lines.filter((l) => l.manual).map((l) => l.spk));
  let next = 1;
  for (const g of final) {
    if (label.has(g)) continue;
    while (taken.has(next) || handLabels.has(next)) next++;
    label.set(g, next); taken.add(next);
  }
  let changed = false;
  for (const g of final) {
    const spk = label.get(g);
    for (const i of g.m) if (items[i].spk !== spk) { items[i].spk = spk; changed = true; }
  }
  return changed;
}

function mergeSpeaker(from, into) {
  for (const l of S.lines) {
    if (l.spk === from) l.spk = into;
    if (l.spk === into && !l.manual) l.anchor = into; // the user said these are one person
  }
  if (!S.names[into] && S.names[from]) S.names[into] = S.names[from];
  delete S.names[from];
}

function maxSpeaker() {
  return S.lines.reduce((m, l) => Math.max(m, l.spk), 0);
}

// Make speakers 1..k in order of first appearance, carrying names along.
function renumberSpeakers() {
  const map = new Map();
  for (const l of S.lines) if (!map.has(l.spk)) map.set(l.spk, map.size + 1);
  const names = {};
  for (const [oldN, newN] of map) if (S.names[oldN]) names[newN] = S.names[oldN];
  for (const l of S.lines) {
    l.spk = map.get(l.spk);
    if (l.anchor) l.anchor = l.spk;
  }
  S.names = names;
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
  clusterSpeakers();
  renumberSpeakers();
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
  worker = new Worker('worker.js?v=5', { type: 'module' });
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
    const line = { id: m.id, t: p.t, text, spk: maxSpeaker() + 1, d: p.dur, marked: p.marked, emb: m.emb ? m.emb.map((x) => Math.round(x * 1e4) / 1e4) : null };
    // Results arrive in order, but keep the transcript sorted by time anyway.
    S.lines.push(line);
    S.lines.sort((a, b) => a.t - b.t);
    // No voice print (rare): assume the previous speaker kept talking.
    if (!line.emb) { const prev = S.lines[S.lines.indexOf(line) - 1]; line.spk = prev ? prev.spk : 1; }
    clusterSpeakers();
    renderAllLines();
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
  const count = maxSpeaker();
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
      clusterSpeakers();
      renderAllLines();
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
      clusterSpeakers();
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
  if (S.lines.length) {
    clusterSpeakers();
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
  window.__cluster = clusterSpeakers;
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
  // Same, but through audio-processor.js at a laptop mic's 48 kHz, like a live meeting.
  window.__feedMic = async (url, rate = 48000) => {
    const buf = await (await fetch(url)).arrayBuffer();
    const off = new OfflineAudioContext(1, 1, rate);
    const decoded = await off.decodeAudioData(buf);
    const ctx = new OfflineAudioContext(1, decoded.length, rate);
    await ctx.audioWorklet.addModule('audio-processor.js?v=' + Date.now());
    const node = new AudioWorkletNode(ctx, 'downsampler');
    const frames = [];
    node.port.onmessage = (e) => frames.push(e.data);
    const src = ctx.createBufferSource();
    src.buffer = decoded;
    src.connect(node).connect(ctx.destination);
    src.start();
    await ctx.startRendering();
    await new Promise((r) => setTimeout(r, 500)); // let the last frames arrive
    if (!S.startedAt) S.startedAt = Date.now();
    S.status = 'rec';
    render();
    for (const f of frames) onFrame(f);
    stop();
  };
}
