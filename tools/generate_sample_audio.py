#!/usr/bin/env python3
"""Generate seamless placeholder ambient loops, one per mood family.

The real score is composed per content/music_brief.md; until those tracks
exist, every track id in content/book.json points at one of these mood
placeholders (see MOOD_MAP) so the audio system is fully exercisable.
To ship real music: drop files in audio/ and repoint ids in book.json's
"tracks" map — nothing else changes.

Partial frequencies are quantized to whole cycles per loop so loops are
click-free. Usage: python3 tools/generate_sample_audio.py
"""
import math
import struct
import wave
from pathlib import Path

RATE = 22050
DUR = 22.0  # seconds per loop
OUT = Path(__file__).resolve().parent.parent / "audio"

# mood: list of (freq_hz, amplitude, tremolo_cycles_per_loop)
MOODS = {
    "placeholder-warm": [    # hearths, lanterns, kindness
        (110.00, 0.22, 2), (164.81, 0.16, 3), (220.00, 0.13, 5), (329.63, 0.06, 7),
    ],
    "placeholder-dark": [    # drones, depths, dead cities
        (55.00, 0.28, 2), (82.41, 0.18, 3), (110.00, 0.10, 4), (164.81, 0.04, 9),
    ],
    "placeholder-gray": [    # the dream, mirrors, thresholds
        (146.83, 0.14, 2), (196.00, 0.12, 3), (293.66, 0.09, 5), (392.00, 0.05, 8),
    ],
    "placeholder-hush": [    # Remembrances: near-silence with a felt floor
        (65.41, 0.05, 2), (98.00, 0.03, 3),
    ],
    "placeholder-bright": [  # feywild, silver fire, winter light
        (220.00, 0.14, 3), (277.18, 0.12, 4), (329.63, 0.10, 5), (554.37, 0.05, 9),
    ],
    "placeholder-tense": [   # rot, harvest, rising pressure
        (98.00, 0.20, 3), (138.59, 0.15, 5), (146.83, 0.12, 6), (293.66, 0.05, 11),
    ],
    "placeholder-gilt": [    # masks, dinner tables, chambers
        (130.81, 0.16, 2), (196.00, 0.14, 4), (246.94, 0.11, 5), (415.30, 0.05, 7),
    ],
}

# track id (from chapters/@audio) -> mood placeholder file
MOOD_MAP = {
    "triboar-hearth": "placeholder-warm", "nesme-lantern": "placeholder-warm",
    "mooring-kind": "placeholder-warm", "heartsilver-eve": "placeholder-warm",
    "epilogue-morning": "placeholder-warm", "particular-fire": "placeholder-warm",
    "moongleam-arch": "placeholder-warm",
    "undergrave-drone": "placeholder-dark", "the-depths": "placeholder-dark",
    "ascore-hush": "placeholder-dark", "gray-country": "placeholder-dark",
    "owned-north": "placeholder-dark",
    "gray-dream": "placeholder-gray", "mirror-glass": "placeholder-gray",
    "door-threshold": "placeholder-gray",
    "remembrance-silent": "placeholder-hush",
    "bright-country": "placeholder-bright", "seam-of-winter": "placeholder-bright",
    "silver-fire": "placeholder-bright", "tide-and-time": "placeholder-bright",
    "bloodrot-wood": "placeholder-tense", "before-the-harvest": "placeholder-tense",
    "glass-rise": "placeholder-tense", "vault-of-glass": "placeholder-tense",
    "ascension-night": "placeholder-tense", "deliverance-bells": "placeholder-tense",
    "masquerade-gilt": "placeholder-gilt", "gentlemans-table": "placeholder-gilt",
    "session-chamber": "placeholder-gilt", "fundament-doubled": "placeholder-gilt",
}


def quantize(freq: float) -> float:
    return round(freq * DUR) / DUR


def render(partials):
    n = int(RATE * DUR)
    out = []
    for i in range(n):
        t = i / RATE
        v = 0.0
        for freq, amp, trem in partials:
            f = quantize(freq)
            lfo = 0.75 + 0.25 * math.sin(2 * math.pi * trem * t / DUR)
            v += amp * lfo * math.sin(2 * math.pi * f * t)
        out.append(max(-1.0, min(1.0, v)))
    return out


def main():
    OUT.mkdir(exist_ok=True)
    for name, partials in MOODS.items():
        path = OUT / f"{name}.wav"
        with wave.open(str(path), "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(RATE)
            w.writeframes(b"".join(struct.pack("<h", int(s * 32000)) for s in render(partials)))
        print(f"wrote {path} ({path.stat().st_size // 1024} KiB)")
    print("\nTrack map for content/book.json:")
    import json
    print(json.dumps({k: f"audio/{v}.wav" for k, v in MOOD_MAP.items()}, indent=2))


if __name__ == "__main__":
    main()
