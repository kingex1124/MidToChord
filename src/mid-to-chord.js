#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { Midi } = require("@tonejs/midi");

const LIMITS = {
  melody: 1200,
  chord1: 800,
  chord2: 500,
};

const NOTE_NAMES = ["c", "c+", "d", "d+", "e", "f", "f+", "g", "g+", "a", "a+", "b"];

function parseArgs(argv) {
  const args = argv.slice(2);
  const parsed = {
    input: null,
    output: null,
    compress: false,
    players: 1,
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

    if (arg === "--players" || arg === "-p") {
      const rawPlayers = args[i + 1];
      const players = Number.parseInt(rawPlayers || "", 10);
      if (!Number.isInteger(players) || players < 1) {
        throw new Error(`Invalid players value: ${rawPlayers}`);
      }
      parsed.players = players;
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

function printHelp() {
  console.log(
    [
      "Usage:",
      "  node src/mid-to-chord.js <input.mid> [output.md]",
      "  node src/mid-to-chord.js -i <input.mid> -o <output.md> [-c] [-p <players>]",
      "",
      "Options:",
      "  -c, --compress     Enable adaptive compression to fit limits before truncating",
      "  -p, --players N    Split into N ensemble sheets",
      "",
      "Character limits:",
      "  Melody: 1200",
      "  Chord1: 800",
      "  Chord2: 500",
    ].join("\n"),
  );
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

function pickTrackGroups(trackStats) {
  if (trackStats.length === 0) {
    return {
      melodyTracks: [],
      harmonyTracks: [],
      chordPoolTracks: [],
    };
  }

  const nonPercussion = trackStats.filter((track) => !track.isPercussion);
  const usable = nonPercussion.length > 0 ? nonPercussion : trackStats;

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
  };
}

function mergeTrackNotes(tracks) {
  return tracks
    .flatMap((track) => track.notes)
    .slice()
    .sort((a, b) => a.ticks - b.ticks || a.midi - b.midi);
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
    const source = onsetSorted.length > 0 ? onsetSorted : activeSorted;
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
  const baseLength = options.baseLength;
  const durationChoices = buildDurationChoices(baseLength);

  if (options.includeTempo) {
    tokens.push(`t${options.tempo}`);
  }
  tokens.push(`v${options.volume}`);

  const firstPitchRun = runs.find((run) => run.value !== null);
  let currentOctave = firstPitchRun ? midiToPitchInfo(firstPitchRun.value).octave : 4;
  currentOctave = clamp(currentOctave, 0, 9);
  tokens.push(`o${currentOctave}`);
  tokens.push(`l${baseLength}`);

  for (const run of runs) {
    const durationParts = splitDuration(run.length, durationChoices);

    if (run.value === null) {
      for (const part of durationParts) {
        tokens.push(`r${part.suffix}`);
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
    for (let i = 1; i < durationParts.length; i += 1) {
      tokens.push(`&${noteInfo.name}${durationParts[i].suffix}`);
    }
  }

  return {
    text: tokens.join(""),
    tokens,
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

  if (out.length === 0 && tokens.length > 0) {
    return tokens[0].slice(0, limit);
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
  } = config;

  const safeLimit = Number.isFinite(limit) ? limit : Number.MAX_SAFE_INTEGER;
  const forcedEndTicks = Number.isFinite(targetDurationTicks) && targetDurationTicks > 0 ? targetDurationTicks : 0;
  const keepTrailingRests = forcedEndTicks > 0;

  const referenceStepsPerQuarter = mode === "melody" ? 24 : 12;
  const referenceStepTicks = Math.max(1, Math.round(ppq / referenceStepsPerQuarter));
  const referenceSequence = buildStepSequence(notes, referenceStepTicks, mode, forcedEndTicks);

  const stepCandidates = compress
    ? mode === "melody"
      ? [32, 24, 20, 16, 12, 10, 8, 6, 4, 3, 2, 1]
      : [24, 20, 16, 12, 10, 8, 6, 4, 3, 2, 1]
    : [mode === "melody" ? 8 : 4];
  const simplifyLevelPasses = compress ? [[0], [1, 2, 3]] : [[0]];
  let bestWithinLimit = null;
  let bestOverflow = null;

  for (let passIndex = 0; passIndex < simplifyLevelPasses.length; passIndex += 1) {
    const simplifyLevels = simplifyLevelPasses[passIndex];

    for (const stepsPerQuarter of stepCandidates) {
      const stepTicks = Math.max(1, Math.round(ppq / stepsPerQuarter));
      const baseLength = 4 * stepsPerQuarter;
      const baseSequence = buildStepSequence(notes, stepTicks, mode, forcedEndTicks);
      const hasPitch = baseSequence.some((pitch) => pitch !== null);

      if (!hasPitch && !keepTrailingRests) {
        continue;
      }

      for (const simplifyLevel of simplifyLevels) {
        const sequence = simplifyLevel > 0 ? simplifySequence(baseSequence, mode, simplifyLevel) : baseSequence.slice();
        const runs = normalizeRuns(sequenceToRuns(sequence), baseLength, keepTrailingRests);
        const encoded = encodeRuns(runs, {
          tempo,
          volume,
          includeTempo,
          baseLength,
        });

        const fidelity = evaluateSequenceFidelity(referenceSequence, referenceStepTicks, sequence, stepTicks);
        const candidate = {
          encoded,
          fidelity,
          simplifyLevel,
          stepsPerQuarter,
        };

        if (encoded.text.length <= safeLimit) {
          const fidelityScore = fidelity - simplifyLevel * 0.14;
          if (
            !bestWithinLimit ||
            fidelityScore > bestWithinLimit.score + 1e-9 ||
            (Math.abs(fidelityScore - bestWithinLimit.score) <= 1e-9 && encoded.text.length < bestWithinLimit.encoded.text.length)
          ) {
            bestWithinLimit = {
              ...candidate,
              score: fidelityScore,
            };
          }
        } else {
          const overflowRatio = (encoded.text.length - safeLimit) / Math.max(1, safeLimit);
          const overflowScore = fidelity - overflowRatio * 3 - simplifyLevel * 0.16;
          if (
            !bestOverflow ||
            overflowScore > bestOverflow.score + 1e-9 ||
            (Math.abs(overflowScore - bestOverflow.score) <= 1e-9 && encoded.text.length < bestOverflow.encoded.text.length)
          ) {
            bestOverflow = {
              ...candidate,
              score: overflowScore,
            };
          }
        }
      }
    }

    if (bestWithinLimit) {
      return bestWithinLimit.encoded.text;
    }
  }

  if (!bestOverflow) {
    const fallback = `${includeTempo ? `t${tempo}` : ""}v${volume}o4l4r1`;
    return fallback.slice(0, safeLimit);
  }

  return truncateByTokens(bestOverflow.encoded.tokens, safeLimit);
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

function splitTickRanges(totalTicks, count, notes, ppq) {
  const safeTotal = Math.max(1, Math.ceil(totalTicks));
  if (count <= 1) {
    return [{ start: 0, end: safeTotal }];
  }

  const ranges = [];
  const boundaries = [0];
  let previous = 0;
  const minSegment = Math.max(1, Math.floor(safeTotal / (count * 4)));

  for (let i = 1; i < count; i += 1) {
    const target = Math.round((safeTotal * i) / count);
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

function buildScoreParts(config) {
  const {
    melodyNotes,
    chordPoolNotes,
    tempo,
    ppq,
    compress,
    targetDurationTicks,
  } = config;

  const melodyVolume = mapVolume(averageVelocity(melodyNotes, 0.7));
  const chordVolume = mapVolume(averageVelocity(chordPoolNotes, 0.65));
  const bassVolume = clamp(chordVolume + 1, 6, 15);

  const melody = buildPartText({
    notes: melodyNotes,
    mode: "melody",
    limit: LIMITS.melody,
    tempo,
    volume: melodyVolume,
    includeTempo: true,
    ppq,
    compress,
    targetDurationTicks,
  });

  const chord1 = buildPartText({
    notes: chordPoolNotes,
    mode: "chord1",
    limit: LIMITS.chord1,
    tempo,
    volume: chordVolume,
    includeTempo: false,
    ppq,
    compress,
    targetDurationTicks,
  });

  const chord2 = buildPartText({
    notes: chordPoolNotes,
    mode: "chord2",
    limit: LIMITS.chord2,
    tempo,
    volume: bassVolume,
    includeTempo: false,
    ppq,
    compress,
    targetDurationTicks,
  });

  return {
    melody,
    chord1,
    chord2,
  };
}

function renderEnsembleScores(scoreList, ranges, metadata) {
  const head = `#META totalTicks=${metadata.totalTicks} ppq=${metadata.ppq} players=${scoreList.length}`;
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

function convertMidiToScore(midiPath, options = {}) {
  const compress = Boolean(options.compress);
  const players = Math.max(1, Number.parseInt(options.players || 1, 10) || 1);

  const buffer = fs.readFileSync(midiPath);
  const midi = new Midi(buffer);

  const ppq = midi.header.ppq || 480;
  const tempo = estimateTempo(midi);
  const trackStats = collectTrackStats(midi);
  if (trackStats.length === 0) {
    throw new Error("MIDI 檔案沒有可用的音符資料。");
  }

  const { melodyTracks, chordPoolTracks } = pickTrackGroups(trackStats);
  const melodyNotes = mergeTrackNotes(melodyTracks);
  const chordPoolNotes = mergeTrackNotes(chordPoolTracks);
  const totalTicks = Math.max(getNotesEndTicks(melodyNotes), getNotesEndTicks(chordPoolNotes), 1);

  if (players <= 1) {
    const singleScore = buildScoreParts({
      melodyNotes,
      chordPoolNotes,
      tempo,
      ppq,
      compress,
    });
    return [
      `#META totalTicks=${totalTicks} ppq=${ppq} players=1`,
      renderScore(singleScore),
    ].join("\n");
  }

  const splitReferenceNotes = melodyNotes.concat(chordPoolNotes);
  const ranges = splitTickRanges(totalTicks, players, splitReferenceNotes, ppq);
  const scoreList = ranges.map((range) => {
    const segmentMelody = sliceNotesByRange(melodyNotes, range.start, range.end);
    const segmentChords = sliceNotesByRange(chordPoolNotes, range.start, range.end);
    const segmentDurationTicks = Math.max(1, range.end - range.start);
    return buildScoreParts({
      melodyNotes: segmentMelody,
      chordPoolNotes: segmentChords,
      tempo,
      ppq,
      compress,
      targetDurationTicks: segmentDurationTicks,
    });
  });

  return renderEnsembleScores(scoreList, ranges, {
    totalTicks,
    ppq,
  });
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

  let score;
  try {
    score = convertMidiToScore(inputPath, {
      compress: parsed.compress,
      players: parsed.players,
    });
  } catch (error) {
    console.error(`轉換失敗: ${error.message}`);
    process.exitCode = 1;
    return;
  }

  const resultPath = path.resolve("Result.md");
  fs.writeFileSync(resultPath, score, "utf8");

  if (parsed.output) {
    const outputPath = path.resolve(parsed.output);
    if (outputPath !== resultPath) {
      fs.writeFileSync(outputPath, score, "utf8");
      console.log(`完成: ${resultPath}`);
      console.log(`完成: ${outputPath}`);
      return;
    }
    console.log(`完成: ${resultPath}`);
    return;
  }

  console.log(score);
  console.log(`\n已寫入: ${resultPath}`);
}

if (require.main === module) {
  main();
}
