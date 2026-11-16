// Two free voices. "gemini" is the natural one; "basic" is Google Translate's voice (MP3),
// used by the page when every Gemini speech model is out of free quota or capacity.
// Each Gemini speech model has its own small daily free quota, so they are tried in turn.
const GEMINI_TTS = (
  process.env.TTS_MODELS ||
  "gemini-3.8-flash-lite-tts,gemini-3.8-flash-tts,gemini-3.1-flash-tts-preview,gemini-2.5-flash-preview-tts"
).split(",");
const VOICE = process.env.TTS_VOICE || "Kore";

// The page joins pieces by skipping a 44-byte header, so always hand back plain
// 24 kHz 16-bit mono WAV, wrapping raw PCM when a model returns it without a header.
function wav(audio) {
  if (audio.subarray(0, 4).toString("latin1") === "RIFF") {
    const at = audio.indexOf("data");
    if (at === 36) return audio;
    audio = audio.subarray(at + 8);
  }
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + audio.length, 4); h.write("WAVEfmt ", 8);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(24000, 24); h.writeUInt32LE(48000, 28); h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34); h.write("data", 36); h.writeUInt32LE(audio.length, 40);
  return Buffer.concat([h, audio]);
}

async function gemini(text) {
  let last;
  for (const model of GEMINI_TTS) {
    try { return await speak(model, text); } catch (e) { last = e; }
  }
  throw last;
}

async function speak(model, text) {
  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: "POST",
      signal: AbortSignal.timeout(25000),
      headers: { "Content-Type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY },
      body: JSON.stringify({
        // Send only the words to be spoken: the speech model reads everything it is given.
        contents: [{ parts: [{ text }] }],
        generationConfig: {
          responseModalities: ["AUDIO"],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: VOICE } } },
        },
      }),
    },
  );
  const data = await r.json();
  if (!r.ok) throw new Error(data?.error?.message || "Voice failed (" + r.status + ")");
  const part = data.candidates?.[0]?.content?.parts?.find((p) => p.inlineData)?.inlineData;
  if (!part?.data) throw new Error("Voice returned no audio");
  return { type: "audio/wav", audio: wav(Buffer.from(part.data, "base64")) };
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

  const text = String(req.body?.text || "").slice(0, 12000);
  if (!text.trim()) return res.status(400).json({ error: "No text" });

  try {
    const { type, audio } = req.body?.engine === "basic" ? await basic(text) : await gemini(text);
    res.setHeader("Content-Type", type);
    res.setHeader("Cache-Control", "no-store");
    res.status(200).send(audio);
  } catch (e) {
    res.status(502).json({ error: e.message || "Voice failed" });
  }
}
