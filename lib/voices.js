// lib/voices.js
// Voices the visitor can pick from (ElevenLabs voice ids on this account).
// Keep in sync with VOICES in app.html. The server only accepts ids listed here.

export const VOICES = {
  // Nigerian
  QqgW7xZ3mjIAgZVFMwJz: 'Ngozi',
  Z8dg0fyk7p6js7cQ7lgi: 'Ololade',
  oC2pCZZWEDRe6lmZpaaw: 'Bukola',
  '8P18CIVcRlwP98FOjZDm': 'Ola',
  '77aEIu0qStu8Jwv1EdhX': 'Ayinde',
  gsyHQ9kWCDIipR26RqQ1: 'Nzube',
  // International
  EXAVITQu4vr4xnSDxMaL: 'Sarah',
  pFZP5JQG7iQjIQuC4Bku: 'Lily',
  SAz9YHcvj6GT2YYXdXww: 'River',
  nPczCjzI2devNBz1zQrb: 'Brian',
  JBFqnCBsd6RMkjVDRZzb: 'George',
  pVnrL6sighQX7hVz89cp: 'Narrator',
};

// Calm, therapist-like defaults per door (the visitor can switch in the app).
export const DEFAULT_VOICE = {
  her: 'QqgW7xZ3mjIAgZVFMwJz', // Ngozi, calm Nigerian
  him: '8P18CIVcRlwP98FOjZDm', // Ola, deep and warm Nigerian
};

export function pickVoice(requested, path) {
  return typeof requested === 'string' && Object.prototype.hasOwnProperty.call(VOICES, requested)
    ? requested
    : DEFAULT_VOICE[path === 'her' ? 'her' : 'him'];
}
