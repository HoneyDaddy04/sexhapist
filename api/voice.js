import { applyCors, checkCsrf } from '../lib/cors.js';
import { ensureConfigured, loadBudget, setSessionCookie } from '../lib/session.js';
import { enforceRateLimit } from '../lib/ratelimit.js';
import { withTimeout } from '../lib/safety.js';
import { Readable } from 'node:stream';
import { pickVoice } from '../lib/voices.js';

export default async function handler(req, res) {
  if (applyCors(req, res)) return; // B1-1
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }
  if (!ensureConfigured(res)) return; // B1-4
  if (!checkCsrf(req)) return res.status(403).json({ error: 'forbidden' }); // B2-6

  if (!process.env.ELEVENLABS_API_KEY) {
    return res.status(503).json({ error: 'voice_disabled' });
  }

  // Cheap checks before expensive work (B1-6).
  if (await enforceRateLimit(req, res, 'voice')) return;

  // Server-side IP-keyed budget (B2-1/B2-3).
  const { session, totalRemainingMs, needsEmail } = await loadBudget(req, { accrue: false });
  if (totalRemainingMs <= 0) {
    setSessionCookie(res, session);
    return res.status(402).json({ error: needsEmail ? 'email_required' : 'time_expired' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { return res.status(400).json({ error: 'invalid_json' }); }
  }
  body = body || {};

  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!text || text.length > 2000) {
    return res.status(400).json({ error: 'invalid_text' });
  }
  const path = body.path === 'her' ? 'her' : 'him';
  const voiceId = pickVoice(body.voice, path);

  try {
    await withTimeout(async (signal) => {
      const model = process.env.VOICE_MODEL || 'eleven_flash_v2_5';
      const upstream = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream?output_format=mp3_44100_64`, {
        method: 'POST',
        signal,
        headers: {
          'xi-api-key': process.env.ELEVENLABS_API_KEY,
          'Content-Type': 'application/json',
          'Accept': 'audio/mpeg',
        },
        body: JSON.stringify({
          text,
          model_id: model,
          // A steady, gentle delivery keeps speech calm and easy to follow.
          // Calm, unhurried therapist delivery.
          voice_settings: {
            stability: 0.62,
            similarity_boost: 0.8,
            style: 0.08,
            use_speaker_boost: true,
            speed: 0.94,
          },
        }),
      });

      if (!upstream.ok || !upstream.body) {
        const detail = await upstream.text().catch(() => '');
        console.error('voice upstream error', upstream.status, detail.slice(0, 300));
        throw new Error('voice_upstream_error');
      }

      setSessionCookie(res, session);
      res.setHeader('Content-Type', upstream.headers.get('content-type') || 'audio/mpeg');
      res.setHeader('Cache-Control', 'no-store, no-transform');
      res.setHeader('X-Accel-Buffering', 'no');
      res.statusCode = 200;
      res.flushHeaders?.();
      await new Promise((resolve, reject) => {
        const audioStream = Readable.fromWeb(upstream.body);
        audioStream.once('error', reject);
        res.once('error', reject);
        res.once('finish', resolve);
        audioStream.pipe(res);
      });
    });
  } catch (err) {
    console.error('voice error', err);
    if (!res.headersSent) {
      if (err?.isTimeout) return res.status(504).json({ error: 'upstream_timeout' });
      return res.status(502).json({ error: 'voice_failed' });
    }
    res.destroy(err);
  }
}
