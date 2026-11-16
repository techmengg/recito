// Two free voices. "gemini" is the natural one (returns WAV); "basic" is Google Translate's
// voice (returns MP3), used by the page when Gemini's speech quota or capacity runs out.
const GEMINI_TTS = process.env.TTS_MODEL || "gemini-3.8-flash-lite-tts";
const VOICE = process.env.TTS_VOICE || "Kore";

async function gemini(text) {
  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_TTS}:generateContent`,
    {
      method: "POST",
      signal: AbortSignal.timeout(25000),
      headers: { "Content-Type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY },
      body: JSON.stringify({
        contents: [{ parts: [{ text: "Read this aloud exactly as written, clearly and at a steady pace:\n\n" + text }] }],
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
  return { type: part.mimeType || "audio/wav", audio: Buffer.from(part.data, "base64") };
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
