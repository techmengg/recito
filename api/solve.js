import Anthropic from "@anthropic-ai/sdk";
import SYSTEM from "./_prompt.js";

const client = new Anthropic();
const MODEL = process.env.SOLVE_MODEL || "claude-opus-5-5";
const EFFORT = process.env.SOLVE_EFFORT || "low";

const SCHEMA = {
  type: "object",
  properties: {
    answers: {
      type: "array",
      items: {
        type: "object",
        properties: {
          question: { type: "string", description: "The term or question exactly as printed" },
          answer: { type: "string" },
        },
        required: ["question", "answer"],
        additionalProperties: false,
      },
    },
  },
  required: ["answers"],
  additionalProperties: false,
};

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  if (process.env.ACCESS_CODE && req.headers["x-code"] !== process.env.ACCESS_CODE)
    return res.status(401).json({ error: "Wrong access code" });
  if (!process.env.ANTHROPIC_API_KEY)
    return res.status(500).json({ error: "ANTHROPIC_API_KEY is not set on the server" });

  const images = Array.isArray(req.body?.images) ? req.body.images.slice(0, 6) : [];
  if (!images.length) return res.status(400).json({ error: "No images" });

  try {
    const msg = await client.beta.messages
      .stream({
        model: MODEL,
        max_tokens: 8000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
        output_config: { effort: EFFORT, format: { type: "json_schema", schema: SCHEMA } },
        messages: [
          {
            role: "user",
            content: [
              ...images.map((data) => ({
                type: "image",
                source: { type: "base64", media_type: "image/jpeg", data },
              })),
              { type: "text", text: "Answer every question shown, in order." },
            ],
          },
        ],
      })
      .finalMessage();

    if (msg.stop_reason === "refusal")
      return res.status(502).json({ error: "The model declined this request" });
    const text = msg.content.find((b) => b.type === "text")?.text;
    const { answers } = JSON.parse(text);
    res.status(200).json({ answers });
  } catch (e) {
    const status = e instanceof Anthropic.APIError ? e.status || 502 : 500;
    res.status(status >= 400 ? status : 502).json({ error: e.message || "Solve failed" });
  }
}
