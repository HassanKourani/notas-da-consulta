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
- **Live preview**: while someone is still talking, a grey draft of their words appears and is replaced by the final text when they pause.
- **Fix text**: click any line to correct it.
- **Copy / .txt**: copies or downloads the plain transcript.
- **Copiar para o Claude**: copies a pt-BR prompt plus the transcript. Paste it into claude.ai to get the summary, key points, next steps, legal risks and open questions. This uses her Claude subscription, with no API cost.
- **Autosave**: the current meeting is kept in the browser. A refresh or a closed tab doesn't lose it, and it comes back paused.

## How it works

```
mic → audio-processor.js (AudioWorklet, 16 kHz frames)
    → app.js voice-activity segmenter (new line at a ~0.3 s pause, max 12 s)
    → worker.js
        - Whisper (word timestamps): text; waiting lines share one pass
        - WeSpeaker ResNet34: 256-d voice fingerprint per line
    → app.js speaker matching → transcript
```

**Lines and speed** (`app.js` segmenter, `worker.js` batching):
- A new line starts at any pause of about 0.3 s, because most changes of speaker have at least that much silence.
  - With the old 0.7 s pause, quick replies shared a line with the question. On real voices with 0.1–0.5 s gaps, 9 of 16 lines held two people.
  - Lines with under 0.4 s of voice wait for a 0.5 s pause instead, so soft speech isn't chopped into crumbs.
  - Anything with at least 0.2 s of voice is kept, so a short "sim" survives.
- Whisper always encodes a 30 s window, about 1.5 s on a laptop GPU, however short the line. So lines waiting in the queue go through one pass together (up to 12 s of speech), and word timestamps give each line its own words.
  - Measured: 7 lines took 2.8 s joined against 12.3 s one by one.
  - Joins of 24 s made Whisper skip sentences. So batches stay at 12 s or less, and a line that comes back with fewer than 0.8 words per second is transcribed again on its own.
- When nothing is waiting, a line goes to Whisper on its own straight away. While idle, Whisper also drafts the sentence still being spoken (the live preview).
- In the transcript, consecutive lines from the same person don't repeat the name. In the .txt they're joined into one paragraph per turn.

**Models.** They're downloaded once from Hugging Face and cached by the browser. They run with transformers.js 4.2.0 from the jsDelivr CDN.

| Quality | Model | First download | Needs |
|---|---|---|---|
| Alta (default with a GPU) | whisper-large-v3-turbo_timestamped, q4f16 encoder + decoder | ~560 MB | WebGPU with f16 (recent Chrome/Edge on a recent laptop) |
| Leve (only without WebGPU) | whisper-small_timestamped | ~300 MB | anything; uses WebGPU if present, otherwise the CPU |

"Automática" picks Alta on any WebGPU machine (q4 instead of q4f16 when the GPU lacks f16). With word timestamps, Leve was slower and less accurate than Alta on a GPU: fastF1 took 79 s against 22 s, covered 20/26 turns, and produced repeated filler ("que é o que é").

The `_timestamped` builds add word timestamps. Moving to them means one new download. Once the new model works, the old non-timestamped files are deleted from the browser cache (`dropOldModels`).

She can switch quality under "Reconhecimento de voz".

**Speaker matching** (`app.js`, `clusterSpeakers`):
- Each time a sentence arrives, all voice prints so far are regrouped with average-linkage clustering. Groups at least 0.18 alike are treated as the same person.
- A sentence-by-sentence approach failed on real voices. On short clips the same person scored 0.12–0.9 and different people up to 0.23, so early guesses locked in.
- "Pessoas na reunião" defaults to 2 (lawyer + client). When a count is set and there are at least 6 sentences, the app uses the grouping in which exactly that many *people* stand out, ignoring the cutoff.
  - A group only counts as a person once it holds at least 2 lines and max(3 s, 5% of all speech).
  - Smaller groups (a cough, an odd "sim") are folded into the person they sound most like.
  - Without this, short lines made stray groups take one of the two places, and the real two got merged: 44% wrong on two similar men.
  - No fixed cutoff works for everyone. Two similar women need 0.30 or more to separate, but at 0.30 other groups split into extra speakers.
  - Knowing the count separated every real test perfectly.
- "Não sei (detectar)" uses the 0.18 cutoff. It handles one person alone and distinct voices, but merges similar voices (see Tested).
- Labels follow the majority of each group's previous labels, so numbers and renames stay stable as groups change.
- A line moved by hand is left out of the grouping and keeps its speaker.
- Speakers joined with "Juntar com…" become one group that new sentences can still join.
- Cost: about 0.2 s per sentence at 900 sentences (a meeting of over an hour).

**Speaker separation limits.**
- Overlapping speech, or a reply with no pause before it, still shares a line and gets one label.
- Very short replies ("sim") may land on the wrong speaker. The fix is one click on that line.

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

- **Real voices:** turns are cut from Multilingual LibriSpeech Portuguese (CC BY 4.0) and mixed at 48 kHz with mic hiss.
  - The `.wav` files are local only (git-ignored). The `.json` files list who speaks when; `fast*` files also give each turn's end.
  - Each is fed through the real mic path with `__feedMic(url, 48000, realtime)`.
  - With `realtime` true, audio is handed over at speaking speed.
- **Before / after:** "Before" is the published version at commit d485949, served from a copy with the same test files.

**Quick replies (0.1–0.5 s between speakers), people count set.** This reproduces "two voices speaking but took them as the same person".

| Test | Voices | Before: speech on wrong person / mixed lines | After | Processing time for the file, before → after |
|---|---|---|---|---|
| fastF1 | 2 similar women | 34% / 9 of 16 lines | **3% / 4 of 39** | 67 s → 14 s |
| fastM | 2 similar men | 50% / 8 of 11 | **2% / 1 of 44** | 31 s → 14 s |
| fast3 | 3 people | 31% / 10 of 19 | **2% / 2 of 46** | 47 s → 14 s |

- **Live (fastF1 at speaking speed):** a turn's text appears a median of 8.6 s after it ends before, 2.5 s after. The 90th percentile went from 14.6 s to 5.4 s, and the worst case from 18.6 s to 6.6 s. Processing kept up throughout.
- **No lost text:**

| Test | Turns transcribed, before → after | Words, before → after |
|---|---|---|
| real4 | 19/24 → 22/24 | 139 → 144 |
| realF1 | 25/26 → 25/26 | 183 → 188 |

**Longer pauses (0.9 s between speakers):**

| Test | Voices | 0.18 cutoff ("Não sei"), measured with the old 0.7 s line pause except real1 | Count set (default 2), current version |
|---|---|---|---|
| real1 | 1 person | 0% wrong | n/a |
| real2 | 2 men, distinct | 0% | 0% |
| realM | 2 men, similar pitch | 0% | 2% |
| realF1 | 2 women, similar | **47% wrong (merged)** | 0% |
| realF2 | 2 women, similar | **46% wrong (merged)** | 0% |
| real3 | 3 people | 0% | 0% |
| real4 | 4 people | 0% | 0% |

  - The realF tests reproduce the lawyer's report ("uma hora eu sou falante 1 e outra hora a cliente é falante 1").
  - Women were picked by estimated pitch: speakers 11247, 9056 and 12114 (about 240–260 Hz).

- **Synthetic** (macOS pt-BR voices):
  - `conversa.wav`: 9 turns.
  - `sala.wav`: room echo and noise.
  - `variado.wav`: one voice changing pitch and speed.
- **Manual fixes:** moving a line, "Juntar com…" and the people cap all hold when the grouping re-runs.
- **Not tested:**
  - a real microphone in a real room (the test browser blocks the mic);
  - overlapping speech;
  - the Leve model on a computer without WebGPU;
  - a slower laptop than the test machine (Apple GPU).
