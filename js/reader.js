// Chapter reader with progressive reveal: paragraphs render one at a time as
// the reader advances (arrow button, scroll, or keyboard). Nothing past the
// reveal frontier exists in the DOM, so unlocks, the sidebar, and the codex
// can never run ahead of what has actually been read. Within revealed text,
// scrolling works normally and the active paragraph drives audio + sidebar.

import { state, save, chapterProgress, unlock, unlockedTier } from './state.js';
import { cardHtml, entity, displayName, displayImage } from './codex.js';

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

  render(container, chapterId, targetPara = null) {
    const chapter = this.chapters.get(chapterId);
    if (!chapter) { container.innerHTML = '<p class="sidebar-empty">Chapter not found.</p>'; return; }
    this.chapter = chapter;
    this.chapterId = chapterId;
    this.active = -1;
    this._visibleEntities = null;
    this._recollections = new Map();   // entityId -> 'discovered' | 'deepened', this sitting only

    // Music is one-way within a render: each distinct @audio directive gets
    // an ordinal, and once one has applied, earlier ones never re-fire until
    // the chapter is opened fresh. (Scrolling up re-reads text, not the score.)
    this._audioOrder = new Map();
    for (const p of chapter.paragraphs) {
      if (p.audio && !this._audioOrder.has(p.audio)) this._audioOrder.set(p.audio, this._audioOrder.size);
    }
    this._audioApplied = -1;
    this.audio.resetOnce();

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

    this._onCodexSeen = () => this._tutorialAdvance('codex-open');
    document.addEventListener('codex:seen', this._onCodexSeen);

    if (this.revealed < 0) {
      // Fresh chapter: reveal the opening paragraph (fires its unlocks/audio).
      this._reveal({ scroll: false });
      this._tutorialMaybeShow();
    } else {
      this._syncFrontier();
      // A codex source link targets a specific paragraph; otherwise resume
      // where the reader left off. Deep links clamp to what's been revealed.
      let target = targetPara != null
        ? Math.max(0, Math.min(targetPara, this.revealed))
        : Math.min(prog.last ?? this.revealed, this.revealed);

      // Previously, in the chronicle: after a long absence, land a few
      // paragraphs upstream of where the reader stopped, with a marker at
      // the spot itself, so the thread picks back up with some run-up.
      const AWAY_MS = 36 * 3600 * 1000;
      if (targetPara == null && target > 0 && state.lastReadAt
          && Date.now() - state.lastReadAt > AWAY_MS) {
        const backed = Math.max(0, target - 3);
        if (backed < target && this.paraEls[target]) {
          this.paraEls[target].insertAdjacentHTML('beforebegin',
            '<div class="resume-marker" id="resume-marker"><span>you left off here</span></div>');
        }
        target = backed;
      }

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
    if (this._onCodexSeen) document.removeEventListener('codex:seen', this._onCodexSeen);
    document.getElementById('coach-fixed')?.remove();
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
    state.lastReadAt = Date.now();
    save();
    this.onProgress?.();

    this.active = nextIndex;
    this._applyAudio(p);
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
      this._tutorialAdvance('reveal');
      if (p.entities.length) this._tutorialAdvance('reveal-entities');
    }
    this._scheduleUpdate();
  }

  // ---- First-time tutorial (three diegetic coach marks) -------------------

  _tutorialMaybeShow() {
    const step = state.tutorialStep || 0;
    if (step === 0 && !document.getElementById('coach')) {
      document.getElementById('reveal-ctl')?.insertAdjacentHTML('beforebegin',
        `<div class="coach" id="coach">The chronicle continues when you do — tap the mark below, or simply scroll on.</div>`);
    }
  }

  _tutorialAdvance(event) {
    const step = state.tutorialStep || 0;
    if (step >= 4) return;

    if (step === 0 && event === 'reveal') {
      state.tutorialStep = 1;
      save();
      document.getElementById('coach')?.remove();
      return;
    }
    if (step === 1 && event === 'reveal-entities') {
      // Anchor the second mark after the newest paragraph (it has entity refs).
      const el = this.paraEls[this.revealed];
      if (el && !document.getElementById('coach')) {
        el.insertAdjacentHTML('afterend',
          `<div class="coach" id="coach">Words set apart like these are kept in the Anamnesis — tap one to read what the chronicle knows so far.</div>`);
        state.tutorialStep = 2;
        save();
      }
      return;
    }
    if (step === 2 && event === 'codex-open') {
      document.getElementById('coach')?.remove();
      state.tutorialStep = 3;
      save();
      // Show the final mark once the detail panel closes.
      const wait = setInterval(() => {
        if (!document.querySelector('.entity-detail')) {
          clearInterval(wait);
          this._tutorialAdvance('detail-closed');
        }
      }, 400);
      setTimeout(() => clearInterval(wait), 60000);
      return;
    }
    if (step === 3 && event === 'detail-closed') {
      const fixed = document.createElement('div');
      fixed.className = 'coach coach--fixed';
      fixed.id = 'coach-fixed';
      fixed.textContent = 'Everything recollected gathers in the Codex above, and deepens as you read.';
      document.body.appendChild(fixed);
      state.tutorialStep = 4;
      save();
      setTimeout(() => fixed.remove(), 8000);
    }
  }

  _syncFrontier() {
    const done = this._done();
    const ctl = document.getElementById('reveal-ctl');
    const nav = document.getElementById('chapter-nav');
    if (ctl) ctl.hidden = done;
    if (nav) nav.hidden = !done;
    if (done) this._renderRecollections();
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
      state.lastReadAt = Date.now();
      save();
      this._applyAudio(this.chapter.paragraphs[best]);
    }
  }

  // Apply a paragraph's effective audio directive, but only ever forward:
  // once a later directive has taken effect this render, earlier ones stay
  // spent. Re-opening the chapter resets the score.
  _applyAudio(p) {
    if (!p.audio) return;
    const ord = this._audioOrder.get(p.audio);
    if (ord <= this._audioApplied) return;
    this._audioApplied = ord;
    this.audio.setTrack(p.audio.track, p.audio.fade, p.audio.once);
  }

  _applyParagraphUnlocks(p) {
    // First inline mention of an entity discovers it (tier 1).
    for (const id of p.entities) {
      if (entity(id) && unlock(id, 1)) {
        this._recollections.set(id, 'discovered');
        this._toast(`Recollected: <em>${displayName(id)}</em>`, id);
      }
    }
    // Explicit @unlock directives deepen existing entries.
    for (const u of p.unlocks) {
      if (entity(u.entity) && unlock(u.entity, u.tier)) {
        if (!this._recollections.has(u.entity)) this._recollections.set(u.entity, 'deepened');
        this._toast(`The chronicle stirs: <em>${displayName(u.entity)}</em>`, u.entity);
      }
    }
  }

  // At the end of a sitting that earned something, recap it above the
  // chapter nav. Cards use the global codex delegation, so they're clickable.
  // Big hauls start collapsed — an overlapping stack and a count — so the
  // chapter nav never gets pushed out of reach.
  _renderRecollections() {
    if (!this._recollections?.size || document.getElementById('chapter-recollections')) return;
    const nav = document.getElementById('chapter-nav');
    if (!nav) return;
    const items = [...this._recollections.entries()];
    const discovered = items.filter(([, kind]) => kind === 'discovered').map(([id]) => id);
    const deepened = items.filter(([, kind]) => kind === 'deepened').map(([id]) => id);
    const section = (label, ids) => ids.length ? `
      <div class="recollect-label">${label}</div>
      <div class="recollect-grid">${ids.map(id => cardHtml(id)).join('')}</div>` : '';
    const full = `
      <div class="recollect-heading">The Anamnesis, on this chapter</div>
      ${section('New to the chronicle', discovered)}
      ${section('Entries deepened', deepened)}`;

    const ids = items.map(([id]) => id);
    if (ids.length <= 4) {
      nav.insertAdjacentHTML('beforebegin',
        `<div class="chapter-recollections" id="chapter-recollections">${full}</div>`);
      return;
    }

    const discs = ids.slice(0, 5).map(id => {
      const img = displayImage(id);
      return img
        ? `<img class="recollect-disc" src="${img}" alt="">`
        : `<span class="recollect-disc recollect-disc--letter">${displayName(id).charAt(0)}</span>`;
    }).join('');
    nav.insertAdjacentHTML('beforebegin', `
      <div class="chapter-recollections" id="chapter-recollections">
        <button class="recollect-summary" id="recollect-expand" aria-expanded="false">
          <span class="recollect-stack">${discs}</span>
          <span class="recollect-count">The Anamnesis gathered ${ids.length} recollections this chapter — show them</span>
        </button>
      </div>`);
    document.getElementById('recollect-expand').addEventListener('click', () => {
      document.getElementById('chapter-recollections').innerHTML = full;
    });
  }

  _toast(html, entityId = null) {
    const root = document.getElementById('toast-root');

    // Never stack more than three: retire the oldest early.
    while (root.children.length >= 3) root.firstElementChild.remove();

    const el = document.createElement('div');
    el.className = 'toast';
    el.innerHTML = html;
    if (entityId) {
      el.classList.add('toast--link');
      el.dataset.entity = entityId;
      // codex.js's global .entity-card/.entity-ref delegation doesn't cover
      // toasts; open directly.
      el.addEventListener('click', () => {
        import('./codex.js').then(m => m.openEntityDetail(entityId));
        el.remove();
      });
    }
    root.appendChild(el);

    // Timed dismissal that pauses while the pointer hovers.
    let fadeTimer, removeTimer;
    const arm = (fadeMs, removeMs) => {
      fadeTimer = setTimeout(() => el.classList.add('leaving'), fadeMs);
      removeTimer = setTimeout(() => el.remove(), removeMs);
    };
    arm(3200, 3800);
    el.addEventListener('mouseenter', () => {
      clearTimeout(fadeTimer);
      clearTimeout(removeTimer);
      el.classList.remove('leaving');
    });
    el.addEventListener('mouseleave', () => arm(1500, 2100));
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
