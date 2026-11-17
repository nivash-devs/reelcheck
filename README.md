# Reelcheck

Know if your Instagram reel works before you post it.

Drop in a vertical video. Reelcheck pulls 6 frames (0s, 1s, 3s, halfway, 80% and the end) and pairs them side by side into 3 images, checks the aspect ratio and resolution, and has an AI vision model review the hook, pacing, text placement, framing and ending. You get a score out of 100, pass/warn/fail checks with timestamps, the top fixes and a better caption.

The video never leaves your device. Only the 6 still frames are sent for review.

## How it works

- `index.html` is the whole site. It reads the video in the browser and grabs frames with a canvas.
- `api/review.js` is a Vercel serverless function. It sends the frames to Groq's vision model and returns the review as JSON. The API key stays on the server.

## Deploy on Vercel

1. Import this repo in Vercel. No build settings needed.
2. In the project's Settings → Environment Variables, add `GROQ_API_KEY` with your key from console.groq.com.
3. Deploy.

Optional: set `GROQ_MODEL` to use a different Groq vision model (default `qwen/qwen3.8-27b`).

## Limits

- The AI sees still frames, not motion or sound, so it can't judge audio, music or transitions.
- The default Groq model takes at most 3 images per request, which is why frames are paired.
- Each server instance allows 8 reviews per visitor per 10 minutes to protect the free quota.

## License

MIT
