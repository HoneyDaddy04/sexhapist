import { applyCors, checkCsrf } from '../lib/cors.js';
import { ensureConfigured, loadBudget, setSessionCookie } from '../lib/session.js';
import { enforceRateLimit } from '../lib/ratelimit.js';
import { SYSTEM_PROMPT_HER, SYSTEM_PROMPT_HIM, LIVE_CALL_ADDENDUM } from '../lib/prompts.js';

// POST /api/realtime  { path, voice }          -> { client_secret, remainingMs }
// POST /api/realtime  { beat: true }           -> { remainingMs, needsEmail }
//
// Live calls run on Opper's realtime gateway (openai/gpt-realtime-2). The
// browser can't hold our API key, so we mint a single-use ticket here with the
// model, voice and therapist instructions locked in. While a call is open the
// browser sends a heartbeat every ~15s; that is what counts call time against
// the free budget (see lib/session.js).

const MODEL = process.env.OPPER_REALTIME_MODEL || 'openai/gpt-realtime-2';
export const LIVE_VOICES = ['marin', 'cedar', 'sage', 'coral', 'shimmer', 'ash', 'ballad', 'verse'];
const DEFAULT_LIVE_VOICE = { her: 'marin', him: 'cedar' };

export default async function handler(req, res) {
  if (applyCors(req, res)) return;
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }
  if (!ensureConfigured(res)) return;
  if (!checkCsrf(req)) return res.status(403).json({ error: 'forbidden' });
  if (!process.env.OPPER_API_KEY) return res.status(503).json({ error: 'realtime_disabled' });
  if (await enforceRateLimit(req, res, 'realtime')) return;

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { return res.status(400).json({ error: 'invalid_json' }); }
  }
  body = body || {};

  const b = await loadBudget(req);
  setSessionCookie(res, b.session);
  if (b.totalRemainingMs <= 0) {
    return res.status(402).json({ error: b.needsEmail ? 'email_required' : 'time_expired', remainingMs: 0 });
  }
  if (body.beat) {
    return res.status(200).json({ remainingMs: b.totalRemainingMs, usedMs: b.sessionUsedMs, freeBudgetMs: b.limitMs });
  }

  const path = body.path === 'her' ? 'her' : 'him';
  const voice = LIVE_VOICES.includes(body.voice) ? body.voice : DEFAULT_LIVE_VOICE[path];
  const instructions = (path === 'her' ? SYSTEM_PROMPT_HER : SYSTEM_PROMPT_HIM) + LIVE_CALL_ADDENDUM;

  try {
    const r = await fetch('https://api.opper.ai/v3/realtime-sessions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.OPPER_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        config: {
          model: MODEL,
          voice,
          instructions,
          reasoning_effort: process.env.OPPER_REALTIME_REASONING || 'minimal',
          input_transcription: true,
          output_transcription: true,
          turn_detection: { type: 'server_vad', threshold: 0.55, prefix_padding_ms: 300, silence_duration_ms: 550 },
        },
        // The browser cannot change any of these after the ticket is minted.
        locked_fields: ['model', 'voice', 'instructions', 'tools'],
        ttl_seconds: 60,
      }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.client_secret) {
      console.error('realtime mint failed', r.status, JSON.stringify(j).slice(0, 300));
      return res.status(502).json({ error: 'realtime_unavailable' });
    }
    return res.status(200).json({
      client_secret: j.client_secret,
      ws_url: 'wss://api.opper.ai/v3/realtime',
      voice,
      remainingMs: b.totalRemainingMs,
      usedMs: b.sessionUsedMs,
      freeBudgetMs: b.limitMs,
    });
  } catch (err) {
    console.error('realtime mint error', err?.message || err);
    return res.status(502).json({ error: 'realtime_unavailable' });
  }
}
