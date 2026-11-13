# Notas da Consulta

Live transcription for in-person lawyer–client meetings, in Brazilian Portuguese.
It uses the browser's built-in speech recognition, so nothing is downloaded:
open the link and start. The audio is never recorded. Only the text is saved,
in this browser.

## What it does

- **Começar a ouvir / Pausar / Retomar / Encerrar / Nova reunião**: meeting controls.
- **Live text**: while someone is talking, their words appear in grey ("Ouvindo…"). When they pause, the phrase becomes a line with its meeting time.
- **Marcar momento**: flags the phrase being spoken, or the last line, as important. Clicking a line's time also toggles the mark.
- **Fix text**: click any line to correct it.
- **Copy / .txt**: copies or downloads the transcript, one `[mm:ss] texto` line per phrase.
- **Copiar para o Claude**: copies a pt-BR prompt plus the transcript. Paste it into claude.ai to get the summary, key points, next steps, legal risks and open questions. This uses her Claude subscription, with no API cost.
- **Autosave**: the current meeting is kept in the browser. A refresh or a closed tab doesn't lose it, and it comes back paused.

It doesn't say who is speaking. The Claude prompt asks Claude to work out the lawyer and the client from the content.

## How it works

```
mic → browser speech recognition (Web Speech API, pt-BR)
    → draft words (grey) → final phrase → line with its meeting time
```

- **Where the audio goes:** the browser sends it to its speech service: Google in Chrome, Microsoft in Edge, Apple in Safari. The page says so in the speech card and the footnote.
- **Firefox** has no speech recognition: "Começar a ouvir" is disabled, with a message to use Chrome, Edge or Safari.
- **One phrase per session.** The browser ends the session at the speaker's pause and `app.js` starts a new one right away (about 20 ms later in Chrome).
  - A single long "continuous" session in Chrome closed a line only every 30–40 s, and on one recording stopped returning text after 37 s (see Tested).
- **Line time:** the meeting clock when the phrase's first words appeared, about 0.5–1 s after the person started speaking. The clock counts recording time only, not pauses.
- **When recognition stops:**
  - "no-speech" (silence) and "aborted": a new session starts at once.
  - Other errors (no network, a browser whose service doesn't answer): retry after 1, 2, 3 and 4 s. After 5 failures in a row, it pauses with a message.
  - Microphone blocked or missing: it stops with a message.
  - Words still in grey when a session ends are kept as a line.
- **Text:** Chrome returns lowercase phrases with little punctuation, so the first letter of each line is capitalized.
- **Old version clean-up:** earlier versions ran Whisper and a speaker model in the browser (git history up to `d84b5af`). On load, the app deletes those cached models (about 600 MB) and the old quality setting. Saved meetings from that version still open, without speakers.

## Branding

- **Client:** RB Advocacia e Consultoria Jurídica. The logo is `assets/logo.png`, resized from `logo_gold_sem fundo.png`.
- **Colours** (tokens in `styles.css`):
  - Gold `#C4A45D`, sampled from the logo, for fills and accents, with dark text on top (7.3:1).
  - Gold text `#7D6224` (5.8:1 on white). Plain gold text on white is only 2.4:1.
  - Charcoal `#2B2519` and ivory `#F8F5EE`.
- **Fonts:** Marcellus for titles, the closest free match to the logo's flared serif (the logo's exact font is unknown). Inter for body text.

## Live link

https://hassankourani.github.io/notas-da-consulta/ (GitHub Pages, from `main`).
When you change `app.js` or `styles.css`, bump the `?v=` in `index.html`. Otherwise browsers can keep the old file for up to 10 minutes.

## Running it

It must be served over `http://localhost` or `https://`, and it needs an internet connection for the speech service.

- **Hosted (recommended)**: the GitHub Pages link above.
- **Local**: double-click `Abrir Notas da Consulta.command` (Mac) or `Abrir Notas da Consulta.bat` (Windows). Both need Python 3.
- **Dev**: run `python3 -m http.server 8765` and open `http://localhost:8765/?debug`.

## Tested

**Logic, with a scripted recognizer.** Open `/?debug&fake` and follow the steps at the top of `test/speech-check.js`. 28 checks pass:
- draft and final phrases, and line times;
- restart after the browser ends a session, keeping words still in grey;
- marks during and between phrases;
- retries, then a pause, after network errors;
- microphone blocked;
- Pausar finishing the last phrase;
- the `.txt` format;
- opening a save from the Whisper version, and deleting its cached models.

**Real Chrome 157, Google's service.**
- Each recording is played into an audio track and passed to `recognition.start(track)` in a separate test profile.
- Chrome's fake-microphone flags don't reach speech recognition.

| Recording | One long session | One session per phrase (shipped) |
|---|---|---|
| `conversa.wav`, 57 s, 10 turns, synthetic pt-BR voices | 2 lines; nothing after 37 s | **10 lines, one per turn** |
| `real2.wav`, 104 s, 24 turns, 2 real men | 4 lines of 30–40 s, ~141 words | **31 lines, ~147 words** |
| `real4.wav`, 105 s, 24 turns, 4 real voices | 5 lines, 77 words | **29 lines, 150 words** |

- On `conversa.wav` the text was close to the script. Mistakes were single words, such as "mais alguma notificação" for "mandou uma notificação".
- The real-voice files are turns cut from audiobooks (Multilingual LibriSpeech Portuguese, CC BY 4.0), so some lines start or end mid-sentence. They're local only (git-ignored).

**Not tested:**
- a real microphone in a real room;
- Edge and Safari;
- a meeting longer than two minutes;
- a real network drop;
- Brave and Opera, whose speech service may not answer (the app should pause with a message after 5 tries).
