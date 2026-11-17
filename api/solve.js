import SYSTEM from "./_prompt.js";

// The free tier gives the lite models 500 requests a day each, against 20 a day for the
// bigger Flash models (which are also often overloaded), so the lite models do the work.
// Set SOLVE_MODEL to try a stronger model first; it is only waited on briefly.
const STRONG = process.env.SOLVE_MODEL || "";
const STRONG_WAIT_MS = +process.env.SOLVE_STRONG_WAIT_MS || 9000;
const FAST = ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite"];

const SCHEMA = {
  type: "OBJECT",
  properties: {
    answers: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          number: {
            type: "INTEGER",
            description:
              "The question number printed next to it. If none is printed, continue counting from the previous question (the first is 1), carrying on across images.",
          },
          question: { type: "STRING", description: "The term or question exactly as printed, without its number" },
          answer: { type: "STRING" },
        },
        required: ["number", "question", "answer"],
        propertyOrdering: ["number", "question", "answer"],
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
              {
                text:
                  "Answer every question shown, in order. The images are consecutive pages of one test, given in order. " +
                  "Give each question its number: use the number printed beside it when there is one (a later page may start at 26, for example); " +
                  "when a page has no printed numbers, keep counting on from the last question of the page before. Do not skip or merge questions, and do not treat titles or instructions as questions.",
              },
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
  const out = answers.map((a, i) => ({
    number: Number.isInteger(a.number) && a.number > 0 ? a.number : i + 1,
    question: a.question.replace(/^\s*\d+[.)]\s*/, ""),
    answer: a.answer.replace(/\bp\.t\./gi, "pertaining to"),
  }));
  // Photos uploaded out of order are put right, but only when every number is distinct;
  // repeated numbers mean separate sections, which stay in the order they were read.
  if (new Set(out.map((a) => a.number)).size === out.length) out.sort((a, b) => a.number - b.number);
  return out;
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
  if (STRONG) {
    try {
      const answers = await ask(STRONG, key, images, STRONG_WAIT_MS);
      return res.status(200).json({ answers, model: STRONG });
    } catch {}
  }
  try {
    res.status(200).json(await backup);
  } catch (e) {
    res.status(502).json({ error: e.message || "Solve failed" });
  }
}
