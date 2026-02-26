#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { Midi } = require("@tonejs/midi");

function parseClockTime(raw, label) {
  const text = String(raw || "").trim();
  if (!text) {
    throw new Error(`${label} 不可為空`);
  }

  if (!text.includes(":")) {
    const seconds = Number.parseFloat(text);
    if (!Number.isFinite(seconds) || seconds < 0) {
      throw new Error(`${label} 格式錯誤: ${raw}`);
    }
    return seconds;
  }

  const parts = text.split(":").map((part) => part.trim());
  if (parts.length !== 2 && parts.length !== 3) {
    throw new Error(`${label} 格式錯誤: ${raw}（支援 mm:ss 或 hh:mm:ss）`);
  }

  const secRaw = parts[parts.length - 1];
  const sec = Number.parseFloat(secRaw);
  if (!Number.isFinite(sec) || sec < 0 || sec >= 60) {
    throw new Error(`${label} 秒數格式錯誤: ${raw}`);
  }

  const mmRaw = parts[parts.length - 2];
  const mm = Number.parseInt(mmRaw, 10);
  if (!Number.isInteger(mm) || mm < 0) {
    throw new Error(`${label} 分鐘格式錯誤: ${raw}`);
  }

  let hh = 0;
  if (parts.length === 3) {
    hh = Number.parseInt(parts[0], 10);
    if (!Number.isInteger(hh) || hh < 0) {
      throw new Error(`${label} 小時格式錯誤: ${raw}`);
    }
  }

  return hh * 3600 + mm * 60 + sec;
}

function formatClockTime(seconds) {
  const safe = Math.max(0, Number(seconds) || 0);
  const hh = Math.floor(safe / 3600);
  const mm = Math.floor((safe % 3600) / 60);
  const sec = safe - hh * 3600 - mm * 60;
  const secText = sec.toFixed(3).replace(/\.000$/, "");
  const [secInt, secFrac] = secText.split(".");
  const secPadded = secInt.padStart(2, "0") + (secFrac ? `.${secFrac}` : "");
  if (hh > 0) {
    return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:${secPadded}`;
  }
  return `${String(mm).padStart(2, "0")}:${secPadded}`;
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const parsed = {
    input: null,
    output: null,
    from: null,
    to: null,
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

    if (arg === "-f" || arg === "--from" || arg === "--start") {
      parsed.from = parseClockTime(args[i + 1], "起始時間");
      i += 1;
      continue;
    }

    if (arg === "-t" || arg === "--to" || arg === "--end") {
      parsed.to = parseClockTime(args[i + 1], "結束時間");
      i += 1;
      continue;
    }

    if (arg.startsWith("-")) {
      throw new Error(`未知參數: ${arg}`);
    }

    if (!parsed.input) {
      parsed.input = arg;
      continue;
    }

    if (parsed.from === null) {
      parsed.from = parseClockTime(arg, "起始時間");
      continue;
    }

    if (parsed.to === null) {
      parsed.to = parseClockTime(arg, "結束時間");
      continue;
    }

    if (!parsed.output) {
      parsed.output = arg;
      continue;
    }

    throw new Error(`多餘參數: ${arg}`);
  }

  if (!parsed.help) {
    if (!parsed.input) {
      throw new Error("請提供輸入 MIDI 檔案");
    }
    if (parsed.from === null || parsed.to === null) {
      throw new Error("請提供起始與結束時間（--from / --to）");
    }
  }

  return parsed;
}

function printHelp() {
  console.log(
    [
      "Usage:",
      "  node src/cut-mid.js <input.mid> <from> <to> [output.mid]",
      "  node src/cut-mid.js -i <input.mid> --from 00:30 --to 01:45 -o <output.mid>",
      "",
      "Time format:",
      "  - mm:ss      (例: 01:23.5)",
      "  - hh:mm:ss   (例: 00:01:23)",
      "  - 秒數        (例: 83.5)",
      "",
      "Options:",
      "  -i, --input   輸入 MIDI",
      "  -o, --output  輸出 MIDI（預設: <input>.cut.mid）",
      "  -f, --from    起始時間",
      "  -t, --to      結束時間",
    ].join("\n"),
  );
}

function cloneTrackMetadata(sourceTrack, targetTrack) {
  if (sourceTrack.name) {
    targetTrack.name = sourceTrack.name;
  }
  if (typeof sourceTrack.channel === "number") {
    targetTrack.channel = sourceTrack.channel;
  }
  if (sourceTrack.instrument && targetTrack.instrument) {
    if (typeof sourceTrack.instrument.number === "number") {
      targetTrack.instrument.number = sourceTrack.instrument.number;
    }
    if (typeof sourceTrack.instrument.percussion === "boolean") {
      targetTrack.instrument.percussion = sourceTrack.instrument.percussion;
    }
  }
}

function pickLastEventBeforeOrAt(events, tick) {
  let picked = null;
  for (const event of events) {
    if (event.ticks <= tick) {
      picked = event;
      continue;
    }
    break;
  }
  return picked;
}

function appendTemposAndTimeSignatures(sourceHeader, targetHeader, startTick, endTick) {
  const sourceTempos = Array.isArray(sourceHeader.tempos) ? [...sourceHeader.tempos].sort((a, b) => a.ticks - b.ticks) : [];
  if (sourceTempos.length > 0) {
    const anchorTempo = pickLastEventBeforeOrAt(sourceTempos, startTick) || sourceTempos[0];
    targetHeader.tempos.push({ ticks: 0, bpm: anchorTempo.bpm });
    for (const tempo of sourceTempos) {
      if (tempo.ticks > startTick && tempo.ticks < endTick) {
        targetHeader.tempos.push({
          ticks: tempo.ticks - startTick,
          bpm: tempo.bpm,
        });
      }
    }
  }

  const sourceTimeSignatures = Array.isArray(sourceHeader.timeSignatures)
    ? [...sourceHeader.timeSignatures].sort((a, b) => a.ticks - b.ticks)
    : [];
  if (sourceTimeSignatures.length > 0) {
    const anchorSignature = pickLastEventBeforeOrAt(sourceTimeSignatures, startTick) || sourceTimeSignatures[0];
    targetHeader.timeSignatures.push({
      ticks: 0,
      timeSignature: Array.isArray(anchorSignature.timeSignature)
        ? [...anchorSignature.timeSignature]
        : [4, 4],
      measures: 0,
    });

    for (const signature of sourceTimeSignatures) {
      if (signature.ticks > startTick && signature.ticks < endTick) {
        targetHeader.timeSignatures.push({
          ticks: signature.ticks - startTick,
          timeSignature: Array.isArray(signature.timeSignature)
            ? [...signature.timeSignature]
            : [4, 4],
          measures: 0,
        });
      }
    }
  }
}

function appendTrackNotes(sourceTrack, targetTrack, startTick, endTick) {
  for (const note of sourceTrack.notes) {
    const noteStart = note.ticks;
    const noteEnd = note.ticks + note.durationTicks;
    if (noteEnd <= startTick || noteStart >= endTick) {
      continue;
    }

    const clippedStart = Math.max(noteStart, startTick);
    const clippedEnd = Math.min(noteEnd, endTick);
    const durationTicks = clippedEnd - clippedStart;
    if (durationTicks <= 0) {
      continue;
    }

    targetTrack.addNote({
      midi: note.midi,
      velocity: note.velocity,
      ticks: clippedStart - startTick,
      durationTicks,
    });
  }
}

function appendTrackCC(sourceTrack, targetTrack, startTick, endTick) {
  const controlChanges = sourceTrack.controlChanges || {};
  for (const key of Object.keys(controlChanges)) {
    const events = [...(controlChanges[key] || [])].sort((a, b) => a.ticks - b.ticks);
    if (events.length === 0) {
      continue;
    }

    const anchor = pickLastEventBeforeOrAt(events, startTick);
    if (anchor) {
      targetTrack.addCC({
        number: anchor.number,
        value: anchor.value,
        ticks: 0,
      });
    }

    for (const event of events) {
      if (event.ticks < startTick || event.ticks >= endTick) {
        continue;
      }
      targetTrack.addCC({
        number: event.number,
        value: event.value,
        ticks: event.ticks - startTick,
      });
    }
  }
}

function appendTrackPitchBends(sourceTrack, targetTrack, startTick, endTick) {
  const sourceEvents = Array.isArray(sourceTrack.pitchBends)
    ? [...sourceTrack.pitchBends].sort((a, b) => a.ticks - b.ticks)
    : [];
  if (sourceEvents.length === 0) {
    return;
  }

  const anchor = pickLastEventBeforeOrAt(sourceEvents, startTick);
  if (anchor) {
    targetTrack.pitchBends.push({
      ticks: 0,
      value: anchor.value,
    });
  }

  for (const bend of sourceEvents) {
    if (bend.ticks < startTick || bend.ticks >= endTick) {
      continue;
    }
    targetTrack.pitchBends.push({
      ticks: bend.ticks - startTick,
      value: bend.value,
    });
  }
}

function deriveOutputPath(inputPath) {
  const dir = path.dirname(inputPath);
  const ext = path.extname(inputPath);
  const name = path.basename(inputPath, ext || path.basename(inputPath));
  return path.join(dir, `${name}.cut.mid`);
}

function cutMidi(inputPath, outputPath, fromSec, toSec) {
  const bytes = fs.readFileSync(inputPath);
  const inputMidi = new Midi(bytes);

  const totalSec = inputMidi.duration || 0;
  const safeFrom = Math.max(0, fromSec);
  const safeTo = Math.min(toSec, totalSec > 0 ? totalSec : toSec);

  if (!(safeTo > safeFrom)) {
    throw new Error(`時間範圍無效: from=${fromSec}, to=${toSec}, duration=${totalSec}`);
  }

  const startTick = Math.floor(inputMidi.header.secondsToTicks(safeFrom));
  const endTick = Math.floor(inputMidi.header.secondsToTicks(safeTo));
  if (!(endTick > startTick)) {
    throw new Error("切割後長度為 0，請確認時間範圍或原始 tempo");
  }

  const outputMidi = new Midi();
  outputMidi.header.ppq = inputMidi.header.ppq;
  appendTemposAndTimeSignatures(inputMidi.header, outputMidi.header, startTick, endTick);

  for (const sourceTrack of inputMidi.tracks) {
    const targetTrack = outputMidi.addTrack();
    cloneTrackMetadata(sourceTrack, targetTrack);
    appendTrackNotes(sourceTrack, targetTrack, startTick, endTick);
    appendTrackCC(sourceTrack, targetTrack, startTick, endTick);
    appendTrackPitchBends(sourceTrack, targetTrack, startTick, endTick);
  }

  fs.writeFileSync(outputPath, Buffer.from(outputMidi.toArray()));

  return {
    fromSec: safeFrom,
    toSec: safeTo,
    totalSec,
    startTick,
    endTick,
  };
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
  if (!fs.existsSync(inputPath)) {
    console.error(`找不到輸入檔案: ${inputPath}`);
    process.exitCode = 1;
    return;
  }

  const outputPath = path.resolve(parsed.output || deriveOutputPath(inputPath));

  try {
    const result = cutMidi(inputPath, outputPath, parsed.from, parsed.to);
    console.log(`完成: ${outputPath}`);
    console.log(`切割區間: ${formatClockTime(result.fromSec)} -> ${formatClockTime(result.toSec)}`);
    console.log(`原始長度: ${formatClockTime(result.totalSec)}`);
  } catch (error) {
    console.error(`切割失敗: ${error.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}
