import OpenAI from 'openai';
import { applyCors, checkCsrf } from '../lib/cors.js';
import { ensureConfigured, loadBudget, setSessionCookie } from '../lib/session.js';
import { enforceRateLimit } from '../lib/ratelimit.js';
import { withTimeout, moderateText, CRISIS_MESSAGE } from '../lib/safety.js';
import { SYSTEM_PROMPT_HER, SYSTEM_PROMPT_HIM } from '../lib/prompts.js';

// Sanitize the client-supplied transcript.
//
// SECURITY (B2-4): we keep client-provided assistant turns ONLY as conversational
// context, but the system prompt remains authoritative (always prepended,
// server-side) and we drop any client "assistant" content that looks like an
// attempt to inject instructions/role overrides. We never let the client send
// `system` turns. The latest user message is additionally run through the
// moderation endpoint in the handler.
const ASSISTANT_INJECTION_RE = /(ignore (all|previous|the) (instructions|rules)|you are now|system prompt|disregard (the|your))/i;

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
    // Do not trust client-faked assistant turns that try to override safety framing.
    if (m.role === 'assistant' && ASSISTANT_INJECTION_RE.test(trimmed)) continue;
    cleaned.push({ role: m.role, content: trimmed });
  }
  if (cleaned.length === 0) return null;
  if (cleaned.length > 40) return cleaned.slice(-40);
  return cleaned;
}

// Never let a dash reach the screen or the voice, even if the model slips.
const cleanText = (t) => t.replace(/\s*[\u2014\u2013]\s*/g, ', ');

// Chat provider, in order of preference. Opper exposes an OpenAI-compatible API,
// so the same SDK works; we try the primary model, then a cheaper fallback.
function chatProvider() {
  if (process.env.OPPER_API_KEY) {
    return {
      name: 'opper',
      client: new OpenAI({ apiKey: process.env.OPPER_API_KEY, baseURL: 'https://api.opper.ai/v3/compat' }),
      models: [process.env.OPPER_MODEL || 'openai/gpt-6-sol', process.env.OPPER_FALLBACK_MODEL || 'openai/gpt-6-luna'],
      extra: { reasoning_effort: process.env.OPPER_REASONING || 'none' },
    };
  }
  if (process.env.OPENROUTER_API_KEY) {
    return {
      name: 'openrouter',
      client: new OpenAI({
        apiKey: process.env.OPENROUTER_API_KEY,
        baseURL: 'https://openrouter.ai/api/v1',
        defaultHeaders: { 'HTTP-Referer': process.env.OPENROUTER_REFERER || 'https://sexhapist.com', 'X-Title': 'Sexhapist' },
      }),
      models: [process.env.OPENROUTER_MODEL || 'openai/gpt-4o'],
    };
  }
  if (process.env.OPENAI_API_KEY) {
    return { name: 'openai', client: new OpenAI({ apiKey: process.env.OPENAI_API_KEY }), models: [process.env.CHAT_MODEL || 'gpt-4o-mini'] };
  }
  return null;
}

// Latest user message, for the moderation pass.
function latestUserMessage(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') return messages[i].content;
  }
  return '';
}

export default async function handler(req, res) {
  if (applyCors(req, res)) return;
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }
  // Validate config up front (B1-4).
  if (!ensureConfigured(res)) return;
  // Lightweight CSRF defense (B2-6).
  if (!checkCsrf(req)) return res.status(403).json({ error: 'forbidden' });

  const provider = chatProvider();
  if (!provider) return res.status(500).json({ error: 'server_misconfigured' });

  // Cheap checks before expensive work (B1-6): rate limit first.
  if (await enforceRateLimit(req, res, 'chat')) return;

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

  // Server-side, IP-keyed budget (B2-1/B2-3). Dropping the cookie does not reset it.
  const { session, totalRemainingMs, needsEmail } = await loadBudget(req);
  if (totalRemainingMs <= 0) {
    setSessionCookie(res, session);
    return res.status(402).json(needsEmail
      ? { error: 'email_required', message: 'add your email to keep talking.', remainingMs: 0 }
      : { error: 'time_expired', message: 'your free time is up. take a breath. when you are ready, we can keep going.', remainingMs: 0 });
  }

  const { client, models, extra = {} } = provider;
  // Moderation always runs on OpenAI (Opper/OpenRouter have no moderation endpoint).
  const modClient = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

  // Moderation pass on the latest user message (B2-4). If flagged for
  // self-harm/violence, return a safe crisis message instead of calling the model.
  const userText = latestUserMessage(messages);
  const moderationP = modClient ? moderateText(modClient, userText) : Promise.resolve({ flagged: false });

  if (body.stream !== true && (await moderationP).flagged) {
    setSessionCookie(res, session);
    return res.status(200).json({
      message: CRISIS_MESSAGE,
      remainingMs: totalRemainingMs,
      safety: true,
    });
  }

  // Optional SSE mode for the Clarity voice experience. Text arrives as the
  // model generates it so the client can render and speak sentence by sentence.
  if (body.stream === true) {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
    // Cookies are headers, so they must be set before the first res.write().
    setSessionCookie(res, session);
    let reply = '';
    let lastErr;
    let cleared = false;
    for (const model of models) {
      try {
        await withTimeout(async (signal) => {
          const stream = await client.chat.completions.create({
            model,
            max_tokens: 700,
            stream: true,
            ...extra,
            messages: [{ role: 'system', content: systemPrompt }, ...messages],
          }, { signal });
          for await (const chunk of stream) {
            const part = cleanText(chunk.choices?.[0]?.delta?.content || '');
            if (!part) continue;
            if (!cleared) {
              if ((await moderationP).flagged) { reply = CRISIS_MESSAGE; res.write(`data: ${JSON.stringify({ text: CRISIS_MESSAGE, safety: true })}\n\n`); break; }
              cleared = true;
            }
            reply += part;
            res.write(`data: ${JSON.stringify({ text: part })}\n\n`);
          }
        });
        res.write(`data: ${JSON.stringify({ done: true, remainingMs: totalRemainingMs, message: reply })}\n\n`);
        return res.end();
      } catch (err) {
        lastErr = err;
        console.error('chat stream error', model, err?.message || err);
        if (reply) break; // already streaming: do not splice in a second model
      }
    }
    res.write(`data: ${JSON.stringify({ error: lastErr?.isTimeout ? 'upstream_timeout' : 'upstream_error' })}\n\n`);
    return res.end();
  }

  let lastErr;
  for (const model of models) {
    try {
      const completion = await withTimeout((signal) => client.chat.completions.create({
        model,
        max_tokens: 700,
        ...extra,
        messages: [{ role: 'system', content: systemPrompt }, ...messages],
      }, { signal }));
      const reply = cleanText(completion.choices?.[0]?.message?.content || '');
      setSessionCookie(res, session);
      return res.status(200).json({ message: reply || 'i lost the thread. try that again?', remainingMs: totalRemainingMs });
    } catch (err) {
      lastErr = err;
      console.error('chat upstream error', model, err?.message || err);
    }
  }
  if (lastErr?.isTimeout) return res.status(504).json({ error: 'upstream_timeout' });
  return res.status(502).json({ error: 'upstream_error' });
}
