#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");
const { Midi } = require("@tonejs/midi");
const { AudioContext } = require("web-audio-api");

const TARGET_SAMPLE_RATE = 22050;
const AUTOCORR_SAMPLE_RATE = 8000;
const MODEL_CDN_URL = "https://unpkg.com/@spotify/basic-pitch@1.0.1/model/model.json";
let TF_BACKEND = "tfjs";
let HAS_TFJS_NODE = null;
let BASIC_PITCH_API = null;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function parseNumberOption(raw, fallback) {
  const value = Number.parseFloat(raw);
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return value;
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const parsed = {
    input: null,
    output: null,
    onsetThreshold: 0.25,
    frameThreshold: 0.25,
    minNoteLength: 5,
    melodiaTrick: true,
    tempo: 120,
    engine: "auto",
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

    if (arg === "--onset") {
      parsed.onsetThreshold = parseNumberOption(args[i + 1], parsed.onsetThreshold);
      i += 1;
      continue;
    }

    if (arg === "--frame") {
      parsed.frameThreshold = parseNumberOption(args[i + 1], parsed.frameThreshold);
      i += 1;
      continue;
    }

    if (arg === "--min-note-length") {
      const minLength = Number.parseInt(args[i + 1] || "", 10);
      if (Number.isInteger(minLength) && minLength > 0) {
        parsed.minNoteLength = minLength;
      }
      i += 1;
      continue;
    }

    if (arg === "--tempo") {
      const tempo = Number.parseInt(args[i + 1] || "", 10);
      if (Number.isInteger(tempo) && tempo > 0) {
        parsed.tempo = tempo;
      }
      i += 1;
      continue;
    }

    if (arg === "--no-melodia") {
      parsed.melodiaTrick = false;
      continue;
    }

    if (arg === "--engine") {
      const engine = (args[i + 1] || "").toLowerCase();
      if (["auto", "basic-pitch", "autocorr"].includes(engine)) {
        parsed.engine = engine;
      } else {
        throw new Error(`Invalid engine: ${args[i + 1]}`);
      }
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

  if (!parsed.input && !parsed.help) {
    throw new Error("Missing input audio file.");
  }

  if (!parsed.output && parsed.input) {
    parsed.output = `${parsed.input}.mid`;
  }

  return parsed;
}

function printHelp() {
  console.log(
    [
      "Usage:",
      "  node src/audio-to-midi.js -i <input.mp3> -o <output.mid>",
      "",
      "Options:",
      "  --onset <number>            Onset threshold (default: 0.25)",
      "  --frame <number>            Frame threshold (default: 0.25)",
      "  --min-note-length <int>     Minimum note length in frames (default: 5)",
      "  --tempo <int>               Tempo for output MIDI (default: 120)",
      "  --engine <auto|basic-pitch|autocorr>  Transcription engine (default: auto)",
      "  --no-melodia                Disable melodia trick",
    ].join("\n"),
  );
}

async function decodeAudioFile(filePath) {
  const audioData = fs.readFileSync(filePath);
  const audioCtx = new AudioContext();

  return new Promise((resolve, reject) => {
    audioCtx.decodeAudioData(
      audioData,
      (audioBuffer) => resolve(audioBuffer),
      (error) => reject(error || new Error("Audio decode failed")),
    );
  });
}

function audioBufferToMono(audioBuffer) {
  const channels = audioBuffer.numberOfChannels || 1;
  const length = audioBuffer.length;
  const mono = new Float32Array(length);

  for (let ch = 0; ch < channels; ch += 1) {
    const channelData = audioBuffer.getChannelData(ch);
    for (let i = 0; i < length; i += 1) {
      mono[i] += channelData[i] / channels;
    }
  }

  return mono;
}

function resampleLinear(input, srcRate, dstRate) {
  if (!input || input.length === 0) {
    return new Float32Array(0);
  }
  if (srcRate === dstRate) {
    return input;
  }

  const outLength = Math.max(1, Math.round((input.length * dstRate) / srcRate));
  const output = new Float32Array(outLength);
  const ratio = srcRate / dstRate;

  for (let i = 0; i < outLength; i += 1) {
    const pos = i * ratio;
    const left = Math.floor(pos);
    const right = Math.min(input.length - 1, left + 1);
    const mix = pos - left;
    output[i] = input[left] * (1 - mix) + input[right] * mix;
  }

  return output;
}

function buildMidiFromNotes(notes, bpm) {
  const midi = new Midi();
  const track = midi.addTrack();
  track.name = "Transcribed";
  const normalizedBpm = clamp(Math.round(bpm || 120), 20, 400);
  const ppq = midi.header.ppq || 480;
  const ticksPerSecond = (normalizedBpm / 60) * ppq;

  for (const note of notes) {
    const startSeconds = Number(note.startTimeSeconds);
    const durationSeconds = Number(note.durationSeconds);
    const pitchRaw = Number(note.pitchMidi);
    const amplitude = Number(note.amplitude);
    if (!Number.isFinite(startSeconds) || !Number.isFinite(durationSeconds) || !Number.isFinite(pitchRaw)) {
      continue;
    }

    const ticks = Math.max(0, Math.round(startSeconds * ticksPerSecond));
    const durationTicks = Math.max(1, Math.round(Math.max(0.01, durationSeconds) * ticksPerSecond));
    const midiPitch = clamp(Math.round(pitchRaw), 0, 127);
    const velocity = clamp(Number.isFinite(amplitude) ? amplitude : 0.7, 0.05, 1);
    track.addNote({
      midi: midiPitch,
      ticks,
      durationTicks,
      velocity,
    });
  }

  midi.header.tempos = [{ ticks: 0, bpm: normalizedBpm }];
  return Buffer.from(midi.toArray());
}

function hasTfjsNodeBackend() {
  if (HAS_TFJS_NODE !== null) {
    return HAS_TFJS_NODE;
  }

  try {
    require("@tensorflow/tfjs-node");
    HAS_TFJS_NODE = true;
    TF_BACKEND = "tfjs-node";
  } catch (_error) {
    HAS_TFJS_NODE = false;
    TF_BACKEND = "tfjs";
  }

  return HAS_TFJS_NODE;
}

function refreshBackendLabel() {
  if (hasTfjsNodeBackend()) {
    TF_BACKEND = "tfjs-node";
  } else {
    TF_BACKEND = "tfjs";
  }
}

function getBasicPitchApi() {
  if (!BASIC_PITCH_API) {
    BASIC_PITCH_API = require("@spotify/basic-pitch");
  }
  return BASIC_PITCH_API;
}

function midiFromFrequency(freq) {
  if (!Number.isFinite(freq) || freq <= 0) {
    return null;
  }
  const midi = Math.round(69 + 12 * Math.log2(freq / 440));
  return clamp(midi, 0, 127);
}

function averageRms(samples, start, length) {
  let sum = 0;
  let count = 0;
  const end = Math.min(samples.length, start + length);
  for (let i = start; i < end; i += 1) {
    const v = samples[i];
    sum += v * v;
    count += 1;
  }
  if (count === 0) {
    return 0;
  }
  return Math.sqrt(sum / count);
}

function estimateFrequencyAmdf(samples, start, frameSize, sampleRate, minFreq, maxFreq) {
  const frameEnd = Math.min(samples.length, start + frameSize);
  const available = frameEnd - start;
  if (available < frameSize) {
    return { freq: null, confidence: 0 };
  }

  let mean = 0;
  for (let i = 0; i < frameSize; i += 1) {
    mean += samples[start + i];
  }
  mean /= frameSize;

  const minLag = Math.max(2, Math.floor(sampleRate / maxFreq));
  const maxLag = Math.min(frameSize - 2, Math.floor(sampleRate / minFreq));
  let bestLag = -1;
  let bestScore = Number.POSITIVE_INFINITY;

  for (let lag = minLag; lag <= maxLag; lag += 1) {
    let diff = 0;
    const limit = frameSize - lag;
    for (let i = 0; i < limit; i += 1) {
      const a = samples[start + i] - mean;
      const b = samples[start + i + lag] - mean;
      diff += Math.abs(a - b);
    }

    const normalized = diff / limit;
    if (normalized < bestScore) {
      bestScore = normalized;
      bestLag = lag;
    }
  }

  if (bestLag < 0) {
    return { freq: null, confidence: 0 };
  }

  const freq = sampleRate / bestLag;
  const confidence = 1 / (1 + bestScore * 12);
  return { freq, confidence };
}

function bridgeSingleFrameGaps(midiFrames) {
  if (midiFrames.length < 3) {
    return midiFrames;
  }

  const bridged = midiFrames.slice();
  for (let i = 1; i < bridged.length - 1; i += 1) {
    if (bridged[i] === null && bridged[i - 1] !== null && bridged[i - 1] === bridged[i + 1]) {
      bridged[i] = bridged[i - 1];
    }
  }
  return bridged;
}

function noteFramesToMonophonicNotes(midiFrames, rmsFrames, hopSize, sampleRate) {
  const bridged = bridgeSingleFrameGaps(midiFrames);
  const notes = [];
  const minFrames = Math.max(1, Math.round((0.06 * sampleRate) / hopSize));

  let currentMidi = null;
  let runStart = 0;
  let rmsSum = 0;
  let rmsCount = 0;

  const flush = (endIndex) => {
    if (currentMidi === null) {
      return;
    }
    const runFrames = endIndex - runStart;
    if (runFrames < minFrames) {
      return;
    }

    const velocityBase = rmsCount > 0 ? rmsSum / rmsCount : 0.2;
    const velocity = clamp(velocityBase * 4, 0.1, 1);
    notes.push({
      pitchMidi: currentMidi,
      startTimeSeconds: (runStart * hopSize) / sampleRate,
      durationSeconds: (runFrames * hopSize) / sampleRate,
      amplitude: velocity,
    });
  };

  for (let i = 0; i < bridged.length; i += 1) {
    const midi = bridged[i];
    const rms = rmsFrames[i] || 0;

    if (currentMidi === null) {
      if (midi !== null) {
        currentMidi = midi;
        runStart = i;
        rmsSum = rms;
        rmsCount = 1;
      }
      continue;
    }

    if (midi === currentMidi || (midi !== null && Math.abs(midi - currentMidi) <= 1)) {
      rmsSum += rms;
      rmsCount += 1;
      continue;
    }

    flush(i);

    if (midi !== null) {
      currentMidi = midi;
      runStart = i;
      rmsSum = rms;
      rmsCount = 1;
    } else {
      currentMidi = null;
      rmsSum = 0;
      rmsCount = 0;
    }
  }

  flush(bridged.length);
  return notes;
}

function transcribeByAutocorr(samples, sampleRate) {
  const frameSize = 512;
  const hopSize = 256;
  const minFreq = 55;
  const maxFreq = 1760;
  const rmsSilence = 0.01;
  const confidenceGate = 0.4;

  const frameCount = Math.max(0, Math.floor((samples.length - frameSize) / hopSize) + 1);
  const midiFrames = new Array(frameCount).fill(null);
  const rmsFrames = new Array(frameCount).fill(0);

  for (let frame = 0; frame < frameCount; frame += 1) {
    const start = frame * hopSize;
    const rms = averageRms(samples, start, frameSize);
    rmsFrames[frame] = rms;

    if (rms < rmsSilence) {
      continue;
    }

    const { freq, confidence } = estimateFrequencyAmdf(
      samples,
      start,
      frameSize,
      sampleRate,
      minFreq,
      maxFreq,
    );

    if (!freq || confidence < confidenceGate) {
      continue;
    }

    midiFrames[frame] = midiFromFrequency(freq);
  }

  return noteFramesToMonophonicNotes(midiFrames, rmsFrames, hopSize, sampleRate);
}

async function createBasicPitch() {
  const { BasicPitch } = getBasicPitchApi();
  const localModelPath = pathToFileURL(require.resolve("@spotify/basic-pitch/model/model.json")).href;
  const localModel = new BasicPitch(localModelPath);
  try {
    await localModel.model;
    return localModel;
  } catch (_error) {
    const remoteModel = new BasicPitch(MODEL_CDN_URL);
    await remoteModel.model;
    return remoteModel;
  }
}

async function transcribeAudioToMidi(inputPath, outputPath, options = {}) {
  const audioBuffer = await decodeAudioFile(inputPath);
  const mono = audioBufferToMono(audioBuffer);
  const requestedEngine = (options.engine || "auto").toLowerCase();

  let engine = requestedEngine;
  if (engine === "auto") {
    engine = "basic-pitch";
  }

  let notes = [];
  if (engine === "basic-pitch") {
    try {
      refreshBackendLabel();
      const resampled = resampleLinear(mono, audioBuffer.sampleRate, TARGET_SAMPLE_RATE);
      const basicPitch = await createBasicPitch();
      const {
        outputToNotesPoly,
        addPitchBendsToNoteEvents,
        noteFramesToTime,
      } = getBasicPitchApi();
      const frames = [];
      const onsets = [];
      const contours = [];

      await basicPitch.evaluateModel(
        resampled,
        (frameChunk, onsetChunk, contourChunk) => {
          frames.push(...frameChunk);
          onsets.push(...onsetChunk);
          contours.push(...contourChunk);
        },
        () => {},
      );

      const noteEvents = outputToNotesPoly(
        frames,
        onsets,
        clamp(options.onsetThreshold ?? 0.25, 0, 1),
        clamp(options.frameThreshold ?? 0.25, 0, 1),
        Math.max(1, Number.parseInt(options.minNoteLength ?? 5, 10)),
        true,
        null,
        null,
        options.melodiaTrick !== false,
      );
      notes = noteFramesToTime(addPitchBendsToNoteEvents(contours, noteEvents));
    } catch (error) {
      if (requestedEngine === "basic-pitch") {
        throw new Error(`basic-pitch 失敗：${error.message}`);
      }
      engine = "autocorr";
      refreshBackendLabel();
    }
  }

  if (engine === "autocorr") {
    const resampled = resampleLinear(mono, audioBuffer.sampleRate, AUTOCORR_SAMPLE_RATE);
    notes = transcribeByAutocorr(resampled, AUTOCORR_SAMPLE_RATE);
  }

  const midiBytes = buildMidiFromNotes(notes, options.tempo || 120);
  fs.writeFileSync(outputPath, midiBytes);

  return {
    engine,
    notes: notes.length,
    durationSeconds: notes.length > 0
      ? notes.reduce(
          (max, note) => Math.max(max, note.startTimeSeconds + note.durationSeconds),
          0,
        )
      : 0,
  };
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
    const result = await transcribeAudioToMidi(inputPath, outputPath, {
      onsetThreshold: parsed.onsetThreshold,
      frameThreshold: parsed.frameThreshold,
      minNoteLength: parsed.minNoteLength,
      melodiaTrick: parsed.melodiaTrick,
      tempo: parsed.tempo,
      engine: parsed.engine,
    });
    console.log(`完成: ${outputPath}`);
    console.log(`TensorFlow backend: ${TF_BACKEND}`);
    console.log(`轉錄引擎: ${result.engine}`);
    console.log(`音符數: ${result.notes}`);
    console.log(`估計長度(秒): ${result.durationSeconds.toFixed(3)}`);
  } catch (error) {
    console.error(`轉換失敗: ${error.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  transcribeAudioToMidi,
};
