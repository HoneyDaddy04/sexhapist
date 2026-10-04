import { applyCors } from '../lib/cors.js';
import { ensureConfigured, peekBudget, SESSION_FREE_MS, IP_FREE_MS } from '../lib/session.js';

// GET /api/session — reports the caller's remaining budget.
//
// Budget is the server-side, IP-keyed time-since-first-seen model documented in
// lib/session.js. This endpoint uses peekBudget() so a bare poll does NOT itself
// start the clock; the clock starts when the user actually uses chat/voice/
// transcribe (which call loadBudget()).
export default async function handler(req, res) {
  if (applyCors(req, res)) return; // B1-3
  // GET-only guard (B1-5).
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'method_not_allowed' });
  }
  if (!ensureConfigured(res)) return; // B1-4

  res.setHeader('Cache-Control', 'no-store');

  const b = await peekBudget(req);
  return res.status(200).json({
    hasSession: b.started,
    remainingMs: b.totalRemainingMs,
    usedMs: b.sessionUsedMs,
    freeBudgetMs: b.limitMs,
    sessionFreeMs: SESSION_FREE_MS,
    ipFreeMs: IP_FREE_MS,
    ipRemainingMs: b.ipRemainingMs,
    needsEmail: b.needsEmail,
    emailUnlocked: b.emailUnlocked,
    paid: b.paidActive,
  });
}
