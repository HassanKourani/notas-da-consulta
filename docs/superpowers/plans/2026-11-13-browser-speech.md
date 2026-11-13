# Browser speech recognition Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace local Whisper and speaker detection with the browser's built-in speech recognition, so transcription starts with nothing to download.

**Architecture:** `app.js` drives one `SpeechRecognition` session at a time (pt-BR, continuous, interim results) and restarts it whenever the browser ends it while recording. Final results become timestamped lines; interim results fill the grey "Ouvindo…" row. `worker.js` and `audio-processor.js` are deleted.

**Tech Stack:** Plain HTML, CSS and JS (ES module), the Web Speech API and GitHub Pages. No build step.

**Spec:** `docs/superpowers/specs/2026-11-13-browser-speech-design.md`

## Global Constraints

- `lang = 'pt-BR'`. All interface copy is in Brazilian Portuguese.
- Nothing is downloaded beyond the page itself.
- The page names where the audio goes: Google (Chrome), Microsoft (Edge) or Apple (Safari).
- Bump `?v=` from 14 to 15 on `app.js` and `styles.css`.
- Keep the localStorage key `notas-consulta:v1`. Older saves must still open.

## Review Focus

1. Chrome ends a session in the middle of a phrase: the words already on screen are kept as a line, not lost.
2. The speech service is unreachable (offline, Brave, Opera): retry with backoff, then pause with a clear message. No tight restart loop.
3. Microphone permission denied: message, back to idle, no restart loop.
4. A result arriving just after Pausar or Encerrar (`stop()` flushes the last phrase): it's still added, with the time it was spoken.
5. Reloading with a save from the Whisper version (`samples`, `spk`, `emb`, 100000+ ids): it opens, the clock continues, and new ids don't collide.

---

### Task 1: Speech engine, clock and UI cleanup

**Files:**
- Modify: `app.js` (rewrite engine, state, rendering, persistence; drop speakers)
- Modify: `index.html`: remove "Pessoas na reunião", the "Falantes" card and the quality select; update the footnote and the engine card; `?v=15`
- Modify: `styles.css`: drop speaker, merge, people, quality and progress rules; add a badge alignment rule
- Delete: `worker.js`, `audio-processor.js`
- Test: a fake recognition behind `?debug&fake` in `app.js`, driven from the browser pane

**Interfaces:**
- State: `S = { status, title, startedAt, elapsed /* ms recorded */, lines: [{ id, t /* s */, text, marked }], nextId }`
- `seconds(): number`: recorded time, live while recording.
- `addLine(t: number, text: string)`: cleans the text, applies the pending mark, renders and saves.
- Debug: `window.__rec` is the current fake. It has:
  - `say(text, isFinal)`;
  - `fail(error)`, which sends an error, then ends;
  - `end()`, which ends with no error.
  `window.__starts` counts sessions started.

- [ ] Step 1: Write the fake recognition and a test script, `test/speech-check.js`. It's pasted into the console on `/?debug&fake` and asserts:
  - an interim result shows the preview, and a final result adds 1 line with the interim's time;
  - `end()` while recording starts a new session (`__starts` grows), and an interim pending at `end()` is kept as a line;
  - 5 `fail('network')` in a row pause with a message;
  - `fail('not-allowed')` returns to idle, with no new session;
  - Marcar while a draft is showing marks the next line;
  - `asText()` lines match `/^\[\d\d:\d\d\] .+/` and marked lines end in `[MARCADO]`;
  - restoring a Whisper-era save opens with its lines, and the next id is higher than every old id.
- [ ] Step 2: Run it against the current code: it fails, because there's no fake hook.
- [ ] Step 3: Implement the engine, clock, line rendering, persistence migration, old-cache clean-up and HTML/CSS cleanup.
- [ ] Step 4: Run the check: all pass, with no console errors.
- [ ] Step 5: Commit.

### Task 2: Real Chrome check

- [ ] Launch Google Chrome with a temporary profile and these flags: `--use-fake-device-for-media-stream --use-file-for-fake-audio-capture=<wav>%noloop --use-fake-ui-for-media-stream --remote-debugging-port`.
- [ ] Open the local server and start it over CDP. Expect pt-BR lines with increasing times, matching the recording's speech.

### Task 3: Docs and deploy

- [ ] Rewrite the README sections that describe Whisper and speakers. Note what is untested: Safari, Edge and a real room.
- [ ] Commit, push, wait for Pages, and check that the live page serves `v=15`, that `worker.js` returns 404, and that it shows the engine text in Chrome.
