# Authoring guide

How to write chapters, wire up music, and build the living codex.

## Adding a chapter

1. Create `content/chapters/<id>.md`.
2. Add it to the `chapters` array in `content/book.json`:

```json
{ "id": "ch03", "title": "Shown in menus", "file": "content/chapters/ch03.md" }
```

The chapter order in `book.json` defines reading order and the prev/next
links at the bottom of each chapter.

## Chapter format

Plain text with blank lines between paragraphs, plus a few directives. Every
directive sits on its own line and applies to the **next** paragraph.

| Syntax | Meaning |
| --- | --- |
| `# Title` | Chapter title (first one wins) |
| `## Heading` | Section heading inside the chapter |
| `---` | Scene break (rendered as an ornament) |
| `@audio: trackId fade=4` | From the next paragraph on, play `trackId`; crossfade over 4s |
| `@audio: none fade=6` | Fade the music out over 6s |
| `@unlock: entityId.2` | Reaching the next paragraph unlocks codex tier 2 for `entityId` |
| `@[Display Text](entityId)` | Inline entity reference — drives the sidebar, opens the codex entry on click, and *discovers* the entity (tier 1) when first reached |
| `*italic*`, `**bold**` | Minimal inline styling |

Notes:

- **Audio carries forward.** One `@audio:` directive holds until the next
  one, across scene breaks. Scrolling *up* also re-triggers the right track —
  each paragraph knows its effective track, so music always matches what the
  reader is looking at, in either direction.
- **Fades are per-transition.** `fade=` is seconds; give quiet scene changes
  long fades (5–8s) and stingers short ones (1–2s).
- **Unlocks are cumulative and ordered.** If a reader jumps ahead, every
  unlock they scrolled past still fires, in order, so state never skips beats.
- **Mentions without discovery:** if you want to mention a character without
  creating a codex entry yet, just don't mark the mention — plain text is
  invisible to the codex. `@[...]` is an authorial choice meaning "the
  chronicle may speak of this now."

## The codex (`content/codex.json`)

Each entity has an `id` (referenced from chapters), a `type` — one of
`character`, `location`, `artifact`, `concept` — and an array of `tiers`:

```json
{
  "id": "warden",
  "type": "character",
  "tiers": [
    { "tier": 1, "name": "The Warden", "label": "A rumor of office",
      "text": "What the reader could fairly know at first mention." },
    { "tier": 2, "name": "The Warden of Harrow's Ferry", "label": "After the knock",
      "text": "Deeper truth, unlocked by an @unlock: warden.2 directive." }
  ]
}
```

Rules the engine enforces:

- The reader only ever sees tiers **at or below** their unlocked level.
  There is no way to scroll, click, or URL-hack into a locked tier.
- The **display name** is the highest unlocked tier's `name` — so an entity
  can be "The Stranger" for three chapters and gain a true name later.
- The detail panel shows all unlocked tiers stacked as a chronicle (oldest
  first, newest highlighted), plus a teaser line if locked tiers remain.
- A gold dot on a card means the entry changed since the reader last opened
  it.
- Tier 1 unlocks automatically at first `@[...]` mention; higher tiers only
  ever unlock via explicit `@unlock:` directives. Write tier text
  *diegetically* — as in-world records — and it will never spoil, because the
  engine won't show it before the story has earned it.

## Music tracks

Declare tracks in `content/book.json`:

```json
"tracks": {
  "threshold": "audio/threshold.wav",
  "storm": "audio/storm.mp3"
}
```

Then reference by id: `@audio: storm fade=5`. Keep loops seamless (the
placeholder generator in `tools/` shows one technique). Files load lazily —
a track is only fetched the first time it's needed.

## Testing a fresh-reader experience

All state is in localStorage. In DevTools:
`localStorage.removeItem('anamnesis:v1')` then reload — you're a new reader.
