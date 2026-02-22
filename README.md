# MidToChord

把 MIDI (`.mid`) 轉成和玄樂譜格式：`主音Melody`、`和弦Chord1`、`和弦Chord2`。

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

啟用壓縮（優先壓到限制內）：

```bash
node src/mid-to-chord.js -i <input.mid> --compress
```

指定多人分譜（按時間切成多張）：

```bash
node src/mid-to-chord.js -i <input.mid> --players 3
```

高保真建議（優先接近原曲）：

```bash
node src/mid-to-chord.js -i <input.mid> --compress --players 4
```

`--players` 越大，通常越不需要截斷，完整度會更高。

## 轉成試聽 MIDI

將 `Result.md` 直接轉成 `Result.mid`（支援單張與 `合奏1..N`）：

```bash
node src/result-to-mid.js
```

或指定輸入輸出：

```bash
node src/result-to-mid.js -i Result.md -o Result.mid
```

也可用 npm script：

```bash
npm run to-mid
```

## 輸出限制

- `Melody` 最多 1200 字元
- `Chord1` 最多 800 字元
- `Chord2` 最多 500 字元

- 預設不壓縮，超過上限會截斷。
- 加上 `--compress` 後，會先嘗試壓縮到上限內，最後才截斷。
- 加上 `--players N` 後，會輸出 `合奏1..N` 多張樂譜，每張套用同一組上限。
- 多人分譜會保留每段時長，避免轉回 MIDI 時整首被縮短。

## 輸出檔案

- 每次執行都會寫入 `Result.md`
- 若有指定 `-o <output.md>`，會再額外輸出一份到指定檔案
- `Result.md` 會帶 `#META` / `段長Ticks` 資訊，供 `result-to-mid` 精準還原時長
