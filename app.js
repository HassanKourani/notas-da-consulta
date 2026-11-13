// Notas da Consulta — live meeting transcription with the browser's own speech
// recognition (Web Speech API), so there is nothing to download. The browser
// sends the audio to its speech service (Google in Chrome, Microsoft in Edge,
// Apple in Safari) and gets text back. Only the text is kept, in this browser.

const STORE_KEY = 'notas-consulta:v1';

const CLAUDE_PROMPT = `Você é assistente de uma advogada brasileira. Abaixo está a transcrição automática de uma reunião presencial com cliente(s).

Atenção:
- A transcrição foi feita por reconhecimento de voz e pode conter erros de palavras e pouca pontuação.
- A transcrição não identifica quem fala. Pelo conteúdo, indique quando possível o que foi dito pela advogada e o que foi dito pelo cliente.
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

// ---------- state ----------
const S = {
  status: 'idle', // idle | rec | paused | stopped
  title: 'Consulta com cliente',
  startedAt: null,
  elapsed: 0, // ms spent recording (pauses excluded), drives the clock and line times
  lines: [], // { id, t, text, marked }
  nextId: 1,
};
let resumedAt = 0; // when the current recording stretch began (Date.now())

// ---------- dom ----------
const $ = (id) => document.getElementById(id);
const el = {
  statusLabel: $('statusLabel'), recDot: $('recDot'), clock: $('clock'),
  title: $('mtitle'), meta: $('meta'),
  start: $('btnStart'), pause: $('btnPause'), mark: $('btnMark'), resume: $('btnResume'),
  stop: $('btnStop'), newMeeting: $('btnNew'), copy: $('btnCopy'), download: $('btnDownload'),
  claude: $('btnClaude'), counts: $('counts'), list: $('list'), empty: $('empty'), lines: $('lines'),
  listening: $('listening'), pausedNote: $('pausedNote'), engineText: $('engineText'),
  toast: $('toast'), preview: $('preview'),
};

// ---------- helpers ----------
const fmt = (s) => {
  s = Math.floor(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  const p = (n) => String(n).padStart(2, '0');
  return (h ? h + ':' : '') + p(m) + ':' + p(x);
};
const fmtDate = (d) => new Date(d).toLocaleDateString('pt-BR', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
const seconds = () => (S.elapsed + (resumedAt ? Date.now() - resumedAt : 0)) / 1000;

let toastT;
function flash(msg) {
  clearTimeout(toastT);
  el.toast.textContent = msg;
  el.toast.hidden = false;
  toastT = setTimeout(() => { el.toast.hidden = true; }, 2200);
}

// Chrome returns lowercase phrases with little punctuation.
function cleanText(t) {
  t = t.replace(/\s+/g, ' ').trim();
  return t.charAt(0).toLocaleUpperCase('pt-BR') + t.slice(1);
}

// ---------- speech recognition ----------
let Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
// Whose service turns the audio into text, for the privacy notice.
const ua = navigator.userAgent;
const SERVICE = /Edg\//.test(ua) ? { to: 'à Microsoft', of: 'da Microsoft' }
  : /Chrome\//.test(ua) ? { to: 'ao Google', of: 'do Google' }
  : /Safari\//.test(ua) ? { to: 'à Apple', of: 'da Apple' }
  : { to: 'ao serviço de voz do navegador', of: 'do navegador' };
const MAX_FAILURES = 5; // sessions in a row ending in an error before giving up

let rec = null;
let failures = 0;
let speechError = '';
let engineNote = ''; // why recognition stopped, shown in the speech card
let markNext = false; // Marcar pressed while a phrase was still being spoken
const draft = { t: null, text: '' }; // words heard but not final yet

// Browsers end a recognition session on their own (after a silence, a network
// hiccup or a few minutes), so while recording a new one starts right away.
function listen() {
  const r = new Recognition();
  r.lang = 'pt-BR';
  r.continuous = true;
  r.interimResults = true;
  r.onresult = onSpeech;
  r.onerror = (e) => { speechError = e.error; };
  r.onend = () => onSpeechEnd(r);
  rec = r;
  try { r.start(); } catch (e) { console.warn(e); }
}

function onSpeech(e) {
  failures = 0;
  let interim = '';
  for (let i = e.resultIndex; i < e.results.length; i++) {
    const r = e.results[i];
    if (r.isFinal) {
      // The line's time is when its first words appeared, not when it ended.
      addLine(draft.t ?? seconds(), r[0].transcript);
      draft.t = null;
    } else {
      interim += r[0].transcript;
    }
  }
  draft.text = cleanText(interim);
  if (!draft.text) draft.t = null;
  else if (draft.t === null) draft.t = seconds();
  renderPreview();
}

function onSpeechEnd(r) {
  if (r !== rec) return;
  rec = null;
  // Words still on screen when a session ends are kept, not lost.
  if (draft.text) addLine(draft.t ?? seconds(), draft.text);
  draft.text = '';
  draft.t = null;
  renderPreview();
  const err = speechError;
  speechError = '';
  if (S.status !== 'rec') return;
  if (err === 'not-allowed' || err === 'service-not-allowed') return halt('mic');
  if (err === 'audio-capture') return halt('nomic');
  if (err === 'language-not-supported') return halt('language');
  if (err && err !== 'no-speech' && err !== 'aborted') failures++;
  if (failures >= MAX_FAILURES) return halt('network');
  setTimeout(() => { if (S.status === 'rec' && !rec) listen(); }, failures * 1000);
}

// Recognition can't go on: stop recording and say why in the speech card.
function halt(reason) {
  engineNote = {
    mic: 'O navegador não liberou o microfone. Clique no cadeado ao lado do endereço, permita o microfone e tente de novo.',
    nomic: 'Nenhum microfone encontrado. Conecte um microfone e tente de novo.',
    language: 'Este navegador não reconhece português do Brasil. Use o Google Chrome.',
    network: `Sem resposta do serviço de voz ${SERVICE.of}. Verifique a internet e toque em Retomar. Se continuar, use o Google Chrome.`,
  }[reason];
  foldTime();
  S.status = S.lines.length ? 'paused' : 'idle';
  if (S.status === 'idle') { S.startedAt = null; S.elapsed = 0; }
  keepAwake(false);
  flash(reason === 'network' ? 'Reconhecimento de voz interrompido' : 'Não foi possível ouvir');
  render();
  save();
}

function addLine(t, text) {
  text = cleanText(text);
  if (!text) return;
  const line = { id: S.nextId++, t: Math.round(t * 10) / 10, text, marked: markNext };
  markNext = false;
  S.lines.push(line);
  renderLine(line);
  render();
  save();
}

let wakeLock = null;
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
function foldTime() {
  if (resumedAt) S.elapsed += Date.now() - resumedAt;
  resumedAt = 0;
}

function start() {
  if (!Recognition) return;
  if (!S.startedAt) S.startedAt = Date.now();
  S.status = 'rec';
  resumedAt = Date.now();
  failures = 0;
  engineNote = '';
  // A session still finishing after Pausar restarts by itself when it ends.
  if (!rec) listen();
  keepAwake(true);
  render();
  save();
}

// Pausar / Encerrar: the phrase being spoken is finished and still added.
function endRecording(status) {
  foldTime();
  S.status = status;
  if (rec) rec.stop();
  keepAwake(false);
  render();
  save();
}

function mark() {
  if (draft.text) {
    markNext = true;
    flash('Momento marcado');
    return;
  }
  const last = S.lines[S.lines.length - 1];
  if (!last) { flash('Nada para marcar ainda'); return; }
  last.marked = true;
  renderLine(last);
  renderCounts();
  save();
  flash('Momento marcado');
}

function newMeeting() {
  if (S.lines.length && !confirm('Começar uma nova reunião? A transcrição atual será apagada desta tela. Baixe o .txt antes se quiser guardá-la.')) return;
  Object.assign(S, { status: 'idle', title: 'Consulta com cliente', startedAt: null, elapsed: 0, lines: [], nextId: 1 });
  draft.text = '';
  draft.t = null;
  markNext = false;
  el.lines.innerHTML = '';
  lineEls.clear();
  el.title.value = S.title;
  render();
  renderPreview();
  save();
}

function asText() {
  const out = [S.title, fmtDate(S.startedAt || Date.now()), 'Duração: ' + fmt(seconds()), ''];
  for (const l of S.lines) out.push(`[${fmt(l.t)}] ${l.text}${l.marked ? '  [MARCADO]' : ''}`);
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
        <span class="badge" hidden>Marcado</span>
        <p class="line-text" contenteditable="plaintext-only" spellcheck="false" title="Clique para corrigir o texto"></p>
      </div>`;
    node.querySelector('.line-time').onclick = () => { line.marked = !line.marked; renderLine(line); renderCounts(); save(); };
    const p = node.querySelector('.line-text');
    p.addEventListener('blur', () => {
      const t = p.textContent.trim();
      if (t && t !== line.text) { line.text = t; save(); }
      else p.textContent = line.text;
    });
    p.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); p.blur(); } });
    lineEls.set(line.id, node);
    const nearBottom = el.list.scrollHeight - el.list.scrollTop - el.list.clientHeight < 80;
    el.lines.append(node);
    if (nearBottom) el.list.scrollTop = el.list.scrollHeight;
  }
  node.classList.toggle('marked', !!line.marked);
  node.querySelector('.line-time').textContent = fmt(line.t);
  node.querySelector('.badge').hidden = !line.marked;
  const p = node.querySelector('.line-text');
  if (document.activeElement !== p) p.textContent = line.text;
}

function renderPreview() {
  el.preview.hidden = !draft.text;
  if (!draft.text) return;
  el.preview.querySelector('.line-time').textContent = fmt(draft.t ?? seconds());
  el.preview.querySelector('.line-text').textContent = draft.text + '…';
  const nearBottom = el.list.scrollHeight - el.list.scrollTop - el.list.clientHeight < 120;
  if (nearBottom) el.list.scrollTop = el.list.scrollHeight;
}

function renderCounts() {
  const marks = S.lines.filter((l) => l.marked).length;
  el.counts.textContent = `${S.lines.length} ${S.lines.length === 1 ? 'fala' : 'falas'} · ${marks} ${marks === 1 ? 'marcada' : 'marcadas'}`;
}

function renderEngine() {
  el.engineText.textContent = !Recognition
    ? 'Este navegador não tem reconhecimento de voz. Abra este link no Google Chrome, no Microsoft Edge ou no Safari.'
    : engineNote || `Pronto, nada para baixar. O áudio é enviado ${SERVICE.to} para virar texto e não é gravado.`;
}

function renderStatus() {
  const labels = { idle: 'Pronto', rec: 'Ouvindo', paused: 'Pausado', stopped: 'Encerrado' };
  const colors = { idle: '#6B6355', rec: '#C2362B', paused: '#8A4B00', stopped: '#7D6224' };
  el.statusLabel.textContent = labels[S.status];
  el.statusLabel.style.color = colors[S.status];
  el.recDot.hidden = S.status !== 'rec';
  el.clock.textContent = fmt(seconds());
  el.listening.hidden = S.status !== 'rec';
  el.pausedNote.hidden = S.status !== 'paused';
}

function render() {
  const st = S.status;
  el.start.hidden = st !== 'idle';
  el.start.disabled = !Recognition;
  el.pause.hidden = st !== 'rec';
  el.mark.hidden = st !== 'rec';
  el.resume.hidden = st !== 'paused';
  el.resume.disabled = !Recognition;
  el.stop.hidden = !(st === 'rec' || st === 'paused');
  el.newMeeting.hidden = st !== 'stopped';
  const none = S.lines.length === 0;
  el.copy.disabled = none;
  el.download.disabled = none;
  el.claude.disabled = none;
  el.empty.hidden = !none;
  el.meta.textContent = fmtDate(S.startedAt || Date.now());
  renderCounts();
  renderStatus();
  renderEngine();
}

// ---------- persistence ----------
let saveT;
function save() {
  clearTimeout(saveT);
  saveT = setTimeout(() => {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({
        title: S.title, startedAt: S.startedAt, elapsed: Math.round(seconds() * 1000),
        lines: S.lines, nextId: S.nextId, status: S.status,
      }));
    } catch (e) { console.warn('save failed', e); }
  }, 300);
}

function restore() {
  try {
    const d = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
    if (!d) return;
    S.title = d.title || S.title;
    S.startedAt = d.startedAt || null;
    // The Whisper version counted 16 kHz audio samples instead of milliseconds,
    // and kept speakers and voice prints on each line.
    S.elapsed = d.elapsed ?? ((d.samples || 0) / 16000) * 1000;
    S.lines = (d.lines || []).map(({ id, t, text, marked }) => ({ id, t, text, marked: !!marked }));
    S.nextId = S.lines.reduce((n, l) => Math.max(n, l.id + 1), d.nextId || 1);
    S.status = d.status || 'idle';
    // The microphone can't survive a page reload; continue as paused.
    if (S.status === 'rec' || (S.status === 'idle' && S.lines.length)) S.status = 'paused';
    el.title.value = S.title;
    S.lines.forEach(renderLine);
  } catch (e) { console.warn('restore failed', e); }
}

// The Whisper version kept ~600 MB of speech models in this browser; free it.
try { localStorage.removeItem('notas-consulta:quality'); } catch { /* ignore */ }
if (window.caches) caches.delete('transformers-cache').catch(() => {});

// ---------- wiring ----------
el.start.onclick = start;
el.resume.onclick = start;
el.pause.onclick = () => endRecording('paused');
el.stop.onclick = () => endRecording('stopped');
el.mark.onclick = mark;
el.newMeeting.onclick = newMeeting;
el.copy.onclick = () => copyText(asText(), 'Transcrição copiada');
el.download.onclick = download;
el.claude.onclick = () => copyText(CLAUDE_PROMPT + '\n' + asText(), 'Copiado. Agora cole no Claude (Cmd/Ctrl + V).');
el.title.addEventListener('input', () => { S.title = el.title.value; save(); });

window.addEventListener('beforeunload', (e) => {
  if (S.status === 'rec') { e.preventDefault(); e.returnValue = ''; }
});
setInterval(() => { if (S.status === 'rec') renderStatus(); }, 500);

// Test hooks: /?debug exposes the state; /?debug&fake swaps the browser's
// recognizer for a scripted one (see test/speech-check.js).
const params = new URLSearchParams(location.search);
if (params.has('debug')) {
  window.__S = S;
  window.__asText = asText;
  if (params.has('fake')) {
    Recognition = class {
      constructor() { this.results = []; window.__rec = this; }
      start() { window.__starts = (window.__starts || 0) + 1; }
      // Like Chrome: the phrase being spoken is finalized, then the session ends.
      stop() {
        setTimeout(() => {
          const last = this.results.at(-1);
          if (last && !last.isFinal) this.say(last[0].transcript, true);
          this.onend();
        });
      }
      say(transcript, isFinal) {
        const r = Object.assign([{ transcript }], { isFinal });
        const last = this.results.at(-1);
        if (last && !last.isFinal) this.results[this.results.length - 1] = r;
        else this.results.push(r);
        this.onresult({ resultIndex: this.results.length - 1, results: this.results });
      }
      fail(error) { this.onerror({ error }); this.onend(); }
      end() { this.onend(); }
    };
  }
}

restore();
render();
renderPreview();
