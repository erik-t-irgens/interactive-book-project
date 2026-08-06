// Ambient audio engine: Web Audio API, looped buffers, equal-power crossfades.
// Tracks are declared in book.json ("tracks": { id: url }) and referenced from
// chapters via @audio: directives.

// 20ms of silence. Looping this through an <audio> element while sound is
// enabled promotes the page to a "playback" audio session on mobile WebKit
// (Chrome/Safari on iOS), which is the only way Web Audio escapes the
// hardware ring/silent switch.
const SILENT_WAV = 'data:audio/wav;base64,UklGRsQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YaAAAACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICA';

export class AudioEngine {
  constructor(trackMap) {
    this.trackMap = trackMap || {};
    this.ctx = null;
    this.master = null;
    this.buffers = new Map();     // trackId -> AudioBuffer | Promise
    this.current = null;          // { id, source, gain }
    this.desired = null;          // { id, fade, once } — remembered while disabled
    this.enabled = false;
    this.volume = 0.6;
    this.fadeToken = 0;
    this.finishedOnce = null;     // a 'once' track that already played to its end
    this._keepAlive = null;       // silent <audio> that claims the media session
  }

  _ensureCtx() {
    if (!this.ctx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      this.ctx = new Ctx();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.volume * (this.duckFactor ?? 1);
      this.master.connect(this.ctx.destination);
      // Mobile-webkit unlock: play a one-sample silent buffer inside the
      // enabling gesture so the context counts as user-started.
      try {
        const b = this.ctx.createBuffer(1, 1, 22050);
        const s = this.ctx.createBufferSource();
        s.buffer = b;
        s.connect(this.ctx.destination);
        s.start(0);
      } catch { /* cosmetic */ }
    }
    if (this.ctx.state !== 'running') this.ctx.resume();
  }

  // Call from any user gesture: mobile browsers suspend audio contexts on
  // backgrounding/interruption and only a gesture may revive them.
  kick() {
    if (!this.enabled || !this.ctx) return;
    this._claimSession();
    if (this.ctx.state !== 'running') {
      this.ctx.resume().then(() => {
        if (this.ctx.state === 'running' && this.current) this._emitNow(this.current.id);
      });
    }
  }

  // decodeAudioData: promise form where supported, callback form for old WebKit.
  _decode(ab) {
    return new Promise((resolve, reject) => {
      const p = this.ctx.decodeAudioData(ab, resolve, reject);
      if (p && typeof p.then === 'function') p.then(resolve, reject);
    });
  }

  async _buffer(id) {
    if (this.buffers.has(id)) return this.buffers.get(id);
    const url = this.trackMap[id];
    if (!url) { console.warn(`[audio] unknown track "${id}"`); return null; }
    if (!this.current) this._emitNow(id, { loading: true });
    const promise = fetch(url)
      .then(r => { if (!r.ok) throw new Error(`${r.status} ${url}`); return r.arrayBuffer(); })
      .then(ab => this._decode(ab))
      .then(buf => { this.buffers.set(id, buf); this._evict(id); return buf; })
      .catch(err => {
        console.warn('[audio] failed to load', id, err);
        this.buffers.delete(id);
        document.dispatchEvent(new CustomEvent('audio:error', { detail: { id } }));
        return null;
      });
    this.buffers.set(id, promise);
    return promise;
  }

  // Decoded songs are big (tens of MB of PCM); keep only a few in memory so
  // long reading sessions don't crash mobile tabs.
  _evict(keep) {
    const MAX = 4;
    for (const [k, v] of this.buffers) {
      if (this.buffers.size <= MAX) break;
      if (k === keep || k === this.current?.id || k === this.desired?.id) continue;
      if (typeof v?.then === 'function') continue;
      this.buffers.delete(k);
    }
  }

  setVolume(v) {
    this.volume = v;
    this._applyGain();
  }

  // Narration ducking: scale the music under a speaking voice without
  // touching the reader's chosen volume.
  setDuck(factor) {
    this.duckFactor = factor;
    this._applyGain(0.4);
  }

  _applyGain(smooth = 0.05) {
    if (this.master) {
      this.master.gain.setTargetAtTime(
        this.volume * (this.duckFactor ?? 1), this.ctx.currentTime, smooth);
    }
  }

  // Claim a "playback" media session so mobile WebKit routes Web Audio past
  // the silent switch. Must be called from within a user gesture.
  _claimSession() {
    if (!this._keepAlive) {
      const el = document.createElement('audio');
      el.src = SILENT_WAV;
      el.loop = true;
      el.setAttribute('playsinline', '');
      el.playsInline = true;
      el.style.display = 'none';
      document.body.appendChild(el);
      this._keepAlive = el;
    }
    this._keepAlive.play().catch(() => { /* blocked; harmless */ });
  }

  async setEnabled(on) {
    this.enabled = on;
    if (on) {
      this._ensureCtx();
      this._claimSession();
      if (this.desired) await this._play(this.desired.id, 1.5, this.desired.once);
    } else {
      if (this.current) this._fadeOutCurrent(0.8);
      this._keepAlive?.pause();
    }
  }

  // Called by the reader whenever the active paragraph's effective track changes.
  async setTrack(id, fade = 3, once = false) {
    this.desired = id ? { id, fade, once } : null;
    if (!this.enabled) return;
    this._ensureCtx();
    if (id === null) {
      if (this.current) this._fadeOutCurrent(fade);
      return;
    }
    // A finished 'once' piece stays finished: silence holds until a different
    // track plays. (Re-entering the scene after other music replays it.)
    if (once && id === this.finishedOnce) return;
    if (this.current && this.current.id === id) return;
    await this._play(id, fade, once);
  }

  async _play(id, fade, once = false) {
    const token = ++this.fadeToken;
    const buf = await this._buffer(id);
    if (!buf || token !== this.fadeToken || !this.enabled) return;
    if (this.current && this.current.id === id) return;

    if (id !== this.finishedOnce) this.finishedOnce = null;
    const now = this.ctx.currentTime;
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(1, now + fade);
    const source = this.ctx.createBufferSource();
    source.buffer = buf;
    source.loop = !once;
    source.connect(gain);
    gain.connect(this.master);
    source.start(now);
    if (once) {
      source.onended = () => {
        // Only the natural end of the still-current voice counts; a stop()
        // during a crossfade also fires onended and must not mark finished.
        if (this.current && this.current.source === source) {
          this.finishedOnce = id;
          this.current = null;
          this._emitNow(null);
        }
      };
    }

    if (this.current) this._fadeOut(this.current, fade);
    this.current = { id, source, gain };
    this._emitNow(id);

    // A suspended context accepts all of the above without producing sound.
    // If it isn't actually running shortly after start, tell the UI so the
    // reader knows a tap is needed.
    setTimeout(() => {
      if (this.enabled && this.current?.id === id && this.ctx.state !== 'running') {
        document.dispatchEvent(new CustomEvent('audio:blocked'));
      }
    }, 600);
  }

  _emitNow(id, extra = {}) {
    document.dispatchEvent(new CustomEvent('audio:now', { detail: { id, ...extra } }));
  }

  // A fresh chapter render is a fresh performance: finished 'once' pieces
  // may play again.
  resetOnce() {
    this.finishedOnce = null;
  }

  _fadeOut(voice, fade) {
    const now = this.ctx.currentTime;
    voice.gain.gain.cancelScheduledValues(now);
    voice.gain.gain.setValueAtTime(voice.gain.gain.value, now);
    voice.gain.gain.linearRampToValueAtTime(0.0001, now + fade);
    try { voice.source.stop(now + fade + 0.1); } catch { /* already stopped */ }
  }

  _fadeOutCurrent(fade) {
    if (!this.current) return;
    this._fadeOut(this.current, fade);
    this.current = null;
    this._emitNow(null);
  }
}
