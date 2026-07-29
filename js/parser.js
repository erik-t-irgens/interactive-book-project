// Parses the chapter authoring format (see AUTHORING.md).
//
//   # Chapter Title          — first h1 becomes the chapter title
//   ## Section Heading       — rendered as an in-chapter heading
//   ---                      — scene break
//   @audio: trackId fade=4   — from the next paragraph on, play this track
//   @audio: none fade=6      — fade music out
//   @unlock: entityId.2      — reaching the next paragraph unlocks codex tier 2
//   @[Display Text](entityId) — inline entity reference (drives the sidebar)
//   *emphasis* / **strong**  — minimal inline styling

const AUDIO_RE = /^@audio:\s*([\w-]+)(?:\s+fade=(\d+(?:\.\d+)?))?\s*$/;
const UNLOCK_RE = /^@unlock:\s*([\w-]+)\.(\d+)\s*$/;
const IMAGE_RE = /^@image:\s*(\S+)(?:\s+(.+))?$/;

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderInline(raw) {
  const entities = [];
  let html = escapeHtml(raw);
  html = html.replace(/@\[([^\]]+)\]\(([\w-]+)\)/g, (_, text, id) => {
    if (!entities.includes(id)) entities.push(id);
    return `<span class="entity-ref" data-entity="${id}" role="button" tabindex="0">${text}</span>`;
  });
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  return { html, entities };
}

export function parseChapter(text) {
  const lines = text.split(/\r?\n/);
  const paragraphs = [];
  let title = 'Untitled';
  let currentAudio = null;      // carried forward: { track, fade } | { track: null, fade }
  let pendingAudio = null;
  let pendingUnlocks = [];
  let pendingBreak = false;
  let buffer = [];

  const flush = (kind = 'text') => {
    const raw = buffer.join(' ').replace(/\s+/g, ' ').trim();
    buffer = [];
    if (!raw) return;
    if (pendingAudio) { currentAudio = pendingAudio; pendingAudio = null; }
    const { html, entities } = renderInline(raw);
    paragraphs.push({
      index: paragraphs.length,
      kind,
      html,
      entities,
      unlocks: pendingUnlocks,
      audio: currentAudio,
      breakBefore: pendingBreak,
    });
    pendingUnlocks = [];
    pendingBreak = false;
  };

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed === '') { flush(); continue; }

    const audioMatch = trimmed.match(AUDIO_RE);
    if (audioMatch) {
      flush();
      pendingAudio = {
        track: audioMatch[1] === 'none' ? null : audioMatch[1],
        fade: audioMatch[2] ? parseFloat(audioMatch[2]) : 3,
      };
      continue;
    }

    const unlockMatch = trimmed.match(UNLOCK_RE);
    if (unlockMatch) {
      flush();
      pendingUnlocks.push({ entity: unlockMatch[1], tier: parseInt(unlockMatch[2], 10) });
      continue;
    }

    // Inline artwork: a block of its own, revealed like a paragraph.
    const imageMatch = trimmed.match(IMAGE_RE);
    if (imageMatch) {
      flush();
      if (pendingAudio) { currentAudio = pendingAudio; pendingAudio = null; }
      paragraphs.push({
        index: paragraphs.length,
        kind: 'image',
        src: imageMatch[1],
        alt: imageMatch[2] || '',
        html: '',
        entities: [],
        unlocks: pendingUnlocks,
        audio: currentAudio,
        breakBefore: pendingBreak,
      });
      pendingUnlocks = [];
      pendingBreak = false;
      continue;
    }

    if (trimmed === '---') { flush(); pendingBreak = true; continue; }

    if (trimmed.startsWith('## ')) {
      flush();
      buffer = [trimmed.slice(3)];
      flush('heading');
      continue;
    }

    if (trimmed.startsWith('# ')) {
      flush();
      title = trimmed.slice(2).trim();
      continue;
    }

    buffer.push(trimmed);
  }
  flush();

  return { title, paragraphs };
}
