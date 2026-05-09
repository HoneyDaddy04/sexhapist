// Shared CORS helper for /api/* serverless handlers.
// Set CORS_ALLOWED_ORIGINS in env, comma-separated list of allowed origins
// (e.g. "https://honeydaddy04.github.io,https://sexhapist.com").
// Use "*" only for fully public APIs without credentials. Since we send
// cookies, we never echo a wildcard when an Origin matches.

export function applyCors(req, res) {
  const allowedOrigins = (process.env.CORS_ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const origin = req.headers.origin;
  const allow = origin
    && allowedOrigins.length > 0
    && (allowedOrigins.includes(origin) || allowedOrigins.includes('*'));

  if (allow) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Vary', 'Origin');
  }

  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
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
