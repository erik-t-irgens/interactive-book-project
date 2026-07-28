import { state, save, chapterProgress, unlock, unlockedTier, resetAll } from './state.js';
import { parseChapter } from './parser.js';
import { AudioEngine } from './audio.js';
import { loadCodex, renderCodexPage, entity } from './codex.js';
import { Reader } from './reader.js';

const view = document.getElementById('view');
let book = null;
const chapters = new Map();
let audio = null;
let reader = null;

// ---- Boot ----------------------------------------------------------------

async function boot() {
  document.documentElement.dataset.theme = state.settings.theme;

  book = await (await fetch('content/book.json')).json();
  document.title = `${book.title} — ${book.subtitle}`;

  await Promise.all([
    loadCodex(book.codex),
    ...book.chapters.map(async c => {
      const text = await (await fetch(c.file)).text();
      chapters.set(c.id, parseChapter(text));
    }),
  ]);

  audio = new AudioEngine(book.tracks);
  audio.volume = state.settings.volume;
  initHeader();

  window.addEventListener('hashchange', route);
  route();
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
  btnTheme.addEventListener('click', () => {
    state.settings.theme = state.settings.theme === 'ink' ? 'parchment' : 'ink';
    save();
    document.documentElement.dataset.theme = state.settings.theme;
    btnTheme.textContent = state.settings.theme === 'ink' ? '☾' : '☀';
  });

  // Browsers require a user gesture before audio can start; if the reader had
  // sound on last visit, resume it on their first interaction.
  const resumeOnGesture = () => {
    if (state.settings.audioEnabled) audio.setEnabled(true);
    window.removeEventListener('pointerdown', resumeOnGesture);
    window.removeEventListener('keydown', resumeOnGesture);
  };
  window.addEventListener('pointerdown', resumeOnGesture);
  window.addEventListener('keydown', resumeOnGesture);

  document.addEventListener('codex:seen', () => reader?.refreshSidebar());

  // Inconspicuous "currently playing" caption under the audio button.
  document.addEventListener('audio:now', e => {
    const el = document.getElementById('now-playing');
    if (!el) return;
    if (e.detail.id) {
      el.textContent = '♪ ' + e.detail.id.replace(/[-_]+/g, ' ');
      el.classList.add('on');
    } else {
      el.classList.remove('on');
    }
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

// Would catching up to this chapter actually reveal anything new?
function wouldUnlockAhead(chapterId) {
  const idx = book.chapters.findIndex(c => c.id === chapterId);
  for (let i = 0; i < idx; i++) {
    const c = book.chapters[i];
    if (c.status === 'todo') continue;
    const parsed = chapters.get(c.id);
    if (!parsed) continue;
    for (const p of parsed.paragraphs) {
      for (const id of p.entities) if (entity(id) && unlockedTier(id) < 1) return true;
      for (const u of p.unlocks) if (entity(u.entity) && unlockedTier(u.entity) < u.tier) return true;
    }
  }
  return false;
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
  const readMatch = hash.match(/^#\/read\/([\w-]+)/);
  const partMatch = hash.match(/^#\/part\/([\w-]+)/);

  window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
  if (readMatch) {
    const entry = book.chapters.find(c => c.id === readMatch[1]);
    if (entry?.status === 'todo') {
      audio.setTrack(null, 2);
      renderForthcoming(entry);
    } else if (entry && !hasAnyProgress() && wouldUnlockAhead(entry.id)) {
      renderSkipConfirm(entry);
    } else {
      openChapter(readMatch[1]);
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

function openChapter(chapterId) {
  catchUpBefore(chapterId);
  reader = new Reader({ book, chapters, audio, onProgress: paintProgress });
  reader.render(view, chapterId);
  paintProgress();
}

function renderSkipConfirm(entry) {
  const first = firstReadableChapter();
  view.innerHTML = `
    <div class="home">
      <h1 class="forthcoming-title">Skip ahead?</h1>
      <p class="description">You're about to open <em>${entry.title}</em> without having read what comes before it.
      The Anamnesis will quietly gather everything from the skipped pages — which may tell you more than you want to know yet.</p>
      <div class="confirm-actions">
        <a class="resume-btn" href="#/read/${first.id}">Begin at the beginning</a>
        <button class="icon-btn" id="skip-anyway">Skip ahead anyway</button>
      </div>
    </div>`;
  document.getElementById('skip-anyway').addEventListener('click', () => openChapter(entry.id));
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
      <button class="reset-link" id="btn-reset">Reset reading progress</button>
    </div>`;

  document.getElementById('btn-reset').addEventListener('click', showResetConfirm);
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
