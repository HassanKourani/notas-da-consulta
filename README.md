# Notas da Consulta

Live transcription for in-person lawyer–client meetings, in Brazilian Portuguese.
Everything runs in the browser: the audio never leaves the laptop and is never
saved, only the text.

## What it does

- **Começar a ouvir / Pausar / Retomar / Encerrar / Nova reunião**: meeting controls.
- **Marcar momento**: flags the current or last line as important. Clicking a line's time also toggles the mark.
- **Speakers**: voices are told apart automatically and labeled Falante 1, 2, 3.
  - Rename a speaker in the "Falantes" panel.
  - Click the speaker on a single line to move that line to another speaker.
  - When the meeting ends, speakers are re-checked using the whole recording.
- **Fix text**: click any line to correct it.
- **Copy / .txt**: copies or downloads the plain transcript.
- **Copiar para o Claude**: copies a pt-BR prompt plus the transcript. Paste it into claude.ai to get the summary, key points, next steps, legal risks and open questions. This uses her Claude subscription, with no API cost.
- **Autosave**: the current meeting is kept in the browser. A refresh or a closed tab doesn't lose it, and it comes back paused.

## How it works

```
mic → audio-processor.js (AudioWorklet, 16 kHz frames)
    → app.js voice-activity segmenter (cuts at pauses, max 20 s)
    → worker.js
        - Whisper: text
        - WeSpeaker ResNet34: 256-d voice fingerprint
    → app.js speaker matching → transcript
```

**Models.** They're downloaded once from Hugging Face and cached by the browser. They run with transformers.js 4.2.0 from the jsDelivr CDN.

| Quality | Model | First download | Needs |
|---|---|---|---|
| Alta (default with a GPU) | whisper-large-v3-turbo, q4f16 encoder + decoder | ~560 MB | WebGPU with f16 (recent Chrome/Edge on a recent laptop) |
| Leve (fallback) | whisper-small | ~300 MB | anything; uses WebGPU if present, otherwise the CPU |

She can switch quality under "Reconhecimento de voz".

**Speaker matching** (`app.js`, `clusterSpeakers`):
- Each time a sentence arrives, all voice prints so far are regrouped with average-linkage clustering. Groups at least 0.18 alike are treated as the same person.
- A sentence-by-sentence approach failed on real voices. On short clips the same person scored 0.12–0.9 and different people up to 0.23, so early guesses locked in.
- "Pessoas na reunião" defaults to 2 (lawyer + client). When a count is set and there are at least 6 sentences, groups merge to exactly that many, ignoring the cutoff.
  - No fixed cutoff works for everyone. Two similar women need 0.30 or more to separate, but at 0.30 other groups split into extra speakers.
  - Knowing the count separated every real test perfectly.
- "Não sei (detectar)" uses the 0.18 cutoff. It handles one person alone and distinct voices, but merges similar voices (see Tested).
- Labels follow the majority of each group's previous labels, so numbers and renames stay stable as groups change.
- A line moved by hand is left out of the grouping and keeps its speaker.
- Speakers joined with "Juntar com…" become one group that new sentences can still join.
- Cost: about 0.2 s per sentence at 900 sentences (a meeting of over an hour).

**Speaker separation limits.** Overlapping speech gets one label. Very short replies ("sim") may land on the wrong speaker. The fix is one click on that line.

**Phantom subtitles.** Whisper sometimes outputs fake subtitle credits ("Legendas pela comunidade Amara.org") on noise. These are filtered in `app.js` (`JUNK`).

## Branding

- **Client:** RB Advocacia e Consultoria Jurídica. The logo is `assets/logo.png`, resized from `logo_gold_sem fundo.png`.
- **Colours** (tokens in `styles.css`):
  - Gold `#C4A45D`, sampled from the logo, for fills and accents, with dark text on top (7.3:1).
  - Gold text `#7D6224` (5.8:1 on white). Plain gold text on white is only 2.4:1.
  - Charcoal `#2B2519` and ivory `#F8F5EE`.
- **Fonts:** Marcellus for titles, the closest free match to the logo's flared serif (the logo's exact font is unknown). Inter for body text.

## Live link

https://hassankourani.github.io/notas-da-consulta/ (GitHub Pages, from `main`).
When you change `app.js`, `worker.js` or `styles.css`, bump the `?v=` in `index.html` and `app.js`. Otherwise browsers can keep the old file for up to 10 minutes.

## Running it

It must be served over `http://localhost` or `https://`. Browsers block the microphone and web workers on `file://`.

- **Hosted (recommended)**: put the folder on GitHub Pages, Netlify or Vercel as a static site. The host only serves the files; audio and transcripts stay in her browser.
- **Local**: double-click `Abrir Notas da Consulta.command` (Mac) or `Abrir Notas da Consulta.bat` (Windows). Both need Python 3.
- **Dev**: run `python3 -m http.server 8765` and open `http://localhost:8765/?debug`. In the console, `__feed('test/conversa.wav')` runs the synthetic two-voice test conversation through the full pipeline.

## Tested

Most of the speaker testing below uses real voices. The macOS computer voices are too consistent to expose speaker problems.

- **Real voices** (`test/real{1,2,3,4}.wav` + `.json` with the true speaker for each turn):
  - Turns are cut from Multilingual LibriSpeech Portuguese (CC BY 4.0) and mixed at 48 kHz with mic hiss.
  - The `.wav` files are local only (git-ignored). The `.json` files list who speaks when.
  - Each is fed through the real mic path with `__feedMic(...)`.

| Test | Voices | Old (one at a time) | 0.18 cutoff ("Não sei") | Count set (default 2) |
|---|---|---|---|---|
| real1 | 1 person | not run | 0% wrong | n/a |
| real2 | 2 men, distinct | 0% | 0% | 0% |
| realM | 2 men, similar pitch | — | 0% | 0% |
| realF1 | 2 women, similar | — | **47% wrong (merged)** | 0% |
| realF2 | 2 women, similar | — | **46% wrong (merged)** | 0% |
| real3 | 3 people | 21% | 0% | 0% |
| real4 | 4 people | 23% | 0% | 0% |

  - The live view never showed more speakers than the true number when the count was set.
  - The realF tests reproduce the lawyer's report ("uma hora eu sou falante 1 e outra hora a cliente é falante 1").
  - Women were picked by estimated pitch: speakers 11247, 9056 and 12114 (about 240–260 Hz).

- **Synthetic** (macOS pt-BR voices):
  - `conversa.wav`: 9 turns, near-perfect text with the Alta model, about 20 s of processing for 56 s of audio.
  - `sala.wav`: room echo and noise. The text degrades.
  - `variado.wav`: one voice changing pitch and speed.
- **Manual fixes:** moving a line, "Juntar com…" and the people cap all hold when the grouping re-runs.
- **Not tested:** a real microphone in a real room (the test browser blocks the mic).
