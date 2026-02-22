#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { Midi } = require("@tonejs/midi");

const DEFAULT_INPUT = "Result.md";
const DEFAULT_OUTPUT = "Result.mid";

const NOTE_TO_SEMITONE = {
  c: 0,
  d: 2,
  e: 4,
  f: 5,
  g: 7,
  a: 9,
  b: 11,
};

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const parsed = {
    input: null,
    output: null,
    help: false,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];

    if (arg === "-h" || arg === "--help") {
      parsed.help = true;
      continue;
    }

    if (arg === "-i" || arg === "--input") {
      parsed.input = args[i + 1] || null;
      i += 1;
      continue;
    }

    if (arg === "-o" || arg === "--output") {
      parsed.output = args[i + 1] || null;
      i += 1;
      continue;
    }

    if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    }

    if (!parsed.input) {
      parsed.input = arg;
    } else if (!parsed.output) {
      parsed.output = arg;
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }

  parsed.input = parsed.input || DEFAULT_INPUT;
  parsed.output = parsed.output || DEFAULT_OUTPUT;
  return parsed;
}

function printHelp() {
  console.log(
    [
      "Usage:",
      "  node src/result-to-mid.js [Result.md] [Result.mid]",
      "  node src/result-to-mid.js -i Result.md -o Result.mid",
      "",
      "Default input/output:",
      "  Input : Result.md",
      "  Output: Result.mid",
    ].join("\n"),
  );
}

function splitMmlParts(raw) {
  const parts = raw.split(",");
  if (parts.length < 3) {
    throw new Error("MML@ 內容格式錯誤，必須包含 3 個聲部（melody,chord1,chord2）。");
  }
  const melody = parts[0].trim();
  const chord1 = parts[1].trim();
  const chord2 = parts.slice(2).join(",").trim();
  return { melody, chord1, chord2 };
}

function extractSegmentsFromMarkdown(markdown) {
  const segments = [];

  const mmlPattern = /MML@([\s\S]*?);/g;
  let match = null;
  while ((match = mmlPattern.exec(markdown)) !== null) {
    const raw = match[1].replace(/\r?\n/g, "").trim();
    if (!raw) {
      continue;
    }
    segments.push(splitMmlParts(raw));
  }
  if (segments.length > 0) {
    return segments;
  }

  const blockPattern = /主音Melody:\s*\d+\s*\r?\n([^\r\n]*)\s*\r?\n和弦Chord1:\s*\d+\s*\r?\n([^\r\n]*)\s*\r?\n和弦Chord2:\s*\d+\s*\r?\n([^\r\n]*)/g;
  while ((match = blockPattern.exec(markdown)) !== null) {
    segments.push({
      melody: match[1].trim(),
      chord1: match[2].trim(),
      chord2: match[3].trim(),
    });
  }

  if (segments.length > 0) {
    return segments;
  }

  throw new Error("找不到可解析的樂譜內容。請確認 Result.md 內有 MML@...; 或主音/和弦三段格式。");
}

function readInteger(text, state) {
  const start = state.index;
  while (state.index < text.length && /[0-9]/.test(text[state.index])) {
    state.index += 1;
  }
  if (state.index === start) {
    return null;
  }
  return Number.parseInt(text.slice(start, state.index), 10);
}

function skipWhitespace(text, state) {
  while (state.index < text.length && /\s/.test(text[state.index])) {
    state.index += 1;
  }
}

function durationFromLength(denominator, dots) {
  const safeDenominator = denominator > 0 ? denominator : 4;
  const base = 4 / safeDenominator;
  let factor = 1;
  let add = 0.5;
  for (let i = 0; i < dots; i += 1) {
    factor += add;
    add /= 2;
  }
  return base * factor;
}

function readDuration(text, state) {
  const value = readInteger(text, state);
  const denominator = value && value > 0 ? value : state.defaultLength;
  let dots = 0;
  while (state.index < text.length && text[state.index] === ".") {
    dots += 1;
    state.index += 1;
  }
  return durationFromLength(denominator, dots);
}

function parsePlayableUnit(text, state) {
  skipWhitespace(text, state);
  if (state.index >= text.length) {
    return null;
  }

  const ch = text[state.index].toLowerCase();

  if (ch === "r") {
    state.index += 1;
    return {
      kind: "rest",
      duration: readDuration(text, state),
    };
  }

  if (ch === "n") {
    state.index += 1;
    const midiNumber = readInteger(text, state);
    if (midiNumber === null) {
      return null;
    }
    return {
      kind: "note",
      midi: clamp(midiNumber, 0, 127),
      duration: readDuration(text, state),
    };
  }

  if (Object.prototype.hasOwnProperty.call(NOTE_TO_SEMITONE, ch)) {
    state.index += 1;
    let semitone = NOTE_TO_SEMITONE[ch];
    if (state.index < text.length) {
      const accidental = text[state.index];
      if (accidental === "+" || accidental === "#") {
        semitone += 1;
        state.index += 1;
      } else if (accidental === "-") {
        semitone -= 1;
        state.index += 1;
      }
    }

    const midi = clamp((state.octave + 1) * 12 + semitone, 0, 127);
    return {
      kind: "note",
      midi,
      duration: readDuration(text, state),
    };
  }

  return null;
}

function volumeToVelocity(volume) {
  const normalized = clamp(volume, 0, 15) / 15;
  return clamp(0.15 + normalized * 0.85, 0, 1);
}

function parseMml(mmlText) {
  const text = (mmlText || "").trim();
  const state = {
    index: 0,
    beat: 0,
    octave: 4,
    defaultLength: 4,
    volume: 12,
    tempo: 120,
  };

  const events = [];
  const tempoChanges = [];

  while (state.index < text.length) {
    skipWhitespace(text, state);
    if (state.index >= text.length) {
      break;
    }

    const ch = text[state.index].toLowerCase();

    if (ch === "," || ch === ";" || ch === "@") {
      state.index += 1;
      continue;
    }

    if (ch === "t") {
      state.index += 1;
      const tempo = readInteger(text, state);
      if (tempo !== null && tempo > 0) {
        state.tempo = clamp(tempo, 20, 400);
        tempoChanges.push({ beat: state.beat, bpm: state.tempo });
      }
      continue;
    }

    if (ch === "v") {
      state.index += 1;
      const volume = readInteger(text, state);
      if (volume !== null) {
        state.volume = clamp(volume, 0, 15);
      }
      continue;
    }

    if (ch === "o") {
      state.index += 1;
      const octave = readInteger(text, state);
      if (octave !== null) {
        state.octave = clamp(octave, 0, 9);
      }
      continue;
    }

    if (ch === "l") {
      state.index += 1;
      const length = readInteger(text, state);
      if (length !== null && length > 0) {
        state.defaultLength = length;
      }
      continue;
    }

    if (ch === "<") {
      state.octave = clamp(state.octave - 1, 0, 9);
      state.index += 1;
      continue;
    }

    if (ch === ">") {
      state.octave = clamp(state.octave + 1, 0, 9);
      state.index += 1;
      continue;
    }

    if (ch === "&") {
      state.index += 1;
      continue;
    }

    const unit = parsePlayableUnit(text, state);
    if (!unit) {
      state.index += 1;
      continue;
    }

    let totalDuration = unit.duration;
    while (true) {
      const checkpoint = state.index;
      skipWhitespace(text, state);
      if (state.index >= text.length || text[state.index] !== "&") {
        state.index = checkpoint;
        break;
      }

      state.index += 1;
      skipWhitespace(text, state);
      while (state.index < text.length && (text[state.index] === "<" || text[state.index] === ">")) {
        if (text[state.index] === "<") {
          state.octave = clamp(state.octave - 1, 0, 9);
        } else {
          state.octave = clamp(state.octave + 1, 0, 9);
        }
        state.index += 1;
      }

      const tiedUnit = parsePlayableUnit(text, state);
      if (!tiedUnit) {
        break;
      }
      totalDuration += tiedUnit.duration;
    }

    if (unit.kind === "note") {
      events.push({
        midi: unit.midi,
        startBeat: state.beat,
        durationBeats: totalDuration,
        velocity: volumeToVelocity(state.volume),
      });
    }

    state.beat += totalDuration;
  }

  return {
    events,
    tempoChanges,
    totalBeats: state.beat,
  };
}

function addEventsToTrack(track, events, beatOffset, ppq) {
  for (const event of events) {
    const ticks = Math.max(0, Math.round((beatOffset + event.startBeat) * ppq));
    const durationTicks = Math.max(1, Math.round(event.durationBeats * ppq));
    track.addNote({
      midi: event.midi,
      ticks,
      durationTicks,
      velocity: event.velocity,
    });
  }
}

function normalizeTempoChanges(tempoChanges, ppq) {
  const sorted = tempoChanges
    .map((entry) => ({
      ticks: Math.max(0, Math.round(entry.beat * ppq)),
      bpm: clamp(Math.round(entry.bpm), 20, 400),
    }))
    .sort((a, b) => a.ticks - b.ticks);

  const deduped = [];
  for (const entry of sorted) {
    const last = deduped[deduped.length - 1];
    if (last && last.ticks === entry.ticks) {
      continue;
    }
    deduped.push(entry);
  }

  if (deduped.length === 0 || deduped[0].ticks !== 0) {
    const fallbackBpm = deduped.length > 0 ? deduped[0].bpm : 120;
    deduped.unshift({ ticks: 0, bpm: fallbackBpm });
  }

  return deduped;
}

function buildMidiFromSegments(segments) {
  const midi = new Midi();
  const ppq = midi.header.ppq || 480;

  const melodyTrack = midi.addTrack();
  melodyTrack.name = "Melody";

  const chord1Track = midi.addTrack();
  chord1Track.name = "Chord1";

  const chord2Track = midi.addTrack();
  chord2Track.name = "Chord2";

  const tempoChanges = [];
  let beatOffset = 0;

  for (const segment of segments) {
    const melody = parseMml(segment.melody);
    const chord1 = parseMml(segment.chord1);
    const chord2 = parseMml(segment.chord2);

    addEventsToTrack(melodyTrack, melody.events, beatOffset, ppq);
    addEventsToTrack(chord1Track, chord1.events, beatOffset, ppq);
    addEventsToTrack(chord2Track, chord2.events, beatOffset, ppq);

    for (const tempo of melody.tempoChanges) {
      tempoChanges.push({ beat: beatOffset + tempo.beat, bpm: tempo.bpm });
    }
    for (const tempo of chord1.tempoChanges) {
      tempoChanges.push({ beat: beatOffset + tempo.beat, bpm: tempo.bpm });
    }
    for (const tempo of chord2.tempoChanges) {
      tempoChanges.push({ beat: beatOffset + tempo.beat, bpm: tempo.bpm });
    }

    const segmentBeats = Math.max(melody.totalBeats, chord1.totalBeats, chord2.totalBeats, 0);
    beatOffset += segmentBeats;
  }

  const normalizedTempos = normalizeTempoChanges(tempoChanges, ppq);
  midi.header.tempos.push(...normalizedTempos);

  return midi.toArray();
}

function convertResultToMidi(inputPath, outputPath) {
  const markdown = fs.readFileSync(inputPath, "utf8");
  const segments = extractSegmentsFromMarkdown(markdown);
  const bytes = buildMidiFromSegments(segments);
  fs.writeFileSync(outputPath, Buffer.from(bytes));
}

function main() {
  let parsed;
  try {
    parsed = parseArgs(process.argv);
  } catch (error) {
    console.error(error.message);
    printHelp();
    process.exitCode = 1;
    return;
  }

  if (parsed.help) {
    printHelp();
    return;
  }

  const inputPath = path.resolve(parsed.input);
  const outputPath = path.resolve(parsed.output);

  if (!fs.existsSync(inputPath)) {
    console.error(`找不到檔案: ${inputPath}`);
    process.exitCode = 1;
    return;
  }

  try {
    convertResultToMidi(inputPath, outputPath);
  } catch (error) {
    console.error(`轉換失敗: ${error.message}`);
    process.exitCode = 1;
    return;
  }

  console.log(`完成: ${outputPath}`);
}

if (require.main === module) {
  main();
}

