// Ambient audio engine: Web Audio API, looped buffers, equal-power crossfades.
// Tracks are declared in book.json ("tracks": { id: url }) and referenced from
// chapters via @audio: directives.

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
  }

  _ensureCtx() {
    if (!this.ctx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      this.ctx = new Ctx();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.volume;
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }

  async _buffer(id) {
    if (this.buffers.has(id)) return this.buffers.get(id);
    const url = this.trackMap[id];
    if (!url) { console.warn(`[audio] unknown track "${id}"`); return null; }
    const promise = fetch(url)
      .then(r => { if (!r.ok) throw new Error(`${r.status} ${url}`); return r.arrayBuffer(); })
      .then(ab => this.ctx.decodeAudioData(ab))
      .then(buf => { this.buffers.set(id, buf); return buf; })
      .catch(err => { console.warn('[audio] failed to load', id, err); this.buffers.delete(id); return null; });
    this.buffers.set(id, promise);
    return promise;
  }

  setVolume(v) {
    this.volume = v;
    if (this.master) {
      this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05);
    }
  }

  async setEnabled(on) {
    this.enabled = on;
    if (on) {
      this._ensureCtx();
      if (this.desired) await this._play(this.desired.id, 1.5, this.desired.once);
    } else if (this.current) {
      this._fadeOutCurrent(0.8);
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
  }

  _emitNow(id) {
    document.dispatchEvent(new CustomEvent('audio:now', { detail: { id } }));
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
