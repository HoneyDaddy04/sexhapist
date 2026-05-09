import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const COOKIE_NAME = 'sx_session';
const COOKIE_MAX_AGE_S = 24 * 60 * 60;
const FREE_DURATION_MS = 3 * 60 * 1000;

const VOICE_HIM = process.env.VOICE_ID_HIM || 'ErXwobaYiN019PkySvjV';
const VOICE_HER = process.env.VOICE_ID_HER || 'EXAVITQu4vr4xnSDxMAL';

function getSecret() {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 16) throw new Error('SESSION_SECRET missing');
  return s;
}

function sign(payload) {
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = createHmac('sha256', getSecret()).update(data).digest('base64url');
  return `${data}.${sig}`;
}

function verify(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [data, sig] = parts;
  const expected = createHmac('sha256', getSecret()).update(data).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try { return JSON.parse(Buffer.from(data, 'base64url').toString('utf8')); }
  catch { return null; }
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = v;
  }
  return out;
}

function setSessionCookie(res, session) {
  const value = sign(session);
  const cookie = [
    `${COOKIE_NAME}=${value}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    `Max-Age=${COOKIE_MAX_AGE_S}`,
  ].join('; ');
  res.setHeader('Set-Cookie', cookie);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  if (!process.env.ELEVENLABS_API_KEY) {
    return res.status(503).json({ error: 'voice_disabled' });
  }

  const cookies = parseCookies(req.headers.cookie);
  let session = verify(cookies[COOKIE_NAME]);
  const now = Date.now();
  if (!session) {
    session = {
      id: randomBytes(8).toString('hex'),
      startedAt: now,
      paid: false,
      paidUntil: 0,
    };
  }
  const elapsed = now - session.startedAt;
  const freeRemaining = FREE_DURATION_MS - elapsed;
  const paidActive = session.paid && session.paidUntil > now;
  if (freeRemaining <= 0 && !paidActive) {
    setSessionCookie(res, session);
    return res.status(402).json({ error: 'time_expired' });
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
  const voiceId = path === 'her' ? VOICE_HER : VOICE_HIM;

  try {
    const upstream = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
      method: 'POST',
      headers: {
        'xi-api-key': process.env.ELEVENLABS_API_KEY,
        'Content-Type': 'application/json',
        'Accept': 'audio/mpeg',
      },
      body: JSON.stringify({
        text,
        model_id: 'eleven_turbo_v2_5',
        voice_settings: { stability: 0.5, similarity_boost: 0.75 },
      }),
    });

    if (!upstream.ok) {
      const detail = await upstream.text().catch(() => '');
      return res.status(502).json({ error: 'voice_upstream_error', status: upstream.status, detail: detail.slice(0, 300) });
    }

    const buf = Buffer.from(await upstream.arrayBuffer());
    setSessionCookie(res, session);
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).send(buf);
  } catch (err) {
    console.error('voice error', err);
    return res.status(502).json({ error: 'voice_failed', detail: err?.message || 'unknown' });
  }
}
