// Logic check for the speech engine, with a fake recognizer instead of the
// browser's. Open /?debug&fake, then in the console:
//   await import('/test/speech-check.js?' + Date.now())
//   __seedOldSave(); location.reload();   then   await __restoreCheck()
//   localStorage.clear(); location.reload();   then   await __speechCheck()
// Each check returns a list of { name, ok, detail }.

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const $ = (id) => document.getElementById(id);

function results() {
  const out = [];
  out.check = (name, ok, detail = '') => out.push({ name, ok: !!ok, detail: String(detail) });
  return out;
}

// A save written by the Whisper version: audio samples, speakers, voice prints.
window.__seedOldSave = async () => {
  localStorage.setItem('notas-consulta:v1', JSON.stringify({
    title: 'Reunião antiga', startedAt: Date.now() - 600000, samples: 16000 * 42,
    lines: [
      { id: 100001, t: 3.2, text: 'Olá, tudo bem?', spk: 1, marked: false, emb: [0.1, 0.2], d: 1.2 },
      { id: 100002, t: 7, text: 'Tudo bem.', spk: 2, marked: true, emb: null, manual: true },
    ],
    names: { 1: 'Dra. Ana' }, nextId: 5, lineSeq: 100002, status: 'stopped', people: 2, peopleChosen: true,
  }));
  localStorage.setItem('notas-consulta:quality', 'alta');
  const cache = await caches.open('transformers-cache');
  await cache.put('/fake-model.onnx', new Response('x'));
};

window.__restoreCheck = async () => {
  const out = results();
  const S = window.__S;
  out.check('old lines open', S.lines.length === 2 && S.lines[1].text === 'Tudo bem.' && S.lines[1].marked);
  out.check('speaker data dropped', S.lines.every((l) => !('spk' in l) && !('emb' in l)));
  out.check('clock continues from the old sample count', $('clock').textContent === '00:42', $('clock').textContent);
  out.check('next id is above every old id', S.nextId > 100002, S.nextId);
  out.check('stays stopped', S.status === 'stopped');
  await wait(300);
  out.check('old model cache deleted', !(await caches.has('transformers-cache')));
  out.check('old quality setting deleted', localStorage.getItem('notas-consulta:quality') === null);
  out.check('no speaker text left on the page', !/Falante|Participantes/.test(document.body.innerText));
  return out;
};

window.__speechCheck = async () => {
  const out = results();
  const S = window.__S;
  if (S.lines.length) return 'Start from a clean meeting: localStorage.clear(); location.reload()';

  $('btnStart').click();
  await wait(50);
  out.check('start opens one session', window.__starts === 1 && S.status === 'rec', window.__starts);

  await wait(1100);
  window.__rec.say('bom dia', false);
  await wait(20);
  out.check('draft words show in the preview', !$('preview').hidden && $('preview').textContent.includes('Bom dia'), $('preview').textContent);

  await wait(1100);
  window.__rec.say('bom dia doutora', true);
  await wait(20);
  const first = S.lines[0];
  out.check('a final phrase becomes one line', S.lines.length === 1 && first.text === 'Bom dia doutora', first && first.text);
  out.check('the line keeps the time its first words appeared', first && first.t >= 1 && first.t < 1.6, first && first.t);
  out.check('preview clears after the final phrase', $('preview').hidden);

  // Chrome splits a phrase into several interim pieces; resultIndex can point at the last one.
  const piece = (transcript) => Object.assign([{ transcript }], { isFinal: false });
  window.__rec.onresult({ resultIndex: 1, results: [piece('você trouxe'), piece(' uma cópia')] });
  await wait(20);
  out.check('the draft shows every interim piece', $('preview').textContent.includes('Você trouxe uma cópia'), $('preview').textContent);

  window.__rec.say('eu queria falar sobre', false);
  await wait(20);
  window.__rec.end();
  await wait(50);
  out.check('words on screen are kept when the browser ends the session', S.lines.at(-1).text === 'Eu queria falar sobre', S.lines.at(-1).text);
  out.check('a new session starts by itself', window.__starts === 2, window.__starts);

  window.__rec.say('o contrato', false);
  $('btnMark').click();
  window.__rec.say('o contrato de aluguel', true);
  await wait(20);
  out.check('Marcar during a phrase marks that phrase', S.lines.at(-1).marked && S.lines.at(-1).text === 'O contrato de aluguel');

  window.__rec.say('vence em março', true);
  await wait(20);
  $('btnMark').click();
  await wait(20);
  out.check('Marcar between phrases marks the last line', S.lines.at(-1).marked && S.lines.at(-1).text === 'Vence em março');

  window.__rec.say('sem pontuação', false);
  await wait(20);
  window.__rec.fail('no-speech');
  await wait(50);
  out.check('silence timeout restarts at once without pausing', S.status === 'rec' && window.__starts === 3, window.__starts);

  const before = window.__starts;
  for (let i = 1; i <= 5; i++) {
    window.__rec.fail('network');
    await wait(i * 1000 + 150);
  }
  out.check('repeated network failures retry, then pause', S.status === 'paused' && window.__starts === before + 4, `${S.status} starts+${window.__starts - before}`);
  out.check('network failure explains itself', /conex|internet/i.test($('engineText').textContent), $('engineText').textContent);

  $('btnResume').click();
  await wait(50);
  out.check('Retomar listens again', S.status === 'rec');
  window.__rec.say('última frase', false);
  await wait(20);
  $('btnPause').click();
  await wait(50);
  out.check('a phrase finished by Pausar is kept', S.lines.at(-1).text === 'Última frase', S.lines.at(-1).text);
  out.check('paused stops the clock', S.status === 'paused');

  const body = window.__asText().split('\n').slice(4);
  out.check('.txt lines are [mm:ss] text', body.length === S.lines.length && body.every((l) => /^\[\d\d:\d\d\] \S/.test(l)), body.join(' | '));
  out.check('.txt tags marked lines', body.filter((l) => l.endsWith('[MARCADO]')).length === 2);

  $('btnResume').click();
  await wait(50);
  const starts = window.__starts;
  window.__rec.fail('not-allowed');
  await wait(1500);
  out.check('microphone blocked stops without retrying', S.status !== 'rec' && window.__starts === starts, `${S.status} ${window.__starts - starts}`);
  out.check('microphone blocked explains itself', /microfone/i.test($('engineText').textContent), $('engineText').textContent);
  return out;
};
