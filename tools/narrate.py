#!/usr/bin/env python3
"""Generate placeholder narration for chapters with Piper TTS.

Mirrors js/parser.js paragraph semantics exactly, so timing indices line up
with the reader's paragraph indices. Output per chapter: <id>.mp3 (mono 64k)
and <id>.json ({"duration": s, "timings": [start_s per paragraph index]}),
plus a manifest.json across all narrated chapters.

Usage:
  python3 tools/narrate.py --voice path/to/voice.onnx --out ../anamnesis-audio/narration ch00 ch01
  python3 tools/narrate.py --voice v.onnx --out DIR --all   # every readable chapter

Replace any chapter with a human recording later by overwriting its .mp3 and
regenerating timings (re-run with --timings-only if the recording is split per
paragraph, or align by hand/WhisperX for single-take recordings).
"""
import argparse, json, re, struct, subprocess, sys, wave
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
GAP_PARA = 0.65      # silence between paragraphs
GAP_BREAK = 1.3      # scene break / heading lead-in
GAP_IMAGE = 1.0      # an image "slot": pause while art is on screen
SAMPLE_RATE = 22050

AUDIO_RE = re.compile(r'^@audio:\s*[\w&-]+((\s+(fade=\d+(\.\d+)?|once))*)\s*$')
UNLOCK_RE = re.compile(r'^@unlock:\s*[\w-]+\.\d+\s*$')
IMAGE_RE = re.compile(r'^@image:\s*(\S+)(?:\s+(.+))?$')

def parse_chapter(text):
    """Same walk as js/parser.js: returns list of dicts {kind, text, break_before}."""
    paras, buf, pending_break = [], [], False
    def flush(kind='text'):
        nonlocal buf, pending_break
        raw = re.sub(r'\s+', ' ', ' '.join(buf)).strip()
        buf = []
        if not raw:
            return
        paras.append({'kind': kind, 'text': raw, 'break_before': pending_break})
        pending_break = False
    for line in text.splitlines():
        t = line.strip()
        if t == '':
            flush(); continue
        if AUDIO_RE.match(t) or UNLOCK_RE.match(t):
            flush(); continue
        m = IMAGE_RE.match(t)
        if m:
            flush()
            paras.append({'kind': 'image', 'text': '', 'break_before': pending_break})
            pending_break = False
            continue
        if t == '---':
            flush(); pending_break = True; continue
        if t.startswith('## '):
            flush(); buf = [t[3:]]; flush('heading'); continue
        if t.startswith('# '):
            flush(); continue
        buf.append(t)
    flush()
    return paras

def clean_for_speech(raw):
    s = re.sub(r'@\[([^\]]+)\]\([\w-]+\)', r'\1', raw)
    s = re.sub(r'\*\*([^*]+)\*\*', r'\1', s)
    s = re.sub(r'\*([^*]+)\*', r'\1', s)
    s = s.replace('—', ', ').replace('…', '...')
    return s.strip()

def synth_paragraphs(voice, paras):
    """Yield (index, pcm_bytes) — silence-only for images."""
    from piper import PiperVoice  # noqa: F401  (import kept near use)
    for i, p in enumerate(paras):
        if p['kind'] == 'image' or not clean_for_speech(p['text']):
            yield i, b''
            continue
        chunks = voice.synthesize(clean_for_speech(p['text']))
        pcm = b''.join(c.audio_int16_bytes for c in chunks)
        yield i, pcm

def silence(seconds):
    return b'\x00\x00' * int(SAMPLE_RATE * seconds)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--voice', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--all', action='store_true')
    ap.add_argument('chapters', nargs='*')
    args = ap.parse_args()

    book = json.loads((ROOT / 'content/book.json').read_text())
    ids = [c['id'] for c in book['chapters'] if c.get('status') != 'todo']
    targets = ids if args.all else args.chapters
    unknown = [t for t in targets if t not in ids]
    if unknown:
        sys.exit(f'not readable chapters: {unknown}')

    from piper import PiperVoice
    voice = PiperVoice.load(args.voice)
    out = Path(args.out); out.mkdir(parents=True, exist_ok=True)

    manifest_path = out / 'manifest.json'
    manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else {
        'version': 1, 'voice': Path(args.voice).stem, 'chapters': {}}

    for cid in targets:
        src = ROOT / f'content/chapters/{cid}.md'
        paras = parse_chapter(src.read_text())
        timings, pcm_parts, t = [], [], 0.0
        for i, pcm in synth_paragraphs(voice, paras):
            p = paras[i]
            gap = GAP_BREAK if (p['break_before'] or p['kind'] == 'heading') else GAP_PARA
            if i > 0:
                pcm_parts.append(silence(gap)); t += gap
            timings.append(round(t, 3))
            if p['kind'] == 'image':
                pcm_parts.append(silence(GAP_IMAGE)); t += GAP_IMAGE
            else:
                pcm_parts.append(pcm); t += len(pcm) / 2 / SAMPLE_RATE
            print(f'  {cid} [{i+1}/{len(paras)}] t={t:7.1f}s', end='\r', flush=True)
        pcm_all = b''.join(pcm_parts)

        wav_path = out / f'{cid}.wav'
        with wave.open(str(wav_path), 'wb') as w:
            w.setnchannels(1); w.setsampwidth(2); w.setframerate(SAMPLE_RATE)
            w.writeframes(pcm_all)
        mp3_path = out / f'{cid}.mp3'
        subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-i', str(wav_path),
                        '-ac', '1', '-codec:a', 'libmp3lame', '-b:a', '64k',
                        str(mp3_path)], check=True)
        wav_path.unlink()
        duration = round(len(pcm_all) / 2 / SAMPLE_RATE, 3)
        (out / f'{cid}.json').write_text(json.dumps(
            {'duration': duration, 'timings': timings}))
        manifest['chapters'][cid] = {'file': f'{cid}.mp3', 'duration': duration}
        manifest_path.write_text(json.dumps(manifest, indent=1))
        print(f'\n{cid}: {len(paras)} paragraphs, {duration/60:.1f} min, '
              f'{mp3_path.stat().st_size//1024} KB')

if __name__ == '__main__':
    main()
