import { applyCors, checkCsrf } from '../lib/cors.js';
import { ensureConfigured, parseCookies, verify, newSession, COOKIE_NAME, setSessionCookie, budgetForSession } from '../lib/session.js';
import { enforceRateLimit } from '../lib/ratelimit.js';
import { normalizeEmail, saveEmail } from '../lib/emails.js';

// POST /api/unlock  { email, path }
// Captures an email and lifts the per-session free limit for this session.
// The per-IP total (IP_FREE_MS) still applies. See lib/session.js.
export default async function handler(req, res) {
  if (applyCors(req, res)) return;
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }
  if (!ensureConfigured(res)) return;
  if (!checkCsrf(req)) return res.status(403).json({ error: 'forbidden' });
  if (await enforceRateLimit(req, res, 'unlock')) return;

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { return res.status(400).json({ error: 'invalid_json' }); }
  }
  body = body || {};

  const email = normalizeEmail(body.email);
  if (!email) return res.status(400).json({ error: 'invalid_email' });

  await saveEmail(email, body.path);

  const session = verify(parseCookies(req.headers.cookie)[COOKIE_NAME]) || newSession();
  session.email = true; // only the flag lives in the cookie, never the address
  setSessionCookie(res, session);

  const b = await budgetForSession(req, session);
  return res.status(200).json({
    ok: true,
    remainingMs: b.totalRemainingMs,
    usedMs: b.sessionUsedMs,
    freeBudgetMs: b.limitMs,
    ipRemainingMs: b.ipRemainingMs,
    emailUnlocked: true,
  });
}
