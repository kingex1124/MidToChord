# Project Guidelines

## Code Style
- Use CommonJS only (`require`, `module.exports`), consistent with `package.json` (`"type": "commonjs"`) and all scripts under `src/`.
- Keep CLI entry pattern: `parseArgs` + `printHelp` + `main`, then `if (require.main === module) { ... }`.
- Keep naming descriptive and music-domain specific (examples in `src/mid-to-chord.js`, `src/result-to-mid.js`).
- Match existing synchronous file I/O style (`fs.readFileSync` / `fs.writeFileSync`) unless a task explicitly requires async refactor.

## Architecture
- Main conversion entry is `src/mid-to-chord.js`.
- Data flow: input (`.mid` / audio / MusicXML) -> normalize to MIDI when needed -> convert to score text -> write `Result.md`.
- Audio inputs are pre-converted via `src/audio-to-midi.js`; MusicXML/MXL inputs via `src/mxl-to-mid.js`.
- Reverse flow (`Result.md` -> `Result.mid`) is implemented in `src/result-to-mid.js`.
- Time-range slicing is a separate CLI in `src/cut-mid.js`.

## Build and Test
- Install dependencies: `npm install`
- Run main converter: `npm run convert -- -i <input.mid> [options]`
- Convert score markdown back to MIDI: `npm run to-mid -- -i Result.md -o Result.mid`
- Audio to MIDI: `npm run audio-to-midi -- -i <input.mp3> -o <output.mid>`
- MusicXML/MXL to MIDI: `npm run mxl-to-midi -- -i <input.mxl> -o <output.mid>`
- Cut MIDI by time range: `npm run cut-mid -- -i <input.mid> --from 00:30 --to 01:45 -o CUT.mid`
- There is currently no `test` script or test framework in `package.json`.

## Project Conventions
- Preserve score contract used across tools: `#META ...`, `段長Ticks`, and `MML@...;` blocks (`src/mid-to-chord.js`, `src/result-to-mid.js`).
- Keep `split` behavior compatible with existing values: `parallel`, `sequential`, and single-player output semantics.
- Respect current output defaults: always write `Result.md`; optional `-o` writes an additional output file.
- Keep current CLI compatibility flags (`--players` and alias `--player`, `--bpm`, `--split-mode`).

## Integration Points
- MIDI parsing/writing is based on `@tonejs/midi` (`src/mid-to-chord.js`, `src/result-to-mid.js`, `src/cut-mid.js`).
- Audio transcription uses `@spotify/basic-pitch` with fallback logic in `src/audio-to-midi.js`.
- MusicXML/MXL parsing uses `adm-zip` and `fast-xml-parser` in `src/mxl-to-mid.js`.
- Audio decoding uses `web-audio-api` in `src/audio-to-midi.js`.

## Security
- Treat all CLI paths as untrusted input; continue resolving with `path.resolve` before read/write.
- Current tools overwrite output files directly (for example `Result.md`, custom `-o` path); do not add hidden extra writes.
- `src/mid-to-chord.js` creates temporary MIDI files under OS temp and performs best-effort cleanup; preserve this behavior when editing the pipeline.
- `src/audio-to-midi.js` may fetch model assets from CDN when local loading fails; consider offline constraints when changing model-loading logic.
