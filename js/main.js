import { state, save, chapterProgress } from './state.js';
import { parseChapter } from './parser.js';
import { AudioEngine } from './audio.js';
import { loadCodex, renderCodexPage } from './codex.js';
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

// ---- Routes --------------------------------------------------------------

function route() {
  reader?.destroy();
  reader = null;
  document.getElementById('overlay-root').innerHTML = '';
  const hash = location.hash || '#/';
  const readMatch = hash.match(/^#\/read\/([\w-]+)/);

  window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
  if (readMatch) {
    const entry = book.chapters.find(c => c.id === readMatch[1]);
    if (entry?.status === 'todo') {
      audio.setTrack(null, 2);
      renderForthcoming(entry);
    } else {
      reader = new Reader({ book, chapters, audio, onProgress: paintProgress });
      reader.render(view, readMatch[1]);
    }
  } else if (hash.startsWith('#/codex')) {
    audio.setTrack(null, 2);
    renderCodexPage(view);
  } else {
    audio.setTrack(null, 2);
    renderHome();
  }
  paintProgress();
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
          if (c.status === 'todo') {
            return `<li><span class="chapter-link is-forthcoming">
              <span class="chapter-title">${c.title}</span>
              <span class="chapter-pct">forthcoming</span>
            </span></li>`;
          }
          const n = chapters.get(c.id)?.paragraphs.length || 1;
          const pct = Math.min(100, Math.round(((state.progress[c.id]?.furthest ?? -1) + 1) / n * 100));
          return `<li>
            <a class="chapter-link" href="#/read/${c.id}">
              <span class="chapter-title">${c.title}</span>
              <span class="chapter-pct ${pct >= 100 ? 'done' : ''}">${pct > 0 ? pct + '%' : ''}</span>
            </a>
          </li>`;
        }).join('')}
      </ul>
    </div>`;
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
