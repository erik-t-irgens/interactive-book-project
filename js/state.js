// Persistent reader state, backed by localStorage. No accounts, no server.
const KEY = 'anamnesis:v1';

const defaults = () => ({
  progress: {},        // chapterId -> { furthest: -1, last: 0 }
  unlocks: {},         // entityId -> highest unlocked tier (int)
  seen: {},            // entityId -> highest tier the reader has opened in detail
  skipAck: {},         // chapterId -> true, reader confirmed skipping past it unread
  tutorialStep: 0,     // 0 fresh … 4 done; resets with everything else
  lastChapter: null,
  lastReadAt: 0,       // ms timestamp of the last reading beat
  settings: { audioEnabled: false, volume: 0.6, theme: 'ink' },
});

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaults();
    const parsed = JSON.parse(raw);
    return { ...defaults(), ...parsed, settings: { ...defaults().settings, ...parsed.settings } };
  } catch {
    return defaults();
  }
}

export const state = load();

let saveTimer = null;
export function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* storage full/blocked */ }
  }, 150);
}

export function chapterProgress(chapterId) {
  if (!state.progress[chapterId]) state.progress[chapterId] = { furthest: -1, last: 0 };
  return state.progress[chapterId];
}

// Raise an entity's unlocked tier; returns true if it actually advanced.
export function unlock(entityId, tier) {
  const cur = state.unlocks[entityId] || 0;
  if (tier <= cur) return false;
  state.unlocks[entityId] = tier;
  save();
  return true;
}

export function unlockedTier(entityId) {
  return state.unlocks[entityId] || 0;
}

export function markSeen(entityId) {
  state.seen[entityId] = unlockedTier(entityId);
  save();
}

export function hasUnseenUpdate(entityId) {
  return unlockedTier(entityId) > (state.seen[entityId] || 0);
}

export function resetAll() {
  localStorage.removeItem(KEY);
  location.reload();
}

// ---- Save transfer -------------------------------------------------------
// The whole state as a base64 code the reader can carry to another device.

export function exportCode() {
  const bytes = new TextEncoder().encode(JSON.stringify(state));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

// Throws on anything that isn't a valid save code; on success overwrites
// this device's state and reloads.
export function importCode(code) {
  const bin = atob(code.replace(/\s+/g, ''));
  const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
  const parsed = JSON.parse(new TextDecoder().decode(bytes));
  if (!parsed || typeof parsed.progress !== 'object') throw new Error('not a save code');
  clearTimeout(saveTimer);
  localStorage.setItem(KEY, JSON.stringify({
    ...defaults(),
    ...parsed,
    settings: { ...defaults().settings, ...parsed.settings },
  }));
  location.reload();
}
