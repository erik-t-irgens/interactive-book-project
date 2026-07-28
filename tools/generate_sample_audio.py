#!/usr/bin/env python3
"""Generate seamless ambient WAV loops as placeholder tracks.

Each track is a soft chord pad whose partial frequencies are quantized to a
whole number of cycles per loop, so the loop point is click-free. Replace
these with real music whenever you have it — anything the browser can decode
(mp3/ogg/wav/m4a) works; just update the "tracks" map in content/book.json.

Usage: python3 tools/generate_sample_audio.py
"""
import math
import struct
import wave
from pathlib import Path

RATE = 22050
DUR = 24.0  # seconds per loop
OUT = Path(__file__).resolve().parent.parent / "audio"

TRACKS = {
    # name: list of (freq_hz, amplitude, lfo_cycles_per_loop)
    "threshold": [   # calm, warm — arrival and daylight
        (110.00, 0.24, 2), (164.81, 0.18, 3), (220.00, 0.14, 5), (277.18, 0.08, 7),
    ],
    "undercroft": [  # low, hollow — the deep rooms
        (73.42, 0.30, 2), (110.00, 0.16, 3), (146.83, 0.10, 4), (220.00, 0.04, 9),
    ],
    "vigil": [       # uneasy shimmer — tension
        (123.47, 0.22, 3), (174.61, 0.16, 5), (185.00, 0.12, 6), (369.99, 0.05, 11),
    ],
}


def quantize(freq: float) -> float:
    """Snap a frequency to a whole number of cycles over the loop length."""
    return round(freq * DUR) / DUR


def render(partials):
    n = int(RATE * DUR)
    samples = []
    for i in range(n):
        t = i / RATE
        v = 0.0
        for freq, amp, lfo_cycles in partials:
            f = quantize(freq)
            # Slow tremolo, also a whole number of cycles so the loop stays seamless.
            lfo = 0.75 + 0.25 * math.sin(2 * math.pi * lfo_cycles * t / DUR)
            v += amp * lfo * math.sin(2 * math.pi * f * t)
        samples.append(max(-1.0, min(1.0, v)))
    return samples


def write_wav(path: Path, samples):
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(b"".join(struct.pack("<h", int(s * 32000)) for s in samples))


def main():
    OUT.mkdir(exist_ok=True)
    for name, partials in TRACKS.items():
        path = OUT / f"{name}.wav"
        write_wav(path, render(partials))
        print(f"wrote {path} ({path.stat().st_size // 1024} KiB)")


if __name__ == "__main__":
    main()
