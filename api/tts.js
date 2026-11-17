// Two voices, neither with a daily limit. The default is Piper, an open-source model that
// runs inside this function (downloaded at build time by scripts/fetch-voice.mjs).
// "basic" is Google Translate's voice (MP3), which the page falls back to if Piper fails.
import path from "node:path";
import sherpa from "sherpa-onnx";

const DIR = path.join(process.cwd(), "models", "vits-piper-en_US-lessac-medium");
const SPEED = +process.env.TTS_SPEED || 1;

// Loading the model takes about a second, so keep it for later requests to this instance.
let engine;
function piper(text, gap) {
  engine ||= sherpa.createOfflineTts({
    offlineTtsModelConfig: {
      offlineTtsVitsModelConfig: {
        model: path.join(DIR, "en_US-lessac-medium.onnx"),
        tokens: path.join(DIR, "tokens.txt"),
        dataDir: path.join(DIR, "espeak-ng-data"),
        noiseScale: 0.667,
        noiseScaleW: 0.8,
        lengthScale: 1.0,
      },
      numThreads: 1,
      debug: 0,
      provider: "cpu",
    },
    maxNumSentences: 1,
  });
  // Each blank-line-separated paragraph (one answer) is voiced on its own and followed by
  // `gap` seconds of silence, so there is a clear pause between answers and between pieces.
  const parts = [];
  let sampleRate = 22050, length = 0;
  for (const p of text.split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean)) {
    const g = engine.generate({ text: p, sid: 0, speed: SPEED });
    if (!g.samples?.length) throw new Error("Voice returned no audio");
    sampleRate = g.sampleRate;
    parts.push(g.samples, new Float32Array(Math.round(gap * sampleRate)));
    length += g.samples.length + Math.round(gap * sampleRate);
  }
  if (!length) throw new Error("Voice returned no audio");
  const samples = new Float32Array(length);
  let at = 0;
  for (const p of parts) { samples.set(p, at); at += p.length; }

  // 16-bit mono WAV with a plain 44-byte header, which is what the page expects when joining pieces.
  const out = Buffer.alloc(44 + samples.length * 2);
  out.write("RIFF", 0); out.writeUInt32LE(36 + samples.length * 2, 4); out.write("WAVEfmt ", 8);
  out.writeUInt32LE(16, 16); out.writeUInt16LE(1, 20); out.writeUInt16LE(1, 22);
  out.writeUInt32LE(sampleRate, 24); out.writeUInt32LE(sampleRate * 2, 28); out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34); out.write("data", 36); out.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++)
    out.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), 44 + i * 2);
  return { type: "audio/wav", audio: out };
}

// Google Translate's endpoint takes at most 200 characters per request.
function pieces(text, max = 180) {
  const out = [];
  for (const sentence of text.split(/\n+/).map((s) => s.trim()).filter(Boolean)) {
    let cur = "";
    for (const word of sentence.split(/\s+/)) {
      if (cur && (cur + " " + word).length > max) { out.push(cur); cur = word; }
      else cur = cur ? cur + " " + word : word;
    }
    if (cur) out.push(cur);
  }
  return out;
}

async function basic(text) {
  const parts = await Promise.all(
    pieces(text).map(async (q) => {
      const r = await fetch(
        "https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=en&q=" + encodeURIComponent(q),
        { signal: AbortSignal.timeout(15000), headers: { "User-Agent": "Mozilla/5.0" } },
      );
      if (!r.ok) throw new Error("Backup voice failed (" + r.status + ")");
      return Buffer.from(await r.arrayBuffer());
    }),
  );
  return { type: "audio/mpeg", audio: Buffer.concat(parts) };
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  if (process.env.ACCESS_CODE && req.headers["x-code"] !== process.env.ACCESS_CODE)
    return res.status(401).json({ error: "Wrong access code" });

  const text = String(req.body?.text || "").slice(0, 6000);
  if (!text.trim()) return res.status(400).json({ error: "No text" });

  try {
    const { type, audio } = req.body?.engine === "basic" ? await basic(text) : piper(text, Math.min(3, Math.max(0, +req.body?.gap || 0)));
    res.setHeader("Content-Type", type);
    res.setHeader("Cache-Control", "no-store");
    res.status(200).send(audio);
  } catch (e) {
    res.status(502).json({ error: e.message || "Voice failed" });
  }
}
