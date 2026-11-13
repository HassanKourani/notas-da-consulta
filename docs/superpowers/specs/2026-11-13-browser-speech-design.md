# Browser speech recognition, no speakers

## Why

The lawyer should open the link and start transcribing at once. The current version downloads about 600 MB of models (Whisper plus a voice-print model) before it can start. Telling speakers apart was the heaviest and least reliable part. She doesn't need to know who said what: text with a time on each line is enough.

## Goals

- Nothing to download: transcription starts on the first visit.
- Live text in Brazilian Portuguese, one line per phrase, each with its meeting time.
- Keep start, pause, resume, stop, new meeting, marks, editing a line, copy, .txt, "Copiar para o Claude" and autosave.

## Non-goals

- Who is speaking.
- Working in Firefox, which has no built-in speech recognition.

## Anti-goals

- Hiding where the audio goes. The page must say plainly that the browser's speech service receives it.

## Approaches

| Approach | Trade-off | Verdict |
|---|---|---|
| **Browser speech recognition (Web Speech API)** | Instant, free, live text. The audio goes to Google (Chrome), Microsoft (Edge) or Apple (Safari). No Firefox. | **Picked by the user**, over the version below with an extra private mode |
| Same, plus an opt-in local Whisper "Modo privado" | Keeps a way to keep the audio on the laptop. Keeps about 600 MB of model and the worker code. | Not wanted: she wants it light |
| Smaller local Whisper (tiny or base) | Still a 40–150 MB download, and much weaker Portuguese | Doesn't meet "nothing to download" |
| A paid cloud speech API | Needs a server, keys and per-minute cost | Out of scope |

## Design

**Engine**
- `SpeechRecognition` / `webkitSpeechRecognition` with `lang = 'pt-BR'` and `interimResults`, one phrase per session (`continuous = false`), restarted after each one. Chosen after testing in Chrome: continuous sessions closed a line only every 30–40 s and once stalled.
- Draft words show in the grey "Ouvindo…" row. Each phrase the browser finalizes becomes one line.
- Browsers end recognition sessions on their own, after silence or after a few minutes. While recording, the app restarts it at once.
- Errors:
  - Microphone blocked: message, and stop.
  - Network or service failure: retry, then a message suggesting Chrome.
  - "no-speech" and "aborted": ignored.

**Times**
- The meeting clock counts only time spent recording (pauses excluded) and is saved.
- A line's time is the clock reading when its first words appeared. That's about half a second to a second after the person started speaking.

**Removed**
- `worker.js`, `audio-processor.js` and transformers.js.
- Speaker grouping, the speaker on each line, the "Falantes" card, "Pessoas na reunião", "Juntar com…" and the quality menu.

**Unsupported browser**
- "Começar a ouvir" is disabled, and the speech card says to use Chrome, Edge or Safari.

**Privacy text**
- The footnote and the speech card name the service that receives the audio (Google, Microsoft or Apple, from the browser).
- They also say the audio isn't recorded and only the text is saved on this computer.

**Clean-up (my call)**
- On load, delete the old `transformers-cache` (about 600 MB of models left from the previous version) and the old quality setting.

**Text (my call)**
- Capitalize the first letter of each line, because Chrome returns lowercase with little punctuation.
- The .txt has one line per phrase: `[mm:ss] texto`, with `[MARCADO]` on marked lines.
- The Claude prompt says there are no speaker names and punctuation may be missing. It asks Claude to infer the lawyer and the client from the content, where it can.

**Old saved meeting**
- Still opens: speaker data is dropped, and the old sample counter becomes the clock.

## Testing (my call)

- Real Google Chrome with a test recording played in as the microphone (Chrome's fake-microphone flags, in a temporary profile).
- Check that lines appear with times, that recognition restarts across a long recording, and that pause/resume, stop, marks, .txt and the Claude copy all work.
- Not testable here: Safari, Edge, and her microphone in a real room.
