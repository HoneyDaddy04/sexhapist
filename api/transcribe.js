import OpenAI from 'openai';
import { toFile } from 'openai/uploads';
import { applyCors, checkCsrf } from '../lib/cors.js';
import { ensureConfigured, loadBudget, setSessionCookie } from '../lib/session.js';
import { enforceRateLimit } from '../lib/ratelimit.js';
import { withTimeout } from '../lib/safety.js';

const MAX_AUDIO_BYTES = 6 * 1024 * 1024;

// Allowed inbound audio content types (B3-2).
const ALLOWED_AUDIO_TYPES = ['audio/webm', 'audio/mp4', 'audio/mpeg', 'audio/ogg', 'audio/wav'];

export const config = {
  api: {
    // bodyParser:false means Vercel does not parse the body; we read the raw
    // stream ourselves and enforce MAX_AUDIO_BYTES below. Note: the old
    // `sizeLimit` here was dead config (it only applies when bodyParser is on),
    // so it has been removed. The real cap is MAX_AUDIO_BYTES in readBody().
    bodyParser: false,
  },
};

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
  if (!ensureConfigured(res)) return; // B1-4
  if (!checkCsrf(req)) return res.status(403).json({ error: 'forbidden' }); // B2-6

  const useOpenRouter = !!process.env.OPENROUTER_API_KEY;
  if (!useOpenRouter && !process.env.OPENAI_API_KEY) {
    return res.status(500).json({ error: 'server_misconfigured' });
  }

  // Reject unsupported content types up front (B3-2).
  const rawCt = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (!ALLOWED_AUDIO_TYPES.includes(rawCt)) {
    return res.status(415).json({ error: 'unsupported_media_type' });
  }

  // Cheap checks before reading the (large) body / calling upstream (B1-6).
  if (await enforceRateLimit(req, res, 'transcribe')) return;

  // Server-side IP-keyed budget (B2-1/B2-3).
  const { session, totalRemainingMs } = await loadBudget(req);
  if (totalRemainingMs <= 0) {
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
    const result = await withTimeout((signal) => client.audio.transcriptions.create({
      file,
      model: useOpenRouter
        ? (process.env.OPENROUTER_TRANSCRIBE_MODEL || 'openai/gpt-4o-mini-transcribe')
        : (process.env.TRANSCRIBE_MODEL || 'whisper-1'),
      language: 'en',
      prompt: 'Conversational Nigerian English. May include some Pidgin like "i dey hear", "wahala", "abi", "sef".',
    }, { signal }));
    setSessionCookie(res, session);
    return res.status(200).json({ text: (result.text || '').trim() });
  } catch (err) {
    console.error('transcribe error', err);
    if (err?.isTimeout) return res.status(504).json({ error: 'upstream_timeout' });
    return res.status(502).json({ error: 'transcribe_failed' });
  }
}
