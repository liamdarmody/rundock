// My tracker: a Rundock extension view built on Rundock UI.
//
// Rundock inlines this one file into a sandboxed frame (no network, no
// filesystem, no access to Rundock's page) for every note whose frontmatter
// carries the `my-tracker` marker. Before this file runs, Rundock has already
// put its design tokens and Rundock UI (window.Rundock.ui) into the frame, so
// every control below is Rundock's own and always matches the running app.
// Reference: docs/RUNDOCK-UI.md and docs/EXTENSION-HOST.md in the Rundock
// repository.
//
// The conversation with Rundock is a few messages:
//   ready   we say it when we have booted, and that we take `theme` changes
//           in place (`handles: ['theme']`)
//   init    Rundock answers with { path, content, theme }
//   theme   the person switched theme: Rundock has already restyled the
//           frame, so there is nothing to redraw and no edit is lost
//   change  we hand back the whole file after an edit (the manifest declares
//           `writes`), and Rundock saves it when the edits pause
//   resize  we ask for a frame height that fits what we drew
//
// The table's column widths are kept for us by Rundock UI in the view's own
// state (`stateKey`), which Rundock stores beside the note, never in it.
//
// The file is UMD-shaped: under Node the parser and serializer are exported
// for the tests in test/, and in the frame the view boots.

(function (root, factory) {
  if (typeof module === 'object' && module && module.exports) {
    module.exports = factory();
  } else {
    root.MyTracker = factory();
    root.MyTracker.boot(root);
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var MARKER = 'my-tracker';

  // ---- the file format -------------------------------------------------
  // Frontmatter, then sections: a `## Heading` and one `- item` per line.
  // Anything else in the body is kept exactly as it was, in place.

  function parse(text) {
    var source = String(text == null ? '' : text).replace(/\r\n/g, '\n');
    var frontmatter = '';
    var body = source;
    var match = /^---\n([\s\S]*?)\n---\n?/.exec(source);
    if (match) {
      frontmatter = match[0];
      body = source.slice(match[0].length);
    }
    var title = null;
    var titleMatch = /^title:\s*(.+)$/m.exec(match ? match[1] : '');
    if (titleMatch) title = titleMatch[1].trim();
    var marked = !!match && new RegExp('^' + MARKER + ':\\s*true\\s*$', 'm').test(match[1]);

    // Every line is kept, in order, so writing the note back changes only
    // what an edit changed. A section is its heading and the lines under it;
    // an item line is `- text`.
    var preamble = [];
    var sections = [];
    var current = null;
    var next = 0;
    body.split('\n').forEach(function (line) {
      var heading = /^##\s+(.+?)\s*$/.exec(line);
      var item = /^[-*]\s+(.+?)\s*$/.exec(line);
      if (heading) {
        current = { title: heading[1], entries: [] };
        sections.push(current);
      } else if (current) {
        current.entries.push(item ? { item: item[1], id: 'item-' + (next += 1) } : { text: line });
      } else {
        preamble.push(line);
      }
    });
    return { frontmatter: frontmatter, title: title, marked: marked, preamble: preamble, sections: sections };
  }

  function itemsOf(section) {
    return section.entries.filter(function (e) { return 'item' in e; }).map(function (e) { return e.item; });
  }

  function serialize(doc) {
    var lines = doc.preamble.slice();
    doc.sections.forEach(function (section) {
      lines.push('## ' + section.title);
      section.entries.forEach(function (e) { lines.push('item' in e ? '- ' + e.item : e.text); });
    });
    return doc.frontmatter + lines.join('\n');
  }

  // Items the section holds, with the id each was given when the note was
  // read. The id is what a board card carries, so a card that has moved
  // still names the same item wherever it is drawn now.
  function entriesOf(section) {
    return section.entries.filter(function (e) { return 'item' in e; });
  }

  // A new item goes after the section's last item, so the blank line that
  // separates it from the next heading stays where it was.
  function insertEntry(section, entry) {
    var at = 0;
    section.entries.forEach(function (e, i) { if ('item' in e) at = i + 1; });
    section.entries.splice(at, 0, entry);
  }

  // Move the item with `id` to the end of section `to`.
  function moveItem(doc, id, to) {
    var target = doc.sections[to];
    var at = find(doc, id);
    if (!target || !at) return false;
    insertEntry(target, doc.sections[at.section].entries.splice(at.index, 1)[0]);
    return true;
  }

  function cleanText(text) {
    return String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  }

  // Where the item with `id` is: its section's index and its place there.
  function find(doc, id) {
    for (var s = 0; s < doc.sections.length; s += 1) {
      var entries = doc.sections[s].entries;
      for (var i = 0; i < entries.length; i += 1) {
        if (entries[i].id === id) return { section: s, index: i };
      }
    }
    return null;
  }

  var added = 0;
  function addItem(doc, to, text) {
    var clean = cleanText(text);
    if (!clean || !doc.sections[to]) return false;
    insertEntry(doc.sections[to], { item: clean, id: 'new-' + (added += 1) });
    return true;
  }

  function renameItem(doc, id, text) {
    var clean = cleanText(text);
    var at = find(doc, id);
    if (!clean || !at) return false;
    doc.sections[at.section].entries[at.index].item = clean;
    return true;
  }

  // Take the item with `id` out of the note. What comes back is enough for
  // restoreItem to put it back exactly where it was.
  function removeItem(doc, id) {
    var at = find(doc, id);
    if (!at) return null;
    at.entry = doc.sections[at.section].entries.splice(at.index, 1)[0];
    return at;
  }

  function restoreItem(doc, removed) {
    var section = removed && doc.sections[removed.section];
    if (!section) return false;
    section.entries.splice(Math.min(removed.index, section.entries.length), 0, removed.entry);
    return true;
  }

  // ---- refusals Rundock has already shown ------------------------------
  // For a refused `open`, `openExternal` or `ask`, Rundock tells the person
  // itself when the reason is one of these, so the view must not say it a
  // second time. This is the one place the match lives.
  var HOST_SHOWN_OF = ['open', 'openExternal', 'ask'];
  var HOST_SHOWN_REASONS = [
    'Rundock stopped this because it did not come from your click',
    'you dismissed this in Rundock',
    'Rundock is already asking you about another request',
  ];
  function hostShowsRefusal(refusal) {
    return !!refusal && HOST_SHOWN_OF.indexOf(refusal.of) !== -1 && HOST_SHOWN_REASONS.indexOf(String(refusal.reason).trim()) !== -1;
  }

  // ---- the view ----------------------------------------------------------

  function boot(win) {
    var ui = win.Rundock && win.Rundock.ui;
    var d = win.document;
    var send = function (message) { win.parent.postMessage(message, '*'); };
    var doc = null;
    var view = 'board';
    var stats = null;
    var content = null;
    var notice = null;
    var refusalsShown = [];

    function save() {
      send({ type: 'change', content: serialize(doc) });
    }

    function resize() {
      send({ type: 'resize', height: d.documentElement.scrollHeight });
    }

    // Counts, one tile per section, redrawn in place so nothing else moves.
    function drawStats() {
      stats.textContent = '';
      doc.sections.forEach(function (section) {
        stats.appendChild(ui.stat({ label: section.title, value: String(itemsOf(section).length) }));
      });
    }

    // The board or the table. Redrawn on its own when the view switches, so
    // the tabs keep their keyboard focus.
    function drawContent() {
      content.textContent = '';
      if (view === 'board') {
        content.appendChild(ui.board({
          columns: doc.sections.map(function (section, s) {
            return {
              id: String(s),
              title: section.title,
              cards: entriesOf(section).map(function (e) { return { id: e.id, title: e.item }; }),
            };
          }),
          // The board has already moved the card and kept focus on it; the
          // note follows, and only the counts are redrawn.
          onCardMove: function (cardId, to) {
            if (!moveItem(doc, cardId, Number(to))) return;
            notice.textContent = '';
            save();
            drawStats();
            resize();
          },
        }));
      } else {
        content.appendChild(drawTable());
      }
      resize();
    }

    // Every item in one table. Select an item to rename it; move or remove it
    // from its row menu. A redraw is a new table, measured afresh, so after a
    // move or a removal focus is put back on the item's menu.
    function drawTable() {
      var rows = [];
      doc.sections.forEach(function (section, s) {
        entriesOf(section).forEach(function (e) { rows.push({ id: e.id, item: e.item, section: section.title, s: s }); });
      });
      return ui.table({
        caption: 'Every item and its section: select an item to rename it, or move or remove it from its row menu',
        resizable: true,
        // Rundock UI keeps the widths the person sets in this view's own
        // state (Rundock.viewState, under `rui.table.items`), per note, so
        // they survive a reload and a return to the note. They are never
        // written into the note: a width is a view preference, not the
        // person's data.
        stateKey: 'items',
        onEdit: function (change) {
          if (!renameItem(doc, change.row.id, change.value)) return 'Write something, or remove the item from its row menu.';
          save();
          return true;
        },
        columns: [
          { key: 'item', label: 'Item', format: String, edit: { type: 'text' } },
          { key: 'section', label: 'Section', render: function (v) { return ui.chip({ tone: v === 'Done' ? 'success' : 'neutral', label: v }); } },
          { key: 'actions', label: hidden('Actions'), render: function (v, row) { return rowMenu(row); } },
        ],
        rows: rows,
      });
    }

    function hidden(text) {
      var span = d.createElement('span');
      span.className = 'rui-visually-hidden';
      span.textContent = text;
      return span;
    }

    // The moves, then a rule, then Remove: the rule sets the one destructive
    // choice apart from the rest.
    function rowMenu(row) {
      var moves = doc.sections
        .map(function (section, s) { return { value: 'move:' + s, label: 'Move to ' + section.title, s: s }; })
        .filter(function (m) { return m.s !== row.s; })
        .map(function (m) { return { value: m.value, label: m.label }; });
      var menu = ui.menu({
        label: 'Actions for ' + row.item,
        items: moves.concat(moves.length ? [{ separator: true }] : [], [{ value: 'remove', label: 'Remove' }]),
        onSelect: function (value) {
          if (value === 'remove') return remove(row.id);
          if (!moveItem(doc, row.id, Number(String(value).slice(5)))) return;
          edited();
          focusMenu(row.id);
        },
      });
      menu.querySelector('.rui-menu-btn').setAttribute('data-item', row.id);
      return menu;
    }

    function focusMenu(id) {
      var menus = content.querySelectorAll('.rui-menu-btn[data-item]');
      for (var i = 0; i < menus.length; i += 1) {
        if (menus[i].getAttribute('data-item') === id) return menus[i].focus();
      }
    }

    // A removal is said on a line of its own, with an Undo that puts the
    // line back where it was. Any later edit clears it.
    function remove(id) {
      var menus = [].slice.call(content.querySelectorAll('.rui-menu-btn[data-item]'));
      var at = menus.map(function (m) { return m.getAttribute('data-item'); }).indexOf(id);
      var removed = removeItem(doc, id);
      if (!removed) return;
      edited();
      var next = content.querySelectorAll('.rui-menu-btn[data-item]');
      if (next.length) next[Math.max(0, Math.min(at, next.length - 1))].focus();
      notice.appendChild(ui.alert({
        tone: 'success',
        message: 'Removed ' + removed.entry.item + '.',
        action: {
          label: 'Undo', onClick: function () {
            if (!restoreItem(doc, removed)) return;
            edited();
            focusMenu(removed.entry.id);
          },
        },
      }));
      resize();
    }

    // After an edit that changes which items exist or where: write the note,
    // recount, redraw the content and clear any notice from an earlier edit.
    function edited() {
      notice.textContent = '';
      save();
      drawStats();
      drawContent();
    }

    function render() {
      d.body.textContent = '';
      var root = d.createElement('main');
      root.className = 'tracker';
      d.body.appendChild(root);

      if (!ui) {
        root.textContent = 'This view needs Rundock UI, which this Rundock does not provide.';
        return resize();
      }
      if (!doc.sections.length) {
        root.appendChild(ui.emptyState({ icon: 'inbox', title: 'Nothing to track yet', subtitle: 'Add a section to this note with a heading like "## Now", then list items under it.' }));
        return resize();
      }

      var heading = d.createElement('h1');
      heading.textContent = doc.title || 'Tracker';
      root.appendChild(heading);

      stats = d.createElement('div');
      stats.className = 'tracker-stats';
      root.appendChild(stats);
      drawStats();

      // Adding: a field around an input, a select for where, and a button.
      var entry = ui.input({ placeholder: 'A new item' });
      var where = ui.select({ label: 'Section', options: doc.sections.map(function (s, i) { return { value: String(i), label: s.title }; }) });
      var add = ui.field({ label: 'Add an item', control: entry, help: 'It lands at the end of the section you choose.' });
      var addButton = ui.button({
        label: 'Add', variant: 'primary', onClick: function () {
          if (!addItem(doc, Number(where.querySelector('select').value), entry.value)) {
            add.setError('Write something to add first.');
            entry.focus();
            return;
          }
          add.setError(null);
          entry.value = '';
          edited();
          entry.focus();
        },
      });
      var addRow = d.createElement('div');
      addRow.className = 'tracker-add';
      addRow.appendChild(add);
      addRow.appendChild(where);
      addRow.appendChild(addButton);
      root.appendChild(addRow);

      // Two ways to see the same list.
      root.appendChild(ui.tabs({
        label: 'Tracker view',
        options: [{ value: 'board', label: 'Board' }, { value: 'table', label: 'Table' }],
        value: view,
        onChange: function (value) { view = value; drawContent(); },
      }));

      notice = d.createElement('div');
      notice.className = 'tracker-notice';
      root.appendChild(notice);

      content = d.createElement('div');
      content.className = 'tracker-content';
      root.appendChild(content);
      drawContent();
    }

    win.addEventListener('message', function (event) {
      // Only Rundock, the frame's parent, speaks to the view.
      if (event.source !== win.parent) return;
      var data = event.data;
      if (!data || typeof data !== 'object') return;
      if (data.type === 'init') {
        doc = parse(data.content);
        render();
      }
      // A refusal names what Rundock would not do and why; surface it rather
      // than failing silently, unless Rundock has already told the person.
      // Each one is said once: in a view embedded in another note, every
      // width the person drags is refused the same way.
      if (data.type === 'refused' && ui && !hostShowsRefusal(data)) {
        var said = data.of + ': ' + data.reason;
        if (refusalsShown.indexOf(said) !== -1) return;
        refusalsShown.push(said);
        d.body.insertBefore(ui.alert({ tone: 'danger', message: 'Rundock refused ' + said }), d.body.firstChild);
      }
    });
    // `handles: ['theme']`: on a theme switch Rundock restyles this frame in
    // place instead of rebuilding it, so a half-typed item survives.
    send({ type: 'ready', handles: ['theme'] });
  }

  return { MARKER: MARKER, parse: parse, serialize: serialize, itemsOf: itemsOf, entriesOf: entriesOf, moveItem: moveItem, addItem: addItem, renameItem: renameItem, removeItem: removeItem, restoreItem: restoreItem, hostShowsRefusal: hostShowsRefusal, boot: boot };
}));
