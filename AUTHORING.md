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

A chapter entry can carry a `status` field:

- `"status": "todo"` — listed in the contents as *forthcoming*, but not
  readable. The file's contents are never rendered, so design notes in
  placeholder chapters can't leak into the site. (The raw `.md` file is still
  in the repo and fetchable by a determined reader — keep real spoilers out
  of public repos, or accept that only the rendered site is spoiler-safe.)
- `"status": "partial"` — readable, with a small "draft" notice at the top.
- no status — a finished, readable chapter.

Prev/next navigation and the overall progress bar skip `todo` chapters
automatically.

## Parts

`book.json` can declare a `parts` array; each part gets a title page shown
when the reader crosses into it, plus a separator in the contents list:

```json
"parts": [
  { "id": "part1", "title": "Part One", "subtitle": "Triboar", "before": "ch01" }
]
```

`before` names the first chapter of the part — the chapter *preceding* it
links to the part's title page instead of directly to that chapter.

## Skipping ahead

Opening any chapter silently brings the codex up to date with everything
before it (first-mention discoveries and `@unlock` directives from all prior
readable chapters), so a reader who jumps to a later chapter has a codex
consistent with their position. Opening a chapter that skips *any* unread
pages — a whole book for a fresh reader, or a single accidentally-skipped
chapter for a veteran — shows a confirmation first, naming what would be
skipped, with a "return to where I left off" escape hatch. Confirmed skips
are remembered, so a deliberate jump isn't re-questioned on every following
chapter. Reading progress itself is never marked by the catch-up — only the
codex.

## Chapter format

Plain text with blank lines between paragraphs, plus a few directives. Every
directive sits on its own line and applies to the **next** paragraph.

| Syntax | Meaning |
| --- | --- |
| `# Title` | Chapter title (first one wins) |
| `## Heading` | Section heading inside the chapter |
| `---` | Scene break (rendered as an ornament) |
| `@audio: trackId fade=4` | From the next paragraph on, play `trackId`; crossfade over 4s |
| `@audio: none fade=6` | Fade the music out over 6s; silence holds until the next directive |
| `@audio: trackId fade=2 once` | Play the track a single time (no loop); when it ends naturally, silence holds. Scrolling within the scene won't restart it — leaving for other music and returning later will |
| `@unlock: entityId.2` | Reaching the next paragraph unlocks codex tier 2 for `entityId` |
| `@image: images/file.jpg Alt text` | Inline artwork, revealed as its own paragraph in the flow (used for the door portraits and the Vault) |
| `@[Display Text](entityId)` | Inline entity reference — drives the sidebar, opens the codex entry on click, and *discovers* the entity (tier 1) when first reached |
| `*italic*`, `**bold**` | Minimal inline styling |

Notes:

- **Audio carries forward.** One `@audio:` directive holds until the next
  one, across scene breaks. Within a single chapter visit the score is
  **one-way**: once a later directive has taken effect (a new song, silence,
  or a finished `once` piece), scrolling back up never re-triggers earlier
  music. Re-opening the chapter starts its score fresh.
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

Entities (and individual tiers) can carry an optional `image` field for
portraits and item photography, added whenever the art exists:

```json
{ "id": "warden", "type": "character", "image": "images/warden.jpg",
  "tiers": [
    { "tier": 1, "name": "The Warden", "label": "...", "text": "..." },
    { "tier": 3, "name": "...", "image": "images/warden-revealed.jpg", "label": "...", "text": "..." }
  ] }
```

The sidebar cards show a thumbnail and the detail panel a full portrait.
The image shown is the deepest *unlocked* tier's image, falling back to the
entity-level one — so a tier-3 "true form" portrait stays hidden until tier 3
unlocks, and entities with no image simply render text-only, as now. Put
files in `images/` (jpg/png/webp; portraits look best at roughly 600×600+).

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
