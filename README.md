# Anamnesis — The Chronicle of Fundament

An interactive web reading experience for the book *Anamnesis*. Pure static
site — no build step, no server, no accounts — designed to be hosted free on
GitHub Pages, with all reader state kept in the browser's localStorage.

> `content/` holds the real manuscript export: 52 chapters (a few marked
> `status: "todo"` — listed as *forthcoming*, never rendered), a 77-entity
> codex, and `music_brief.md` describing the 30 intended cues. All track ids
> currently point at generated mood placeholders in `audio/` until the real
> score exists.

## Features

- **Progressive reveal** — paragraphs render one at a time; the reader
  advances with the ⌄ button, by scrolling at the frontier, or with
  ↓/Space/PageDown (↑ steps back a paragraph). Nothing past the frontier
  exists in the DOM, so unlocks and the sidebar can never run ahead of what
  has actually been read. Already-read text stays on the page and scrolls
  normally.
- **Reading progress** — the reveal frontier is the reader's progress,
  persisted locally, with per-chapter percentages, an overall progress bar,
  and a "Continue reading" resume button. No login needed.
- **Ambient scoring** — the author assigns music per paragraph with
  `@audio:` directives in the chapter text. As the reader scrolls, tracks
  crossfade (Web Audio API, per-transition fade durations). Audio is opt-in
  (the `♪` toggle) and remembers the reader's preference.
- **The Anamnesis (living codex)** — an X-Ray-style sidebar shows codex cards
  for the characters, places, artifacts, and concepts present on the page the
  reader is currently looking at. Entries are *tiered*: they deepen as the
  story unlocks more, and never reveal anything ahead of the reader's furthest
  point. Entity names themselves can evolve ("The Stranger" → a real name).
- **Reader-assembled appendix** — first mentions "discover" entries; explicit
  `@unlock:` directives deepen them at exactly the story beat the author
  chooses. The full codex page shows everything gathered so far, plus
  anonymous silhouettes for what's still buried — diegetic, spoiler-safe.

## Project layout

```
index.html            app shell
css/styles.css        themes (ink / parchment), reader, sidebar, codex
js/
  main.js             boot, routing (#/, #/read/<ch>, #/codex), header
  parser.js           chapter format parser (see AUTHORING.md)
  reader.js           scroll tracking, progress, unlocks, sidebar
  audio.js            Web Audio crossfade engine
  codex.js            codex data, cards, detail overlay, codex page
  state.js            localStorage persistence
content/
  book.json           manifest: title, chapter list, audio track map
  chapters/*.md       chapter text + directives (the authoring format)
  codex.json          tiered codex entries
audio/*.wav           ambient loops (generated placeholders — replace!)
tools/generate_sample_audio.py   regenerates the placeholder loops
.github/workflows/deploy.yml     GitHub Pages deployment
```

## Writing content

See **[AUTHORING.md](AUTHORING.md)** for the full chapter format, the codex
schema, and how unlock tiers work. The short version:

```markdown
# Chapter Title

@audio: threshold fade=4

A paragraph mentioning @[Someone](someone-id), which discovers their
codex entry the moment the reader gets here.

@unlock: someone-id.2

Reaching this paragraph deepens their entry to tier 2.
```

## Running locally

Any static file server works:

```bash
python3 -m http.server 8080
# then open http://localhost:8080
```

(Opening `index.html` via `file://` won't work — the app fetches JSON/markdown.)

## Deploying to GitHub Pages (free)

1. Merge to `main`.
2. In the repo settings: **Settings → Pages → Source → GitHub Actions**.
3. The included workflow (`.github/workflows/deploy.yml`) publishes the site
   on every push to `main`, at `https://<user>.github.io/<repo>/`.

Everything is relative-path and hash-routed, so it works from a project
subpath with zero configuration.

## Replacing the placeholder audio

Drop real tracks (mp3/ogg/wav/m4a — anything browsers decode) into `audio/`
and update the `tracks` map in `content/book.json`. Loops should be seamless;
the placeholder generator (`tools/generate_sample_audio.py`) shows the trick
of quantizing partials to whole cycles per loop.

## Reader data

All state lives in `localStorage` under the key `anamnesis:v1`: progress,
codex unlocks, "seen" markers for the update badges, and settings (theme,
volume, audio on/off). Clearing site data resets the book.
