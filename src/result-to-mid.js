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
    bpm: null,
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

    if (arg === "-b" || arg === "--bpm") {
      const rawBpm = args[i + 1];
      const bpm = Number.parseInt(rawBpm || "", 10);
      if (!Number.isInteger(bpm) || bpm <= 0) {
        throw new Error(`Invalid BPM value: ${rawBpm}`);
      }
      parsed.bpm = bpm;
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
      "  node src/result-to-mid.js -i Result.md -o Result.mid --bpm 200",
      "",
      "Default input/output:",
      "  Input : Result.md",
      "  Output: Result.mid",
      "",
      "Options:",
      "  -b, --bpm N   Override output MIDI tempo",
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

function parseMetadata(markdown) {
  const match = markdown.match(/^#META\s+([^\r\n]+)/m);
  if (!match) {
    return {};
  }

  const meta = {};
  const pairPattern = /([a-zA-Z0-9_]+)\s*=\s*([^\s]+)/g;
  let pair = null;
  while ((pair = pairPattern.exec(match[1])) !== null) {
    const key = pair[1];
    const rawValue = pair[2];
    if (/^[0-9]+$/.test(rawValue)) {
      meta[key] = Number.parseInt(rawValue, 10);
    } else {
      meta[key] = rawValue;
    }
  }
  return meta;
}

function extractSegmentsFromMarkdown(markdown) {
  const metadata = parseMetadata(markdown);
  const segments = [];

  const mmlPattern = /MML@([\s\S]*?);/g;
  let match = null;
  let previousEnd = 0;
  while ((match = mmlPattern.exec(markdown)) !== null) {
    const raw = match[1].replace(/\r?\n/g, "").trim();
    if (!raw) {
      previousEnd = match.index + match[0].length;
      continue;
    }
    const context = markdown.slice(previousEnd, match.index);
    const tickMatches = Array.from(context.matchAll(/段長Ticks:\s*(\d+)/g));
    const segmentTicks = tickMatches.length > 0
      ? Number.parseInt(tickMatches[tickMatches.length - 1][1], 10)
      : null;

    segments.push({
      ...splitMmlParts(raw),
      segmentTicks: Number.isInteger(segmentTicks) && segmentTicks > 0 ? segmentTicks : null,
    });
    previousEnd = match.index + match[0].length;
  }
  if (segments.length > 0) {
    if (segments.length === 1 && !segments[0].segmentTicks && Number.isInteger(metadata.totalTicks) && metadata.totalTicks > 0) {
      segments[0].segmentTicks = metadata.totalTicks;
    }
    return {
      segments,
      metadata,
    };
  }

  const blockPattern = /主音Melody:\s*\d+\s*\r?\n([^\r\n]*)\s*\r?\n和弦Chord1:\s*\d+\s*\r?\n([^\r\n]*)\s*\r?\n和弦Chord2:\s*\d+\s*\r?\n([^\r\n]*)/g;
  while ((match = blockPattern.exec(markdown)) !== null) {
    segments.push({
      melody: match[1].trim(),
      chord1: match[2].trim(),
      chord2: match[3].trim(),
      segmentTicks: null,
    });
  }

  if (segments.length > 0) {
    if (segments.length === 1 && Number.isInteger(metadata.totalTicks) && metadata.totalTicks > 0) {
      segments[0].segmentTicks = metadata.totalTicks;
    }
    return {
      segments,
      metadata,
    };
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
  let dots = 0;
  while (state.index < text.length && text[state.index] === ".") {
    dots += 1;
    state.index += 1;
  }

  if (value && value > 0) {
    return durationFromLength(value, dots);
  }

  const useDots = dots > 0 ? dots : state.defaultLengthDots;
  return durationFromLength(state.defaultLength, useDots);
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
    defaultLengthDots: 0,
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
      let dots = 0;
      while (state.index < text.length && text[state.index] === ".") {
        dots += 1;
        state.index += 1;
      }
      state.defaultLengthDots = dots;
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

function addEventsToTrack(track, events, tickOffset, ppq, segmentTicks) {
  const segmentEnd = tickOffset + (Number.isFinite(segmentTicks) ? Math.max(1, segmentTicks) : Number.MAX_SAFE_INTEGER);
  const pending = [];

  for (const event of events) {
    const start = Math.max(0, tickOffset + Math.round(event.startBeat * ppq));
    if (start >= segmentEnd) {
      continue;
    }

    // Compute end by absolute beat to reduce rounding drift on dense passages.
    let end = Math.max(start + 1, tickOffset + Math.round((event.startBeat + event.durationBeats) * ppq));
    if (end > segmentEnd) {
      end = segmentEnd;
    }
    if (end <= start) {
      end = Math.min(segmentEnd, start + 1);
    }
    if (end <= start) {
      continue;
    }

    pending.push({
      midi: event.midi,
      start,
      end,
      velocity: event.velocity,
    });
  }

  pending.sort((a, b) => a.start - b.start || a.midi - b.midi || a.end - b.end);

  // Avoid same-pitch overlaps on the same track/channel to prevent parser pair loss.
  const lastEndByMidi = new Map();
  for (const note of pending) {
    const previousEnd = lastEndByMidi.get(note.midi) || 0;
    let start = note.start;
    let end = note.end;

    if (start < previousEnd) {
      start = previousEnd;
    }
    if (end <= start) {
      end = Math.min(segmentEnd, start + 1);
    }
    if (end <= start) {
      continue;
    }

    track.addNote({
      midi: note.midi,
      ticks: start,
      durationTicks: Math.max(1, end - start),
      velocity: note.velocity,
    });
    lastEndByMidi.set(note.midi, end);
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

function buildMidiFromSegments(payload, options = {}) {
  const segments = payload.segments;
  const metadata = payload.metadata || {};
  const forcedBpm = Number.isFinite(options.bpm) ? clamp(Math.round(options.bpm), 20, 400) : null;
  const splitMode = typeof metadata.split === "string" ? metadata.split.toLowerCase() : "sequential";
  const parallelMode = splitMode === "parallel";
  const midi = new Midi();
  const ppq = midi.header.ppq || 480;

  const segmentTracks = parallelMode
    ? segments.map((_, index) => {
      const melodyTrack = midi.addTrack();
      melodyTrack.name = `Melody-${index + 1}`;
      const chord1Track = midi.addTrack();
      chord1Track.name = `Chord1-${index + 1}`;
      const chord2Track = midi.addTrack();
      chord2Track.name = `Chord2-${index + 1}`;
      return {
        melodyTrack,
        chord1Track,
        chord2Track,
      };
    })
    : [{
      melodyTrack: (() => {
        const track = midi.addTrack();
        track.name = "Melody";
        return track;
      })(),
      chord1Track: (() => {
        const track = midi.addTrack();
        track.name = "Chord1";
        return track;
      })(),
      chord2Track: (() => {
        const track = midi.addTrack();
        track.name = "Chord2";
        return track;
      })(),
    }];

  const tempoChanges = [];
  let tickOffset = 0;
  let maxEndTick = 0;

  for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex += 1) {
    const segment = segments[segmentIndex];
    const tracks = parallelMode ? segmentTracks[segmentIndex] : segmentTracks[0];
    const melody = parseMml(segment.melody);
    const chord1 = parseMml(segment.chord1);
    const chord2 = parseMml(segment.chord2);

    const producedTicks = Math.max(
      1,
      Math.round(Math.max(melody.totalBeats, chord1.totalBeats, chord2.totalBeats, 0) * ppq),
    );
    const segmentTicks = Number.isInteger(segment.segmentTicks) && segment.segmentTicks > 0
      ? segment.segmentTicks
      : producedTicks;
    const baseTick = parallelMode ? 0 : tickOffset;

    addEventsToTrack(tracks.melodyTrack, melody.events, baseTick, ppq, segmentTicks);
    addEventsToTrack(tracks.chord1Track, chord1.events, baseTick, ppq, segmentTicks);
    addEventsToTrack(tracks.chord2Track, chord2.events, baseTick, ppq, segmentTicks);

    for (const tempo of melody.tempoChanges) {
      const tempoTick = baseTick + Math.round(tempo.beat * ppq);
      if (tempoTick <= baseTick + segmentTicks) {
        tempoChanges.push({ beat: tempoTick / ppq, bpm: tempo.bpm });
      }
    }
    for (const tempo of chord1.tempoChanges) {
      const tempoTick = baseTick + Math.round(tempo.beat * ppq);
      if (tempoTick <= baseTick + segmentTicks) {
        tempoChanges.push({ beat: tempoTick / ppq, bpm: tempo.bpm });
      }
    }
    for (const tempo of chord2.tempoChanges) {
      const tempoTick = baseTick + Math.round(tempo.beat * ppq);
      if (tempoTick <= baseTick + segmentTicks) {
        tempoChanges.push({ beat: tempoTick / ppq, bpm: tempo.bpm });
      }
    }

    maxEndTick = Math.max(maxEndTick, baseTick + segmentTicks);
    if (!parallelMode) {
      tickOffset += segmentTicks;
    }
  }

  if (Number.isInteger(metadata.totalTicks) && metadata.totalTicks > 0) {
    const totalTicks = metadata.totalTicks;
    const clampTrack = (track) => {
      const nextNotes = track.notes
        .filter((note) => note.ticks < totalTicks)
        .map((note) => {
          const end = Math.min(totalTicks, note.ticks + note.durationTicks);
          return {
            ...note,
            durationTicks: Math.max(1, end - note.ticks),
          };
        });
      track.notes.length = 0;
      track.notes.push(...nextNotes);
    };
    for (const tracks of segmentTracks) {
      clampTrack(tracks.melodyTrack);
      clampTrack(tracks.chord1Track);
      clampTrack(tracks.chord2Track);
    }
  }

  const anchorTicks = Number.isInteger(metadata.totalTicks) && metadata.totalTicks > 0
    ? metadata.totalTicks
    : (parallelMode ? maxEndTick : tickOffset);
  for (const tracks of segmentTracks) {
    for (const track of [tracks.melodyTrack, tracks.chord1Track, tracks.chord2Track]) {
      track.addCC({
        number: 123,
        value: 0,
        ticks: Math.max(0, anchorTicks),
      });
    }
  }

  const normalizedTempos = forcedBpm
    ? [{ ticks: 0, bpm: forcedBpm }]
    : normalizeTempoChanges(tempoChanges, ppq);
  midi.header.tempos.push(...normalizedTempos);

  return midi.toArray();
}

function convertResultToMidi(inputPath, outputPath, options = {}) {
  const markdown = fs.readFileSync(inputPath, "utf8");
  const payload = extractSegmentsFromMarkdown(markdown);
  const bytes = buildMidiFromSegments(payload, options);
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
    convertResultToMidi(inputPath, outputPath, {
      bpm: parsed.bpm,
    });
  } catch (error) {
    console.error(`轉換失敗: ${error.message}`);
    process.exitCode = 1;
    return;
  }

  console.log(`完成: ${outputPath}`);
  if (parsed.bpm) {
    console.log(`BPM 覆蓋: ${parsed.bpm}`);
  }
}

if (require.main === module) {
  main();
}
