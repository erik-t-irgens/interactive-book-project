// Chapter reader: renders parsed paragraphs, tracks the active paragraph on
// scroll, drives audio transitions, progress persistence, codex unlocks, and
// the contextual sidebar ("who is on the page right now").

import { state, save, chapterProgress, unlock, unlockedTier } from './state.js';
import { cardHtml, entity, displayName } from './codex.js';

export class Reader {
  constructor({ book, chapters, audio, onProgress }) {
    this.book = book;
    this.chapters = chapters;   // Map chapterId -> parsed chapter
    this.audio = audio;
    this.onProgress = onProgress;
    this.active = -1;
    this.paraEls = [];
    this.chapter = null;
    this.chapterId = null;
    this._scrollScheduled = false;
    this._onScroll = () => this._scheduleUpdate();
    this._visibleEntities = null;   // null = sidebar not painted yet
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

    const body = chapter.paragraphs.map(p => {
      const brk = p.breakBefore ? '<hr class="scene-break">' : '';
      if (p.kind === 'heading') {
        return `${brk}<h2 class="section-heading" data-index="${p.index}">${p.html}</h2>`;
      }
      return `${brk}<p class="para" data-index="${p.index}">${p.html}</p>`;
    }).join('');

    container.innerHTML = `
      <div class="reader">
        <article class="reader-column">
          <div class="chapter-kicker">${this.book.title} · ${this.book.subtitle}</div>
          <h1 class="chapter-heading">${chapter.title}</h1>
          ${entry?.status === 'partial' ? '<div class="draft-note">This entry is a draft — parts may still change.</div>' : ''}
          ${body}
          <nav class="chapter-nav">
            <span>${prev ? `<a href="#/read/${prev.id}">← ${prev.title}</a>` : ''}</span>
            <span>${next ? `<a href="#/read/${next.id}">${next.title} →</a>` : '<a href="#/">Finis — return to contents</a>'}</span>
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

    this.paraEls = [...container.querySelectorAll('[data-index]')];
    state.lastChapter = chapterId;
    save();

    document.getElementById('fab-codex')?.addEventListener('click', () => this._openMobileSheet());

    window.addEventListener('scroll', this._onScroll, { passive: true });
    window.addEventListener('resize', this._onScroll, { passive: true });

    // Resume where the reader left off (unless they're starting fresh).
    const prog = chapterProgress(chapterId);
    if (prog.last > 0 && prog.last < this.paraEls.length) {
      requestAnimationFrame(() => {
        this.paraEls[prog.last]?.scrollIntoView({ block: 'center', behavior: 'instant' });
        this._update();
      });
    } else {
      requestAnimationFrame(() => this._update());
    }
  }

  destroy() {
    window.removeEventListener('scroll', this._onScroll);
    window.removeEventListener('resize', this._onScroll);
  }

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
      this._onActiveChanged(best);
    }
  }

  _onActiveChanged(index) {
    const prog = chapterProgress(this.chapterId);
    prog.last = index;

    if (index > prog.furthest) {
      // Fire unlocks for every newly-reached paragraph, in order.
      for (let i = prog.furthest + 1; i <= index; i++) {
        this._applyParagraphUnlocks(this.chapter.paragraphs[i]);
      }
      prog.furthest = index;
    }
    save();
    this.onProgress?.();

    // Audio: paragraphs carry their effective track (parser carries directives
    // forward), so the active paragraph fully determines what should play.
    const p = this.chapter.paragraphs[index];
    if (p.audio) this.audio.setTrack(p.audio.track, p.audio.fade);
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
