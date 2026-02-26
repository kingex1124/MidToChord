# MidToChord

把 MIDI (`.mid`)、MusicXML (`.mxl/.musicxml/.xml`) 或音訊（`.mp3/.wav/.ogg/.flac/.m4a/.aac`）轉成和玄樂譜格式：`主音Melody`、`和弦Chord1`、`和弦Chord2`。

## 安裝

```bash
npm install
```

## 使用

```bash
node src/mid-to-chord.js <input.mid>
```

或指定輸出檔：

```bash
node src/mid-to-chord.js -i <input.mid> -o <output.md>
```

若檔名含空白，建議加引號（例如：`"Lock-on Full Version.mxl"`）。

也可以直接吃音訊檔：

```bash
node src/mid-to-chord.js -i <input.mp3> --compress --players 5
```

也可以直接吃 MXL / MusicXML（規則與 MIDI 完全相同，含多人合奏）：

```bash
node src/mid-to-chord.js -i <input.mxl> --compress --players 5
```

指定輸出樂譜 BPM（覆蓋來源檔案 tempo）：

```bash
node src/mid-to-chord.js -i <input.mid> --players 5 --bpm 132
```

啟用壓縮（優先壓到限制內）：

```bash
node src/mid-to-chord.js -i <input.mid> --compress
```

指定多人分譜（預設為平行合奏）：

```bash
node src/mid-to-chord.js -i <input.mid> --players 3
```

切換為舊版按時間切段：

```bash
node src/mid-to-chord.js -i <input.mid> --players 3 --split-mode sequential
```

高保真建議（優先接近原曲）：

```bash
node src/mid-to-chord.js -i <input.mid> --compress --players 4
```

`--players` 越大，通常越不需要截斷，完整度會更高。

## 音訊轉 MIDI（MP3 -> MID）

```bash
node src/audio-to-midi.js -i <input.mp3> -o <output.mid>
```

可調參數：

```bash
node src/audio-to-midi.js -i <input.mp3> -o <output.mid> --engine autocorr --tempo 120
```

也可用 npm script：

```bash
npm run audio-to-midi -- -i <input.mp3> -o <output.mid>
```

- `--engine auto`：自動選擇引擎（預設）
- `--engine autocorr`：純 JS 單旋律估測，穩定但和聲細節會少一些
- `--engine basic-pitch`：高品質多音轉錄（可用純 `tfjs`，但會比較慢）

## MusicXML / MXL 轉 MIDI

```bash
node src/mxl-to-mid.js -i <input.mxl> -o <output.mid>
```

也可用 npm script：

```bash
npm run mxl-to-midi -- -i <input.mxl> -o <output.mid>
```

## MID 切割（依時間區間）

指定從幾分幾秒切到幾分幾秒：

```bash
node src/cut-mid.js <input.mid> <from> <to> [output.mid]
```

例如切 `00:30` 到 `01:45`：

```bash
node src/cut-mid.js -i "Lock-on Full Version.mid" --from 00:30 --to 01:45 -o CUT.mid
```

也可用 npm script：

```bash
npm run cut-mid -- -i "Lock-on Full Version.mid" --from 00:30 --to 01:45 -o CUT.mid
```

時間格式支援：

- `mm:ss`（例：`01:23.5`）
- `hh:mm:ss`（例：`00:01:23`）
- 直接秒數（例：`83.5`）

## 轉成試聽 MIDI

將 `Result.md` 直接轉成 `Result.mid`（支援單張與 `合奏1..N`）：

```bash
node src/result-to-mid.js
```

或指定輸入輸出：

```bash
node src/result-to-mid.js -i Result.md -o Result.mid
```

若要強制試聽速度（忽略樂譜內 `t` 值）：

```bash
node src/result-to-mid.js -i Result.md -o Result.mid --bpm 200
```

也可用 npm script：

```bash
npm run to-mid
```

`result-to-mid` 會依 `#META split=...` 自動判斷：

- `split=parallel`：多張合奏同時疊加
- `split=sequential`：多張合奏依序串接
- 也可用 `--bpm N` 直接覆蓋輸出的 MIDI tempo

`split=parallel` 轉成 MIDI 時，會為每位合奏玩家各自建立 `Melody/Chord1/Chord2` 獨立軌道，避免同音重疊時被 MIDI 配對機制吃音。

## 輸出限制

- `Melody` 最多 1200 字元
- `Chord1` 最多 800 字元
- `Chord2` 最多 500 字元

- 預設不壓縮，超過上限會截斷。
- 不加 `--compress`：維持原本邏輯，不做跨聲部共同截斷點對齊。
- 加上 `--compress` 後，會先嘗試壓縮到上限內；若仍超限，才會截斷。
- 加上 `--compress` 後，`Melody / Chord1 / Chord2` 會以「先到上限的軌道」為共同截斷點同步收尾（單人/多人都一樣）。
- 加上 `--players N` 後，會輸出 `合奏1..N` 多張樂譜，每張套用同一組上限。
- `--player N` 也可用（等同 `--players N`）。
- `--split-mode parallel`（預設）：多張樂譜是平行合奏，`result-to-mid` 會同時疊加。
- `--split-mode sequential`：多張樂譜按時間分段串接。
- `--bpm N`：指定輸出樂譜 BPM（會覆蓋原檔 tempo）。
- 輸出的 `Melody / Chord1 / Chord2` 都會帶 `tN`，可直接分給不同玩家保持同速。
- 轉完可看 `Result.md` 第一行 `#META ... players=N`，確認實際輸出人數。

## 輸出檔案

- 每次執行都會寫入 `Result.md`
- 若有指定 `-o <output.md>`，會再額外輸出一份到指定檔案
- `Result.md` 會帶 `#META`（含 `bpm`）/ `段長Ticks` 資訊，供 `result-to-mid` 精準還原時長

## memo

``` memo
node src/mid-to-chord.js Lock-on Full Version.mid --players 5 

node src/mid-to-chord.js Lock-on Full Version.mxl --players 1 --bpm 200

node src/mid-to-chord.js Lock-on Full Version.mxl --players 2 --compress --bpm 200 

node src/result-to-mid.js -i Result.md -o Result.mid


node src/cut-mid.js -i "Lock-on Full Version.mid" --from 00:00 --to 01:08 -o CUT.mid

node src/mid-to-chord.js CUT.mid --players 1 
```
