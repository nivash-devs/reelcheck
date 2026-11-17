// Reviews a reel from up to 6 still frames (sent as up to 3 side-by-side images)
// plus, when available, a transcript of the first 20 seconds of audio.
// Needs the GROQ_API_KEY environment variable, set in Vercel's project settings.

const BASE = process.env.GROQ_BASE_URL || "https://api.groq.com/openai/v1";
const VISION_MODEL = process.env.GROQ_MODEL || "qwen/qwen3.8-27b";
const STT_MODEL = process.env.GROQ_STT_MODEL || "whisper-large-v3-turbo";
const MAX_SHEETS = 3; // the vision model accepts at most 3 images per request
const MAX_PER_SHEET = 3;
const MAX_IMAGE_CHARS = 1_400_000; // about 1 MB of JPEG per image, base64
const MAX_WAV_CHARS = 1_500_000; // 20 s of 16 kHz mono 16-bit audio is about 850k chars of base64
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

// Turns the first seconds of audio into text with timestamps. Returns the segments, or null if it failed.
async function transcribe(b64) {
  const buf = Buffer.from(b64, "base64");
  if (buf.length < 44 || buf.toString("ascii", 0, 4) !== "RIFF") return null;
  const form = new FormData();
  form.append("file", new Blob([buf], { type: "audio/wav" }), "audio.wav");
  form.append("model", STT_MODEL);
  form.append("response_format", "verbose_json");
  form.append("temperature", "0");
  let r;
  try {
    r = await fetch(`${BASE}/audio/transcriptions`, { method: "POST", headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` }, body: form });
  } catch { return null; }
  if (!r.ok) {
    console.error("Groq STT error", r.status, (await r.text().catch(() => "")).slice(0, 300));
    return null;
  }
  const d = await r.json().catch(() => null);
  if (!d || !Array.isArray(d.segments)) return null;
  // Whisper invents text over silence and music. Drop segments it isn't confident contain speech.
  return d.segments
    .filter((s) => (s.no_speech_prob == null || s.no_speech_prob < 0.6) && (s.avg_logprob == null || s.avg_logprob > -1.2))
    .map((s) => ({ t: Number(s.start) || 0, text: String(s.text || "").trim().slice(0, 200) }))
    .filter((s) => s.text)
    .slice(0, 12);
}

function audioLines(a) {
  if (a.status === "heard") {
    return ["Speech heard in the first 20 seconds, with start times:", ...a.segments.map((s) => `${fmt(s.t)} "${s.text}"`), "Judge whether the opening words work as a hook."];
  }
  if (a.status === "silent") return ["Audio: no speech was detected in the first 20 seconds (silence, or music only). Don't comment on sound beyond that."];
  return ["Audio: not available for this video. Don't comment on sound or speech."];
}

function buildPrompt(b, a) {
  const total = b.sheets.reduce((n, s) => n + s.times.length, 0);
  const stamps = b.sheets.map((s, i) => `Image ${i + 1}: ${s.times.map(fmt).join(" (left), ") + (s.times.length > 1 ? " (right)" : "")}`).join("; ");
  const vertical = Math.abs(b.width / b.height - 9 / 16) < 0.03;
  const cap = typeof b.caption === "string" ? b.caption.trim().slice(0, 600) : "";
  const checks = [
    "Hook in the first second",
    "Something changes by 3 seconds",
    "On-screen text readable and in the safe zone (Instagram's buttons and caption cover roughly the top 13% and bottom 18% of the frame)",
    "Framed for vertical",
    "Lighting and focus",
    "Clear ending or call to action",
  ];
  if (a.status === "heard") checks.push("Audio and first words");
  return [
    "You are an experienced short-form video editor reviewing an Instagram Reel before it's posted.",
    `You are given ${total} still frames from the video in ${b.sheets.length} images. Each image shows frames side by side, left to right in time order, with its timestamp printed in the top-left corner. White gaps separate frames and are not part of the video. ${stamps}.`,
    "You cannot see motion between frames. Say so when the frames aren't enough to judge something.",
    `Measured from the file: length ${b.duration.toFixed(1)}s, resolution ${b.width}x${b.height}${vertical ? " (9:16 vertical)" : " (NOT 9:16)"}.`,
    ...audioLines(a),
    `The creator's goal: ${b.goal}.`,
    cap ? `Caption they plan to use: "${cap}"` : "They haven't written a caption yet.",
    "",
    "Review these checks, in this order, with these exact labels:",
    ...checks.map((c, i) => `${i + 1}. ${c}`),
    "",
    "Be direct and specific, like a friend who edits for a living. No generic advice.",
    "Keep every note to 12 words or fewer, and cite a timestamp like 0:02.0 where it helps. The verdict is 20 words or fewer. Each fix is 14 words or fewer. Give at most 4 fixes. The caption is under 120 characters.",
    "",
    "Reply with only this JSON, nothing else:",
    '{"score": integer 0-100, "verdict": "whether this will hold attention and why", "checks": [{"label": string, "status": "pass"|"warn"|"fail", "note": "short note"}], "fixes": ["most important first"], "caption": "a better caption that fits the video"}',
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
  if (!Array.isArray(b.sheets) || b.sheets.length < 1 || b.sheets.length > MAX_SHEETS) return `Send 1 to ${MAX_SHEETS} images.`;
  for (const s of b.sheets) {
    if (!s || typeof s.image !== "string" || !Array.isArray(s.times) || s.times.length < 1 || s.times.length > MAX_PER_SHEET || !s.times.every((t) => typeof t === "number")) return "Each image needs times and image.";
    if (!/^data:image\/(jpeg|png|webp);base64,/.test(s.image)) return "Images must be JPEG, PNG or WebP data URLs.";
    if (s.image.length > MAX_IMAGE_CHARS) return "An image is too large.";
  }
  for (const k of ["duration", "width", "height"]) if (!(typeof b[k] === "number" && b[k] > 0)) return `Missing ${k}.`;
  if (b.audio != null) {
    if (typeof b.audio !== "object" || typeof b.audio.wav !== "string" || b.audio.wav.length > MAX_WAV_CHARS) return "The audio is invalid or too large.";
  }
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

  // Audio: transcribe the first seconds if the browser sent them.
  let audio = { status: body.audioStatus === "silent" ? "silent" : "none", segments: [] };
  if (body.audio) {
    const segs = await transcribe(body.audio.wav);
    if (segs === null) audio = { status: "unavailable", segments: [] };
    else if (segs.length === 0) audio = { status: "silent", segments: [] };
    else audio = { status: "heard", segments: segs };
  }

  const content = [{ type: "text", text: buildPrompt(body, audio) }, ...body.sheets.map((s) => ({ type: "image_url", image_url: { url: s.image } }))];

  let r;
  try {
    r = await fetch(`${BASE}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
      body: JSON.stringify({ model: VISION_MODEL, messages: [{ role: "user", content }], temperature: 0.4, max_completion_tokens: 1500 }),
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
  return res.status(200).json({ ...review, audio: audio.status, heard: audio.segments });
}
