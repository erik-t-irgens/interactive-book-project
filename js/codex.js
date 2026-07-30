// The Anamnesis: codex data access, sidebar cards, detail overlay, codex page.
// Spoiler rule: the reader only ever sees content at or below their unlocked
// tier for each entity. Undiscovered entities render as anonymous silhouettes.

import { state, unlockedTier, markSeen, hasUnseenUpdate, save } from './state.js';

export let codex = { entities: [] };
const byId = new Map();

export async function loadCodex(url) {
  const res = await fetch(url);
  codex = await res.json();
  byId.clear();
  for (const e of codex.entities) byId.set(e.id, e);
}

export function entity(id) { return byId.get(id) || null; }

// Where each tier was earned: entityId -> { tier: { ch, index } }, computed
// from the chapters at boot. Lets the codex cite its sources.
let sources = {};
let chapterTitle = () => '';
export function setSources(map, titleFn) {
  sources = map;
  chapterTitle = titleFn;
}

// Highest tier definition at or below the reader's unlock level.
export function visibleTier(id) {
  const e = byId.get(id);
  const level = unlockedTier(id);
  if (!e || level === 0) return null;
  let best = null;
  for (const t of e.tiers) if (t.tier <= level) best = t;
  return best;
}

export function displayName(id) {
  const e = byId.get(id);
  const level = unlockedTier(id);
  if (!e) return id;
  let name = e.tiers[0]?.name || id;
  for (const t of e.tiers) if (t.tier <= level && t.name) name = t.name;
  return name;
}

// Portrait for the reader's current knowledge: the deepest unlocked tier's
// image if any tier has one, else the entity-level image. Never shows a
// locked tier's image.
export function displayImage(id) {
  const e = byId.get(id);
  const level = unlockedTier(id);
  if (!e) return null;
  let img = e.image || null;
  for (const t of e.tiers) if (t.tier <= level && t.image) img = t.image;
  return img;
}

const TYPE_LABELS = {
  character: 'Character',
  location: 'Place',
  concept: 'Concept',
  artifact: 'Artifact',
};

export function cardHtml(id, { locked = false } = {}) {
  if (locked) {
    return `<div class="entity-card locked" aria-hidden="true">
      <div class="card-type">Undiscovered</div>
      <div class="card-name">— ? —</div>
      <div class="card-teaser">Keep reading.</div>
    </div>`;
  }
  const e = byId.get(id);
  const tier = visibleTier(id);
  if (!e || !tier) return '';
  const badge = hasUnseenUpdate(id) ? '<span class="badge-new" title="Entry updated"></span>' : '';
  const img = displayImage(id);
  return `<button class="entity-card" data-entity="${id}">
    ${img ? `<img class="card-thumb" src="${img}" alt="" loading="lazy">` : ''}
    <div class="card-body">
      <div class="card-type">${TYPE_LABELS[e.type] || e.type} ${badge}</div>
      <div class="card-name">${displayName(id)}</div>
      <div class="card-teaser">${tier.label || ''}</div>
    </div>
  </button>`;
}

// ---- Detail overlay ------------------------------------------------------

export function openEntityDetail(id) {
  const e = byId.get(id);
  const level = unlockedTier(id);
  if (!e || level === 0) return;
  const root = document.getElementById('overlay-root');
  const shown = e.tiers.filter(t => t.tier <= level);
  const remaining = e.tiers.length - shown.length;

  const img = displayImage(id);
  const wide = e.imageWide ? ' detail-portrait--wide' : '';
  root.innerHTML = `
    <div class="overlay-scrim" data-close></div>
    <aside class="entity-detail${e.imageWide ? ' entity-detail--wide' : ''}" role="dialog" aria-label="Codex entry">
      <button class="detail-close" data-close aria-label="Close">×</button>
      ${img ? `<img class="detail-portrait${wide}" src="${img}" alt="${displayName(id)}">` : ''}
      <div class="detail-type">${TYPE_LABELS[e.type] || e.type}</div>
      <h2 class="detail-name">${displayName(id)}</h2>
      ${shown.map((t, i) => {
        const src = sources[id]?.[t.tier];
        const cite = src && chapterTitle(src.ch)
          ? `<a class="tier-source" href="#/read/${src.ch}/${src.index}">⟶ from ${chapterTitle(src.ch)}</a>`
          : '';
        return `
        <div class="detail-tier ${i === shown.length - 1 ? 'latest' : ''}">
          <div class="detail-tier-label">${t.label || 'Recollection ' + t.tier}</div>
          <div class="detail-tier-text">${t.text}</div>
          ${cite}
        </div>`;
      }).join('')}
      ${remaining > 0
        ? `<div class="detail-locked-note">The chronicle holds more on this. Keep reading.</div>`
        : ''}
    </aside>`;

  root.querySelectorAll('[data-close]').forEach(el =>
    el.addEventListener('click', closeEntityDetail));
  markSeen(id);
  document.dispatchEvent(new CustomEvent('codex:seen', { detail: { id } }));
}

export function closeEntityDetail() {
  document.getElementById('overlay-root').innerHTML = '';
}

// Global delegation: any .entity-card / .entity-ref opens the detail panel.
document.addEventListener('click', ev => {
  const card = ev.target.closest('.entity-card:not(.locked)');
  if (card?.dataset.entity) { openEntityDetail(card.dataset.entity); return; }
  const ref = ev.target.closest('.entity-ref');
  if (ref?.dataset.entity) openEntityDetail(ref.dataset.entity);
});
document.addEventListener('keydown', ev => {
  if (ev.key === 'Escape') closeEntityDetail();
  if (ev.key === 'Enter' && ev.target.classList?.contains('entity-ref')) {
    openEntityDetail(ev.target.dataset.entity);
  }
});

// ---- Codex page ----------------------------------------------------------

const GROUP_ORDER = ['character', 'location', 'artifact', 'concept'];

export function renderCodexPage(container) {
  const discovered = codex.entities.filter(e => unlockedTier(e.id) > 0);
  const hiddenCount = codex.entities.length - discovered.length;

  const groups = GROUP_ORDER
    .map(type => ({ type, items: discovered.filter(e => e.type === type) }))
    .filter(g => g.items.length > 0);

  container.innerHTML = `
    <div class="codex-page">
      <h1>The Anamnesis</h1>
      <p class="codex-intro">Everything the chronicle has yielded so far. Entries deepen as you read; nothing here runs ahead of you.</p>
      ${discovered.length === 0
        ? '<p class="sidebar-empty">Nothing recollected yet. Begin reading, and the chronicle will begin keeping notes alongside you.</p>'
        : groups.map(g => `
            <div class="codex-group-label">${TYPE_LABELS[g.type]}s</div>
            <div class="codex-grid">${g.items.map(e => cardHtml(e.id)).join('')}</div>
          `).join('')}
      ${hiddenCount > 0
        ? `<div class="codex-group-label">Still buried</div>
           <div class="codex-grid">${Array.from({ length: hiddenCount }, () => cardHtml(null, { locked: true })).join('')}</div>`
        : ''}
    </div>`;
}
