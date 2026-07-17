// Properties panel: read-only renderer for YAML frontmatter.
//
// Renders a row per top-level scalar or array value. Nested objects are
// hidden in v1 (preserved in the raw frontmatter and round-tripped on save,
// but not exposed inline). Phase 2 adds editable inputs and an "Add property"
// affordance.
//
// inferType returns one of: 'string' | 'number' | 'date' | 'bool' | 'list' |
// 'object' | 'null'. The panel uses the type to pick an icon and a value
// renderer; it never mutates the underlying data in v1.

const TYPE_ICONS = {
  string: 'T',
  number: '#',
  date:   '▦',
  bool:   '◉',
  list:   '⊟',
  object: '{ }',
  null:   '∅',
};

function inferType(value) {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return 'list';
  if (value instanceof Date) return 'date';
  if (typeof value === 'object') {
    if (value && value.__type === 'date') return 'date';
    return 'object';
  }
  if (typeof value === 'boolean') return 'bool';
  if (typeof value === 'number')  return 'number';
  if (typeof value === 'string') {
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return 'date';
    return 'string';
  }
  return 'string';
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function dateString(value) {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (value && typeof value === 'object' && value.__type === 'date') return String(value.value);
  return String(value);
}

// A property value that IS a wikilink: "[[target]]" or "[[target|alias]]"
// (quotes already consumed by YAML). Obsidian renders these as links in its
// properties panel; so do we. Values merely CONTAINING a wikilink stay text.
const PROP_WIKILINK_RE = /^\[\[([^\[\]\|\n]+?)(?:\|([^\[\]\|\n]+?))?\]\]$/;

export function parsePropWikilink(value) {
  if (typeof value !== 'string') return null;
  const m = value.trim().match(PROP_WIKILINK_RE);
  if (!m) return null;
  const target = m[1].trim();
  if (!target) return null;
  return { target, alias: m[2] ? m[2].trim() : null };
}

function renderWikilinkValue(link, resolveWikilink) {
  const display = link.alias || link.target;
  // Unresolvable targets look visibly dead rather than erroring on click.
  const dead = typeof resolveWikilink === 'function' && !resolveWikilink(link.target);
  return `<a class="prop-wikilink${dead ? ' dead' : ''}" tabindex="0" data-target="${escapeHtml(link.target)}"${dead ? ' title="No matching file in this workspace"' : ''}>${escapeHtml(display)}</a>`;
}

function renderValue(value, type, resolveWikilink) {
  if (type === 'null') return '<span class="prop-value empty">empty</span>';
  if (type === 'bool') {
    const on = value === true;
    return `<span class="prop-value"><span class="bool ${on ? 't' : 'f'}"><span class="dot"></span>${on ? 'true' : 'false'}</span></span>`;
  }
  if (type === 'date') {
    return `<span class="prop-value date">${escapeHtml(dateString(value))}</span>`;
  }
  if (type === 'list') {
    const chips = value
      .map(v => {
        const link = parsePropWikilink(v);
        if (link) return `<span class="prop-chip">${renderWikilinkValue(link, resolveWikilink)}</span>`;
        return `<span class="prop-chip">${escapeHtml(String(v))}</span>`;
      })
      .join('');
    return `<span class="prop-value list">${chips || '<span class="empty">empty</span>'}</span>`;
  }
  if (type === 'number') {
    return `<span class="prop-value number">${escapeHtml(String(value))}</span>`;
  }
  if (type === 'object') {
    return '<span class="prop-value empty">nested object (Phase 2)</span>';
  }
  const link = parsePropWikilink(value);
  if (link) return `<span class="prop-value string">${renderWikilinkValue(link, resolveWikilink)}</span>`;
  return `<span class="prop-value string">${escapeHtml(String(value))}</span>`;
}

// Renders the panel into the given container element. Returns the count of
// rows rendered so the caller can decide whether to show the panel at all.
// opts.onWikilinkClick: wikilink property values become clickable and route
// through it; opts.resolveWikilink(target) -> bool marks dead links.
export function renderProperties(container, parsed, opts = {}) {
  const { onWikilinkClick = null, resolveWikilink = null } = opts;
  if (!container) return 0;
  container.innerHTML = '';
  if (!parsed || typeof parsed !== 'object') {
    container.classList.remove('visible');
    return 0;
  }

  const entries = Object.entries(parsed);
  if (!entries.length) {
    container.classList.remove('visible');
    return 0;
  }

  let nestedHidden = 0;
  const rows = [];
  for (const [key, value] of entries) {
    const type = inferType(value);
    if (type === 'object') { nestedHidden += 1; continue; }
    rows.push(`
      <div class="prop-row">
        <span class="prop-icon" title="${escapeHtml(type)}">${TYPE_ICONS[type] || 'T'}</span>
        <span class="prop-key">${escapeHtml(key)}</span>
        ${renderValue(value, type, resolveWikilink)}
      </div>
    `);
  }

  const header = `
    <div class="properties-header">
      <span class="label">Properties</span>
      <span class="meta">${rows.length} field${rows.length === 1 ? '' : 's'}${nestedHidden ? `, ${nestedHidden} nested hidden` : ''}</span>
    </div>
  `;
  container.innerHTML = header + '<div class="properties-body">' + rows.join('') + '</div>';
  container.classList.add('visible');

  // One delegated click/keyboard handler per render (innerHTML assignment
  // above dropped any previous one). Dead links are inert by design.
  if (typeof onWikilinkClick === 'function') {
    const activate = (event) => {
      const el = event.target.closest && event.target.closest('a.prop-wikilink');
      if (!el || el.classList.contains('dead')) return;
      if (event.type === 'keydown' && event.key !== 'Enter') return;
      event.preventDefault();
      onWikilinkClick(el.getAttribute('data-target') || '');
    };
    container.addEventListener('click', activate);
    container.addEventListener('keydown', activate);
  }
  return rows.length;
}
