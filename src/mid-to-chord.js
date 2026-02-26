#!/usr/bin/env node

const fs = require("fs");
const os = require("os");
const path = require("path");
const { Midi } = require("@tonejs/midi");

const LIMITS = {
  melody: 1200,
  chord1: 800,
  chord2: 500,
};

const NOTE_NAMES = ["c", "c+", "d", "d+", "e", "f", "f+", "g", "g+", "a", "a+", "b"];

function parseArgs(argv) {
  const args = normalizeSpaceSeparatedInputArgs(argv.slice(2));
  const parsed = {
    input: null,
    output: null,
    compress: false,
    players: 1,
    splitMode: "parallel",
    bpm: null,
    help: false,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      continue;
    }

    if (arg === "--input" || arg === "-i") {
      parsed.input = args[i + 1] || null;
      i += 1;
      continue;
    }

    if (arg === "--output" || arg === "-o") {
      parsed.output = args[i + 1] || null;
      i += 1;
      continue;
    }

    if (arg === "--compress" || arg === "-c") {
      parsed.compress = true;
      continue;
    }

    if (arg === "--no-compress") {
      parsed.compress = false;
      continue;
    }

    if (arg === "--players" || arg === "--player" || arg === "-p") {
      const rawPlayers = args[i + 1];
      const players = Number.parseInt(rawPlayers || "", 10);
      if (!Number.isInteger(players) || players < 1) {
        throw new Error(`Invalid players value: ${rawPlayers}`);
      }
      parsed.players = players;
      i += 1;
      continue;
    }

    if (arg === "--split-mode") {
      const mode = (args[i + 1] || "").toLowerCase();
      if (!["parallel", "sequential"].includes(mode)) {
        throw new Error(`Invalid split mode: ${args[i + 1]}`);
      }
      parsed.splitMode = mode;
      i += 1;
      continue;
    }

    if (arg === "--bpm" || arg === "-b") {
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

  return parsed;
}

function normalizeSpaceSeparatedInputArgs(args) {
  if (!Array.isArray(args) || args.length <= 1) {
    return args;
  }

  if (args.includes("-i") || args.includes("--input")) {
    return args;
  }

  const firstOptionIndex = args.findIndex((item) => item.startsWith("-"));
  const endIndex = firstOptionIndex === -1 ? args.length : firstOptionIndex;
  if (endIndex <= 1) {
    return args;
  }

  const leading = args.slice(0, endIndex);
  for (let tokenCount = leading.length; tokenCount >= 2; tokenCount -= 1) {
    const candidate = leading.slice(0, tokenCount).join(" ");
    if (!fs.existsSync(path.resolve(candidate))) {
      continue;
    }
    return [candidate, ...leading.slice(tokenCount), ...args.slice(endIndex)];
  }

  return args;
}

function isAudioInput(filePath) {
  const ext = path.extname(filePath || "").toLowerCase();
  return [".mp3", ".wav", ".ogg", ".flac", ".m4a", ".aac"].includes(ext);
}

function isMusicXmlInput(filePath) {
  const ext = path.extname(filePath || "").toLowerCase();
  return [".mxl", ".musicxml", ".xml"].includes(ext);
}

function printHelp() {
  console.log(
    [
      "Usage:",
      "  node src/mid-to-chord.js <input.mid|input.mp3|input.mxl> [output.md]",
      "  node src/mid-to-chord.js -i <input.mid|input.mp3|input.mxl> -o <output.md> [-c] [-p <players>]",
      "",
      "Options:",
      "  -c, --compress     Enable adaptive compression to fit limits before truncating",
      "  -p, --players N    Split into N ensemble sheets",
      "  --player N         Alias of --players",
      "  --split-mode M     ensemble split mode: parallel|sequential (default: parallel)",
      "  -b, --bpm N        Override output BPM for score generation (e.g. 120)",
      "  note: filenames with spaces are supported; quoting is still recommended",
      "",
      "Character limits:",
      "  Melody: 1200",
      "  Chord1: 800",
      "  Chord2: 500",
    ].join("\n"),
  );
}

function readPlayersFromMeta(scoreText) {
  const match = String(scoreText || "").match(/^#META[^\n]*\bplayers=(\d+)/m);
  if (!match) {
    return null;
  }
  const parsed = Number.parseInt(match[1], 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function estimateTempo(midi) {
  const bpm = midi.header.tempos && midi.header.tempos.length > 0 ? midi.header.tempos[0].bpm : 120;
  return clamp(Math.round(bpm || 120), 30, 300);
}

function midiToPitchInfo(midiNumber) {
  const pitchClass = ((midiNumber % 12) + 12) % 12;
  const octave = Math.floor(midiNumber / 12) - 1;
  return {
    name: NOTE_NAMES[pitchClass],
    octave,
  };
}

function collectTrackStats(midi) {
  return midi.tracks
    .map((track, index) => {
      const notes = track.notes
        .map((note) => ({
          midi: note.midi,
          ticks: note.ticks,
          durationTicks: Math.max(1, note.durationTicks || 0),
          velocity: note.velocity || 0.7,
        }))
        .filter((note) => Number.isFinite(note.midi) && Number.isFinite(note.ticks) && Number.isFinite(note.durationTicks))
        .sort((a, b) => a.ticks - b.ticks || a.midi - b.midi);

      if (notes.length === 0) {
        return null;
      }

      let maxEnd = 0;
      let overlapCount = 0;
      let activeEnd = -1;
      let pitchSum = 0;
      let velocitySum = 0;

      for (const note of notes) {
        const end = note.ticks + note.durationTicks;
        if (note.ticks < activeEnd) {
          overlapCount += 1;
        }
        activeEnd = Math.max(activeEnd, end);
        maxEnd = Math.max(maxEnd, end);
        pitchSum += note.midi;
        velocitySum += note.velocity;
      }

      const avgPitch = pitchSum / notes.length;
      const avgVelocity = velocitySum / notes.length;
      const overlapRatio = overlapCount / Math.max(1, notes.length);
      const isPercussion = Boolean(track.instrument && track.instrument.percussion) || track.channel === 9;

      return {
        index,
        notes,
        noteCount: notes.length,
        avgPitch,
        avgVelocity,
        overlapRatio,
        maxEndTicks: maxEnd,
        isPercussion,
      };
    })
    .filter(Boolean);
}

function splitPolyphonicTrackVoices(track, voiceCount = 3) {
  if (!track || !track.notes || track.notes.length === 0) {
    return [];
  }

  const voices = Array.from({ length: Math.max(1, voiceCount) }, () => ({
    notes: [],
    lastEnd: -1,
    lastMidi: null,
    pitchSum: 0,
    velocitySum: 0,
  }));

  const sortedNotes = track.notes
    .slice()
    .sort((a, b) => a.ticks - b.ticks || b.midi - a.midi || b.durationTicks - a.durationTicks);

  for (const note of sortedNotes) {
    let bestVoiceIndex = 0;
    let bestScore = Number.POSITIVE_INFINITY;

    for (let i = 0; i < voices.length; i += 1) {
      const voice = voices[i];
      const overlapTicks = Math.max(0, voice.lastEnd - note.ticks);
      const overlapPenalty = overlapTicks > 0 ? 1000 + overlapTicks * 4 : 0;
      const pitchDistance = voice.lastMidi === null ? 0 : Math.abs(note.midi - voice.lastMidi);
      const gapTicks = voice.lastEnd < 0 ? 0 : Math.max(0, note.ticks - voice.lastEnd);
      const gapPenalty = gapTicks / 960;
      const score = overlapPenalty + pitchDistance * 1.6 + gapPenalty;

      if (score < bestScore - 1e-9 || (Math.abs(score - bestScore) <= 1e-9 && i < bestVoiceIndex)) {
        bestScore = score;
        bestVoiceIndex = i;
      }
    }

    const selected = voices[bestVoiceIndex];
    selected.notes.push({ ...note });
    selected.lastEnd = Math.max(selected.lastEnd, note.ticks + note.durationTicks);
    selected.lastMidi = note.midi;
    selected.pitchSum += note.midi;
    selected.velocitySum += note.velocity || 0.7;
  }

  const voiceTracks = voices
    .filter((voice) => voice.notes.length > 0)
    .map((voice, index) => {
      const rawNotes = voice.notes
        .slice()
        .sort((a, b) => a.ticks - b.ticks || a.midi - b.midi);

      const notes = [];
      for (const currentNote of rawNotes) {
        if (notes.length === 0) {
          notes.push({ ...currentNote });
          continue;
        }

        const previous = notes[notes.length - 1];
        const previousEnd = previous.ticks + previous.durationTicks;
        if (currentNote.ticks < previousEnd) {
          const trimmedLength = currentNote.ticks - previous.ticks;
          if (trimmedLength >= 1) {
            previous.durationTicks = trimmedLength;
          } else if (currentNote.durationTicks > previous.durationTicks) {
            notes[notes.length - 1] = { ...currentNote };
            continue;
          } else {
            continue;
          }
        }

        notes.push({ ...currentNote });
      }

      let overlapCount = 0;
      let activeEnd = -1;
      let maxEnd = 0;
      for (const note of notes) {
        const end = note.ticks + note.durationTicks;
        if (note.ticks < activeEnd) {
          overlapCount += 1;
        }
        activeEnd = Math.max(activeEnd, end);
        maxEnd = Math.max(maxEnd, end);
      }

      return {
        index: -(index + 1),
        notes,
        noteCount: notes.length,
        avgPitch: voice.pitchSum / notes.length,
        avgVelocity: voice.velocitySum / notes.length,
        overlapRatio: overlapCount / Math.max(1, notes.length),
        maxEndTicks: maxEnd,
        isPercussion: false,
      };
    })
    .sort((a, b) => b.avgPitch - a.avgPitch || b.noteCount - a.noteCount);

  return voiceTracks;
}

function pickTrackGroups(trackStats) {
  if (trackStats.length === 0) {
    return {
      melodyTracks: [],
      harmonyTracks: [],
      chordPoolTracks: [],
      chord1Tracks: [],
      chord2Tracks: [],
    };
  }

  const nonPercussion = trackStats.filter((track) => !track.isPercussion);
  const usable = nonPercussion.length > 0 ? nonPercussion : trackStats;

  if (usable.length === 1 && usable[0].overlapRatio >= 0.55 && usable[0].noteCount >= 64) {
    const splitVoices = splitPolyphonicTrackVoices(usable[0], 3);
    if (splitVoices.length >= 2) {
      const melodyTracks = [splitVoices[0]];
      const harmonyTracks = splitVoices.slice(1);
      const chordPoolTracks = harmonyTracks.length > 0 ? harmonyTracks : [splitVoices[0]];
      const chord1Tracks = splitVoices[1] ? [splitVoices[1]] : [splitVoices[0]];
      const chord2Tracks = splitVoices[2] ? [splitVoices[2]] : chord1Tracks;
      return {
        melodyTracks,
        harmonyTracks: harmonyTracks.length > 0 ? harmonyTracks : melodyTracks,
        chordPoolTracks,
        chord1Tracks,
        chord2Tracks,
      };
    }
  }

  const melodyTrack = usable.reduce((best, track) => {
    if (!best) {
      return track;
    }
    const scoreBest = best.avgPitch * 1.2 + (1 - best.overlapRatio) * 25 + Math.log2(best.noteCount + 1) * 4;
    const scoreTrack = track.avgPitch * 1.2 + (1 - track.overlapRatio) * 25 + Math.log2(track.noteCount + 1) * 4;
    return scoreTrack > scoreBest ? track : best;
  }, null);

  const melodySupportTracks = usable
    .filter((track) => track.index !== melodyTrack.index)
    .filter((track) => track.avgPitch >= melodyTrack.avgPitch - 7)
    .filter((track) => track.overlapRatio <= 0.45)
    .filter((track) => track.noteCount >= Math.max(8, Math.floor(melodyTrack.noteCount * 0.2)))
    .sort((a, b) => b.avgPitch - a.avgPitch || b.noteCount - a.noteCount)
    .slice(0, 2);

  const melodyTracks = [melodyTrack, ...melodySupportTracks];
  const melodyTrackIds = new Set(melodyTracks.map((track) => track.index));

  let harmonyTracks = usable.filter((track) => !melodyTrackIds.has(track.index));
  if (harmonyTracks.length === 0) {
    harmonyTracks = [melodyTrack];
  }

  const chordPoolTracks = harmonyTracks
    .slice()
    .sort((a, b) => b.noteCount - a.noteCount || a.avgPitch - b.avgPitch)
    .slice(0, Math.min(3, harmonyTracks.length));

  return {
    melodyTracks,
    harmonyTracks,
    chordPoolTracks,
    chord1Tracks: [],
    chord2Tracks: [],
  };
}

function mergeTrackNotes(tracks) {
  return tracks
    .flatMap((track) => track.notes)
    .slice()
    .sort((a, b) => a.ticks - b.ticks || a.midi - b.midi);
}

function computeNotesOverlapRatio(notes) {
  if (!notes || notes.length === 0) {
    return 0;
  }

  const sorted = notes
    .slice()
    .sort((a, b) => a.ticks - b.ticks || a.midi - b.midi);

  let overlapCount = 0;
  let activeEnd = -1;
  for (const note of sorted) {
    if (note.ticks < activeEnd) {
      overlapCount += 1;
    }
    activeEnd = Math.max(activeEnd, note.ticks + note.durationTicks);
  }

  return overlapCount / Math.max(1, sorted.length);
}

function buildMonophonicSequence(notes, stepTicks, targetEndTicks = 0) {
  const noteMaxEnd = notes && notes.length > 0
    ? notes.reduce((max, note) => Math.max(max, note.ticks + note.durationTicks), 0)
    : 0;
  const maxEnd = Math.max(noteMaxEnd, targetEndTicks || 0);
  const totalSteps = Math.max(1, Math.ceil(maxEnd / stepTicks));

  if (!notes || notes.length === 0) {
    return new Array(totalSteps).fill(null);
  }

  const sequence = new Array(totalSteps).fill(null);
  const sorted = notes
    .slice()
    .sort((a, b) => a.ticks - b.ticks || b.midi - a.midi || b.durationTicks - a.durationTicks);

  for (const note of sorted) {
    const start = clamp(Math.round(note.ticks / stepTicks), 0, totalSteps - 1);
    const endFromTicks = Math.round((note.ticks + note.durationTicks) / stepTicks);
    const end = clamp(Math.max(start + 1, endFromTicks), start + 1, totalSteps);

    for (let step = start; step < end; step += 1) {
      sequence[step] = note.midi;
    }
  }

  return sequence;
}

function buildMonophonicRunsFromNotes(notes, stepTicks, targetEndTicks = 0, keepTrailingRests = false) {
  const noteMaxEnd = notes && notes.length > 0
    ? notes.reduce((max, note) => Math.max(max, note.ticks + note.durationTicks), 0)
    : 0;
  const maxEnd = Math.max(noteMaxEnd, targetEndTicks || 0);
  const totalSteps = Math.max(1, Math.ceil(maxEnd / stepTicks));

  if (!notes || notes.length === 0) {
    return [{ value: null, start: 0, end: totalSteps, length: totalSteps }];
  }

  const sorted = notes
    .slice()
    .sort((a, b) => a.ticks - b.ticks || a.midi - b.midi || a.durationTicks - b.durationTicks);

  const runs = [];
  let cursor = 0;

  for (const note of sorted) {
    let start = clamp(Math.ceil(note.ticks / stepTicks), 0, totalSteps - 1);
    let end = clamp(Math.ceil((note.ticks + note.durationTicks) / stepTicks), start + 1, totalSteps);

    if (start < cursor) {
      start = cursor;
    }
    if (start >= totalSteps) {
      break;
    }
    if (end <= start) {
      end = Math.min(totalSteps, start + 1);
    }
    if (end <= start) {
      continue;
    }

    if (start > cursor) {
      runs.push({
        value: null,
        start: cursor,
        end: start,
        length: start - cursor,
      });
    }

    runs.push({
      value: note.midi,
      start,
      end,
      length: end - start,
    });
    cursor = end;
  }

  if (keepTrailingRests && cursor < totalSteps) {
    runs.push({
      value: null,
      start: cursor,
      end: totalSteps,
      length: totalSteps - cursor,
    });
  }

  if (runs.length === 0) {
    return [{ value: null, start: 0, end: totalSteps, length: totalSteps }];
  }

  return runs;
}

function buildStepSequence(notes, stepTicks, mode, targetEndTicks = 0) {
  const noteMaxEnd = notes && notes.length > 0
    ? notes.reduce((max, note) => Math.max(max, note.ticks + note.durationTicks), 0)
    : 0;
  const maxEnd = Math.max(noteMaxEnd, targetEndTicks || 0);
  const totalSteps = Math.max(1, Math.ceil(maxEnd / stepTicks));

  if (!notes || notes.length === 0) {
    return new Array(totalSteps).fill(null);
  }

  const buckets = Array.from({ length: totalSteps }, () => ({
    active: [],
    onsets: [],
  }));

  for (const note of notes) {
    const start = clamp(Math.floor(note.ticks / stepTicks), 0, totalSteps - 1);
    const endFromTicks = Math.ceil((note.ticks + note.durationTicks) / stepTicks);
    const end = clamp(Math.max(start + 1, endFromTicks), start + 1, totalSteps);

    buckets[start].onsets.push(note.midi);
    for (let step = start; step < end; step += 1) {
      buckets[step].active.push(note.midi);
    }
  }

  const sequence = new Array(totalSteps);
  let previousPitch = null;

  for (let i = 0; i < totalSteps; i += 1) {
    const bucket = buckets[i];
    if (bucket.active.length === 0) {
      sequence[i] = null;
      continue;
    }

    const activeSorted = Array.from(new Set(bucket.active)).sort((a, b) => a - b);
    const onsetSorted = Array.from(new Set(bucket.onsets)).sort((a, b) => a - b);
    const source = mode === "melody"
      ? (onsetSorted.length > 0 ? onsetSorted : activeSorted)
      : activeSorted;
    const activeSet = new Set(activeSorted);
    const hasOnset = onsetSorted.length > 0;

    if (mode === "melody") {
      if (!hasOnset && previousPitch !== null && activeSet.has(previousPitch)) {
        sequence[i] = previousPitch;
      } else {
        sequence[i] = source[source.length - 1];
      }
      previousPitch = sequence[i];
      continue;
    }

    if (mode === "chord2") {
      if (!hasOnset && previousPitch !== null && activeSet.has(previousPitch)) {
        sequence[i] = previousPitch;
      } else {
        sequence[i] = source[0];
      }
      previousPitch = sequence[i];
      continue;
    }

    let candidates = source;
    if (source.length >= 3) {
      candidates = source.slice(1);
    }

    if (!hasOnset && previousPitch !== null && candidates.includes(previousPitch)) {
      sequence[i] = previousPitch;
      continue;
    }

    if (previousPitch === null) {
      sequence[i] = candidates[candidates.length - 1];
      previousPitch = sequence[i];
      continue;
    }

    let bestPitch = candidates[0];
    let bestDistance = Math.abs(bestPitch - previousPitch);
    for (const pitch of candidates) {
      const distance = Math.abs(pitch - previousPitch);
      if (distance < bestDistance) {
        bestPitch = pitch;
        bestDistance = distance;
      }
    }

    sequence[i] = bestPitch;
    previousPitch = bestPitch;
  }

  return sequence;
}

function sequenceToRuns(sequence) {
  if (sequence.length === 0) {
    return [];
  }

  const runs = [];
  let current = sequence[0];
  let start = 0;

  for (let i = 1; i < sequence.length; i += 1) {
    if (sequence[i] !== current) {
      runs.push({
        value: current,
        start,
        end: i,
        length: i - start,
      });
      current = sequence[i];
      start = i;
    }
  }

  runs.push({
    value: current,
    start,
    end: sequence.length,
    length: sequence.length - start,
  });

  return runs;
}

function runsToSequence(runs, totalLength) {
  const sequence = new Array(totalLength).fill(null);
  for (const run of runs) {
    for (let i = run.start; i < run.end; i += 1) {
      sequence[i] = run.value;
    }
  }
  return sequence;
}

function simplifySequence(sequence, mode, level) {
  if (level <= 0 || sequence.length < 3) {
    return sequence.slice();
  }

  let working = sequence.slice();
  for (let pass = 0; pass < level; pass += 1) {
    const runs = sequenceToRuns(working);
    const nextRuns = runs.map((run) => ({ ...run }));
    const shortThreshold = mode === "melody" ? 1 + pass : 2 + pass;
    let changed = false;

    for (let i = 0; i < nextRuns.length; i += 1) {
      const run = nextRuns[i];
      if (run.length > shortThreshold) {
        continue;
      }

      const left = i > 0 ? nextRuns[i - 1].value : null;
      const right = i + 1 < nextRuns.length ? nextRuns[i + 1].value : null;
      const hasLeft = left !== null;
      const hasRight = right !== null;

      let replacement = run.value;
      if (run.value === null) {
        if (hasLeft && hasRight && left === right) {
          replacement = left;
        } else if (hasLeft && !hasRight) {
          replacement = left;
        } else if (!hasLeft && hasRight) {
          replacement = right;
        }
      } else if (hasLeft && hasRight) {
        replacement = Math.abs(left - run.value) <= Math.abs(right - run.value) ? left : right;
      } else if (hasLeft) {
        replacement = left;
      } else if (hasRight) {
        replacement = right;
      }

      if (replacement !== run.value) {
        run.value = replacement;
        changed = true;
      }
    }

    if (!changed) {
      break;
    }
    working = runsToSequence(nextRuns, working.length);
  }

  return working;
}

function normalizeRuns(runs, baseLength, keepTrailingRests = false) {
  const normalized = runs.map((run) => ({ ...run }));

  if (!keepTrailingRests) {
    while (normalized.length > 0 && normalized[normalized.length - 1].value === null) {
      normalized.pop();
    }
  }

  if (normalized.length === 0) {
    return [{ value: null, length: baseLength, start: 0, end: baseLength }];
  }

  return normalized;
}

function buildDurationChoices(baseLength) {
  const denominators = [1, 2, 4, 8, 16, 32, 64];
  const bySteps = new Map();

  for (const denominator of denominators) {
    const steps = baseLength / denominator;
    if (Number.isInteger(steps) && steps >= 1) {
      const suffix = denominator === baseLength ? "" : String(denominator);
      const current = bySteps.get(steps);
      if (!current || suffix.length < current.suffix.length) {
        bySteps.set(steps, { steps, suffix });
      }

      const dottedSteps = steps + steps / 2;
      if (Number.isInteger(dottedSteps)) {
        const dottedSuffix = `${denominator}.`;
        const currentDotted = bySteps.get(dottedSteps);
        if (!currentDotted || dottedSuffix.length < currentDotted.suffix.length) {
          bySteps.set(dottedSteps, { steps: dottedSteps, suffix: dottedSuffix });
        }
      }
    }
  }

  if (!bySteps.has(1)) {
    bySteps.set(1, { steps: 1, suffix: "" });
  }

  return Array.from(bySteps.values()).sort((a, b) => b.steps - a.steps);
}

function splitDuration(steps, choices) {
  const parts = [];
  let remaining = steps;

  while (remaining > 0) {
    const choice = choices.find((candidate) => candidate.steps <= remaining) || { steps: 1, suffix: "" };
    parts.push(choice);
    remaining -= choice.steps;
  }

  return parts;
}

function encodeRuns(runs, options) {
  const tokens = [];
  const tokenSteps = [];
  const baseLength = options.baseLength;
  const durationChoices = buildDurationChoices(baseLength);

  if (options.includeTempo) {
    tokens.push(`t${options.tempo}`);
    tokenSteps.push(0);
  }
  tokens.push(`v${options.volume}`);
  tokenSteps.push(0);

  const firstPitchRun = runs.find((run) => run.value !== null);
  let currentOctave = firstPitchRun ? midiToPitchInfo(firstPitchRun.value).octave : 4;
  currentOctave = clamp(currentOctave, 0, 9);
  tokens.push(`o${currentOctave}`);
  tokenSteps.push(0);
  tokens.push(`l${baseLength}`);
  tokenSteps.push(0);

  for (const run of runs) {
    const durationParts = splitDuration(run.length, durationChoices);

    if (run.value === null) {
      for (const part of durationParts) {
        tokens.push(`r${part.suffix}`);
        tokenSteps.push(part.steps);
      }
      continue;
    }

    const noteInfo = midiToPitchInfo(run.value);
    let shift = "";
    while (currentOctave < noteInfo.octave) {
      shift += ">";
      currentOctave += 1;
    }
    while (currentOctave > noteInfo.octave) {
      shift += "<";
      currentOctave -= 1;
    }

    const firstPart = durationParts[0];
    tokens.push(`${shift}${noteInfo.name}${firstPart.suffix}`);
    tokenSteps.push(firstPart.steps);
    for (let i = 1; i < durationParts.length; i += 1) {
      tokens.push(`&${noteInfo.name}${durationParts[i].suffix}`);
      tokenSteps.push(durationParts[i].steps);
    }
  }

  return {
    text: tokens.join(""),
    tokens,
    tokenSteps,
  };
}

function truncateByTokens(tokens, limit) {
  if (limit <= 0) {
    return "";
  }

  let out = "";
  for (const token of tokens) {
    if (out.length + token.length > limit) {
      break;
    }
    out += token;
  }

  return out;
}

function isNoteStartToken(token) {
  if (!token || typeof token !== "string") {
    return false;
  }

  const first = token[0];
  if (first === "&" || first === "r" || first === "t" || first === "v" || first === "o" || first === "l") {
    return false;
  }

  let index = 0;
  while (index < token.length && (token[index] === ">" || token[index] === "<")) {
    index += 1;
  }
  if (index >= token.length) {
    return false;
  }

  const ch = token[index].toLowerCase();
  return ch === "a" || ch === "b" || ch === "c" || ch === "d" || ch === "e" || ch === "f" || ch === "g";
}

function truncateTokensWithStats(tokens, tokenSteps, limit) {
  if (limit <= 0 || !Array.isArray(tokens) || tokens.length === 0) {
    return {
      text: "",
      noteEventCount: 0,
      tokenCount: 0,
      retainedSteps: 0,
      truncated: Array.isArray(tokens) && tokens.length > 0,
    };
  }

  let out = "";
  let noteEventCount = 0;
  let tokenCount = 0;
  let retainedSteps = 0;

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (out.length + token.length > limit) {
      break;
    }

    out += token;
    tokenCount += 1;
    const stepValue = Array.isArray(tokenSteps) ? tokenSteps[i] : 0;
    retainedSteps += Number.isFinite(stepValue) ? stepValue : 0;
    if (isNoteStartToken(token)) {
      noteEventCount += 1;
    }
  }

  return {
    text: out,
    noteEventCount,
    tokenCount,
    retainedSteps,
    truncated: tokenCount < tokens.length,
  };
}

function truncateTokensByMaxSteps(tokens, tokenSteps, maxSteps, charLimit = Number.MAX_SAFE_INTEGER) {
  if (!Array.isArray(tokens) || tokens.length === 0 || maxSteps <= 0 || charLimit <= 0) {
    return "";
  }

  let out = "";
  let usedSteps = 0;

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    const stepValue = Array.isArray(tokenSteps) && Number.isFinite(tokenSteps[i]) ? tokenSteps[i] : 0;

    if (stepValue > 0 && usedSteps + stepValue > maxSteps + 1e-9) {
      break;
    }
    if (out.length + token.length > charLimit) {
      break;
    }

    out += token;
    usedSteps += stepValue;
  }

  return out;
}

function averageVelocity(notes, fallback) {
  if (!notes || notes.length === 0) {
    return fallback;
  }
  const sum = notes.reduce((acc, note) => acc + (Number.isFinite(note.velocity) ? note.velocity : 0.7), 0);
  return sum / notes.length;
}

function mapVolume(velocityAverage) {
  return clamp(Math.round(8 + velocityAverage * 7), 6, 15);
}

function scorePitchMatch(referencePitch, candidatePitch) {
  if (referencePitch === null && candidatePitch === null) {
    return 0.35;
  }
  if (referencePitch === null || candidatePitch === null) {
    return -1.2;
  }

  const distance = Math.abs(referencePitch - candidatePitch);
  if (distance === 0) {
    return 2;
  }
  if (distance === 1) {
    return 1.45;
  }
  if (distance === 2) {
    return 1.05;
  }
  if (distance <= 4) {
    return 0.4;
  }
  if (distance <= 7) {
    return -0.25;
  }
  return -0.85;
}

function sampleSequenceAtTick(sequence, stepTicks, tick) {
  if (!sequence || sequence.length === 0) {
    return null;
  }
  const rawIndex = Math.floor(tick / stepTicks);
  if (rawIndex < 0) {
    return sequence[0];
  }
  if (rawIndex >= sequence.length) {
    return sequence[sequence.length - 1];
  }
  return sequence[rawIndex];
}

function evaluateSequenceFidelity(referenceSequence, referenceStepTicks, candidateSequence, candidateStepTicks) {
  if (!referenceSequence || referenceSequence.length === 0 || !candidateSequence || candidateSequence.length === 0) {
    return -Infinity;
  }

  let score = 0;
  let prevReference = null;
  let prevCandidate = null;

  for (let i = 0; i < referenceSequence.length; i += 1) {
    const tick = i * referenceStepTicks;
    const referencePitch = referenceSequence[i];
    const candidatePitch = sampleSequenceAtTick(candidateSequence, candidateStepTicks, tick);

    score += scorePitchMatch(referencePitch, candidatePitch);

    const referenceChanged = referencePitch !== prevReference;
    const candidateChanged = candidatePitch !== prevCandidate;
    if (referenceChanged === candidateChanged) {
      score += 0.15;
    }

    if (referenceChanged && candidateChanged && referencePitch !== null && candidatePitch !== null && prevReference !== null && prevCandidate !== null) {
      const referenceMove = referencePitch - prevReference;
      const candidateMove = candidatePitch - prevCandidate;
      const moveDistance = Math.abs(referenceMove - candidateMove);
      if (moveDistance === 0) {
        score += 0.2;
      } else if (moveDistance <= 2) {
        score += 0.08;
      } else if (moveDistance >= 7) {
        score -= 0.12;
      }
    }

    prevReference = referencePitch;
    prevCandidate = candidatePitch;
  }

  return score / referenceSequence.length;
}

function evaluateSequenceFidelityWithinTicks(referenceSequence, referenceStepTicks, candidateSequence, candidateStepTicks, maxTicks) {
  if (!referenceSequence || referenceSequence.length === 0 || !candidateSequence || candidateSequence.length === 0) {
    return -Infinity;
  }
  if (!Number.isFinite(maxTicks) || maxTicks <= 0) {
    return evaluateSequenceFidelity(referenceSequence, referenceStepTicks, candidateSequence, candidateStepTicks);
  }

  let score = 0;
  let count = 0;
  let prevReference = null;
  let prevCandidate = null;

  for (let i = 0; i < referenceSequence.length; i += 1) {
    const tick = i * referenceStepTicks;
    if (tick > maxTicks) {
      break;
    }

    const referencePitch = referenceSequence[i];
    const candidatePitch = sampleSequenceAtTick(candidateSequence, candidateStepTicks, tick);

    score += scorePitchMatch(referencePitch, candidatePitch);

    const referenceChanged = referencePitch !== prevReference;
    const candidateChanged = candidatePitch !== prevCandidate;
    if (referenceChanged === candidateChanged) {
      score += 0.15;
    }

    if (referenceChanged && candidateChanged && referencePitch !== null && candidatePitch !== null && prevReference !== null && prevCandidate !== null) {
      const referenceMove = referencePitch - prevReference;
      const candidateMove = candidatePitch - prevCandidate;
      const moveDistance = Math.abs(referenceMove - candidateMove);
      if (moveDistance === 0) {
        score += 0.2;
      } else if (moveDistance <= 2) {
        score += 0.08;
      } else if (moveDistance >= 7) {
        score -= 0.12;
      }
    }

    prevReference = referencePitch;
    prevCandidate = candidatePitch;
    count += 1;
  }

  if (count <= 0) {
    return evaluateSequenceFidelity(referenceSequence, referenceStepTicks, candidateSequence, candidateStepTicks);
  }
  return score / count;
}

function buildPartText(config) {
  const {
    notes,
    mode,
    limit,
    tempo,
    volume,
    includeTempo,
    ppq,
    compress,
    targetDurationTicks,
    returnMeta,
    strictPrefix,
  } = config;

  const safeLimit = Number.isFinite(limit) ? limit : Number.MAX_SAFE_INTEGER;
  const forcedEndTicks = Number.isFinite(targetDurationTicks) && targetDurationTicks > 0 ? targetDurationTicks : 0;
  const keepTrailingRests = forcedEndTicks > 0;
  const sourceNoteCount = Array.isArray(notes) ? notes.length : 0;
  const enforcePrefixTruncation = Boolean(strictPrefix);
  const overlapRatio = computeNotesOverlapRatio(notes);
  const preferMonophonicFlow = overlapRatio <= 0.35;

  const referenceStepsPerQuarter = 96;
  const referenceStepTicks = ppq / referenceStepsPerQuarter;
  const referenceSequence = preferMonophonicFlow
    ? buildMonophonicSequence(notes, referenceStepTicks, forcedEndTicks)
    : buildStepSequence(notes, referenceStepTicks, mode, forcedEndTicks);
  const sourceEndTicks = forcedEndTicks > 0 ? forcedEndTicks : getNotesEndTicks(notes);
  const frontPriorityTicks = Math.max(
    ppq * 64,
    Math.min(ppq * 192, Math.floor(sourceEndTicks * 0.35)),
  );

  const melodyCompressSteps = [128, 112, 96, 80, 64, 48, 40, 32, 24, 20, 16, 12, 10, 8];
  const harmonyCompressSteps = [128, 112, 96, 80, 64, 48, 40, 32, 24, 20, 16, 12, 10, 8, 6, 4, 3, 2, 1];
  const normalSteps = [128, 112, 96, 80, 64, 48, 40, 32, 24, 20, 16, 12, 10, 8, 6, 4];
  const compressStepsByMode = mode === "melody" ? melodyCompressSteps : harmonyCompressSteps;
  const stepCandidates = enforcePrefixTruncation
    ? compressStepsByMode
    : (compress ? compressStepsByMode : normalSteps);
  const simplifyLevelPasses = enforcePrefixTruncation
    ? [[0]]
    : (compress
      ? (preferMonophonicFlow ? [[0]] : [[0], [1, 2, 3]])
      : [[0]]);
  let bestWithinLimit = null;
  let lowPriorityWithin = null;
  let bestOverflow = null;

  for (let passIndex = 0; passIndex < simplifyLevelPasses.length; passIndex += 1) {
    const simplifyLevels = simplifyLevelPasses[passIndex];

    for (const stepsPerQuarter of stepCandidates) {
      const stepTicks = ppq / stepsPerQuarter;
      const baseLength = 4 * stepsPerQuarter;
      const baseSequence = preferMonophonicFlow
        ? buildMonophonicSequence(notes, stepTicks, forcedEndTicks)
        : buildStepSequence(notes, stepTicks, mode, forcedEndTicks);
      const hasPitch = baseSequence.some((pitch) => pitch !== null);
      if (!hasPitch && !keepTrailingRests) {
        continue;
      }

      for (const simplifyLevel of simplifyLevels) {
        let sequence = null;
        let runs = null;

        if (preferMonophonicFlow && simplifyLevel === 0) {
          runs = buildMonophonicRunsFromNotes(notes, stepTicks, forcedEndTicks, keepTrailingRests);
          sequence = runsToSequence(runs, Math.max(1, baseSequence.length));
        } else {
          sequence = simplifyLevel > 0 ? simplifySequence(baseSequence, mode, simplifyLevel) : baseSequence.slice();
          runs = normalizeRuns(sequenceToRuns(sequence), baseLength, keepTrailingRests);
        }

        const encoded = encodeRuns(runs, {
          tempo,
          volume,
          includeTempo,
          baseLength,
        });

        const fidelity = evaluateSequenceFidelity(referenceSequence, referenceStepTicks, sequence, stepTicks);
        const earlyFidelity = evaluateSequenceFidelityWithinTicks(
          referenceSequence,
          referenceStepTicks,
          sequence,
          stepTicks,
          frontPriorityTicks,
        );
        const detailBonus = Math.min(0.22, stepsPerQuarter / 700);
        const noteEventCount = runs.reduce((sum, run) => sum + (run.value === null ? 0 : 1), 0);
        const noteCoverage = sourceNoteCount > 0 ? noteEventCount / sourceNoteCount : 1;
        const candidate = {
          encoded,
          fidelity,
          earlyFidelity,
          simplifyLevel,
          stepsPerQuarter,
          noteEventCount,
        };

        const prefersDetailedWithin = compress && !enforcePrefixTruncation;
        const allowWithinCandidate = !prefersDetailedWithin || stepsPerQuarter >= 6;

        if (encoded.text.length <= safeLimit && allowWithinCandidate) {
          const fidelityScore = fidelity - simplifyLevel * 0.14 + detailBonus + noteCoverage * 0.03
            + earlyFidelity * (compress ? 0.35 : 0.12);
          const betterCandidate = enforcePrefixTruncation
            ? (
              !bestWithinLimit ||
              noteEventCount > bestWithinLimit.noteEventCount + 1e-9 ||
              (
                Math.abs(noteEventCount - bestWithinLimit.noteEventCount) <= 1e-9 &&
                (
                  fidelityScore > bestWithinLimit.score + 1e-9 ||
                  (
                    Math.abs(fidelityScore - bestWithinLimit.score) <= 1e-9 &&
                    encoded.text.length < bestWithinLimit.encoded.text.length
                  )
                )
              )
            )
            : (
              !bestWithinLimit ||
              fidelityScore > bestWithinLimit.score + 1e-9 ||
              (
                Math.abs(fidelityScore - bestWithinLimit.score) <= 1e-9 &&
                (stepsPerQuarter > bestWithinLimit.stepsPerQuarter ||
                  (stepsPerQuarter === bestWithinLimit.stepsPerQuarter && encoded.text.length < bestWithinLimit.encoded.text.length))
              )
            );
          if (betterCandidate) {
            bestWithinLimit = {
              ...candidate,
              score: fidelityScore,
            };
          }
        } else if (encoded.text.length <= safeLimit) {
          const fallbackScore = fidelity - simplifyLevel * 0.14 + detailBonus + noteCoverage * 0.03
            + earlyFidelity * (compress ? 0.35 : 0.12);
          const betterFallback = !lowPriorityWithin
            || fallbackScore > lowPriorityWithin.score + 1e-9
            || (
              Math.abs(fallbackScore - lowPriorityWithin.score) <= 1e-9
              && stepsPerQuarter > lowPriorityWithin.stepsPerQuarter
            );
          if (betterFallback) {
            lowPriorityWithin = {
              ...candidate,
              score: fallbackScore,
            };
          }
        } else {
          const overflowRatio = (encoded.text.length - safeLimit) / Math.max(1, safeLimit);
          const overflowScore = fidelity - overflowRatio * 3 - simplifyLevel * 0.16 + detailBonus * 0.4 + noteCoverage * 0.05
            + earlyFidelity * (compress ? 0.55 : 0.18);
          const overflowTruncation = enforcePrefixTruncation
            ? truncateTokensWithStats(encoded.tokens, encoded.tokenSteps, safeLimit)
            : null;
          const overflowRetainedEndTicks = overflowTruncation ? overflowTruncation.retainedSteps * stepTicks : 0;
          const projectedNotes = noteEventCount * Math.min(1, safeLimit / Math.max(1, encoded.text.length));
          const betterCandidate = enforcePrefixTruncation
            ? (
              !bestOverflow ||
              overflowRetainedEndTicks > bestOverflow.retainedEndTicks + 1e-9 ||
              (
                Math.abs(overflowRetainedEndTicks - bestOverflow.retainedEndTicks) <= 1e-9 &&
                (
                  overflowTruncation.noteEventCount > bestOverflow.retainedNoteEventCount + 1e-9 ||
                  (
                    Math.abs(overflowTruncation.noteEventCount - bestOverflow.retainedNoteEventCount) <= 1e-9 &&
                    (
                      overflowScore > bestOverflow.score + 1e-9 ||
                      (
                        Math.abs(overflowScore - bestOverflow.score) <= 1e-9 &&
                        encoded.text.length < bestOverflow.encoded.text.length
                      )
                    )
                  )
                )
              )
            )
            : (
              !bestOverflow ||
              projectedNotes > bestOverflow.projectedNotes + 0.5 ||
              (
                Math.abs(projectedNotes - bestOverflow.projectedNotes) <= 0.5 &&
                noteEventCount > bestOverflow.noteEventCount + 1
              ) ||
              overflowScore > bestOverflow.score + 1e-9 ||
              (Math.abs(overflowScore - bestOverflow.score) <= 1e-9 && encoded.text.length < bestOverflow.encoded.text.length)
            );
          if (betterCandidate) {
            bestOverflow = {
              ...candidate,
              projectedNotes,
              score: overflowScore,
              retainedEndTicks: overflowRetainedEndTicks,
              retainedNoteEventCount: overflowTruncation ? overflowTruncation.noteEventCount : 0,
            };
          }
        }
      }
    }

    if (bestWithinLimit) {
      if (returnMeta) {
        const retainedSteps = (bestWithinLimit.encoded.tokenSteps || [])
          .reduce((sum, value) => sum + (Number.isFinite(value) ? value : 0), 0);
        return {
          text: bestWithinLimit.encoded.text,
          noteEventCount: bestWithinLimit.noteEventCount,
          retainedEndTicks: retainedSteps * (ppq / bestWithinLimit.stepsPerQuarter),
          truncated: false,
          tokens: (bestWithinLimit.encoded.tokens || []).slice(),
          tokenSteps: (bestWithinLimit.encoded.tokenSteps || []).slice(),
          stepTicks: ppq / bestWithinLimit.stepsPerQuarter,
        };
      }
      return bestWithinLimit.encoded.text;
    }
  }

  if (lowPriorityWithin) {
    if (returnMeta) {
      const retainedSteps = (lowPriorityWithin.encoded.tokenSteps || [])
        .reduce((sum, value) => sum + (Number.isFinite(value) ? value : 0), 0);
      return {
        text: lowPriorityWithin.encoded.text,
        noteEventCount: lowPriorityWithin.noteEventCount,
        retainedEndTicks: retainedSteps * (ppq / lowPriorityWithin.stepsPerQuarter),
        truncated: false,
        tokens: (lowPriorityWithin.encoded.tokens || []).slice(),
        tokenSteps: (lowPriorityWithin.encoded.tokenSteps || []).slice(),
        stepTicks: ppq / lowPriorityWithin.stepsPerQuarter,
      };
    }
    return lowPriorityWithin.encoded.text;
  }

  if (!bestOverflow) {
    const fallback = `${includeTempo ? `t${tempo}` : ""}v${volume}o4l4r1`;
    const text = fallback.slice(0, safeLimit);
    if (returnMeta) {
      return {
        text,
        noteEventCount: 0,
        retainedEndTicks: 0,
        truncated: false,
        tokens: [],
        tokenSteps: [],
        stepTicks: 0,
      };
    }
    return text;
  }

  const overflowTruncation = truncateTokensWithStats(
    bestOverflow.encoded.tokens,
    bestOverflow.encoded.tokenSteps,
    safeLimit,
  );
  const overflowText = overflowTruncation.text;
  if (returnMeta) {
    return {
      text: overflowText,
      noteEventCount: overflowTruncation.noteEventCount,
      retainedEndTicks: overflowTruncation.retainedSteps * (ppq / bestOverflow.stepsPerQuarter),
      truncated: overflowTruncation.truncated,
      tokens: (bestOverflow.encoded.tokens || []).slice(),
      tokenSteps: (bestOverflow.encoded.tokenSteps || []).slice(),
      stepTicks: ppq / bestOverflow.stepsPerQuarter,
    };
  }

  return overflowText;
}

function alignPartsToTruncationCutoff(partMetaMap, limits) {
  const safeMap = partMetaMap || {};
  const truncatedCutoffs = Object.values(safeMap)
    .filter((meta) => meta && meta.truncated)
    .map((meta) => meta.retainedEndTicks)
    .filter((tick) => Number.isFinite(tick) && tick > 0);

  if (truncatedCutoffs.length === 0) {
    return {
      melody: safeMap.melody && safeMap.melody.text ? safeMap.melody.text : "",
      chord1: safeMap.chord1 && safeMap.chord1.text ? safeMap.chord1.text : "",
      chord2: safeMap.chord2 && safeMap.chord2.text ? safeMap.chord2.text : "",
    };
  }

  const cutoffTicks = Math.max(1, Math.floor(Math.min(...truncatedCutoffs)));

  const clipByCutoff = (meta, limit) => {
    if (!meta || !Array.isArray(meta.tokens) || !Array.isArray(meta.tokenSteps) || !Number.isFinite(meta.stepTicks) || meta.stepTicks <= 0) {
      return meta && typeof meta.text === "string" ? meta.text : "";
    }

    const maxSteps = Math.max(1, Math.floor(cutoffTicks / meta.stepTicks));
    const clipped = truncateTokensByMaxSteps(meta.tokens, meta.tokenSteps, maxSteps, limit);
    return clipped && clipped.length > 0 ? clipped : (meta.text || "");
  };

  return {
    melody: clipByCutoff(safeMap.melody, limits.melody),
    chord1: clipByCutoff(safeMap.chord1, limits.chord1),
    chord2: clipByCutoff(safeMap.chord2, limits.chord2),
  };
}

function renderScore(parts) {
  return [
    `主音Melody: ${parts.melody.length}`,
    parts.melody,
    `和弦Chord1: ${parts.chord1.length}`,
    parts.chord1,
    `和弦Chord2: ${parts.chord2.length}`,
    parts.chord2,
  ].join("\n");
}

function getNotesEndTicks(notes) {
  if (!notes || notes.length === 0) {
    return 0;
  }
  return notes.reduce((max, note) => Math.max(max, note.ticks + note.durationTicks), 0);
}

function sliceNotesByRange(notes, startTicks, endTicks) {
  if (!notes || notes.length === 0 || endTicks <= startTicks) {
    return [];
  }

  return notes
    .map((note) => {
      const noteStart = note.ticks;
      const noteEnd = note.ticks + note.durationTicks;
      if (noteEnd <= startTicks || noteStart >= endTicks) {
        return null;
      }

      const clippedStart = Math.max(noteStart, startTicks);
      const clippedEnd = Math.min(noteEnd, endTicks);
      return {
        ...note,
        ticks: clippedStart - startTicks,
        durationTicks: Math.max(1, clippedEnd - clippedStart),
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.ticks - b.ticks || a.midi - b.midi);
}

function countActiveNotesAtTick(notes, tick) {
  let active = 0;
  for (const note of notes) {
    if (note.ticks < tick && note.ticks + note.durationTicks > tick) {
      active += 1;
    }
  }
  return active;
}

function countBoundaryNotesAtTick(notes, tick) {
  let boundaries = 0;
  for (const note of notes) {
    const start = Math.round(note.ticks);
    const end = Math.round(note.ticks + note.durationTicks);
    if (Math.abs(start - tick) <= 1 || Math.abs(end - tick) <= 1) {
      boundaries += 1;
    }
  }
  return boundaries;
}

function chooseSplitBoundary(targetTick, minTick, maxTick, notes, ppq) {
  if (maxTick <= minTick) {
    return minTick;
  }

  const clampedTarget = clamp(Math.round(targetTick), minTick, maxTick);
  const adaptiveWindow = Math.floor((maxTick - minTick) / 4);
  const window = clamp(adaptiveWindow, ppq, ppq * 4);
  const searchMin = Math.max(minTick, clampedTarget - window);
  const searchMax = Math.min(maxTick, clampedTarget + window);
  const barTicks = Math.max(1, ppq * 4);

  const candidates = new Set([clampedTarget, searchMin, searchMax, minTick, maxTick]);
  const lowerBar = Math.floor(clampedTarget / barTicks) * barTicks;
  const upperBar = Math.ceil(clampedTarget / barTicks) * barTicks;
  if (lowerBar >= searchMin && lowerBar <= searchMax) {
    candidates.add(lowerBar);
  }
  if (upperBar >= searchMin && upperBar <= searchMax) {
    candidates.add(upperBar);
  }

  for (const note of notes) {
    const start = Math.round(note.ticks);
    const end = Math.round(note.ticks + note.durationTicks);
    if (start >= searchMin && start <= searchMax) {
      candidates.add(start);
    }
    if (end >= searchMin && end <= searchMax) {
      candidates.add(end);
    }
  }

  let bestTick = clampedTarget;
  let bestScore = -Infinity;

  for (const rawTick of candidates) {
    const tick = clamp(Math.round(rawTick), minTick, maxTick);
    const active = countActiveNotesAtTick(notes, tick);
    const boundaries = countBoundaryNotesAtTick(notes, tick);
    const distance = Math.abs(tick - clampedTarget);
    const distancePenalty = distance / Math.max(1, barTicks);
    const barBonus = tick % barTicks === 0 ? 0.45 : 0;
    const score = boundaries * 0.08 - active * 2 - distancePenalty * 1.8 + barBonus;

    if (score > bestScore || (Math.abs(score - bestScore) <= 1e-9 && distance < Math.abs(bestTick - clampedTarget))) {
      bestScore = score;
      bestTick = tick;
    }
  }

  return bestTick;
}

function buildComplexityProfile(totalTicks, notes, ppq) {
  if (!notes || notes.length === 0) {
    return null;
  }

  const safeTotal = Math.max(1, Math.ceil(totalTicks));
  const sliceTicks = Math.max(1, Math.round(ppq / 8));
  const bucketCount = Math.max(1, Math.ceil(safeTotal / sliceTicks));

  const baseWeight = 1;
  const onsetWeight = 4;
  const releaseWeight = 1.8;
  const sustainWeight = 0.2;

  const onset = new Array(bucketCount).fill(0);
  const release = new Array(bucketCount).fill(0);
  const sustainDiff = new Array(bucketCount + 1).fill(0);

  for (const note of notes) {
    const start = clamp(Math.floor(note.ticks / sliceTicks), 0, bucketCount - 1);
    const endTick = Math.max(note.ticks, note.ticks + note.durationTicks - 1);
    const end = clamp(Math.floor(endTick / sliceTicks), start, bucketCount - 1);

    onset[start] += 1;
    release[end] += 1;
    sustainDiff[start] += 1;
    if (end + 1 < sustainDiff.length) {
      sustainDiff[end + 1] -= 1;
    }
  }

  const weights = new Array(bucketCount).fill(baseWeight);
  let sustain = 0;
  for (let i = 0; i < bucketCount; i += 1) {
    sustain += sustainDiff[i];
    weights[i] += onset[i] * onsetWeight + release[i] * releaseWeight + sustain * sustainWeight;
  }

  const prefix = new Array(bucketCount + 1).fill(0);
  for (let i = 0; i < bucketCount; i += 1) {
    prefix[i + 1] = prefix[i] + weights[i];
  }

  return {
    sliceTicks,
    weights,
    prefix,
    totalWeight: prefix[prefix.length - 1],
  };
}

function resolveTickByComplexity(profile, targetWeight, totalTicks) {
  if (!profile || !Number.isFinite(profile.totalWeight) || profile.totalWeight <= 0) {
    return clamp(Math.round(targetWeight), 0, totalTicks);
  }

  const clampedTarget = clamp(targetWeight, 0, profile.totalWeight);
  let bucket = profile.weights.length - 1;

  for (let i = 0; i < profile.weights.length; i += 1) {
    if (profile.prefix[i + 1] >= clampedTarget) {
      bucket = i;
      break;
    }
  }

  const weightInBucket = Math.max(1e-9, profile.weights[bucket]);
  const before = profile.prefix[bucket];
  const ratio = clamp((clampedTarget - before) / weightInBucket, 0, 1);
  const tick = Math.round((bucket + ratio) * profile.sliceTicks);
  return clamp(tick, 0, totalTicks);
}

function splitTickRanges(totalTicks, count, notes, ppq) {
  const safeTotal = Math.max(1, Math.ceil(totalTicks));
  if (count <= 1) {
    return [{ start: 0, end: safeTotal }];
  }

  const ranges = [];
  const boundaries = [0];
  let previous = 0;
  const minSegment = Math.max(1, Math.floor(safeTotal / (count * 4)));
  const complexityProfile = buildComplexityProfile(safeTotal, notes, ppq);

  for (let i = 1; i < count; i += 1) {
    const targetByTime = Math.round((safeTotal * i) / count);
    const targetByComplexity = complexityProfile
      ? resolveTickByComplexity(complexityProfile, (complexityProfile.totalWeight * i) / count, safeTotal)
      : targetByTime;
    const target = Math.round((targetByTime + targetByComplexity) / 2);
    const remainingSegments = count - i;
    const minTick = Math.max(previous + minSegment, i);
    const maxTick = Math.max(minTick, safeTotal - remainingSegments * minSegment);
    const boundary = chooseSplitBoundary(target, minTick, maxTick, notes, ppq);
    boundaries.push(boundary);
    previous = boundary;
  }

  boundaries.push(safeTotal);

  for (let i = 0; i < count; i += 1) {
    const start = boundaries[i];
    const end = boundaries[i + 1];
    ranges.push({ start, end: Math.max(start + 1, end) });
  }

  ranges[ranges.length - 1].end = safeTotal;
  return ranges;
}

function sortNotesByTime(notes) {
  return (notes || []).slice().sort((a, b) => a.ticks - b.ticks || a.midi - b.midi || a.durationTicks - b.durationTicks);
}

function mergeUniqueNotes(baseNotes, extraNotes) {
  const out = [];
  const seen = new Set();
  const append = (note) => {
    if (!note) {
      return;
    }
    const key = `${Math.round(note.ticks)}|${Math.round(note.durationTicks)}|${Math.round(note.midi)}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    out.push({ ...note });
  };

  for (const note of baseNotes || []) {
    append(note);
  }
  for (const note of extraNotes || []) {
    append(note);
  }

  return sortNotesByTime(out);
}

function normalizeSameMidiOverlaps(notes) {
  const byMidi = new Map();
  for (const note of notes || []) {
    const midi = Math.round(note.midi);
    if (!byMidi.has(midi)) {
      byMidi.set(midi, []);
    }
    byMidi.get(midi).push({ ...note, midi });
  }

  const normalized = [];
  for (const list of byMidi.values()) {
    list.sort((a, b) => a.ticks - b.ticks || a.durationTicks - b.durationTicks);
    const kept = [];

    for (const current of list) {
      if (kept.length === 0) {
        kept.push(current);
        continue;
      }

      const previous = kept[kept.length - 1];
      const previousEnd = previous.ticks + previous.durationTicks;
      if (current.ticks < previousEnd) {
        const trimmedLength = current.ticks - previous.ticks;
        if (trimmedLength >= 1) {
          previous.durationTicks = trimmedLength;
        } else if (current.durationTicks > previous.durationTicks) {
          kept[kept.length - 1] = current;
        }
        continue;
      }

      kept.push(current);
    }

    normalized.push(...kept);
  }

  return sortNotesByTime(normalized);
}

function pitchQuantile(notes, ratio) {
  if (!notes || notes.length === 0) {
    return null;
  }
  const sorted = notes
    .map((note) => note.midi)
    .filter((midi) => Number.isFinite(midi))
    .sort((a, b) => a - b);
  if (sorted.length === 0) {
    return null;
  }

  const clampedRatio = clamp(ratio, 0, 1);
  const index = clamp(Math.floor((sorted.length - 1) * clampedRatio), 0, sorted.length - 1);
  return sorted[index];
}

function rebalanceHighNotes(melodyNotes, chord1Notes, chord2Notes) {
  const melody = sortNotesByTime(melodyNotes || []);
  const chord1 = sortNotesByTime(chord1Notes || []);
  const chord2 = sortNotesByTime(chord2Notes || []);
  const allNotes = melody.concat(chord1, chord2);

  if (allNotes.length < 24 || chord2.length === 0) {
    return {
      melody,
      chord1,
      chord2,
    };
  }

  const highThreshold = pitchQuantile(allNotes, 0.95);
  const accentThreshold = pitchQuantile(allNotes, 0.985);
  if (!Number.isFinite(highThreshold)) {
    return {
      melody,
      chord1,
      chord2,
    };
  }

  const promoteFromChord2 = chord2.filter((note) => note.midi >= highThreshold);
  const reducedChord2 = chord2.filter((note) => note.midi < highThreshold);
  const boostedChord1 = mergeUniqueNotes(chord1, promoteFromChord2);

  if (!Number.isFinite(accentThreshold)) {
    return {
      melody,
      chord1: boostedChord1,
      chord2: reducedChord2,
    };
  }

  const melodyAccents = boostedChord1.filter((note) => note.midi >= accentThreshold);
  return {
    melody: normalizeSameMidiOverlaps(mergeUniqueNotes(melody, melodyAccents)),
    chord1: normalizeSameMidiOverlaps(boostedChord1),
    chord2: normalizeSameMidiOverlaps(reducedChord2),
  };
}

function buildScoreParts(config) {
  const {
    melodyNotes,
    chordPoolNotes,
    chord1Notes,
    chord2Notes,
    tempo,
    ppq,
    compress,
    targetDurationTicks,
    strictPrefixTruncation,
  } = config;

  const chord1Source = chord1Notes && chord1Notes.length > 0 ? chord1Notes : chordPoolNotes;
  const chord2Source = chord2Notes && chord2Notes.length > 0 ? chord2Notes : chordPoolNotes;
  const rebalanced = rebalanceHighNotes(melodyNotes, chord1Source, chord2Source);
  const melodySource = rebalanced.melody;
  const chord1Balanced = rebalanced.chord1;
  const chord2Balanced = rebalanced.chord2;

  const melodyVolume = mapVolume(averageVelocity(melodySource, 0.7));
  const chordVolume = mapVolume(averageVelocity(chord1Balanced, 0.65));
  const bassVolume = clamp(chordVolume + 1, 6, 15);
  const shouldUseCompressCutoff = Boolean(compress);
  const effectiveStrictPrefix = Boolean(strictPrefixTruncation);

  if (!shouldUseCompressCutoff) {
    const melody = buildPartText({
      notes: melodySource,
      mode: "melody",
      limit: LIMITS.melody,
      tempo,
      volume: melodyVolume,
      includeTempo: true,
      ppq,
      compress,
      targetDurationTicks,
      strictPrefix: strictPrefixTruncation,
    });

    const chord1 = buildPartText({
      notes: chord1Balanced,
      mode: "chord1",
      limit: LIMITS.chord1,
      tempo,
      volume: chordVolume,
      includeTempo: true,
      ppq,
      compress,
      targetDurationTicks,
      strictPrefix: strictPrefixTruncation,
    });

    const chord2 = buildPartText({
      notes: chord2Balanced,
      mode: "chord2",
      limit: LIMITS.chord2,
      tempo,
      volume: bassVolume,
      includeTempo: true,
      ppq,
      compress,
      targetDurationTicks,
      strictPrefix: strictPrefixTruncation,
    });

    return {
      melody,
      chord1,
      chord2,
    };
  }

  const melodyMeta = buildPartText({
    notes: melodySource,
    mode: "melody",
    limit: LIMITS.melody,
    tempo,
    volume: melodyVolume,
    includeTempo: true,
    ppq,
    compress,
    targetDurationTicks,
    strictPrefix: effectiveStrictPrefix,
    returnMeta: true,
  });

  const chord1Meta = buildPartText({
    notes: chord1Balanced,
    mode: "chord1",
    limit: LIMITS.chord1,
    tempo,
    volume: chordVolume,
    includeTempo: true,
    ppq,
    compress,
    targetDurationTicks,
    strictPrefix: effectiveStrictPrefix,
    returnMeta: true,
  });

  const chord2Meta = buildPartText({
    notes: chord2Balanced,
    mode: "chord2",
    limit: LIMITS.chord2,
    tempo,
    volume: bassVolume,
    includeTempo: true,
    ppq,
    compress,
    targetDurationTicks,
    strictPrefix: effectiveStrictPrefix,
    returnMeta: true,
  });

  const aligned = alignPartsToTruncationCutoff({
    melody: melodyMeta,
    chord1: chord1Meta,
    chord2: chord2Meta,
  }, LIMITS);

  return {
    melody: aligned.melody || melodyMeta.text,
    chord1: aligned.chord1 || chord1Meta.text,
    chord2: aligned.chord2 || chord2Meta.text,
  };
}

function renderEnsembleScores(scoreList, ranges, metadata) {
  const splitMode = metadata.splitMode || "sequential";
  const bpmPart = Number.isFinite(metadata.bpm) ? ` bpm=${Math.round(metadata.bpm)}` : "";
  const head = `#META totalTicks=${metadata.totalTicks} ppq=${metadata.ppq} players=${scoreList.length} split=${splitMode}${bpmPart}`;
  const bodies = scoreList
    .map((parts, index) => {
      const range = ranges[index] || { start: 0, end: 0 };
      const segmentTicks = Math.max(0, range.end - range.start);
      return [
        `合奏${index + 1}`,
        `段長Ticks: ${segmentTicks}`,
        renderScore(parts),
        `MML@${parts.melody},${parts.chord1},${parts.chord2};`,
      ].join("\n");
    })
    .join("\n\n");

  return `${head}\n\n${bodies}`;
}

function computeMaxSimultaneousNotes(notes) {
  if (!notes || notes.length === 0) {
    return 0;
  }

  const events = [];
  for (const note of notes) {
    const start = Math.max(0, Math.round(note.ticks));
    const end = Math.max(start + 1, Math.round(note.ticks + note.durationTicks));
    events.push({ tick: start, delta: 1 });
    events.push({ tick: end, delta: -1 });
  }

  events.sort((a, b) => a.tick - b.tick || a.delta - b.delta);

  let active = 0;
  let maxActive = 0;
  for (const event of events) {
    active += event.delta;
    if (active > maxActive) {
      maxActive = active;
    }
  }

  return maxActive;
}

function allocateVoicesWithinBand(voices, players) {
  const safePlayers = Math.max(1, players);
  const buckets = Array.from({ length: safePlayers }, () => ({
    notes: [],
    weight: 0,
  }));

  if (!voices || voices.length === 0) {
    return buckets.map((bucket) => bucket.notes);
  }

  const ordered = voices
    .slice()
    .sort((a, b) => b.noteCount - a.noteCount || b.maxEndTicks - a.maxEndTicks || b.avgPitch - a.avgPitch);

  for (const voice of ordered) {
    let bestIndex = 0;
    for (let i = 1; i < buckets.length; i += 1) {
      if (buckets[i].weight < buckets[bestIndex].weight - 1e-9) {
        bestIndex = i;
      }
    }

    const target = buckets[bestIndex];
    target.notes.push(...voice.notes.map((note) => ({ ...note })));
    const spanWeight = Math.max(1, Math.round((voice.maxEndTicks || 0) / 960));
    target.weight += voice.noteCount * 1.2 + spanWeight * 0.4;
  }

  return buckets.map((bucket) =>
    bucket.notes.slice().sort((a, b) => a.ticks - b.ticks || a.midi - b.midi),
  );
}

function distributeVoicesAcrossEnsemble(voices, players, options = {}) {
  const safePlayers = Math.max(1, players);
  const emptyByPlayer = () => Array.from({ length: safePlayers }, () => []);
  if (!voices || voices.length === 0) {
    return {
      melodyByPlayer: emptyByPlayer(),
      chord1ByPlayer: emptyByPlayer(),
      chord2ByPlayer: emptyByPlayer(),
    };
  }

  const sortedVoices = voices
    .slice()
    .sort((a, b) => b.avgPitch - a.avgPitch || b.noteCount - a.noteCount || b.maxEndTicks - a.maxEndTicks);

  const hasFullVoiceGrid = sortedVoices.length >= safePlayers * 3;
  if (hasFullVoiceGrid) {
    const melodyVoices = sortedVoices.slice(0, safePlayers);
    const remainingVoices = sortedVoices.slice(safePlayers);

    const evaluationContext = {
      tempo: Number.isFinite(options.tempo) ? options.tempo : 120,
      ppq: Number.isFinite(options.ppq) ? options.ppq : 480,
      compress: options.compress !== false,
      targetDurationTicks: Number.isFinite(options.targetDurationTicks) ? options.targetDurationTicks : 0,
    };

    const evaluated = remainingVoices.map((voice, index) => {
      const chord1Meta = buildPartText({
        notes: voice.notes,
        mode: "chord1",
        limit: LIMITS.chord1,
        tempo: evaluationContext.tempo,
        volume: 12,
        includeTempo: false,
        ppq: evaluationContext.ppq,
        compress: evaluationContext.compress,
        targetDurationTicks: evaluationContext.targetDurationTicks,
        returnMeta: true,
      });

      const chord2Meta = buildPartText({
        notes: voice.notes,
        mode: "chord2",
        limit: LIMITS.chord2,
        tempo: evaluationContext.tempo,
        volume: 12,
        includeTempo: false,
        ppq: evaluationContext.ppq,
        compress: evaluationContext.compress,
        targetDurationTicks: evaluationContext.targetDurationTicks,
        returnMeta: true,
      });

      const chord1Loss = Math.max(0, voice.noteCount - Math.max(0, chord1Meta.noteEventCount || 0));
      const chord2Loss = Math.max(0, voice.noteCount - Math.max(0, chord2Meta.noteEventCount || 0));

      const pitchRank = remainingVoices.length <= 1
        ? 0
        : 1 - index / (remainingVoices.length - 1);
      const lossBenefit = chord2Loss - chord1Loss;
      const assignmentScore = lossBenefit * 200 + pitchRank * 4;

      return {
        id: index,
        voice,
        chord1Loss,
        chord2Loss,
        assignmentScore,
      };
    });

    const chosenChord1 = evaluated
      .slice()
      .sort((a, b) => b.assignmentScore - a.assignmentScore || b.voice.avgPitch - a.voice.avgPitch)
      .slice(0, safePlayers);

    const chosenSet = new Set(chosenChord1.map((item) => item.id));
    let chord2Candidates = evaluated.filter((item) => !chosenSet.has(item.id));
    if (chord2Candidates.length < safePlayers) {
      const needed = safePlayers - chord2Candidates.length;
      const supplement = chosenChord1
        .slice()
        .sort((a, b) => a.assignmentScore - b.assignmentScore || a.voice.avgPitch - b.voice.avgPitch)
        .slice(0, needed);
      for (const item of supplement) {
        chord2Candidates.push(item);
      }
    }

    const chord1Voices = chosenChord1
      .slice()
      .sort((a, b) => b.voice.avgPitch - a.voice.avgPitch || b.voice.noteCount - a.voice.noteCount)
      .map((item) => item.voice);
    const chord2Voices = chord2Candidates
      .slice(0, safePlayers)
      .sort((a, b) => b.voice.avgPitch - a.voice.avgPitch || b.voice.noteCount - a.voice.noteCount)
      .map((item) => item.voice);

    return {
      melodyByPlayer: allocateVoicesWithinBand(melodyVoices, safePlayers),
      chord1ByPlayer: allocateVoicesWithinBand(chord1Voices, safePlayers),
      chord2ByPlayer: allocateVoicesWithinBand(chord2Voices, safePlayers),
    };
  }

  const bands = [[], [], []];
  for (let i = 0; i < sortedVoices.length; i += 1) {
    const bandIndex = Math.min(2, Math.floor((i * 3) / sortedVoices.length));
    bands[bandIndex].push(sortedVoices[i]);
  }

  // Ensure all three parts keep material, even on very sparse input.
  for (let bandIndex = 0; bandIndex < 3; bandIndex += 1) {
    if (bands[bandIndex].length > 0) {
      continue;
    }

    const donorIndex = bands.findIndex((band) => band.length > 1);
    if (donorIndex === -1) {
      continue;
    }
    bands[bandIndex].push(bands[donorIndex].pop());
  }

  return {
    melodyByPlayer: allocateVoicesWithinBand(bands[0], safePlayers),
    chord1ByPlayer: allocateVoicesWithinBand(bands[1], safePlayers),
    chord2ByPlayer: allocateVoicesWithinBand(bands[2], safePlayers),
  };
}

function distributeNotesAcrossPlayers(notes, players) {
  const safePlayers = Math.max(1, players);
  if (!notes || notes.length === 0) {
    return Array.from({ length: safePlayers }, () => []);
  }
  if (safePlayers === 1) {
    return [notes.slice().sort((a, b) => a.ticks - b.ticks || a.midi - b.midi)];
  }

  const buckets = Array.from({ length: safePlayers }, () => ({
    notes: [],
    lastEnd: -1,
    lastMidi: null,
  }));

  const sorted = notes
    .slice()
    .sort((a, b) => a.ticks - b.ticks || a.midi - b.midi || a.durationTicks - b.durationTicks);

  for (const note of sorted) {
    let bestBucket = 0;
    let bestScore = Number.POSITIVE_INFINITY;

    for (let i = 0; i < buckets.length; i += 1) {
      const bucket = buckets[i];
      const overlapTicks = Math.max(0, bucket.lastEnd - note.ticks);
      const overlapPenalty = overlapTicks > 0 ? 500 + overlapTicks * 2 : 0;
      const pitchPenalty = bucket.lastMidi === null ? 0 : Math.abs(note.midi - bucket.lastMidi) * 0.8;
      const densityPenalty = bucket.notes.length * 0.012;
      const score = overlapPenalty + pitchPenalty + densityPenalty;

      if (score < bestScore - 1e-9 || (Math.abs(score - bestScore) <= 1e-9 && i < bestBucket)) {
        bestScore = score;
        bestBucket = i;
      }
    }

    const selected = buckets[bestBucket];
    selected.notes.push({ ...note });
    selected.lastEnd = Math.max(selected.lastEnd, note.ticks + note.durationTicks);
    selected.lastMidi = note.midi;
  }

  return buckets.map((bucket) => bucket.notes.sort((a, b) => a.ticks - b.ticks || a.midi - b.midi));
}

function summarizeVoiceNotes(notes, index = 0) {
  const sorted = (notes || [])
    .slice()
    .sort((a, b) => a.ticks - b.ticks || a.midi - b.midi || a.durationTicks - b.durationTicks);

  if (sorted.length === 0) {
    return {
      index,
      notes: [],
      noteCount: 0,
      avgPitch: 0,
      avgVelocity: 0.7,
      overlapRatio: 0,
      maxEndTicks: 0,
      isPercussion: false,
    };
  }

  let pitchSum = 0;
  let velocitySum = 0;
  let overlapCount = 0;
  let activeEnd = -1;
  let maxEndTicks = 0;

  for (const note of sorted) {
    const end = note.ticks + note.durationTicks;
    if (note.ticks < activeEnd) {
      overlapCount += 1;
    }
    activeEnd = Math.max(activeEnd, end);
    maxEndTicks = Math.max(maxEndTicks, end);
    pitchSum += note.midi;
    velocitySum += note.velocity || 0.7;
  }

  return {
    index,
    notes: sorted,
    noteCount: sorted.length,
    avgPitch: pitchSum / sorted.length,
    avgVelocity: velocitySum / sorted.length,
    overlapRatio: overlapCount / Math.max(1, sorted.length),
    maxEndTicks,
    isPercussion: false,
  };
}

function distributePooledNotesAcrossEnsemble(notes, players, options = {}) {
  const safePlayers = Math.max(1, players);
  const emptyByPlayer = () => Array.from({ length: safePlayers }, () => []);
  if (!notes || notes.length === 0) {
    return {
      melodyByPlayer: emptyByPlayer(),
      chord1ByPlayer: emptyByPlayer(),
      chord2ByPlayer: emptyByPlayer(),
    };
  }

  const slotCount = Math.max(3, safePlayers * 3);
  const slotNotes = distributeNotesAcrossPlayers(notes, slotCount);
  const voices = slotNotes
    .map((slot, index) => summarizeVoiceNotes(slot, index))
    .filter((voice) => voice.noteCount > 0)
    .sort((a, b) => b.avgPitch - a.avgPitch || b.noteCount - a.noteCount || b.maxEndTicks - a.maxEndTicks);

  if (voices.length === 0) {
    return {
      melodyByPlayer: emptyByPlayer(),
      chord1ByPlayer: emptyByPlayer(),
      chord2ByPlayer: emptyByPlayer(),
    };
  }

  const shouldUseSmartDistribution = Boolean(options.compress);
  if (shouldUseSmartDistribution) {
    const distributed = distributeVoicesAcrossEnsemble(voices, safePlayers, {
      tempo: Number.isFinite(options.tempo) ? options.tempo : 120,
      ppq: Number.isFinite(options.ppq) ? options.ppq : 480,
      compress: options.compress !== false,
      targetDurationTicks: Number.isFinite(options.targetDurationTicks) ? options.targetDurationTicks : 0,
    });
    const hasDistributedMaterial = [distributed.melodyByPlayer, distributed.chord1ByPlayer, distributed.chord2ByPlayer]
      .every((group) => Array.isArray(group) && group.some((notesByPlayer) => Array.isArray(notesByPlayer) && notesByPlayer.length > 0));
    if (hasDistributedMaterial) {
      return distributed;
    }
  }

  const bands = [[], [], []];
  for (let i = 0; i < voices.length; i += 1) {
    const bandIndex = Math.min(2, Math.floor((i * 3) / voices.length));
    bands[bandIndex].push(voices[i]);
  }

  return {
    melodyByPlayer: allocateVoicesWithinBand(bands[0], safePlayers),
    chord1ByPlayer: allocateVoicesWithinBand(bands[1], safePlayers),
    chord2ByPlayer: allocateVoicesWithinBand(bands[2], safePlayers),
  };
}

function convertMidiToScore(midiPath, options = {}) {
  const compress = Boolean(options.compress);
  const players = Math.max(1, Number.parseInt(options.players || 1, 10) || 1);
  const splitMode = options.splitMode === "sequential" ? "sequential" : "parallel";

  const buffer = fs.readFileSync(midiPath);
  const midi = new Midi(buffer);

  const ppq = midi.header.ppq || 480;
  const forcedBpm = Number.isFinite(options.bpm) ? clamp(Math.round(options.bpm), 30, 300) : null;
  const tempo = forcedBpm || estimateTempo(midi);
  const trackStats = collectTrackStats(midi);
  if (trackStats.length === 0) {
    throw new Error("MIDI 檔案沒有可用的音符資料。");
  }

  const nonPercussionTracks = trackStats.filter((track) => !track.isPercussion);
  const usableTracks = nonPercussionTracks.length > 0 ? nonPercussionTracks : trackStats;

  if (players > 1 && splitMode === "parallel") {
    const pooledNotes = mergeTrackNotes(usableTracks);
    const pooledTotalTicks = Math.max(getNotesEndTicks(pooledNotes), 1);
    const {
      melodyByPlayer,
      chord1ByPlayer,
      chord2ByPlayer,
    } = distributePooledNotesAcrossEnsemble(pooledNotes, players, {
      tempo,
      ppq,
      compress,
      targetDurationTicks: pooledTotalTicks,
    });

    const scoreList = Array.from({ length: players }, (_, index) => {
      const segmentMelody = melodyByPlayer[index] || [];
      const segmentChord1 = chord1ByPlayer[index] || [];
      const segmentChord2 = chord2ByPlayer[index] || [];
      return buildScoreParts({
        melodyNotes: segmentMelody,
        chordPoolNotes: segmentChord1.concat(segmentChord2),
        chord1Notes: segmentChord1,
        chord2Notes: segmentChord2,
        tempo,
        ppq,
        compress,
        targetDurationTicks: 0,
      });
    });

    const ranges = Array.from({ length: players }, () => ({ start: 0, end: pooledTotalTicks }));
    return renderEnsembleScores(scoreList, ranges, {
      totalTicks: pooledTotalTicks,
      ppq,
      splitMode: "parallel",
      bpm: tempo,
    });
  }

  const {
    melodyTracks,
    chordPoolTracks,
    chord1Tracks,
    chord2Tracks,
  } = pickTrackGroups(trackStats);
  const melodyNotes = mergeTrackNotes(melodyTracks);
  const chordPoolNotes = mergeTrackNotes(chordPoolTracks);
  const chord1Notes = chord1Tracks && chord1Tracks.length > 0 ? mergeTrackNotes(chord1Tracks) : chordPoolNotes;
  const chord2Notes = chord2Tracks && chord2Tracks.length > 0 ? mergeTrackNotes(chord2Tracks) : chordPoolNotes;
  const totalTicks = Math.max(
    getNotesEndTicks(melodyNotes),
    getNotesEndTicks(chord1Notes),
    getNotesEndTicks(chord2Notes),
    1,
  );

  if (players <= 1) {
    const singleScore = buildScoreParts({
      melodyNotes,
      chordPoolNotes,
      chord1Notes,
      chord2Notes,
      tempo,
      ppq,
      compress,
      strictPrefixTruncation: true,
    });
    return [
      `#META totalTicks=${totalTicks} ppq=${ppq} players=1 split=single bpm=${tempo}`,
      renderScore(singleScore),
    ].join("\n");
  }

  const splitReferenceNotes = melodyNotes.concat(chord1Notes, chord2Notes);
  const ranges = splitTickRanges(totalTicks, players, splitReferenceNotes, ppq);
  const scoreList = ranges.map((range) => {
    const segmentMelody = sliceNotesByRange(melodyNotes, range.start, range.end);
    const segmentChords = sliceNotesByRange(chordPoolNotes, range.start, range.end);
    const segmentChord1 = sliceNotesByRange(chord1Notes, range.start, range.end);
    const segmentChord2 = sliceNotesByRange(chord2Notes, range.start, range.end);
    const segmentDurationTicks = Math.max(1, range.end - range.start);
    return buildScoreParts({
      melodyNotes: segmentMelody,
      chordPoolNotes: segmentChords,
      chord1Notes: segmentChord1,
      chord2Notes: segmentChord2,
      tempo,
      ppq,
      compress,
      targetDurationTicks: segmentDurationTicks,
    });
  });

  return renderEnsembleScores(scoreList, ranges, {
    totalTicks,
    ppq,
    splitMode: "sequential",
    bpm: tempo,
  });
}

async function main() {
  let parsed;
  try {
    parsed = parseArgs(process.argv);
  } catch (error) {
    console.error(error.message);
    printHelp();
    process.exitCode = 1;
    return;
  }

  if (parsed.help || !parsed.input) {
    printHelp();
    return;
  }

  const inputPath = path.resolve(parsed.input);
  if (!fs.existsSync(inputPath)) {
    console.error(`找不到檔案: ${inputPath}`);
    process.exitCode = 1;
    return;
  }

  let workingInputPath = inputPath;
  let tempMidiPath = null;

  try {
    if (isAudioInput(inputPath)) {
      tempMidiPath = path.join(os.tmpdir(), `midtochord-${Date.now()}-${process.pid}.mid`);
      const { transcribeAudioToMidi } = require("./audio-to-midi.js");
      await transcribeAudioToMidi(inputPath, tempMidiPath, {
        onsetThreshold: 0.25,
        frameThreshold: 0.25,
        minNoteLength: 5,
        melodiaTrick: true,
        tempo: parsed.bpm || 120,
        engine: "auto",
      });
      workingInputPath = tempMidiPath;
    } else if (isMusicXmlInput(inputPath)) {
      tempMidiPath = path.join(os.tmpdir(), `midtochord-${Date.now()}-${process.pid}.mid`);
      const { convertMxlToMidi } = require("./mxl-to-mid.js");
      convertMxlToMidi(inputPath, tempMidiPath, {
        tempo: parsed.bpm || 120,
      });
      workingInputPath = tempMidiPath;
    }
  } catch (error) {
    const conversionLabel = isAudioInput(inputPath)
      ? "音訊轉 MIDI"
      : (isMusicXmlInput(inputPath) ? "MusicXML/MXL 轉 MIDI" : "前置轉換");
    console.error(`${conversionLabel} 失敗: ${error.message}`);
    process.exitCode = 1;
    return;
  }

  let score;
  try {
    score = convertMidiToScore(workingInputPath, {
      compress: parsed.compress,
      players: parsed.players,
      splitMode: parsed.splitMode,
      bpm: parsed.bpm,
    });
  } catch (error) {
    console.error(`轉換失敗: ${error.message}`);
    process.exitCode = 1;
    return;
  } finally {
    if (tempMidiPath && fs.existsSync(tempMidiPath)) {
      try {
        fs.unlinkSync(tempMidiPath);
      } catch (cleanupError) {
        // Ignore temp cleanup failures.
      }
    }
  }

  const resultPath = path.resolve("Result.md");
  fs.writeFileSync(resultPath, score, "utf8");

  if (parsed.output) {
    const outputPath = path.resolve(parsed.output);
    const actualPlayers = readPlayersFromMeta(score);
    if (outputPath !== resultPath) {
      fs.writeFileSync(outputPath, score, "utf8");
      if (actualPlayers) {
        console.log(`完成: ${resultPath} (players=${actualPlayers})`);
        console.log(`完成: ${outputPath} (players=${actualPlayers})`);
      } else {
        console.log(`完成: ${resultPath}`);
        console.log(`完成: ${outputPath}`);
      }
      return;
    }
    if (actualPlayers) {
      console.log(`完成: ${resultPath} (players=${actualPlayers})`);
    } else {
      console.log(`完成: ${resultPath}`);
    }
    return;
  }

  console.log(score);
  console.log(`\n已寫入: ${resultPath}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`轉換失敗: ${error.message}`);
    process.exitCode = 1;
  });
}
