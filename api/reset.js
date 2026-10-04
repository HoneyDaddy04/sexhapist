import { applyCors, checkCsrf } from '../lib/cors.js';
import { ensureConfigured, peekBudget, clearCookie } from '../lib/session.js';

// POST /api/reset
// Clears the session cookie ONLY if the caller's budget is fully used up
// (so a mid-session refresh doesn't lose ongoing free time).
//
// NOTE (B2-1): clearing the cookie does NOT grant fresh free time, because the
// free budget is the server-side IP record (see lib/session.js), which is not
// affected by this endpoint. This only tidies up the client cookie.
export default async function handler(req, res) {
  if (applyCors(req, res)) return; // B1-3
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }
  if (!ensureConfigured(res)) return; // B1-4
  if (!checkCsrf(req)) return res.status(403).json({ error: 'forbidden' }); // B2-6

  const { hasSession, seen, totalRemainingMs } = await peekBudget(req);

  if (!hasSession && !seen) {
    return res.status(200).json({ status: 'no_session' });
  }

  if (totalRemainingMs <= 0) {
    clearCookie(res); // uses cookieSameSite() via shared helper (B1-3)
    return res.status(200).json({ status: 'reset' });
  }

  return res.status(200).json({ status: 'kept' });
}
