import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";

const VOICE = process.env.TTS_VOICE || "en-US-AndrewNeural";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  if (process.env.ACCESS_CODE && req.headers["x-code"] !== process.env.ACCESS_CODE)
    return res.status(401).json({ error: "Wrong access code" });

  const text = String(req.body?.text || "").slice(0, 12000);
  if (!text.trim()) return res.status(400).json({ error: "No text" });

  try {
    const tts = new MsEdgeTTS();
    await tts.setMetadata(VOICE, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
    const { audioStream } = tts.toStream(text);
    const chunks = [];
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("TTS timed out")), 45000);
      audioStream.on("data", (c) => chunks.push(c));
      audioStream.on("error", reject);
      audioStream.on("close", () => (clearTimeout(timer), resolve()));
      audioStream.on("end", () => (clearTimeout(timer), resolve()));
    });
    tts.close();
    const audio = Buffer.concat(chunks);
    if (!audio.length) throw new Error("TTS returned no audio");
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Cache-Control", "no-store");
    res.status(200).send(audio);
  } catch (e) {
    res.status(502).json({ error: e.message || "TTS failed" });
  }
}
