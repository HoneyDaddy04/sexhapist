import { applyCors } from '../lib/cors.js';
import { ensureConfigured, peekBudget, FREE_DURATION_MS } from '../lib/session.js';

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

  const { hasSession, seen, totalRemainingMs, paidActive, firstSeenAt } = await peekBudget(req);

  // hasSession reflects whether the server has started this caller's clock
  // (either a valid cookie exists OR the IP has a firstSeenAt record).
  const started = hasSession || seen;
  if (!started) {
    return res.status(200).json({
      hasSession: false,
      remainingMs: FREE_DURATION_MS,
      freeBudgetMs: FREE_DURATION_MS,
      paid: false,
    });
  }

  return res.status(200).json({
    hasSession: true,
    remainingMs: totalRemainingMs,
    freeBudgetMs: FREE_DURATION_MS,
    paid: paidActive,
    startedAt: firstSeenAt,
  });
}
