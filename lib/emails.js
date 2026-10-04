// lib/emails.js
// Saves an email captured by /api/unlock.
//
// Primary: appends a CSV row to a file in a PRIVATE GitHub repo through the
// Contents API. Configure with:
//   GITHUB_DATA_TOKEN  fine-grained token with Contents: read & write on that repo only
//   GITHUB_DATA_REPO   owner/name (default HoneyDaddy04/sexhapist-data)
//   GITHUB_DATA_PATH   file path   (default emails.csv)
// Never point this at the public app repo: these are personal details.
//
// We store only: when, the email, and which door (him/her). No IP, no chat.

import { createHash } from 'node:crypto';
import { get as storeGet, set as storeSet } from './store.js';

const REPO = process.env.GITHUB_DATA_REPO || 'HoneyDaddy04/sexhapist-data';
const FILE = process.env.GITHUB_DATA_PATH || 'emails.csv';
const HEADER = 'captured_at,email,door\n';

export function normalizeEmail(raw) {
  const email = String(raw || '').trim().toLowerCase();
  if (email.length < 6 || email.length > 254) return null;
  if (!/^[^\s@,"<>]+@[^\s@,"<>]+\.[a-z]{2,}$/.test(email)) return null;
  return email;
}

const csvSafe = (v) => String(v).replace(/[\r\n,"]/g, ' ');

async function appendToGitHub(row, email) {
  const token = process.env.GITHUB_DATA_TOKEN;
  if (!token) return false;
  const url = `https://api.github.com/repos/${REPO}/contents/${encodeURIComponent(FILE)}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'sexhapist-app',
  };
  // Concurrent signups can race on the file's sha; retry a few times.
  for (let attempt = 0; attempt < 4; attempt++) {
    const cur = await fetch(url, { headers });
    let sha, text = HEADER;
    if (cur.ok) {
      const j = await cur.json();
      sha = j.sha;
      text = Buffer.from(j.content || '', 'base64').toString('utf8') || HEADER;
    } else if (cur.status !== 404) {
      throw new Error(`github read ${cur.status}`);
    }
    if (text.includes(`,${email},`)) return true; // already captured
    const body = {
      message: 'Add email signup',
      content: Buffer.from(text + row).toString('base64'),
      ...(sha ? { sha } : {}),
    };
    const put = await fetch(url, { method: 'PUT', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (put.ok) return true;
    if (put.status !== 409 && put.status !== 422) throw new Error(`github write ${put.status}`);
  }
  throw new Error('github write conflict');
}

// Returns where it was stored: 'github' | 'store'. Never throws for storage
// failures: the visitor still gets their time, and the failure is logged.
export async function saveEmail(email, door) {
  const key = `email:${createHash('sha256').update(email).digest('hex').slice(0, 32)}`;
  const row = `${new Date().toISOString()},${csvSafe(email)},${door === 'her' ? 'her' : 'him'}\n`;
  try {
    if (await appendToGitHub(row, email)) return 'github';
  } catch (err) {
    console.error('email save to github failed:', err?.message || err);
  }
  // Fallback: keep it in the KV store so it is not silently dropped.
  if (!(await storeGet(key))) await storeSet(key, row.trim(), 365 * 24 * 60 * 60);
  return 'store';
}
