import OpenAI from 'openai';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { toFile } from 'openai/uploads';
import { applyCors, cookieSameSite } from '../lib/cors.js';

const COOKIE_NAME = 'sx_session';
const COOKIE_MAX_AGE_S = 24 * 60 * 60;
const FREE_DURATION_MS = 3 * 60 * 1000;
const MAX_AUDIO_BYTES = 6 * 1024 * 1024;

export const config = {
  api: {
    bodyParser: false,
    sizeLimit: '8mb',
  },
};

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
    `SameSite=${cookieSameSite()}`,
    `Max-Age=${COOKIE_MAX_AGE_S}`,
  ].join('; ');
  res.setHeader('Set-Cookie', cookie);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (c) => {
      total += c.length;
      if (total > MAX_AUDIO_BYTES) {
        reject(new Error('audio_too_large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function extFromContentType(ct) {
  if (!ct) return 'webm';
  if (ct.includes('webm')) return 'webm';
  if (ct.includes('ogg')) return 'ogg';
  if (ct.includes('mp4')) return 'mp4';
  if (ct.includes('mpeg')) return 'mp3';
  if (ct.includes('wav')) return 'wav';
  return 'webm';
}

export default async function handler(req, res) {
  if (applyCors(req, res)) return;
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }
  const useOpenRouter = !!process.env.OPENROUTER_API_KEY;
  if (!useOpenRouter && !process.env.OPENAI_API_KEY) {
    return res.status(500).json({ error: 'server_misconfigured', detail: 'set OPENAI_API_KEY (Vercel) or OPENROUTER_API_KEY (proxy)' });
  }

  const cookies = parseCookies(req.headers.cookie);
  let session = verify(cookies[COOKIE_NAME]);
  const now = Date.now();
  if (!session) {
    session = { id: randomBytes(8).toString('hex'), startedAt: now, paid: false, paidUntil: 0 };
  }
  const elapsed = now - session.startedAt;
  const freeRemaining = FREE_DURATION_MS - elapsed;
  const paidActive = session.paid && session.paidUntil > now;
  if (freeRemaining <= 0 && !paidActive) {
    setSessionCookie(res, session);
    return res.status(402).json({ error: 'time_expired' });
  }

  let buffer;
  try {
    buffer = await readBody(req);
  } catch (err) {
    if (err?.message === 'audio_too_large') {
      return res.status(413).json({ error: 'audio_too_large' });
    }
    return res.status(400).json({ error: 'body_read_failed' });
  }

  if (!buffer || buffer.length < 1024) {
    return res.status(400).json({ error: 'audio_too_short' });
  }

  const ct = req.headers['content-type'] || 'audio/webm';
  const ext = extFromContentType(ct);

  try {
    const client = useOpenRouter
      ? new OpenAI({
          apiKey: process.env.OPENROUTER_API_KEY,
          baseURL: 'https://openrouter.ai/api/v1',
          defaultHeaders: {
            'HTTP-Referer': process.env.OPENROUTER_REFERER || 'https://sexhapist.com',
            'X-Title': 'Sexhapist',
          },
        })
      : new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const file = await toFile(buffer, `clip.${ext}`, { type: ct.split(';')[0] });
    const result = await client.audio.transcriptions.create({
      file,
      model: useOpenRouter
        ? (process.env.OPENROUTER_TRANSCRIBE_MODEL || 'openai/gpt-4o-mini-transcribe')
        : (process.env.TRANSCRIBE_MODEL || 'whisper-1'),
      language: 'en',
      prompt: 'Conversational Nigerian English. May include some Pidgin like "i dey hear", "wahala", "abi", "sef".',
    });
    setSessionCookie(res, session);
    return res.status(200).json({ text: (result.text || '').trim() });
  } catch (err) {
    console.error('transcribe error', err);
    return res.status(502).json({ error: 'transcribe_failed', detail: err?.message || 'unknown' });
  }
}
