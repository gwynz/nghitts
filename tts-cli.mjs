#!/usr/bin/env node
import { phonemize } from 'phonemizer';
import ort from 'onnxruntime-node';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { processVietnameseText } from './src/utils/vietnamese-processor.js';
import { transliterateWord } from './src/utils/transliterator.js';
import { isVietnameseWord } from './src/utils/vietnamese-detector.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { model: '', text: '', output: 'output.wav', speed: 1.0, debug: false, padSilence: 125 };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '-m': case '--model': opts.model = args[++i]; break;
      case '-t': case '--text': opts.text = args[++i]; break;
      case '-f': case '--file': {
        const fp = args[++i];
        if (path.extname(fp).toLowerCase() === '.srt') {
          opts.isSrt = true;
          opts.srtPath = path.resolve(__dirname, fp);
        } else {
          opts.text = fs.readFileSync(fp, 'utf-8');
        }
        break;
      }
      case '-o': case '--output': opts.output = args[++i]; break;
      case '-s': case '--speed': opts.speed = parseFloat(args[++i]); break;
      case '--debug': opts.debug = true; break;
      case '--pad-silence': opts.padSilence = parseInt(args[++i], 10); break;
      case '-h': case '--help':
        console.log(`Usage: node tts-cli.mjs [options]
  -m, --model <path>   Model path without extension (e.g. public/tts-model/vi/ngochuyennew)
  -t, --text <text>    Input text
  -f, --file <path>    Read input text from file
  -o, --output <file>  Output WAV file (default: output.wav)
   -s, --speed <float>  Speed multiplier (default: 1.0)
   --debug              Enable debug logging
   --pad-silence <ms>   Leading/trailing silence in ms (default: 125)
   -h, --help           Show this help`);
        process.exit(0);
    }
  }
  if (!opts.model) { console.error('Error: model path required (-m)'); process.exit(1); }
  if (!opts.text && !opts.isSrt) { console.error('Error: text required (-t or -f)'); process.exit(1); }
  return opts;
}

// ---------------------------------------------------------------------------
// WAV writer
// ---------------------------------------------------------------------------
function writeWav(filePath, samples, sampleRate) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);

  const writeStr = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, samples.length * 2, true);

  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
  }

  fs.writeFileSync(filePath, Buffer.from(buffer));
  console.log(`Wrote ${filePath}`);
}

// ---------------------------------------------------------------------------
// CSV loading (Node replacement for fetch)
// ---------------------------------------------------------------------------
function loadCsv(filePath) {
  try {
    const text = fs.readFileSync(filePath, 'utf-8');
    const map = new Map();
    const lines = text.split('\n');
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      const m = line.match(/^([^,]+),(.+)$/);
      if (m) map.set(m[1].trim().toLowerCase(), m[2].trim());
    }
    const sorted = [...map.entries()].sort((a, b) => b[0].length - a[0].length);
    return new Map(sorted);
  } catch {
    return new Map();
  }
}

// ---------------------------------------------------------------------------
// SRT parser
// ---------------------------------------------------------------------------
function parseSRT(filePath) {
  const text = fs.readFileSync(filePath, 'utf-8').replace(/\r\n/g, '\n');
  const segments = [];
  const blocks = text.trim().split(/\n\n+/);
  for (const block of blocks) {
    const lines = block.trim().split('\n');
    if (lines.length < 3) continue;
    const index = parseInt(lines[0], 10);
    if (isNaN(index)) continue;
    const timeMatch = lines[1].match(/(\d{2}:\d{2}:\d{2}[.,]\d{3}) --> (\d{2}:\d{2}:\d{2}[.,]\d{3})/);
    if (!timeMatch) continue;
    const startTime = timeMatch[1].replace(',', '.');
    const endTime = timeMatch[2].replace(',', '.');
    const segText = lines.slice(2).join('\n').trim();
    segments.push({ index, startTime, endTime, text: segText });
  }
  return segments;
}

// ---------------------------------------------------------------------------
// Text processing (adapted from text-cleaner.js)
// ---------------------------------------------------------------------------
const TRANSLITERATION_SKIP = new Set(['mc']);

function cleanTextForTTS(text) {
  if (!text) return '';
  return text
    .replace(/[\u{1F600}-\u{1F64F}]|[\u{1F300}-\u{1F5FF}]|[\u{1F680}-\u{1F6FF}]|[\u{1F1E0}-\u{1F1FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]|[\u{1F900}-\u{1F9FF}]|[\u{1F018}-\u{1F270}]|[\u{238C}-\u{2454}]|[\u{20D0}-\u{20FF}]|[\u{FE0F}]|[\u{200D}]/gu, '')
    .replace(/[\\()¯]/g, '')
    .replace(/["""]/g, '')
    .replace(/\s—/g, '.')
    .replace(/\b_\b/g, ' ')
    .replace(/(?<!\d)-(?!\d)/g, ' ')
    .replace(/[^\u0000-\u024F\u1E00-\u1EFF]/g, '')
    .trim();
}

function chunkText(text) {
  if (!text) return [];
  const chunks = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const processed = /[.!?]$/.test(t) ? t : t + '.';
    for (const s of processed.split(/(?<=[.!?])(?=\s+|$)/)) {
      const ts = s.trim();
      if (ts) chunks.push(ts);
    }
  }
  return chunks;
}

async function processTextForTTS(text, csvDir) {
  if (!text) return '';
  const cleaned = cleanTextForTTS(text);
  const vietnameseProcessed = processVietnameseText(cleaned, null);

  const mappingInput = vietnameseProcessed.toLowerCase();

  const acronymMap = loadCsv(path.join(csvDir, 'acronyms.csv'));
  let result = mappingInput;
  if (acronymMap.size) {
    for (const [acro, trans] of acronymMap) {
      const esc = acro.replace(/[+?^${}()|[\]\\]/g, '\\$&');
      result = result.replace(new RegExp(`\\b${esc}\\b`, 'gi'), trans);
    }
  }

  const replacementMap = loadCsv(path.join(csvDir, 'non-vietnamese-words.csv'));
  if (replacementMap.size) {
    for (const [orig, trans] of replacementMap) {
      const esc = orig.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      result = result.replace(new RegExp(`\\b${esc}\\b`, 'gi'), (match) =>
        match[0] === match[0].toUpperCase()
          ? trans.charAt(0).toUpperCase() + trans.slice(1)
          : trans
      );
    }
  }

  // Transliteration
  const wordRegex = /(?:^|[^\w\u00C0-\u1EFF])([\w\u00C0-\u1EFF]+)(?=[^\w\u00C0-\u1EFF]|$)/g;
  const processed = new Set();
  result = result.replace(wordRegex, (match, word, offset) => {
    const wl = word.toLowerCase();
    if (processed.has(wl) || replacementMap.has(wl) || isVietnameseWord(word) || isVietnameseWord(wl) || word.length === 1 || TRANSLITERATION_SKIP.has(wl))
      return match;
    processed.add(wl);
    const trans = transliterateWord(word);
    return match.replace(word, (w) => w[0] === w[0].toUpperCase() ? trans.charAt(0).toUpperCase() + trans.slice(1) : trans);
  });

  return result;
}

// ---------------------------------------------------------------------------
// PiperTTS (Node.js version)
// ---------------------------------------------------------------------------
class RawAudio {
  constructor(audio, samplingRate) {
    this.audio = audio;
    this.samplingRate = samplingRate;
  }
}

class PiperTTS {
  constructor(voiceConfig, session) {
    this.voiceConfig = voiceConfig;
    this.session = session;
    this.padSilence = 0;
  }

  static async fromFiles(modelPath, configPath) {
    const [modelBuffer, configStr] = await Promise.all([
      fs.promises.readFile(modelPath),
      fs.promises.readFile(configPath, 'utf-8'),
    ]);
    const voiceConfig = JSON.parse(configStr);

    const backends = (ort.listSupportedBackends?.() ?? []).map(b => b.name);
    const hasDml = backends.includes('dml');
    const executionProviders = hasDml ? ['dml', 'cpu'] : ['cpu'];
    console.log(`Using ${hasDml ? 'GPU (DirectML)' : 'CPU'}`);

    const session = await ort.InferenceSession.create(modelBuffer, { executionProviders });
    console.log('Model loaded:', path.basename(modelPath));
    return new PiperTTS(voiceConfig, session);
  }

  getSpeakers() {
    if (!this.voiceConfig || this.voiceConfig.num_speakers <= 1) return [{ id: 0, name: 'Voice 1' }];
    const map = this.voiceConfig.speaker_id_map || {};
    return Object.entries(map)
      .sort(([, a], [, b]) => a - b)
      .map(([origId, id]) => ({ id, name: `Voice ${id + 1}`, originalId: origId }));
  }

  async textToPhonemes(text) {
    if (this.voiceConfig.phoneme_type === 'text') {
      return [Array.from(text.normalize('NFD'))];
    }
    const voice = this.voiceConfig.espeak?.voice || 'en-us';
    const raw = await phonemize(text, voice);
    const merged = this._mergePhonemes(text, raw);
    const cleaned = merged.replace(/\(en\)/g, '').replace(/\(vi\)/g, '');
    const trimmed = cleaned.trim();
    return trimmed ? [Array.from(trimmed.normalize('NFD'))] : [];
  }

  _mergePhonemes(text, phonemes) {
    if (typeof phonemes === 'string') return phonemes;
    if (phonemes && typeof phonemes === 'object' && !Array.isArray(phonemes)) {
      return String(phonemes.text || phonemes.phonemes || phonemes);
    }
    if (!Array.isArray(phonemes)) return String(phonemes ?? '');
    const separators = [...text.matchAll(/[,;:]/g)].map(m => m[0]);
    let result = '';
    let idx = 0;
    for (const part of phonemes) {
      const p = String(part).trim();
      if (!p) continue;
      if (result) result += (separators[idx] || ',') + ' ';
      result += p;
      idx++;
    }
    return result;
  }

  async phonemesToIds(textPhonemes) {
    const idMap = this.voiceConfig.phoneme_id_map;
    const BOS = idMap['^'];
    const EOS = idMap['$'];
    const PAD = idMap['_'];
    if (BOS === undefined || EOS === undefined || PAD === undefined) {
      throw new Error('Missing BOS/EOS/PAD in phoneme_id_map');
    }
    const ids = [];
    for (const sentence of textPhonemes) {
      ids.push(BOS, PAD);
      for (const ph of sentence) {
        if (ph in idMap) {
          ids.push(idMap[ph], PAD);
        }
      }
      ids.push(EOS);
    }
    return ids;
  }

  async generate(text, options = {}) {
    const speakerId = options.speakerId ?? 0;
    const lengthScale = options.speed ? 1.0 / options.speed : 1.0;
    const noiseScale = options.noiseScale ?? 0.667;
    const noiseWScale = options.noiseWScale ?? 0.8;
    this.padSilence = options.padSilence ?? this.padSilence;

    // Chunk text
    const chunks = chunkText(text);
    const allAudio = [];

    for (let idx = 0; idx < chunks.length; idx++) {
      const chunk = chunks[idx];
      console.log(`[${idx + 1}/${chunks.length}] Processing: "${chunk.slice(0, 60)}..."`);

      const textPhonemes = await this.textToPhonemes(chunk);
      const phonemeIds = await this.phonemesToIds(textPhonemes);

      if (phonemeIds.length === 0) continue;

      const inputs = {
        input: new ort.Tensor('int64', BigInt64Array.from(phonemeIds.map(id => BigInt(id))), [1, phonemeIds.length]),
        input_lengths: new ort.Tensor('int64', BigInt64Array.from([BigInt(phonemeIds.length)]), [1]),
        scales: new ort.Tensor('float32', Float32Array.from([noiseScale, lengthScale, noiseWScale]), [3]),
      };

      if ((this.voiceConfig.num_speakers || 1) > 1) {
        inputs.sid = new ort.Tensor('int64', BigInt64Array.from([BigInt(speakerId)]), [1]);
      }

      const results = await this.session.run(inputs);
      const audioData = results.output.data;
      allAudio.push(new Float32Array(audioData));
    }

    return this._mergeAudio(allAudio, this.padSilence);
  }

  _mergeAudio(chunks, padSilence = 0) {
    if (!chunks.length) return null;
    const sr = this.voiceConfig.audio?.sample_rate || 22050;
    const padSamples = padSilence > 0 ? Math.round(padSilence * sr / 1000) : 0;
    const totalLen = chunks.reduce((s, c) => s + c.length, padSamples * 2);
    const waveform = new Float32Array(totalLen);
    let offset = padSamples;
    for (const c of chunks) {
      waveform.set(c, offset);
      offset += c.length;
    }
    this._normalizePeak(waveform, 1.0);
    return new RawAudio(waveform, sr);
  }

  _normalizePeak(f32, target = 0.9) {
    if (!f32?.length) return;
    let max = 1e-9;
    for (let i = 0; i < f32.length; i++) max = Math.max(max, Math.abs(f32[i]));
    const g = Math.min(4, target / max);
    if (g < 1) for (let i = 0; i < f32.length; i++) f32[i] *= g;
  }
}

function generateSilence(durationMs, sampleRate) {
  const numSamples = Math.round(sampleRate * durationMs / 1000);
  return new RawAudio(new Float32Array(numSamples), sampleRate);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const opts = parseArgs();

  // Resolve model files
  const modelOnnx = path.resolve(__dirname, opts.model + '.onnx');
  const modelJson = path.resolve(__dirname, opts.model + '.onnx.json');

  if (!fs.existsSync(modelOnnx)) {
    console.error(`Model file not found: ${modelOnnx}`);
    process.exit(1);
  }
  if (!fs.existsSync(modelJson)) {
    console.error(`Config file not found: ${modelJson}`);
    process.exit(1);
  }

  const csvDir = path.resolve(__dirname, 'public');

  // Load model
  const tts = await PiperTTS.fromFiles(modelOnnx, modelJson);
  const speakers = tts.getSpeakers();
  console.log(`Speakers: ${speakers.length > 1 ? speakers.length + ' voices available' : '1 voice'}`);

  // Preprocess text
  console.log('Preprocessing text...');

  if (opts.isSrt) {
    // --- SRT mode: generate one WAV per segment ---
    const segments = parseSRT(opts.srtPath);
    if (!segments.length) {
      console.error('No subtitle segments found');
      process.exit(1);
    }

    console.log(`Found ${segments.length} segments`);

    const outDir = path.resolve(__dirname, opts.output);
    fs.mkdirSync(outDir, { recursive: true });
    console.log(`Found ${segments.length} segments, output to ${outDir}`);

    const info = [];

    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      console.log(`[${i + 1}/${segments.length}] ${seg.startTime} -> ${seg.endTime}: "${seg.text.slice(0, 60)}..."`);

      const processedText = await processTextForTTS(seg.text, csvDir);

      let audio;
      if (!processedText || !/[\w\d]/i.test(processedText)) {
        audio = generateSilence(500, tts.voiceConfig.audio?.sample_rate || 22050);
      } else {
        try {
          audio = await tts.generate(processedText, { speed: opts.speed, padSilence: opts.padSilence });
        } catch (err) {
          console.error(`Error on segment ${i} (${seg.startTime}): "${seg.text}" - ${err.message}`);
          continue;
        }
        if (!audio) continue;
      }

      const segFile = `segment_${i}.wav`;
      const segPath = path.join(outDir, segFile);
      writeWav(segPath, audio.audio, audio.samplingRate);

      info.push({
        index: i,
        srtIndex: seg.index,
        startTime: seg.startTime,
        endTime: seg.endTime,
        file: segFile,
        text: seg.text,
      });
    }

    // Write segment metadata
    const metaPath = path.join(outDir, 'segments.json');
    fs.writeFileSync(metaPath, JSON.stringify({ segments: info }, null, 2));
    console.log(`Wrote ${metaPath}`);
    console.log('Done!');
    return;
  }

  // --- Plain text mode ---
  const processedText = await processTextForTTS(opts.text, csvDir);
  console.log('Input:', opts.text);
  console.log('Processed:', processedText);

  console.log('Generating audio...');
  const audio = await tts.generate(processedText, { speed: opts.speed, padSilence: opts.padSilence });

  if (!audio) {
    console.error('No audio generated');
    process.exit(1);
  }

  const outPath = path.resolve(__dirname, opts.output);
  writeWav(outPath, audio.audio, audio.samplingRate);
  console.log('Done!');
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
