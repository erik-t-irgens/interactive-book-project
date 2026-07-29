// Chapter reader with progressive reveal: paragraphs render one at a time as
// the reader advances (arrow button, scroll, or keyboard). Nothing past the
// reveal frontier exists in the DOM, so unlocks, the sidebar, and the codex
// can never run ahead of what has actually been read. Within revealed text,
// scrolling works normally and the active paragraph drives audio + sidebar.

import { state, save, chapterProgress, unlock, unlockedTier } from './state.js';
import { cardHtml, entity, displayName } from './codex.js';

const REVEAL_THROTTLE_MS = 400;

export class Reader {
  constructor({ book, chapters, audio, onProgress }) {
    this.book = book;
    this.chapters = chapters;   // Map chapterId -> parsed chapter
    this.audio = audio;
    this.onProgress = onProgress;
    this.active = -1;
    this.revealed = -1;         // index of last rendered paragraph
    this.paraEls = [];
    this.chapter = null;
    this.chapterId = null;
    this._scrollScheduled = false;
    this._lastReveal = 0;
    this._touchY = null;
    this._visibleEntities = null;   // null = sidebar not painted yet

    this._onScroll = () => this._scheduleUpdate();
    this._onWheel = e => { if (e.deltaY > 20) this._tryReveal(); };
    this._onKey = e => this._handleKey(e);
    this._onTouchStart = e => { this._touchY = e.touches[0]?.clientY ?? null; };
    this._onTouchMove = e => {
      const y = e.touches[0]?.clientY;
      if (this._touchY != null && y != null && this._touchY - y > 40) {
        this._touchY = y;
        this._tryReveal();
      }
    };
  }

  render(container, chapterId) {
    const chapter = this.chapters.get(chapterId);
    if (!chapter) { container.innerHTML = '<p class="sidebar-empty">Chapter not found.</p>'; return; }
    this.chapter = chapter;
    this.chapterId = chapterId;
    this.active = -1;
    this._visibleEntities = null;

    const idx = this.book.chapters.findIndex(c => c.id === chapterId);
    const entry = this.book.chapters[idx];
    const readable = c => c && c.status !== 'todo';
    let prev = null;
    for (let i = idx - 1; i >= 0; i--) if (readable(this.book.chapters[i])) { prev = this.book.chapters[i]; break; }
    let next = null;
    for (let i = idx + 1; i < this.book.chapters.length; i++) if (readable(this.book.chapters[i])) { next = this.book.chapters[i]; break; }

    // Crossing into a new part goes by way of its title page.
    let nextHref = next ? `#/read/${next.id}` : '#/';
    let nextLabel = next ? `${next.title} →` : 'Finis — return to contents';
    const partAhead = next && this.book.parts?.find(p => p.before === next.id);
    if (partAhead) {
      nextHref = `#/part/${partAhead.id}`;
      nextLabel = `${partAhead.title} — ${partAhead.subtitle} →`;
    }

    container.innerHTML = `
      <div class="reader">
        <article class="reader-column">
          <div class="chapter-kicker">${this.book.title} · ${this.book.subtitle}</div>
          <h1 class="chapter-heading">${chapter.title}</h1>
          ${entry?.status === 'partial' ? '<div class="draft-note">This entry is a draft — parts may still change.</div>' : ''}
          <div id="para-flow"></div>
          <div class="reveal-ctl" id="reveal-ctl" hidden>
            <button class="btn-reveal" id="btn-reveal" title="Continue reading" aria-label="Reveal next paragraph"><span class="glyph"></span></button>
          </div>
          <nav class="chapter-nav" id="chapter-nav" hidden>
            <span>${prev ? `<a href="#/read/${prev.id}">← ${prev.title}</a>` : ''}</span>
            <span><a href="${nextHref}">${nextLabel}</a></span>
          </nav>
        </article>
        <aside class="reader-sidebar">
          <div class="sidebar-sticky">
            <div class="sidebar-label">On this page</div>
            <div id="sidebar-cards"></div>
          </div>
        </aside>
        <button class="fab-codex" id="fab-codex" hidden>
          Anamnesis <span class="fab-count" id="fab-count">0</span>
        </button>
      </div>`;

    // Re-render everything the reader has already earned, without re-firing
    // unlocks (unlock() is idempotent anyway, but this skips toasts too).
    const prog = chapterProgress(chapterId);
    this.revealed = Math.min(prog.furthest, chapter.paragraphs.length - 1);
    const flow = container.querySelector('#para-flow');
    for (let i = 0; i <= this.revealed; i++) {
      flow.insertAdjacentHTML('beforeend', this._paraHtml(chapter.paragraphs[i]));
    }
    this._collectEls();

    state.lastChapter = chapterId;
    save();

    document.getElementById('btn-reveal').addEventListener('click', () => this._reveal());
    document.getElementById('fab-codex')?.addEventListener('click', () => this._openMobileSheet());

    window.addEventListener('scroll', this._onScroll, { passive: true });
    window.addEventListener('resize', this._onScroll, { passive: true });
    window.addEventListener('wheel', this._onWheel, { passive: true });
    window.addEventListener('keydown', this._onKey);
    window.addEventListener('touchstart', this._onTouchStart, { passive: true });
    window.addEventListener('touchmove', this._onTouchMove, { passive: true });

    if (this.revealed < 0) {
      // Fresh chapter: reveal the opening paragraph (fires its unlocks/audio).
      this._reveal({ scroll: false });
    } else {
      this._syncFrontier();
      // Resume where the reader left off.
      const target = Math.min(prog.last ?? this.revealed, this.revealed);
      if (target > 0 && this.paraEls[target]) {
        requestAnimationFrame(() => {
          this.paraEls[target].scrollIntoView({ block: 'center', behavior: 'instant' });
          this._update();
        });
      } else {
        requestAnimationFrame(() => this._update());
      }
    }
  }

  destroy() {
    window.removeEventListener('scroll', this._onScroll);
    window.removeEventListener('resize', this._onScroll);
    window.removeEventListener('wheel', this._onWheel);
    window.removeEventListener('keydown', this._onKey);
    window.removeEventListener('touchstart', this._onTouchStart);
    window.removeEventListener('touchmove', this._onTouchMove);
  }

  // ---- Progressive reveal ------------------------------------------------

  _paraHtml(p, newly = false) {
    const brk = p.breakBefore ? '<hr class="scene-break">' : '';
    const cls = newly ? ' newly' : '';
    if (p.kind === 'heading') {
      return `${brk}<h2 class="section-heading${cls}" data-index="${p.index}">${p.html}</h2>`;
    }
    if (p.kind === 'image') {
      return `${brk}<figure class="para-image${cls}" data-index="${p.index}">
        <img src="${p.src}" alt="${p.alt}" loading="lazy">
      </figure>`;
    }
    return `${brk}<p class="para${cls}" data-index="${p.index}">${p.html}</p>`;
  }

  _collectEls() {
    this.paraEls = [...document.querySelectorAll('#para-flow [data-index]')];
  }

  _done() {
    return this.revealed >= this.chapter.paragraphs.length - 1;
  }

  _frontierVisible() {
    const ctl = document.getElementById('reveal-ctl');
    if (!ctl || ctl.hidden) return false;
    return ctl.getBoundingClientRect().top < window.innerHeight;
  }

  // Throttled reveal for scroll/keyboard/touch — only fires while the
  // frontier arrow is on screen, so you can't blow past text you haven't seen.
  _tryReveal() {
    if (this._done() || !this._frontierVisible()) return;
    const now = performance.now();
    if (now - this._lastReveal < REVEAL_THROTTLE_MS) return;
    this._lastReveal = now;
    this._reveal();
  }

  _reveal({ scroll = true } = {}) {
    const nextIndex = this.revealed + 1;
    const p = this.chapter.paragraphs[nextIndex];
    if (!p) return;
    this.revealed = nextIndex;

    const flow = document.getElementById('para-flow');
    flow.insertAdjacentHTML('beforeend', this._paraHtml(p, true));
    this._collectEls();

    const prog = chapterProgress(this.chapterId);
    if (nextIndex > prog.furthest) {
      this._applyParagraphUnlocks(p);
      prog.furthest = nextIndex;
    }
    prog.last = nextIndex;
    save();
    this.onProgress?.();

    this.active = nextIndex;
    if (p.audio) this.audio.setTrack(p.audio.track, p.audio.fade);
    this._syncFrontier();

    // A heading is not a reading beat on its own — bring its first paragraph
    // along with it.
    if (p.kind === 'heading' && !this._done()) {
      this._reveal({ scroll });
      return;
    }

    if (scroll) {
      const el = this.paraEls[nextIndex];
      if (el) {
        const top = el.getBoundingClientRect().top + window.scrollY - window.innerHeight * 0.28;
        window.scrollTo({ top, behavior: 'smooth' });
      }
    }
    this._scheduleUpdate();
  }

  _syncFrontier() {
    const done = this._done();
    const ctl = document.getElementById('reveal-ctl');
    const nav = document.getElementById('chapter-nav');
    if (ctl) ctl.hidden = done;
    if (nav) nav.hidden = !done;
  }

  _handleKey(e) {
    if (e.target.closest?.('input, textarea, select')) return;
    if (document.querySelector('.entity-detail')) return; // codex overlay open
    if (e.key === 'ArrowDown' || e.key === 'PageDown' || e.key === ' ') {
      if (!this._done() && this._frontierVisible()) {
        e.preventDefault();
        this._tryReveal();
      }
    } else if (e.key === 'ArrowUp') {
      if (this.active > 0 && this.paraEls[this.active - 1]) {
        e.preventDefault();
        this.paraEls[this.active - 1].scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
    }
  }

  // ---- Scroll tracking (within revealed text) ----------------------------

  _scheduleUpdate() {
    if (this._scrollScheduled) return;
    this._scrollScheduled = true;
    requestAnimationFrame(() => { this._scrollScheduled = false; this._update(); });
  }

  _update() {
    if (!this.paraEls.length) return;
    const vh = window.innerHeight;
    const center = vh * 0.45;
    let best = -1;
    let bestDist = Infinity;
    const visible = [];

    for (const el of this.paraEls) {
      const r = el.getBoundingClientRect();
      if (r.bottom > 0 && r.top < vh) {
        const i = parseInt(el.dataset.index, 10);
        visible.push(i);
        const mid = (r.top + r.bottom) / 2;
        const dist = Math.abs(mid - center);
        if (dist < bestDist) { bestDist = dist; best = i; }
      }
    }
    if (best === -1) return;

    this._updateSidebar(visible);

    if (best !== this.active) {
      this.active = best;
      // Re-reading: keep audio and resume position in step with the eye.
      // Unlocks only ever fire from _reveal().
      const prog = chapterProgress(this.chapterId);
      prog.last = best;
      save();
      const p = this.chapter.paragraphs[best];
      if (p.audio) this.audio.setTrack(p.audio.track, p.audio.fade);
    }
  }

  _applyParagraphUnlocks(p) {
    // First inline mention of an entity discovers it (tier 1).
    for (const id of p.entities) {
      if (entity(id) && unlock(id, 1)) this._toast(`Recollected: <em>${displayName(id)}</em>`);
    }
    // Explicit @unlock directives deepen existing entries.
    for (const u of p.unlocks) {
      if (entity(u.entity) && unlock(u.entity, u.tier)) {
        this._toast(`The chronicle stirs: <em>${displayName(u.entity)}</em>`);
      }
    }
  }

  _toast(html) {
    const root = document.getElementById('toast-root');
    const el = document.createElement('div');
    el.className = 'toast';
    el.innerHTML = html;
    root.appendChild(el);
    setTimeout(() => el.classList.add('leaving'), 3200);
    setTimeout(() => el.remove(), 3800);
  }

  _updateSidebar(visibleIndexes) {
    // Union of entities on visible paragraphs, in reading order,
    // filtered to discovered ones only (no spoilers from a glance).
    const ids = [];
    for (const i of visibleIndexes.sort((a, b) => a - b)) {
      for (const id of this.chapter.paragraphs[i].entities) {
        if (!ids.includes(id) && unlockedTier(id) > 0) ids.push(id);
      }
    }
    const changed = this._visibleEntities === null || ids.join() !== this._visibleEntities.join();
    this._visibleEntities = ids;

    const fab = document.getElementById('fab-codex');
    if (fab) {
      fab.hidden = ids.length === 0;
      const count = document.getElementById('fab-count');
      if (count) count.textContent = ids.length;
    }

    if (!changed && !this._sidebarDirty) return;
    this._sidebarDirty = false;
    const holder = document.getElementById('sidebar-cards');
    if (!holder) return;
    holder.innerHTML = ids.length
      ? ids.map(id => cardHtml(id)).join('')
      : '<div class="sidebar-empty">Nothing of note on this page — yet.</div>';
  }

  refreshSidebar() {
    this._sidebarDirty = true;
    this._scheduleUpdate();
  }

  _openMobileSheet() {
    const root = document.getElementById('overlay-root');
    root.innerHTML = `
      <div class="overlay-scrim" data-close></div>
      <div class="mobile-sheet">
        <div class="sidebar-label">On this page</div>
        ${(this._visibleEntities || []).map(id => cardHtml(id)).join('') || '<div class="sidebar-empty">Nothing of note here yet.</div>'}
      </div>`;
    root.querySelector('[data-close]').addEventListener('click', () => { root.innerHTML = ''; });
  }
}
