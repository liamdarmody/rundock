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

// Per-type row icons as Lucide-style inline SVGs (24 viewBox, 1.8 stroke, round
// caps), matching Obsidian's property-type icons far better than glyphs did.
const TYPE_ICON_PATHS = {
  string: ['M4 7V5h16v2', 'M9 19h6', 'M12 5v14'],                           // type
  number: ['M4 9h16', 'M4 15h16', 'M10 3 8 21', 'M16 3l-2 18'],            // hash
  date:   ['M8 2v4', 'M16 2v4', 'M3 10h18', 'M5 4h14a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z'], // calendar
  bool:   ['m9 11 3 3L22 4', 'M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11'], // check-square
  list:   ['M8 6h13', 'M8 12h13', 'M8 18h13', 'M3 6h.01', 'M3 12h.01', 'M3 18h.01'],       // list
  object: ['M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5a2 2 0 0 0 2 2h1', 'M16 3h1a2 2 0 0 1 2 2v5a2 2 0 0 0 2 2 2 2 0 0 0-2 2v5a2 2 0 0 1-2 2h-1'], // braces
  null:   ['M5 12h14'],                                                     // minus
};

function typeIconSvg(type) {
  const paths = TYPE_ICON_PATHS[type] || TYPE_ICON_PATHS.string;
  return '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" '
    + 'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">'
    + paths.map((d) => `<path d="${d}"/>`).join('') + '</svg>';
}

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
    .replace(/>/g, '&gt;')
    // Quotes MUST be escaped: these values interpolate into double-quoted
    // attributes (data-target, data-prop-key). Without this a frontmatter
    // wikilink like [[x" onmouseover=alert(1)]] breaks out of the attribute
    // and injects a handler that runs in the app's own (unsandboxed) origin.
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
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

function renderValue(value, type, resolveWikilink, editable) {
  if (type === 'null') return '<span class="prop-value empty">empty</span>';
  if (type === 'bool') {
    const on = value === true;
    return `<span class="prop-value"><span class="bool ${on ? 't' : 'f'}"><span class="dot"></span>${on ? 'true' : 'false'}</span></span>`;
  }
  if (type === 'date') {
    return `<span class="prop-value date">${escapeHtml(dateString(value))}</span>`;
  }
  if (type === 'list') {
    // Wikilink items render as inline links (Obsidian's grammar), keeping the
    // remove affordance; plain items stay as tag-style pills.
    const items = value
      .map((v, i) => {
        const link = parsePropWikilink(v);
        const remove = '<button type="button" class="prop-chip-remove" title="Remove">&times;</button>';
        return link
          ? `<span class="prop-link-item" data-item-index="${i}">${renderWikilinkValue(link, resolveWikilink)}${remove}</span>`
          : `<span class="prop-chip" data-item-index="${i}">${escapeHtml(String(v))}${remove}</span>`;
      })
      .join('');
    // Inline add affordance, always present (subtle) rather than a hover row,
    // so adding reads like Obsidian.
    const add = editable ? '<button type="button" class="prop-add" title="Add item">+</button>' : '';
    return `<span class="prop-value list">${items || '<span class="empty">empty</span>'}${add}</span>`;
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
// opts.onEditProperty(key, newValue) -> bool: when present, scalar values
// edit inline, bools toggle, and list chips remove/add. The callback owns
// the byte-honest YAML surgery; a false return leaves the panel unchanged.
export function renderProperties(container, parsed, opts = {}) {
  const { onWikilinkClick = null, resolveWikilink = null, onEditProperty = null } = opts;
  if (!container) return 0;
  // The container is a single persistent node reused for every file. Store the
  // current render's callbacks and data here; the delegated handlers (attached
  // exactly once, below) read this at event time. Attaching per render instead
  // would stack a new handler each file/edit, each bound to a stale file's
  // data, so a click would fire several at once and edit the wrong file.
  container.__propsState = { parsed, onWikilinkClick, resolveWikilink, onEditProperty };
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
    const editable = onEditProperty && ['string', 'number', 'date', 'bool', 'list', 'null'].includes(type);
    rows.push(`
      <div class="prop-row${editable ? ' editable' : ''}" data-prop-key="${escapeHtml(key)}" data-prop-type="${escapeHtml(type)}">
        <span class="prop-icon" title="${escapeHtml(type)}">${typeIconSvg(type)}</span>
        <span class="prop-key">${escapeHtml(key)}</span>
        ${renderValue(value, type, resolveWikilink, editable)}
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
  container.classList.toggle('props-editable', typeof onEditProperty === 'function');

  // Delegated handlers attach once and read container.__propsState (refreshed
  // above), so they always act on the file currently shown. Dead links inert.
  wirePropsHandlers(container);
  return rows.length;
}

// ---------- inline editing ----------

// Wires the delegated click/keyboard handlers ONCE per container. Because the
// container node persists across files, attaching per render would accumulate
// stale handlers (each bound to a previous file's data) that all fire on a
// single click. Instead, one handler set reads container.__propsState, which
// renderProperties refreshes every render, so edits always target the file
// currently shown.
function wirePropsHandlers(container) {
  if (container.__propsWired) return;
  container.__propsWired = true;

  const activate = (event) => {
    const st = container.__propsState;
    if (!st || typeof st.onWikilinkClick !== 'function') return;
    const el = event.target.closest && event.target.closest('a.prop-wikilink');
    if (!el || el.classList.contains('dead')) return;
    if (event.type === 'keydown' && event.key !== 'Enter') return;
    event.preventDefault();
    event.stopPropagation();
    st.onWikilinkClick(el.getAttribute('data-target') || '');
  };
  container.addEventListener('click', activate);
  container.addEventListener('keydown', activate);

  container.addEventListener('click', (event) => {
    const st = container.__propsState;
    if (!st || typeof st.onEditProperty !== 'function') return;
    handleEditClick(container, st, event);
  });
}

function rerenderProps(container) {
  if (typeof container.__propsRerender === 'function') container.__propsRerender();
}

// Commit rules: Enter commits, Escape cancels, blur commits when non-empty
// (matching the review composer's grammar). onEditProperty returning false
// (unlocatable key, would-corrupt) leaves the value as it was: the panel
// re-renders from the file's truth after every commit, so a refused edit
// simply snaps back. onEditProperty is captured from the state read at the
// moment editing begins, so one edit stays internally consistent even if the
// file changes while the input is open.
function openScalarInput(container, row, seed, apply) {
  if (row.querySelector('input.prop-edit-input')) return;
  const doc = container.ownerDocument;
  const valueEl = row.querySelector('.prop-value');
  const input = doc.createElement('input');
  input.className = 'prop-edit-input';
  input.value = seed;
  valueEl.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = (commit) => {
    if (done) return;
    done = true;
    if (commit) apply(input.value);
    else rerenderProps(container);
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  });
  input.addEventListener('blur', () => finish(input.value.trim().length > 0));
}

// Adding a list item appends the input INLINE after the existing chips
// (Obsidian's grammar) instead of replacing the whole value, so the tags
// already on the row stay visible while typing the new one.
function openListAddInput(container, onEditProperty, row, key) {
  const doc = container.ownerDocument;
  const valueEl = row.querySelector('.prop-value');
  if (!valueEl || valueEl.querySelector('input.prop-edit-input')) return;
  const input = doc.createElement('input');
  input.className = 'prop-edit-input prop-add-input';
  input.setAttribute('aria-label', `Add item to ${key}`);
  // Insert before the inline "+" so the field sits among the items.
  const addBtn = valueEl.querySelector('.prop-add');
  if (addBtn) valueEl.insertBefore(input, addBtn); else valueEl.appendChild(input);
  input.focus();
  let done = false;
  const finish = (commit) => {
    if (done) return;
    done = true;
    const t = input.value.trim();
    if (commit && t) onEditProperty(key, { list: { add: t } });
    else rerenderProps(container);
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  });
  input.addEventListener('blur', () => finish(input.value.trim().length > 0));
}

function handleEditClick(container, st, event) {
  // A click on a wikilink value is navigation, not an edit: the wikilink
  // handler (a separate listener on this same container) owns it. Without
  // this bail, clicking a wikilink would ALSO open an inline editor over
  // it, whose blur then fires a spurious write.
  if (event.target.closest('.prop-wikilink')) return;
  const row = event.target.closest && event.target.closest('.prop-row.editable');
  if (!row) return;
  const key = row.getAttribute('data-prop-key');
  const type = row.getAttribute('data-prop-type');
  const { parsed, onEditProperty } = st;
  const value = parsed[key];

  // List item removal / addition go through index-based mutations so
  // untouched items keep their exact bytes (never re-parsed).
  const removeBtn = event.target.closest('.prop-chip-remove');
  if (removeBtn) {
    const idx = Number(removeBtn.closest('[data-item-index]').getAttribute('data-item-index'));
    onEditProperty(key, { list: { remove: idx } });
    return;
  }
  if (event.target.closest('.prop-add')) {
    openListAddInput(container, onEditProperty, row, key);
    return;
  }
  // Bool toggles on click.
  if (type === 'bool' && event.target.closest('.prop-value')) {
    onEditProperty(key, !value);
    return;
  }
  // Scalar values edit inline.
  if (['string', 'number', 'date', 'null'].includes(type) && event.target.closest('.prop-value')) {
    const seed = type === 'null' ? '' : (type === 'date' ? dateString(value) : String(value));
    openScalarInput(container, row, seed, (text) => {
      const t = text.trim();
      if (type === 'number' && /^-?\d+(\.\d+)?$/.test(t)) onEditProperty(key, Number(t));
      else onEditProperty(key, t);
    });
  }
}
