// Shared CORS helper for /api/* serverless handlers.
// Set CORS_ALLOWED_ORIGINS in env, comma-separated list of allowed origins
// (e.g. "https://honeydaddy04.github.io,https://sexhapist.com").
//
// SECURITY: Because we send cookies (credentialed requests), credentials are
// ONLY enabled for an explicit allow-list match. If CORS_ALLOWED_ORIGINS is "*"
// we treat the API as public and do NOT set Access-Control-Allow-Credentials,
// and we send "Access-Control-Allow-Origin: *" (never echo a specific origin
// with credentials). A wildcard with credentials would let any site make
// authenticated requests on the user's behalf. (B2-5)

export function applyCors(req, res) {
  const allowedOrigins = (process.env.CORS_ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const origin = req.headers.origin;
  const isWildcard = allowedOrigins.includes('*');
  const explicitMatch = !!origin && allowedOrigins.includes(origin);

  if (isWildcard) {
    // Public, non-credentialed mode.
    res.setHeader('Access-Control-Allow-Origin', '*');
  } else if (explicitMatch) {
    // Credentialed mode: echo the specific origin and allow credentials.
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Vary', 'Origin');
  }

  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    // Keep the allow-list tight. We accept Content-Type and our custom CSRF
    // header (X-Requested-With) only. (B2-6)
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Requested-With');
    res.setHeader('Access-Control-Max-Age', '86400');
    res.status(204).end();
    return true;
  }

  return false;
}

// Returns 'None' or 'Lax' for the SameSite cookie attribute, depending on
// whether this deployment is acting as a cross-origin proxy. SameSite=None
// requires Secure (which we always set).
export function cookieSameSite() {
  return process.env.CROSS_ORIGIN_COOKIE === 'true' ? 'None' : 'Lax';
}

// Lightweight CSRF defense for state-changing POSTs. (B2-6)
//
// A cross-site HTML <form> can only send "simple" content types
// (application/x-www-form-urlencoded, multipart/form-data, text/plain) and
// cannot set custom headers without triggering a CORS preflight. So we accept a
// request as same-origin-ish if EITHER:
//   - it carries our custom header X-Requested-With: sexhapist, OR
//   - its Content-Type is application/json (chat/voice), OR
//   - its Content-Type is one of our audio types (transcribe), since audio/*
//     is also not a form-submittable "simple" content type.
//
// Returns true if the request looks safe; false if it should be rejected (403).
export function checkCsrf(req) {
  const xrw = (req.headers['x-requested-with'] || '').toLowerCase();
  if (xrw === 'sexhapist') return true;

  const ct = (req.headers['content-type'] || '').toLowerCase();
  if (ct.includes('application/json')) return true;
  if (ct.startsWith('audio/')) return true;

  return false;
}
