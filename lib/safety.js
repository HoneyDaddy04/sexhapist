// lib/safety.js
// Shared upstream-call helpers: timeouts (B3-1) and OpenAI moderation (B2-4).

export const UPSTREAM_TIMEOUT_MS = 25_000;

// Run an async producer with an AbortController-based timeout. The producer
// receives an AbortSignal it should pass to fetch / the OpenAI SDK so the
// underlying request is actually cancelled. Throws an error tagged
// `.isTimeout = true` on timeout so callers can return 504.
export async function withTimeout(producer, ms = UPSTREAM_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await producer(controller.signal);
  } catch (err) {
    if (controller.signal.aborted) {
      const e = new Error('upstream_timeout');
      e.isTimeout = true;
      throw e;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// Run the latest user message through OpenAI's moderation endpoint. If it is
// flagged for self-harm or violence, we return a structured "blocked" result so
// the caller can respond with a safe crisis/refusal message instead of calling
// the chat model. (B2-4)
//
// Fails OPEN on errors/timeouts (moderation should not take down the product),
// but logs server-side.
//
// Returns: { flagged: boolean, categories: string[] }
const CRISIS_CATEGORIES = [
  'self-harm',
  'self-harm/intent',
  'self-harm/instructions',
  'violence',
  'violence/graphic',
];

export async function moderateText(client, text) {
  if (!text || typeof text !== 'string') return { flagged: false, categories: [] };
  try {
    const result = await withTimeout(
      (signal) => client.moderations.create(
        { model: 'omni-moderation-latest', input: text.slice(0, 4000) },
        { signal }
      ),
      10_000
    );
    const r = result?.results?.[0];
    if (!r) return { flagged: false, categories: [] };
    const cats = r.categories || {};
    const hit = CRISIS_CATEGORIES.filter((c) => cats[c]);
    return { flagged: hit.length > 0, categories: hit };
  } catch (err) {
    console.error('moderation error', err?.message || err);
    return { flagged: false, categories: [] }; // fail open
  }
}

// A warm, non-clinical crisis message (no fabricated phone numbers, matching
// the system-prompt guidance to point at searchable resources).
export const CRISIS_MESSAGE =
  'i need to pause here, because what you are carrying sounds heavier than this ' +
  'space can hold safely. you are not alone, and this is not the end of the road. ' +
  'please reach a real human who can sit with you right now. in nigeria you can ' +
  'search "MANI Nigeria helpline" (mentally aware nigeria initiative) or "She Writes ' +
  'Woman mental health" to find current numbers. if you are in immediate danger, ' +
  'please get to the nearest hospital or call someone you trust to be with you. ' +
  'i am still here when you are ready.';
