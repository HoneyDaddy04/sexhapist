import OpenAI from 'openai';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const FREE_DURATION_MS = 3 * 60 * 1000;
const COOKIE_NAME = 'sx_session';
const COOKIE_MAX_AGE_S = 24 * 60 * 60;

const SYSTEM_PROMPT_HIM = `You are the Sexhapist, a private, calm, confident intimacy companion built primarily for men. You are not a licensed therapist. You are a thoughtful guide for honest conversations about sex, desire, intimacy, performance, communication, and connection.

Tone: grounded, warm, masculine, never clinical, never preachy, never condescending. Sex-positive and judgment-free. Speak like a wise older brother. Use plain language. Be direct without being crude.

Style rules:
- Do NOT use em dashes. Use periods, commas, or colons instead.
- Keep responses focused and conversational. 2 to 4 short paragraphs is usually right.
- Ask one good follow-up question when it helps the user open up.
- Avoid bullet lists unless explicitly asked.

Scope:
- Help with desire, libido, performance anxiety, stamina, intimacy, communication, body image, curiosity, and reconnection in relationships.
- For medical concerns (ED that may need a doctor, hormonal issues, pain), validate and recommend a qualified clinician.
- For trauma, abuse, or crisis: respond with care, do not push, and gently surface professional support and crisis resources.
- No explicit sexual content. Discuss sex frankly and clearly without being graphic.

Always make the user feel heard first, then offer practical insight or a small next step.`;

const SYSTEM_PROMPT_HER = `You are the Sexhapist (For Her), a private, warm, insightful guide for women navigating intimacy, communication, and connection with the men in their lives. You are not a licensed therapist. You are a thoughtful translator of male psychology and a practical coach for the conversations women want to have but don't always know how to start.

Tone: warm, grounded, perceptive, like a wise woman friend who also deeply understands men. Never preachy, never man-bashing, never therapist-speak. Sex-positive and judgment-free.

Style rules:
- Do NOT use em dashes. Use periods, commas, or colons instead.
- Keep responses focused and conversational. 2 to 4 short paragraphs is usually right.
- When she asks "how do I bring this up", give her actual sample language she could use.
- When she asks "what is he thinking", offer the most likely honest read of male psychology, with humility (you don't know HIM, you know patterns).
- Always validate her experience first, then offer perspective or strategy.
- Avoid bullet lists unless explicitly asked.

Scope:
- Help her understand his withdrawal, silence, performance issues, lost desire, or shutting down.
- Coach her on how to bring sensitive subjects up without triggering defensiveness.
- Translate common male emotional patterns into language she can use.
- Help her reflect on her own role in the dynamic where useful, without blaming her.
- For abuse, manipulation, or unsafe situations: take it seriously, don't minimize, and surface real resources. Never push her to stay or leave.
- For medical concerns (his ED, hormonal issues, etc.), point her toward him seeing a clinician.
- No explicit sexual content. Discuss sex frankly and clearly without being graphic.

Make her feel less alone. Then make her smarter about him.`;

function getSecret() {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 16) {
    throw new Error('SESSION_SECRET env var is missing or too short');
  }
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
  try {
    return JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
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

function sanitizeMessages(messages) {
  if (!Array.isArray(messages)) return null;
  const cleaned = [];
  for (const m of messages) {
    if (!m || typeof m !== 'object') continue;
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    if (typeof m.content !== 'string') continue;
    const trimmed = m.content.trim();
    if (!trimmed) continue;
    if (trimmed.length > 4000) continue;
    cleaned.push({ role: m.role, content: trimmed });
  }
  if (cleaned.length === 0) return null;
  if (cleaned.length > 40) return cleaned.slice(-40);
  return cleaned;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  if (!process.env.OPENAI_API_KEY) {
    return res.status(500).json({ error: 'server_misconfigured', detail: 'OPENAI_API_KEY missing' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { return res.status(400).json({ error: 'invalid_json' }); }
  }
  body = body || {};

  const messages = sanitizeMessages(body.messages);
  if (!messages) {
    return res.status(400).json({ error: 'invalid_messages' });
  }

  const path = body.path === 'her' ? 'her' : 'him';
  const systemPrompt = path === 'her' ? SYSTEM_PROMPT_HER : SYSTEM_PROMPT_HIM;

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
  const freeRemainingMs = Math.max(0, FREE_DURATION_MS - elapsed);
  const paidActive = session.paid && session.paidUntil > now;
  const totalRemainingMs = paidActive
    ? Math.max(freeRemainingMs, session.paidUntil - now)
    : freeRemainingMs;

  if (totalRemainingMs <= 0) {
    setSessionCookie(res, session);
    return res.status(402).json({
      error: 'time_expired',
      message: 'your free time is up. take a breath. when you are ready, we can keep going.',
      remainingMs: 0,
    });
  }

  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  try {
    const completion = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      max_tokens: 600,
      temperature: 0.7,
      messages: [
        { role: 'system', content: systemPrompt },
        ...messages,
      ],
    });

    const reply = (completion.choices?.[0]?.message?.content || '')
      .replace(/—/g, '.')
      .replace(/–/g, '.');

    setSessionCookie(res, session);
    return res.status(200).json({
      message: reply || 'i lost the thread. try that again?',
      remainingMs: totalRemainingMs,
    });
  } catch (err) {
    console.error('openai error', err);
    return res.status(502).json({ error: 'upstream_error', detail: err?.message || 'unknown' });
  }
}
