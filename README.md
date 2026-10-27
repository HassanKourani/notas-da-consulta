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

**Speaker matching** (`app.js`, speakers section):
- A clip joins the speaker it best matches. The match is scored against both that speaker's average voice and their closest earlier clip.
- A new speaker is only created when the clip is clearly unlike everyone (cosine < 0.25), the clip is at least 2 s long, and the "Pessoas na reunião" count hasn't been reached yet.
- At "Encerrar", clips are reassigned to their closest voice. Speakers whose voices are ≥ 0.35 alike are then merged, and so are speakers beyond the people count.
- If one person still shows up twice, "Juntar com…" in the Falantes panel merges them.

**Speaker separation limits.** Overlapping speech gets one label. Very short replies ("sim") may land on the wrong speaker. The fix is one click on that line.

**Phantom subtitles.** Whisper sometimes outputs fake subtitle credits ("Legendas pela comunidade Amara.org") on noise. These are filtered in `app.js` (`JUNK`).

## Live link

https://hassankourani.github.io/notas-da-consulta/ (GitHub Pages, from `main`).
When you change `app.js`, `worker.js` or `styles.css`, bump the `?v=` in `index.html` and `app.js`. Otherwise browsers can keep the old file for up to 10 minutes.

## Running it

It must be served over `http://localhost` or `https://`. Browsers block the microphone and web workers on `file://`.

- **Hosted (recommended)**: put the folder on GitHub Pages, Netlify or Vercel as a static site. The host only serves the files; audio and transcripts stay in her browser.
- **Local**: double-click `Abrir Notas da Consulta.command` (Mac) or `Abrir Notas da Consulta.bat` (Windows). Both need Python 3.
- **Dev**: run `python3 -m http.server 8765` and open `http://localhost:8765/?debug`. In the console, `__feed('test/conversa.wav')` runs the synthetic two-voice test conversation through the full pipeline.

## Tested

- `test/conversa.wav`: a 56 s, 9-turn conversation with two macOS pt-BR voices (Luciana, Eddy).
- Alta model on WebGPU: near-perfect text, all 9 speakers correct, about 20 s of processing for 56 s of audio. The earlier fp16 build (1.6 GB) crashed the test browser while loading, which is why it's now 4-bit.
- Leve model on WebGPU: a few word errors ("Obrigada por ver"), all 9 speakers correct, about 10 s of processing.
- Similarity margin: the same voice scored 0.72–0.95, different voices ≤ 0.07.
- `test/sala.wav` (same conversation with room echo and noise): speakers stay separable (same 0.58–0.77, different ≤ 0.13), but the text degrades.
- `test/variado.wav`: the lawyer's voice changes pitch and speed. Her own clips score as low as 0.32 against each other, under the old 0.4 cutoff. All 8 turns were assigned correctly.
- Manual line move, "Juntar com…" and the people cap (3 forced speakers with the count set to 2) all fold back to the correct 2.
- Not tested yet: a real microphone in a real room (the test browser blocks the mic).
