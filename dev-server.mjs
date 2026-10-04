// Local dev server: serves the static site + runs the Vercel /api/* handlers.
// Not part of the deploy. Run with: node --env-file=.env.local dev-server.mjs
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname } from 'node:path';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.txt': 'text/plain; charset=utf-8',
};

// Augment a native ServerResponse with the Vercel/Next helpers the handlers use.
function enhanceRes(res) {
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (obj) => {
    if (!res.getHeader('Content-Type')) res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(obj));
    return res;
  };
  res.send = (data) => { res.end(data); return res; };
  return res;
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function handleApi(req, res, name) {
  const modPath = join(ROOT, 'api', `${name}.js`);
  try { await stat(modPath); }
  catch { res.statusCode = 404; return res.end(`No such API route: /api/${name}`); }

  // transcribe reads the raw request stream itself — don't consume it here.
  // Everything else gets a parsed JSON body on req.body (as Vercel provides).
  if (name !== 'transcribe' && req.method !== 'GET' && req.method !== 'HEAD') {
    const raw = await readRawBody(req);
    if (raw.length) {
      const ct = req.headers['content-type'] || '';
      if (ct.includes('application/json')) {
        try { req.body = JSON.parse(raw.toString('utf8')); }
        catch { req.body = undefined; }
      } else {
        req.body = raw.toString('utf8');
      }
    }
  }

  enhanceRes(res);
  try {
    const mod = await import(pathToFileURL(modPath).href);
    await mod.default(req, res);
  } catch (err) {
    console.error(`[api/${name}] error:`, err);
    if (!res.headersSent) { res.statusCode = 500; res.end(JSON.stringify({ error: String(err?.message || err) })); }
  }
}

async function serveStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath.split('?')[0]);
  if (rel === '/' || rel === '') rel = '/index.html';
  // prevent path traversal
  const full = normalize(join(ROOT, rel));
  if (!full.startsWith(ROOT + sep) && full !== ROOT) {
    res.statusCode = 403; return res.end('Forbidden');
  }
  try {
    let target = full;
    const s = await stat(target).catch(() => null);
    if (s && s.isDirectory()) target = join(target, 'index.html');
    const data = await readFile(target);
    res.statusCode = 200;
    res.setHeader('Content-Type', MIME[extname(target).toLowerCase()] || 'application/octet-stream');
    res.end(data);
  } catch {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end('<h1>404</h1>');
  }
}

const server = http.createServer(async (req, res) => {
  const url = req.url || '/';
  const apiMatch = url.match(/^\/api\/([a-zA-Z0-9_-]+)/);
  if (apiMatch) {
    await handleApi(req, res, apiMatch[1]);
  } else {
    await serveStatic(req, res, url);
  }
});

server.listen(PORT, () => {
  console.log(`\n  sexhapist dev server  →  http://localhost:${PORT}\n`);
  if (!process.env.OPENAI_API_KEY && !process.env.OPENROUTER_API_KEY) {
    console.log('  NOTE: no OPENAI_API_KEY set — chat/voice/transcribe will error; static UI + /api/session work.\n');
  }
});
