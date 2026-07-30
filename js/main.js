import { state, save, unlock, resetAll, exportCode, importCode } from './state.js';
import { parseChapter } from './parser.js';
import { AudioEngine } from './audio.js';
import { loadCodex, renderCodexPage, entity, setSources } from './codex.js';
import { Reader } from './reader.js';

const view = document.getElementById('view');
let book = null;
const chapters = new Map();
let audio = null;
let reader = null;

// ---- Boot ----------------------------------------------------------------

async function boot() {
  document.documentElement.dataset.theme = state.settings.theme;
  document.documentElement.dataset.textsize = state.settings.textSize || 'm';

  book = await (await fetch('content/book.json')).json();
  document.title = `${book.title} — ${book.subtitle}`;

  await Promise.all([
    loadCodex(book.codex),
    ...book.chapters.map(async c => {
      const text = await (await fetch(c.file)).text();
      chapters.set(c.id, parseChapter(text));
    }),
  ]);

  // The codex cites its sources: first mention earns tier 1, @unlock
  // directives earn the rest. Hidden chapters are excluded so links never
  // lead to a forthcoming page.
  const sources = {};
  for (const c of book.chapters) {
    if (c.status === 'todo') continue;
    const parsed = chapters.get(c.id);
    if (!parsed) continue;
    for (const p of parsed.paragraphs) {
      for (const id of p.entities) {
        (sources[id] ??= {})[1] ??= { ch: c.id, index: p.index };
      }
      for (const u of p.unlocks) {
        (sources[u.entity] ??= {})[u.tier] ??= { ch: c.id, index: p.index };
      }
    }
  }
  setSources(sources, id => book.chapters.find(c => c.id === id)?.title || '');

  audio = new AudioEngine(book.tracks);
  audio.volume = state.settings.volume;
  initHeader();

  window.addEventListener('hashchange', route);
  route();

  // Offline support: relative path keeps the scope right under a
  // project-pages subpath.
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

// ---- Header controls -----------------------------------------------------

function initHeader() {
  const btnAudio = document.getElementById('btn-audio');
  const vol = document.getElementById('vol');
  const btnTheme = document.getElementById('btn-theme');

  const paintAudio = () => {
    btnAudio.textContent = state.settings.audioEnabled ? '♪ On' : '♪ Off';
    btnAudio.setAttribute('aria-pressed', String(state.settings.audioEnabled));
  };
  paintAudio();
  vol.value = Math.round(state.settings.volume * 100);

  btnAudio.addEventListener('click', () => {
    state.settings.audioEnabled = !state.settings.audioEnabled;
    save();
    paintAudio();
    audio.setEnabled(state.settings.audioEnabled);
  });
  vol.addEventListener('input', () => {
    state.settings.volume = vol.value / 100;
    save();
    audio.setVolume(state.settings.volume);
  });
  const btnText = document.getElementById('btn-textsize');
  const SIZES = ['s', 'm', 'l'];
  btnText.addEventListener('click', () => {
    const cur = SIZES.indexOf(state.settings.textSize || 'm');
    state.settings.textSize = SIZES[(cur + 1) % SIZES.length];
    save();
    document.documentElement.dataset.textsize = state.settings.textSize;
  });

  btnTheme.addEventListener('click', () => {
    state.settings.theme = state.settings.theme === 'ink' ? 'parchment' : 'ink';
    save();
    document.documentElement.dataset.theme = state.settings.theme;
    btnTheme.textContent = state.settings.theme === 'ink' ? '☾' : '☀';
  });

  // Browsers require a user gesture before audio can start — and mobile
  // browsers re-suspend the context on backgrounding or interruptions. Every
  // interaction re-arms it: the first one starts persisted audio, later ones
  // revive a suspended context.
  const onGesture = () => {
    if (state.settings.audioEnabled && !audio.enabled) audio.setEnabled(true);
    else audio.kick();
  };
  window.addEventListener('pointerdown', onGesture);
  window.addEventListener('keydown', onGesture);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) audio.kick();
  });

  document.addEventListener('codex:seen', () => reader?.refreshSidebar());

  // Inconspicuous "currently playing" caption under the audio button.
  document.addEventListener('audio:now', e => {
    const el = document.getElementById('now-playing');
    if (!el) return;
    if (e.detail.loading) {
      el.textContent = '♪ loading…';
      el.classList.add('on');
    } else if (e.detail.id) {
      el.textContent = '♪ ' + e.detail.id.replace(/[-_]+/g, ' ');
      el.classList.add('on');
    } else {
      el.classList.remove('on');
    }
  });
  document.addEventListener('audio:blocked', () => {
    const el = document.getElementById('now-playing');
    if (!el) return;
    el.textContent = '♪ tap anywhere for sound';
    el.classList.add('on');
  });
  document.addEventListener('audio:error', () => {
    const el = document.getElementById('now-playing');
    if (!el) return;
    el.textContent = '♪ track unavailable';
    el.classList.add('on');
    setTimeout(() => el.classList.remove('on'), 4000);
  });
}

// ---- Progress ------------------------------------------------------------

function overallProgress() {
  let total = 0;
  let read = 0;
  for (const c of book.chapters) {
    if (c.status === 'todo') continue;
    const n = chapters.get(c.id)?.paragraphs.length || 0;
    total += n;
    read += Math.min(n, (state.progress[c.id]?.furthest ?? -1) + 1);
  }
  return total ? read / total : 0;
}

function paintProgress() {
  document.getElementById('progress-fill').style.width = `${(overallProgress() * 100).toFixed(1)}%`;
}

// ---- Skip-ahead catch-up -------------------------------------------------

function hasAnyProgress() {
  return Object.values(state.progress).some(p => p.furthest >= 0);
}

// Silently bring the codex up to date with everything before this chapter,
// as though those pages had been read. Reading progress itself is untouched.
function catchUpBefore(chapterId) {
  const idx = book.chapters.findIndex(c => c.id === chapterId);
  for (let i = 0; i < idx; i++) {
    const c = book.chapters[i];
    if (c.status === 'todo') continue;
    const parsed = chapters.get(c.id);
    if (!parsed) continue;
    for (const p of parsed.paragraphs) {
      for (const id of p.entities) if (entity(id)) unlock(id, 1);
      for (const u of p.unlocks) if (entity(u.entity)) unlock(u.entity, u.tier);
    }
  }
}

// Chapters before this one that still hold unread pages (and haven't already
// been knowingly skipped). Any hit means opening this chapter skips story.
function pendingSkips(chapterId) {
  const idx = book.chapters.findIndex(c => c.id === chapterId);
  const skipped = [];
  for (let i = 0; i < idx; i++) {
    const c = book.chapters[i];
    if (c.status === 'todo' || state.skipAck[c.id]) continue;
    const parsed = chapters.get(c.id);
    if (!parsed) continue;
    const prog = state.progress[c.id];
    if (!prog || prog.furthest < parsed.paragraphs.length - 1) skipped.push(c);
  }
  return skipped;
}

function firstReadableChapter() {
  return book.chapters.find(c => c.status !== 'todo');
}

// ---- Routes --------------------------------------------------------------

function route() {
  reader?.destroy();
  reader = null;
  document.getElementById('overlay-root').innerHTML = '';
  const hash = location.hash || '#/';
  const readMatch = hash.match(/^#\/read\/([\w-]+)(?:\/(\d+))?/);
  const partMatch = hash.match(/^#\/part\/([\w-]+)/);

  window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
  if (readMatch) {
    const entry = book.chapters.find(c => c.id === readMatch[1]);
    if (entry?.status === 'todo') {
      audio.setTrack(null, 2);
      renderForthcoming(entry);
    } else if (entry && pendingSkips(entry.id).length > 0) {
      renderSkipConfirm(entry);
    } else {
      openChapter(readMatch[1], readMatch[2] != null ? parseInt(readMatch[2], 10) : null);
    }
  } else if (partMatch) {
    renderPartPage(book.parts?.find(p => p.id === partMatch[1]));
  } else if (hash.startsWith('#/codex')) {
    audio.setTrack(null, 2);
    renderCodexPage(view);
  } else {
    audio.setTrack(null, 2);
    renderHome();
  }
  paintProgress();
}

function openChapter(chapterId, targetPara = null) {
  catchUpBefore(chapterId);
  reader = new Reader({ book, chapters, audio, onProgress: paintProgress });
  reader.render(view, chapterId, targetPara);
  paintProgress();
}

function renderSkipConfirm(entry) {
  const skipped = pendingSkips(entry.id);
  const fresh = !hasAnyProgress();
  const backTo = skipped[0]; // earliest chapter with unread pages
  const names = skipped.slice(0, 3).map(c => `<em>${c.title}</em>`).join(', ')
    + (skipped.length > 3 ? ` and ${skipped.length - 3} more` : '');
  view.innerHTML = `
    <div class="home">
      <h1 class="forthcoming-title">Skip ahead?</h1>
      <p class="description">Opening <em>${entry.title}</em> skips unread pages in ${names}.
      The Anamnesis will quietly gather everything from the skipped pages — which may tell you more than you want to know yet.</p>
      <div class="confirm-actions">
        <a class="resume-btn" href="#/read/${backTo.id}">${fresh ? 'Begin at the beginning' : 'Return to where I left off'}</a>
        <button class="icon-btn" id="skip-anyway">Skip ahead anyway</button>
      </div>
    </div>`;
  document.getElementById('skip-anyway').addEventListener('click', () => {
    // Remember the choice so the reader isn't re-warned about these chapters.
    for (const c of skipped) state.skipAck[c.id] = true;
    save();
    openChapter(entry.id);
  });
}

function renderPartPage(part) {
  if (!part) { location.hash = '#/'; return; }
  view.innerHTML = `
    <div class="part-page">
      <div class="part-kicker">${part.title}</div>
      <h1 class="part-title">${part.subtitle}</h1>
      <hr class="part-rule">
      <a class="part-continue" href="#/read/${part.before}">Continue</a>
    </div>`;
}

function renderHome() {
  const resume = state.lastChapter && chapters.has(state.lastChapter);
  view.innerHTML = `
    <div class="home">
      <h1>${book.title}</h1>
      <p class="subtitle">${book.subtitle}</p>
      <div class="byline">${book.author}</div>
      <p class="description">${book.description}</p>
      ${resume ? `<a class="resume-btn" href="#/read/${state.lastChapter}">Continue reading</a>` : ''}
      <ul class="chapter-list">
        ${book.chapters.map(c => {
          const part = book.parts?.find(p => p.before === c.id);
          const sep = part ? `<li class="part-sep"><span>${part.title} — ${part.subtitle}</span></li>` : '';
          if (c.status === 'todo') {
            return `${sep}<li><span class="chapter-link is-forthcoming">
              <span class="chapter-title">${c.title}</span>
              <span class="chapter-pct">forthcoming</span>
            </span></li>`;
          }
          const n = chapters.get(c.id)?.paragraphs.length || 1;
          const pct = Math.min(100, Math.round(((state.progress[c.id]?.furthest ?? -1) + 1) / n * 100));
          return `${sep}<li>
            <a class="chapter-link" href="#/read/${c.id}">
              <span class="chapter-title">${c.title}</span>
              <span class="chapter-pct ${pct >= 100 ? 'done' : ''}">${pct > 0 ? pct + '%' : ''}</span>
            </a>
          </li>`;
        }).join('')}
      </ul>
      <div class="home-footer-links">
        <button class="reset-link" id="btn-transfer">Transfer progress between devices</button>
        <button class="reset-link" id="btn-reset">Reset reading progress</button>
      </div>
    </div>`;

  document.getElementById('btn-reset').addEventListener('click', showResetConfirm);
  document.getElementById('btn-transfer').addEventListener('click', showTransferDialog);
}

function showTransferDialog() {
  const root = document.getElementById('overlay-root');
  root.innerHTML = `
    <div class="overlay-scrim" data-close></div>
    <div class="confirm-box" role="dialog" aria-label="Transfer progress">
      <h2>Carry your place with you</h2>
      <p>This code holds your reading progress and everything the Anamnesis has gathered on this device.
      Copy it, then paste it into this same dialog on another device.</p>
      <textarea class="save-code" id="save-out" readonly spellcheck="false">${exportCode()}</textarea>
      <div class="confirm-actions">
        <button class="icon-btn" id="copy-code">Copy code</button>
      </div>
      <p>Bringing a code from elsewhere? Paste it below. Loading it replaces everything on this device.</p>
      <textarea class="save-code" id="save-in" placeholder="Paste a save code…" spellcheck="false"></textarea>
      <div class="transfer-error" id="transfer-error"></div>
      <div class="confirm-actions">
        <button class="icon-btn" data-close>Close</button>
        <button class="icon-btn danger" id="load-code">Load code</button>
      </div>
    </div>`;

  root.querySelectorAll('[data-close]').forEach(el =>
    el.addEventListener('click', () => { root.innerHTML = ''; }));

  const out = document.getElementById('save-out');
  const copyBtn = document.getElementById('copy-code');
  copyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(out.value);
    } catch {
      out.select();
      document.execCommand('copy');
    }
    copyBtn.textContent = 'Copied';
    setTimeout(() => { copyBtn.textContent = 'Copy code'; }, 2000);
  });
  out.addEventListener('focus', () => out.select());

  document.getElementById('load-code').addEventListener('click', () => {
    const code = document.getElementById('save-in').value.trim();
    const err = document.getElementById('transfer-error');
    if (!code) { err.textContent = 'Paste a code first.'; return; }
    try {
      importCode(code);
    } catch {
      err.textContent = 'That doesn’t look like a save code. Check that the whole code was copied.';
    }
  });
}

function showResetConfirm() {
  const root = document.getElementById('overlay-root');
  root.innerHTML = `
    <div class="overlay-scrim" data-close></div>
    <div class="confirm-box" role="dialog" aria-label="Reset progress">
      <h2>Begin again?</h2>
      <p>This clears your reading progress and everything the Anamnesis has gathered on this device. There is no undo.</p>
      <div class="confirm-actions">
        <button class="icon-btn" data-close>Keep my progress</button>
        <button class="icon-btn danger" id="confirm-reset">Reset everything</button>
      </div>
    </div>`;
  root.querySelectorAll('[data-close]').forEach(el =>
    el.addEventListener('click', () => { root.innerHTML = ''; }));
  document.getElementById('confirm-reset').addEventListener('click', resetAll);
}

function renderForthcoming(entry) {
  view.innerHTML = `
    <div class="home">
      <h1 class="forthcoming-title">${entry.title}</h1>
      <p class="subtitle">— to be written —</p>
      <p class="description">This part of the chronicle has not yet been set down. The story will continue here.</p>
      <a class="resume-btn" href="#/">Return to contents</a>
    </div>`;
}

boot().catch(err => {
  view.innerHTML = `<div class="home"><p class="description">Failed to load the book: ${err.message}</p></div>`;
  console.error(err);
});
