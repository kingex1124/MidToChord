#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const AdmZip = require("adm-zip");
const { XMLParser } = require("fast-xml-parser");
const { Midi } = require("@tonejs/midi");

const STEP_TO_SEMITONE = {
  C: 0,
  D: 2,
  E: 4,
  F: 5,
  G: 7,
  A: 9,
  B: 11,
};

const XML_PARSER_OPTIONS = {
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseTagValue: false,
  trimValues: true,
};

const ORDERED_XML_PARSER_OPTIONS = {
  ...XML_PARSER_OPTIONS,
  preserveOrder: true,
};

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function ensureArray(value) {
  if (value === undefined || value === null) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function readText(value) {
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value === "string" || typeof value === "number") {
    return String(value);
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const text = readText(item);
      if (text !== "") {
        return text;
      }
    }
    return "";
  }
  if (typeof value === "object") {
    if (Object.prototype.hasOwnProperty.call(value, "#text")) {
      return String(value["#text"]);
    }
    for (const key of Object.keys(value)) {
      if (key === ":@") {
        continue;
      }
      const text = readText(value[key]);
      if (text !== "") {
        return text;
      }
    }
  }
  return "";
}

function readNumeric(value, fallback = 0) {
  const raw = readText(value);
  const number = Number.parseFloat(raw);
  return Number.isFinite(number) ? number : fallback;
}

function getChildrenByTag(nodes, tagName) {
  const out = [];
  for (const node of ensureArray(nodes)) {
    if (!node || typeof node !== "object") {
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(node, tagName)) {
      out.push(node[tagName]);
    }
  }
  return out;
}

function getFirstChild(nodes, tagName) {
  for (const node of ensureArray(nodes)) {
    if (!node || typeof node !== "object") {
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(node, tagName)) {
      return node[tagName];
    }
  }
  return null;
}

function hasTag(nodes, tagName) {
  return getFirstChild(nodes, tagName) !== null;
}

function readContainerRootPath(containerXmlText) {
  const parser = new XMLParser(XML_PARSER_OPTIONS);
  const parsed = parser.parse(containerXmlText);
  const container = parsed && parsed.container ? parsed.container : null;
  if (!container || !container.rootfiles) {
    return null;
  }
  const rootfiles = ensureArray(container.rootfiles.rootfile);
  for (const rootfile of rootfiles) {
    if (!rootfile || typeof rootfile !== "object") {
      continue;
    }
    const fullPath = rootfile["@_full-path"];
    if (typeof fullPath === "string" && fullPath.trim() !== "") {
      return fullPath;
    }
  }
  return null;
}

function readMusicXmlText(inputPath) {
  const ext = path.extname(inputPath || "").toLowerCase();
  if (ext === ".mxl") {
    const zip = new AdmZip(inputPath);
    const entries = zip.getEntries();
    const entryNames = entries.map((entry) => entry.entryName);
    let xmlEntryPath = null;

    const containerEntry = zip.getEntry("META-INF/container.xml");
    if (containerEntry) {
      const containerXmlText = zip.readAsText(containerEntry.entryName);
      xmlEntryPath = readContainerRootPath(containerXmlText);
    }

    if (!xmlEntryPath) {
      const fallback = entryNames.find((name) => /\.(musicxml|xml)$/i.test(name) && !/^META-INF\//i.test(name));
      if (!fallback) {
        throw new Error("找不到可用的 MusicXML 內容（container.xml 與 XML entry 都不存在）。");
      }
      xmlEntryPath = fallback;
    }

    const xmlEntry = zip.getEntry(xmlEntryPath);
    if (!xmlEntry) {
      throw new Error(`找不到 MusicXML entry: ${xmlEntryPath}`);
    }
    return zip.readAsText(xmlEntry.entryName);
  }

  return fs.readFileSync(inputPath, "utf8");
}

function getScorePartwiseObject(parsed) {
  if (!parsed || typeof parsed !== "object") {
    return null;
  }
  if (parsed["score-partwise"]) {
    return parsed["score-partwise"];
  }
  return null;
}

function getScorePartwiseOrderedNodes(parsedOrdered) {
  const node = ensureArray(parsedOrdered).find((item) => item && item["score-partwise"]);
  if (!node) {
    return null;
  }
  return node["score-partwise"];
}

function buildPartNameMap(scorePartwiseObject) {
  const map = new Map();
  if (!scorePartwiseObject || !scorePartwiseObject["part-list"]) {
    return map;
  }

  const scoreParts = ensureArray(scorePartwiseObject["part-list"]["score-part"]);
  for (const scorePart of scoreParts) {
    if (!scorePart || typeof scorePart !== "object") {
      continue;
    }
    const id = scorePart["@_id"];
    if (!id) {
      continue;
    }
    const partName = readText(scorePart["part-name"]).trim();
    map.set(id, partName || String(id));
  }
  return map;
}

function beatUnitToQuarterMultiplier(beatUnit, dots) {
  const normalized = String(beatUnit || "quarter").toLowerCase();
  let base = 1;
  if (normalized === "whole") {
    base = 4;
  } else if (normalized === "half") {
    base = 2;
  } else if (normalized === "quarter") {
    base = 1;
  } else if (normalized === "eighth") {
    base = 0.5;
  } else if (normalized === "16th") {
    base = 0.25;
  } else if (normalized === "32nd") {
    base = 0.125;
  } else if (normalized === "64th") {
    base = 0.0625;
  }

  let factor = 1;
  let next = 0.5;
  for (let i = 0; i < dots; i += 1) {
    factor += next;
    next /= 2;
  }
  return base * factor;
}

function octaveShiftSizeToSemitones(rawSize) {
  const size = Number.parseInt(String(rawSize || "8"), 10);
  if (!Number.isFinite(size) || size <= 0) {
    return 12;
  }
  if (size === 8) {
    return 12;
  }
  if (size === 15) {
    return 24;
  }
  if (size === 22) {
    return 36;
  }
  const steps = Math.max(1, Math.round((size - 1) / 7));
  return steps * 12;
}

function getActiveOctaveShift(state, staff) {
  const targetStaff = String(staff || "1");
  let semitones = 0;
  for (const [key, shift] of state.octaveShiftMap.entries()) {
    if (key.startsWith(`${targetStaff}|`)) {
      semitones += shift;
    }
  }
  return semitones;
}

function parseTempoFromDirection(directionChildren) {
  const tempos = [];
  for (const child of ensureArray(directionChildren)) {
    if (!child || typeof child !== "object") {
      continue;
    }

    if (child.sound) {
      const attrs = child[":@"] || {};
      const tempo = Number.parseFloat(attrs["@_tempo"]);
      if (Number.isFinite(tempo) && tempo > 0) {
        tempos.push(tempo);
      }
    }

    if (child["direction-type"]) {
      for (const directionType of ensureArray(child["direction-type"])) {
        if (!directionType || typeof directionType !== "object") {
          continue;
        }
        if (!directionType.metronome) {
          continue;
        }

        for (const metronome of ensureArray(directionType.metronome)) {
          const beatUnit = readText(getFirstChild(metronome, "beat-unit")) || "quarter";
          const dots = getChildrenByTag(metronome, "beat-unit-dot").length;
          const perMinute = readNumeric(getFirstChild(metronome, "per-minute"), NaN);
          if (!Number.isFinite(perMinute) || perMinute <= 0) {
            continue;
          }

          const quarterMultiplier = beatUnitToQuarterMultiplier(beatUnit, dots);
          const bpm = perMinute * quarterMultiplier;
          if (Number.isFinite(bpm) && bpm > 0) {
            tempos.push(bpm);
          }
        }
      }
    }
  }
  return tempos;
}

function applyOctaveShiftDirection(state, directionChildren) {
  const staffText = readText(getFirstChild(directionChildren, "staff")).trim();
  const staff = staffText || "1";

  for (const child of ensureArray(directionChildren)) {
    if (!child || typeof child !== "object") {
      continue;
    }
    if (!child["direction-type"]) {
      continue;
    }

    for (const directionType of ensureArray(child["direction-type"])) {
      if (!directionType || typeof directionType !== "object") {
        continue;
      }
      if (!directionType["octave-shift"]) {
        continue;
      }

      const attrs = directionType[":@"] || {};
      const rawType = String(attrs["@_type"] || "").toLowerCase();
      const number = String(attrs["@_number"] || "1");
      const semitones = octaveShiftSizeToSemitones(attrs["@_size"]);
      const key = `${staff}|${number}`;

      if (rawType === "up") {
        state.octaveShiftMap.set(key, semitones);
      } else if (rawType === "down") {
        state.octaveShiftMap.set(key, -semitones);
      } else if (rawType === "stop") {
        state.octaveShiftMap.delete(key);
      }
    }
  }
}

function parseTransposeFromAttributes(attributesChildren) {
  const transposeNode = getFirstChild(attributesChildren, "transpose");
  if (!transposeNode) {
    return 0;
  }

  const chromatic = readNumeric(getFirstChild(transposeNode, "chromatic"), 0);
  const octaveChange = readNumeric(getFirstChild(transposeNode, "octave-change"), 0);
  return chromatic + octaveChange * 12;
}

function parsePitchMidi(noteChildren, state, staff) {
  const pitchNode = getFirstChild(noteChildren, "pitch");
  if (!pitchNode) {
    return null;
  }

  const step = readText(getFirstChild(pitchNode, "step")).trim().toUpperCase();
  if (!Object.prototype.hasOwnProperty.call(STEP_TO_SEMITONE, step)) {
    return null;
  }

  const alter = readNumeric(getFirstChild(pitchNode, "alter"), 0);
  const octave = readNumeric(getFirstChild(pitchNode, "octave"), NaN);
  if (!Number.isFinite(octave)) {
    return null;
  }

  const base = (octave + 1) * 12 + STEP_TO_SEMITONE[step] + alter;
  const shifted = base + state.transposeSemitone + getActiveOctaveShift(state, staff);
  return clamp(Math.round(shifted), 0, 127);
}

function extractTieTypes(noteChildren) {
  const types = [];
  for (const node of ensureArray(noteChildren)) {
    if (!node || typeof node !== "object" || !node.tie) {
      continue;
    }
    const attrs = node[":@"] || {};
    const type = String(attrs["@_type"] || "").toLowerCase();
    if (type) {
      types.push(type);
    }
  }
  return types;
}

function flushOpenTies(state, outEvents) {
  for (const tie of state.openTies.values()) {
    if (!Number.isFinite(tie.startBeat) || !Number.isFinite(tie.durationBeats) || tie.durationBeats <= 0) {
      continue;
    }
    outEvents.push({
      midi: tie.midi,
      startBeat: tie.startBeat,
      durationBeats: tie.durationBeats,
      velocity: tie.velocity,
    });
  }
  state.openTies.clear();
}

function parsePartEvents(partChildren, defaultVelocity, tempoMarks) {
  const state = {
    currentBeat: 0,
    lastChordStartBeat: 0,
    divisions: 1,
    transposeSemitone: 0,
    octaveShiftMap: new Map(),
    openTies: new Map(),
    velocity: defaultVelocity,
  };

  const events = [];

  for (const measureNode of ensureArray(partChildren)) {
    if (!measureNode || typeof measureNode !== "object" || !measureNode.measure) {
      continue;
    }

    for (const measureChild of ensureArray(measureNode.measure)) {
      if (!measureChild || typeof measureChild !== "object") {
        continue;
      }

      if (measureChild.attributes) {
        const divisions = readNumeric(getFirstChild(measureChild.attributes, "divisions"), NaN);
        if (Number.isFinite(divisions) && divisions > 0) {
          state.divisions = divisions;
        }
        state.transposeSemitone = parseTransposeFromAttributes(measureChild.attributes) || 0;
        continue;
      }

      if (measureChild.direction) {
        const directionChildren = ensureArray(measureChild.direction);
        const tempos = parseTempoFromDirection(directionChildren);
        for (const bpm of tempos) {
          tempoMarks.push({
            beat: state.currentBeat,
            bpm: clamp(Math.round(bpm), 20, 400),
          });
        }
        applyOctaveShiftDirection(state, directionChildren);
        continue;
      }

      if (measureChild.backup) {
        const durationDiv = readNumeric(getFirstChild(measureChild.backup, "duration"), 0);
        if (durationDiv > 0 && state.divisions > 0) {
          state.currentBeat = Math.max(0, state.currentBeat - durationDiv / state.divisions);
          state.lastChordStartBeat = state.currentBeat;
        }
        continue;
      }

      if (measureChild.forward) {
        const durationDiv = readNumeric(getFirstChild(measureChild.forward, "duration"), 0);
        if (durationDiv > 0 && state.divisions > 0) {
          state.currentBeat += durationDiv / state.divisions;
          state.lastChordStartBeat = state.currentBeat;
        }
        continue;
      }

      if (!measureChild.note) {
        continue;
      }

      const noteChildren = ensureArray(measureChild.note);
      const isRest = hasTag(noteChildren, "rest");
      const isChord = hasTag(noteChildren, "chord");
      const voice = readText(getFirstChild(noteChildren, "voice")).trim() || "1";
      const staff = readText(getFirstChild(noteChildren, "staff")).trim() || "1";
      const durationDiv = readNumeric(getFirstChild(noteChildren, "duration"), 0);
      const durationBeats = durationDiv > 0 && state.divisions > 0 ? durationDiv / state.divisions : 0;
      const startBeat = isChord ? state.lastChordStartBeat : state.currentBeat;

      if (!isChord) {
        state.lastChordStartBeat = startBeat;
      }

      const tieTypes = extractTieTypes(noteChildren);
      const hasTieStart = tieTypes.includes("start");
      const hasTieStop = tieTypes.includes("stop");

      if (!isRest) {
        const midi = parsePitchMidi(noteChildren, state, staff);
        if (midi !== null && durationBeats > 0) {
          const tieKey = `${voice}|${staff}|${midi}`;
          if (hasTieStop) {
            const openTie = state.openTies.get(tieKey);
            if (openTie) {
              openTie.durationBeats += durationBeats;
              if (hasTieStart) {
                state.openTies.set(tieKey, openTie);
              } else {
                events.push({
                  midi: openTie.midi,
                  startBeat: openTie.startBeat,
                  durationBeats: openTie.durationBeats,
                  velocity: openTie.velocity,
                });
                state.openTies.delete(tieKey);
              }
            } else if (hasTieStart) {
              state.openTies.set(tieKey, {
                midi,
                startBeat,
                durationBeats,
                velocity: state.velocity,
              });
            } else {
              events.push({
                midi,
                startBeat,
                durationBeats,
                velocity: state.velocity,
              });
            }
          } else if (hasTieStart) {
            state.openTies.set(tieKey, {
              midi,
              startBeat,
              durationBeats,
              velocity: state.velocity,
            });
          } else {
            events.push({
              midi,
              startBeat,
              durationBeats,
              velocity: state.velocity,
            });
          }
        }
      }

      if (!isChord && durationBeats > 0) {
        state.currentBeat += durationBeats;
      }
    }
  }

  flushOpenTies(state, events);

  return events
    .filter((event) => Number.isFinite(event.startBeat) && Number.isFinite(event.durationBeats) && event.durationBeats > 0)
    .sort((a, b) => a.startBeat - b.startBeat || a.midi - b.midi);
}

function normalizeTempoMarks(tempoMarks, ppq, fallbackBpm) {
  const normalized = ensureArray(tempoMarks)
    .map((mark) => ({
      ticks: Math.max(0, Math.round(mark.beat * ppq)),
      bpm: clamp(Math.round(mark.bpm), 20, 400),
    }))
    .filter((mark) => Number.isFinite(mark.ticks) && Number.isFinite(mark.bpm))
    .sort((a, b) => a.ticks - b.ticks);

  const dedup = [];
  for (const mark of normalized) {
    const last = dedup[dedup.length - 1];
    if (last && last.ticks === mark.ticks) {
      last.bpm = mark.bpm;
    } else {
      dedup.push(mark);
    }
  }

  if (dedup.length === 0 || dedup[0].ticks !== 0) {
    dedup.unshift({
      ticks: 0,
      bpm: clamp(Math.round(fallbackBpm || 120), 20, 400),
    });
  }

  return dedup;
}

function buildMidiFromMusicXml(xmlText, options = {}) {
  const parser = new XMLParser(XML_PARSER_OPTIONS);
  const orderedParser = new XMLParser(ORDERED_XML_PARSER_OPTIONS);
  const parsed = parser.parse(xmlText);
  const ordered = orderedParser.parse(xmlText);

  const scorePartwise = getScorePartwiseObject(parsed);
  const scoreOrdered = getScorePartwiseOrderedNodes(ordered);
  if (!scorePartwise || !scoreOrdered) {
    throw new Error("只支援 score-partwise 的 MusicXML。");
  }

  const partNameMap = buildPartNameMap(scorePartwise);
  const partNodes = ensureArray(scoreOrdered).filter((node) => node && node.part);
  if (partNodes.length === 0) {
    throw new Error("MusicXML 沒有可轉換的 part。");
  }

  const midi = new Midi();
  const ppq = midi.header.ppq || 480;
  const fallbackBpm = Number.isFinite(options.tempo) ? options.tempo : 120;
  const tempoMarks = [];

  for (let i = 0; i < partNodes.length; i += 1) {
    const partNode = partNodes[i];
    const attrs = partNode[":@"] || {};
    const partId = attrs["@_id"] || `P${i + 1}`;
    const partName = partNameMap.get(partId) || String(partId);
    const partChildren = partNode.part;
    const events = parsePartEvents(partChildren, 0.72, tempoMarks);
    if (events.length === 0) {
      continue;
    }

    const track = midi.addTrack();
    track.name = partName;
    for (const event of events) {
      const ticks = Math.max(0, Math.round(event.startBeat * ppq));
      const durationTicks = Math.max(1, Math.round(event.durationBeats * ppq));
      track.addNote({
        midi: clamp(Math.round(event.midi), 0, 127),
        ticks,
        durationTicks,
        velocity: clamp(Number(event.velocity) || 0.72, 0.05, 1),
      });
    }
  }

  if (midi.tracks.length === 0) {
    throw new Error("MusicXML 沒有可用音符。");
  }

  const tempos = normalizeTempoMarks(tempoMarks, ppq, fallbackBpm);
  midi.header.tempos = tempos.map((tempo) => ({
    ticks: tempo.ticks,
    bpm: tempo.bpm,
  }));

  return Buffer.from(midi.toArray());
}

function convertMxlToMidi(inputPath, outputPath, options = {}) {
  const xmlText = readMusicXmlText(inputPath);
  const bytes = buildMidiFromMusicXml(xmlText, options);
  fs.writeFileSync(outputPath, bytes);
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const parsed = {
    input: null,
    output: null,
    tempo: 120,
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

    if (arg === "--tempo") {
      const tempo = Number.parseInt(args[i + 1] || "", 10);
      if (Number.isInteger(tempo) && tempo > 0) {
        parsed.tempo = tempo;
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
    throw new Error("Missing input file.");
  }

  if (!parsed.output && parsed.input) {
    const ext = path.extname(parsed.input);
    parsed.output = parsed.input.slice(0, -ext.length) + ".mid";
  }

  return parsed;
}

function printHelp() {
  console.log(
    [
      "Usage:",
      "  node src/mxl-to-mid.js -i <input.mxl|input.musicxml|input.xml> -o <output.mid>",
      "",
      "Options:",
      "  --tempo <int>   fallback tempo when score has no tempo mark (default: 120)",
    ].join("\n"),
  );
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
    convertMxlToMidi(inputPath, outputPath, {
      tempo: parsed.tempo,
    });
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

module.exports = {
  buildMidiFromMusicXml,
  convertMxlToMidi,
};
