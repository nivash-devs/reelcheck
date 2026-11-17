// Reviews a reel from up to 5 still frames using a Groq vision model.
// Needs the GROQ_API_KEY environment variable, set in Vercel's project settings.

const MODEL = process.env.GROQ_MODEL || "qwen/qwen3.8-27b";
const GROQ_URL = (process.env.GROQ_BASE_URL || "https://api.groq.com/openai/v1") + "/chat/completions";
const MAX_FRAMES = 5;
const MAX_FRAME_CHARS = 1_400_000; // about 1 MB of JPEG per frame, base64
const GOALS = ["Grow followers", "Launch or promote a product", "Teach something", "Entertain", "Sell something"];

// Simple per-instance limit so one person can't drain the free quota. Resets when the server restarts.
const hits = new Map();
function limited(ip) {
  const now = Date.now(), windowMs = 10 * 60 * 1000, max = 8;
  const list = (hits.get(ip) || []).filter((t) => now - t < windowMs);
  list.push(now);
  hits.set(ip, list);
  return list.length > max;
}

function fmt(t) {
  const m = Math.floor(t / 60), s = (t - m * 60).toFixed(1);
  return `${m}:${s < 10 ? "0" : ""}${s}`;
}

function buildPrompt(b) {
  const stamps = b.frames.map((f, i) => `Image ${i + 1} = ${fmt(f.t)}`).join(", ");
  const vertical = Math.abs(b.width / b.height - 9 / 16) < 0.03;
  const cap = typeof b.caption === "string" ? b.caption.trim().slice(0, 600) : "";
  return [
    "You are an experienced short-form video editor reviewing an Instagram Reel before it's posted.",
    `You are given ${b.frames.length} still frames from the video, in order. Timestamps: ${stamps}.`,
    "You cannot hear audio or see motion between frames. Say so when the frames aren't enough to judge something; never guess about sound.",
    `Measured from the file: length ${b.duration.toFixed(1)}s, resolution ${b.width}x${b.height}${vertical ? " (9:16 vertical)" : " (NOT 9:16)"}.`,
    `The creator's goal: ${b.goal}.`,
    cap ? `Caption they plan to use: "${cap}"` : "They haven't written a caption yet.",
    "",
    "Review these checks, in this order, with these exact labels:",
    "1. Hook in the first second",
    "2. Something changes by 3 seconds",
    "3. On-screen text readable and in the safe zone (Instagram's buttons and caption cover roughly the top 13% and bottom 18% of the frame)",
    "4. Framed for vertical",
    "5. Lighting and focus",
    "6. Clear ending or call to action",
    "",
    "Every note must point at what is visible and cite timestamps like 0:02.0. Be direct and specific. No generic advice.",
    "",
    "Reply with only this JSON, nothing else:",
    '{"score": integer 0-100, "verdict": "one sentence on whether this will hold attention and why", "checks": [{"label": string, "status": "pass"|"warn"|"fail", "note": "one sentence"}], "fixes": ["up to 5 concrete edits, most important first"], "caption": "a better caption under 150 characters that fits the video"}',
  ].join("\n");
}

function parseJson(text) {
  const clean = String(text || "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  try { return JSON.parse(clean); } catch {}
  const fence = clean.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) { try { return JSON.parse(fence[1]); } catch {} }
  const a = clean.indexOf("{"), z = clean.lastIndexOf("}");
  if (a >= 0 && z > a) { try { return JSON.parse(clean.slice(a, z + 1)); } catch {} }
  return null;
}

function validate(b) {
  if (!b || typeof b !== "object") return "Send JSON.";
  if (!Array.isArray(b.frames) || b.frames.length < 1 || b.frames.length > MAX_FRAMES) return `Send 1 to ${MAX_FRAMES} frames.`;
  for (const f of b.frames) {
    if (!f || typeof f.t !== "number" || typeof f.image !== "string") return "Each frame needs t and image.";
    if (!/^data:image\/(jpeg|png|webp);base64,/.test(f.image)) return "Frames must be JPEG, PNG or WebP data URLs.";
    if (f.image.length > MAX_FRAME_CHARS) return "A frame is too large.";
  }
  for (const k of ["duration", "width", "height"]) if (!(typeof b[k] === "number" && b[k] > 0)) return `Missing ${k}.`;
  if (!GOALS.includes(b.goal)) b.goal = GOALS[0];
  return null;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST." });
  if (!process.env.GROQ_API_KEY) return res.status(500).json({ error: "The server has no GROQ_API_KEY set." });

  const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "unknown";
  if (limited(ip)) return res.status(429).json({ error: "Too many reviews in a short time. Try again in 10 minutes." });

  const body = typeof req.body === "string" ? (() => { try { return JSON.parse(req.body); } catch { return null; } })() : req.body;
  const bad = validate(body);
  if (bad) return res.status(400).json({ error: bad });

  const content = [{ type: "text", text: buildPrompt(body) }, ...body.frames.map((f) => ({ type: "image_url", image_url: { url: f.image } }))];

  let r;
  try {
    r = await fetch(GROQ_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
      body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content }], temperature: 0.4, max_completion_tokens: 1500 }),
    });
  } catch {
    return res.status(502).json({ error: "Couldn't reach the AI service. Try again." });
  }
  if (r.status === 429) return res.status(429).json({ error: "The free AI quota is used up for now. Try again later." });
  if (!r.ok) {
    const detail = await r.text().catch(() => "");
    console.error("Groq error", r.status, detail.slice(0, 500));
    let msg = "";
    try { msg = JSON.parse(detail)?.error?.message || ""; } catch {}
    return res.status(502).json({ error: `The AI service returned an error (${r.status}${msg ? ": " + msg.slice(0, 200) : ""}).` });
  }
  const data = await r.json();
  const review = parseJson(data?.choices?.[0]?.message?.content);
  if (!review || typeof review !== "object") return res.status(502).json({ error: "The review came back garbled. Try again." });
  return res.status(200).json(review);
}
