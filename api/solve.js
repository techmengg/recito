import SYSTEM from "./_prompt.js";

// The strongest model is tried first but only waited on briefly, because the free tier
// often reports it as overloaded; the lite models run alongside as the fast fallback.
const STRONG = process.env.SOLVE_MODEL || "gemini-3.8-flash";
const STRONG_WAIT_MS = +process.env.SOLVE_STRONG_WAIT_MS || 9000;
const FAST = ["gemini-flash-lite-latest", "gemini-3.5-flash-lite"];

const SCHEMA = {
  type: "OBJECT",
  properties: {
    answers: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          question: { type: "STRING", description: "The term or question exactly as printed" },
          answer: { type: "STRING" },
        },
        required: ["question", "answer"],
        propertyOrdering: ["question", "answer"],
      },
    },
  },
  required: ["answers"],
};

async function ask(model, key, images, ms) {
  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: "POST",
      signal: AbortSignal.timeout(ms),
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM }] },
        contents: [
          {
            role: "user",
            parts: [
              ...images.map((data) => ({ inlineData: { mimeType: "image/jpeg", data } })),
              { text: "Answer every question shown, in order." },
            ],
          },
        ],
        generationConfig: { responseMimeType: "application/json", responseSchema: SCHEMA },
      }),
    },
  );
  const data = await r.json();
  if (!r.ok) throw new Error(data?.error?.message || "Solve failed (" + r.status + ")");
  const text = data.candidates?.[0]?.content?.parts?.find((p) => p.text && !p.thought)?.text;
  const answers = JSON.parse(text || "{}").answers;
  if (!answers?.length) throw new Error("The model returned no answers");
  return answers.map((a) => ({
    question: a.question.replace(/^s*d+[.)]s*/, ""),
    answer: a.answer.replace(/p.t./gi, "pertaining to"),
  }));
}

async function fast(key, images) {
  let last;
  for (const m of FAST) {
    try { return { answers: await ask(m, key, images, 20000), model: m }; } catch (e) { last = e; }
  }
  throw last;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  if (process.env.ACCESS_CODE && req.headers["x-code"] !== process.env.ACCESS_CODE)
    return res.status(401).json({ error: "Wrong access code" });
  const key = process.env.GEMINI_API_KEY;
  if (!key) return res.status(500).json({ error: "GEMINI_API_KEY is not set on the server" });

  const images = Array.isArray(req.body?.images) ? req.body.images.slice(0, 6) : [];
  if (!images.length) return res.status(400).json({ error: "No images" });

  const backup = fast(key, images);
  backup.catch(() => {});
  try {
    const answers = await ask(STRONG, key, images, STRONG_WAIT_MS);
    return res.status(200).json({ answers, model: STRONG });
  } catch {}
  try {
    res.status(200).json(await backup);
  } catch (e) {
    res.status(502).json({ error: e.message || "Solve failed" });
  }
}
