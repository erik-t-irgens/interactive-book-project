// Narration: the spoken layer beside the music engine. Three modes:
//   off   — nothing
//   along — the reader drives; each newly revealed paragraph queues its clip,
//           and the voice never overlaps itself (clips play in order)
//   book  — the narration drives; as playback crosses a paragraph boundary the
//           reader is asked to reveal it, so unlocks stay in sync
//
// Built on an HTML <audio> element rather than Web Audio, deliberately: the OS
// treats it as real media — pulling out an earbud pauses it, headset buttons
// control it via the Media Session API, and chapter-length files stream with
// range requests instead of being decoded whole into memory.

const SEG_EPSILON = 0.06;

export class NarrationPlayer {
  constructor({ base, onDuck }) {
    this.base = base || null;
    this.onDuck = onDuck || (() => {});
    this.manifest = null;         // null until init resolves; {chapters:{}} on failure
    this.mode = 'off';
    this.chapterId = null;
    this.chapterTitle = '';
    this.timings = [];
    this.duration = 0;
    this.queue = [];              // read-along: paragraph indices awaiting voice
    this.playingIdx = null;       // read-along: segment currently sounding
    this._segEnd = Infinity;
    this._lastEmitted = -1;       // book: last boundary announced
    this._segTimer = null;

    const el = document.createElement('audio');
    el.preload = 'metadata';
    el.setAttribute('playsinline', '');
    el.playsInline = true;
    el.style.display = 'none';
    document.body.appendChild(el);
    this.el = el;

    el.addEventListener('play', () => { this.onDuck(0.35); this._emitState(); });
    // Fires for every pause: ours, the pause button, or the OS yanking the
    // session when an earbud comes out. All of them mean "hold position".
    el.addEventListener('pause', () => { this.onDuck(1); this._emitState(); });
    el.addEventListener('ended', () => {
      this.playingIdx = null;
      this.queue = [];
      this.onDuck(1);
      this._emitState();
    });
    el.addEventListener('timeupdate', () => this._tick());

    this.ready = this.init();

    if ('mediaSession' in navigator) {
      try {
        navigator.mediaSession.setActionHandler('play', () => this.resume());
        navigator.mediaSession.setActionHandler('pause', () => this.pause());
        navigator.mediaSession.setActionHandler('seekbackward', () => this.nudge(-10));
        navigator.mediaSession.setActionHandler('seekforward', () => this.nudge(10));
      } catch { /* partial support is fine */ }
    }
  }

  async init() {
    if (!this.base) { this.manifest = { chapters: {} }; return; }
    try {
      const res = await fetch(`${this.base}/manifest.json`);
      this.manifest = res.ok ? await res.json() : { chapters: {} };
    } catch {
      this.manifest = { chapters: {} };
    }
  }

  hasChapter(id) {
    return !!this.manifest?.chapters?.[id];
  }

  async loadChapter(id, title = '') {
    // Chapter switches can interleave (route changes while a fetch is in
    // flight); only the most recent load may win.
    const token = (this._loadToken = (this._loadToken || 0) + 1);
    await this.ready;
    if (token !== this._loadToken) return false;
    this.stop();
    this.chapterId = null;
    this.chapterTitle = title;
    if (!this.hasChapter(id)) { this._emitState(); return false; }
    try {
      const meta = await (await fetch(`${this.base}/${id}.json`)).json();
      if (token !== this._loadToken) return false;
      this.timings = meta.timings || [];
      this.duration = meta.duration || 0;
    } catch {
      this._emitState();
      return false;
    }
    this.el.src = `${this.base}/${this.manifest.chapters[id].file}`;
    this.chapterId = id;
    this._lastEmitted = -1;
    if ('mediaSession' in navigator) {
      try {
        navigator.mediaSession.metadata = new MediaMetadata({
          title, artist: 'Anamnesis — The Chronicle of Fundament',
          artwork: [{ src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' }],
        });
      } catch { /* cosmetic */ }
    }
    this._emitState();
    return true;
  }

  setMode(mode) {
    this.mode = mode;
    if (mode !== 'along') { this.queue = []; this.playingIdx = null; this._segEnd = Infinity; }
    if (mode === 'off') this.stop();
    this._emitState();
  }

  get active() {
    return this.mode !== 'off' && !!this.chapterId;
  }

  get playing() {
    return !!this.el && !this.el.paused && !this.el.ended;
  }

  // ---- read-along ---------------------------------------------------------

  // A paragraph became current. In read-along, freshly revealed paragraphs
  // queue for the voice; in audiobook, a manual reveal steers the playhead.
  onReveal(index) {
    if (!this.active || index >= this.timings.length) return;
    if (this.mode === 'along') {
      if (!this.queue.includes(index) && index !== this.playingIdx) this.queue.push(index);
      this._pump();
    } else if (this.mode === 'book') {
      // A genuine jump (deep link, skimming ahead) steers the playhead; the
      // echo of our own auto-reveal at a boundary must not cause a seek.
      const start = this.timings[index];
      if (Math.abs(this.el.currentTime - start) > 1.5) {
        this._lastEmitted = index;
        this._seekTo(index);
      } else {
        this._lastEmitted = Math.max(this._lastEmitted, index);
      }
    }
  }

  _pump() {
    if (this.playingIdx != null || this.queue.length === 0) return;
    const i = this.queue.shift();
    this.playingIdx = i;
    this._segEnd = this.timings[i + 1] ?? this.duration;
    const start = this.timings[i];
    if (Math.abs(this.el.currentTime - start) > 0.35) this.el.currentTime = start;
    this.el.play().catch(() => { this.playingIdx = null; });
    this._armSegTimer();
  }

  // timeupdate is coarse (~4 Hz); a timer aimed at the boundary keeps segment
  // ends from bleeding into the next paragraph.
  _armSegTimer() {
    clearTimeout(this._segTimer);
    if (this.mode !== 'along' || this.playingIdx == null) return;
    const ms = Math.max(0, (this._segEnd - this.el.currentTime - SEG_EPSILON) * 1000);
    this._segTimer = setTimeout(() => this._tick(), ms + 10);
  }

  _tick() {
    if (this.mode === 'along' && this.playingIdx != null) {
      if (this.el.currentTime >= this._segEnd - SEG_EPSILON) {
        if (this.queue[0] === this.playingIdx + 1) {
          // Seamless: the next queued paragraph starts where this one ends.
          this.playingIdx = this.queue.shift();
          this._segEnd = this.timings[this.playingIdx + 1] ?? this.duration;
        } else {
          this.el.pause();
          this.playingIdx = null;
          if (this.queue.length) { this._pump(); return; }
        }
      }
      this._armSegTimer();
    } else if (this.mode === 'book' && this.playing) {
      const idx = this._indexAt(this.el.currentTime);
      if (idx > this._lastEmitted) {
        this._lastEmitted = idx;
        document.dispatchEvent(new CustomEvent('narration:paragraph', { detail: { index: idx } }));
      }
    }
  }

  _indexAt(t) {
    let idx = 0;
    for (let i = 0; i < this.timings.length; i++) {
      if (this.timings[i] <= t + SEG_EPSILON) idx = i; else break;
    }
    return idx;
  }

  // ---- audiobook / shared transport --------------------------------------

  _seekTo(index) {
    if (index < this.timings.length) this.el.currentTime = this.timings[index];
  }

  // Start (or restart) audiobook playback from a paragraph.
  playFrom(index) {
    if (!this.active) return;
    this._lastEmitted = index;
    this._seekTo(index);
    this.el.play().catch(() => { /* needs gesture; button provides one */ });
  }

  resume() {
    if (!this.active) return;
    if (this.mode === 'along') { this._pump(); return; }
    this.el.play().catch(() => {});
  }

  pause() { this.el.pause(); }

  toggle(fallbackIndex = 0) {
    if (this.playing) this.pause();
    else if (this.mode === 'book' && this.el.currentTime === 0) this.playFrom(fallbackIndex);
    else this.resume();
  }

  nudge(seconds) {
    if (!this.active || this.mode !== 'book') return;
    this.el.currentTime = Math.min(this.duration, Math.max(0, this.el.currentTime + seconds));
    this._lastEmitted = this._indexAt(this.el.currentTime);
  }

  stop() {
    clearTimeout(this._segTimer);
    this.el.pause();
    try { this.el.currentTime = 0; } catch { /* no src yet */ }
    this.queue = [];
    this.playingIdx = null;
    this._segEnd = Infinity;
    this.onDuck(1);
  }

  _emitState() {
    document.dispatchEvent(new CustomEvent('narration:state', {
      detail: {
        mode: this.mode,
        playing: this.playing,
        available: !!this.chapterId,
        chapterId: this.chapterId,
      },
    }));
  }
}
