# Rundock UI

Rundock UI is the component library for Rundock and its extensions. An extension view calls `Rundock.ui.<component>(options)`, gets an element back, and composes it. Controls and containers are Rundock's; what an extension draws inside a `canvas` is its own.

Rundock injects the library into every extension frame, with its stylesheet and the design tokens, so a view always matches the Rundock it is running in. An extension never bundles a copy and cannot drift from what the host looks like. When Rundock restyles a button, every extension's buttons change with it, with nothing to republish.

To see every component in every state, in both themes, open `/rundock-ui/gallery` on a running Rundock (for example `http://localhost:3000/rundock-ui/gallery` in browser mode). Each theme there is a real extension frame built by the host, so it is exactly what an extension gets.

- [Using it](#using-it)
- [What is injected, and what it cannot do](#what-is-injected-and-what-it-cannot-do)
- [Versions and compatibility](#versions-and-compatibility)
- [Components](#components)
- [Design rules the components follow](#design-rules-the-components-follow)

## Using it

The library is on `window.Rundock.ui` before an extension's entry script runs, so the entry can use it at once:

```js
const ui = Rundock.ui;

const save = ui.button({ label: 'Save', variant: 'primary', onClick: () => persist() });
const panel = ui.card({
  title: 'Risk constraints',
  children: [
    ui.slider({ label: 'Maximum single position', value: 15, min: 0, max: 100, format: (v) => `${v}%`, onChange }),
    ui.checkbox({ label: 'Prefer tax-advantaged accounts', checked: true, onChange }),
    save,
  ],
});
document.body.appendChild(panel);
```

Every factory takes one options object and returns an element. Labels and text are always set as text, never parsed as markup, so a label that contains `<b>` shows `<b>`. An option outside its allowed set (an unknown `variant` or `tone`, a callback that is not a function) is refused with a `TypeError` naming the component and the option, for example `Rundock.ui.button: variant must be one of primary, secondary, danger, danger-confirm`.

Components are styled by classes prefixed `rui-`. An extension's own stylesheet is inlined after Rundock UI's, so it can override any of them, and its own classes never collide with them. The `rui-force-hover`, `rui-force-focus` and `rui-force-active` classes draw a state without a pointer or a keyboard, for galleries and screenshots; they are not a way to set state.

## Where a view sits

A view is full bleed: the frame fills the editor pane, paints the pane's own colour, and its `body` carries the note's `24px 32px` padding, so the view's content lines up with a note's text. Do not add an outer padding or background of your own. For an edge-to-edge canvas, add `rundock-full-bleed` to `document.body`, which takes the body padding to zero. A view embedded in another note gets `rundock-embedded` on its body from the host: the panel's surface and no padding, because the panel pads it. The details are in [EXTENSION-HOST.md](EXTENSION-HOST.md#where-a-view-sits-full-bleed).

## What is injected, and what it cannot do

Every frame the extension host builds (a mounted view, an embedded view and a headless region renderer) gets, in this order:

1. the token block (`:root` custom properties with the showing theme's values);
2. the element floor (`extension-base.css`);
3. Rundock UI's stylesheet (`public/styles/rundock-ui.css`);
4. the extension's own declared stylesheets;

and then, in the body, the error bootstrap, the Rundock UI library, and the extension's entry. In the light theme the frame's `<body>` carries the class `light`, the same class Rundock's own page carries, so a rule written `body.light ...` behaves in a frame as it does on the page.

When the theme changes while a view is open, a view that says `ready` with `handles: ['theme']` is restyled in place: the host sends a `theme` message, and the bootstrap rewrites the token block and the body's `light` class before the entry hears it, so every component follows and the view keeps its state, including edits not yet saved. A view that does not say so is rebuilt instead and starts again from the file. A view that edits should say it; the message is described in [EXTENSION-HOST.md](EXTENSION-HOST.md#the-palette-inside-the-frame).

The library runs inside the frame, as the frame. It has no host privileges and adds no message types: it builds elements and listens to them, and it never posts a message, reads the parent or fetches anything (a test holds its source to that). The frame's sandbox, its Content-Security-Policy and the closed message table in [EXTENSION-HOST.md](EXTENSION-HOST.md) are exactly the same with it as without it.

The stylesheet is one source for Rundock and for extensions: Rundock's page loads it like any other stylesheet, and the host reads it back from the page for each frame. Where a component reproduces a rule Rundock already has (the settings button and input, the mode toggle, the empty state, the region placeholder, the files menu), a test holds the copy to the original declaration by declaration.

## Versions and compatibility

`Rundock.ui.version` is a string `"MAJOR.MINOR"`, `"1.0"` in this release.

- **A minor version adds**: a new component, a new option, a new state.
- **A major version changes what an existing call does or accepts.**
- **A visual change is neither.** The host injects the library, so a restyle reaches every extension at once and asks nothing of any of them.

An extension declares the version it was built against in `rundock.json`:

```json
{
  "name": "risk-board",
  "version": "0.1.0",
  "extension": {
    "entry": "view/main.js",
    "match": "*.md",
    "declares": "risk-board",
    "rundockUi": "1.0"
  }
}
```

**The rule:** an extension built against `X.Y` installs on a Rundock that provides `X.Z` where `Z` is `Y` or greater, and on nothing else. An older minor lacks something the extension may call; another major means a call it makes may behave differently. The install refuses anything else by name, for example "the extension was built against Rundock UI 1.3, newer than the 1.0 this Rundock provides: update Rundock to install it". `rundockUi` is optional: an extension that declares nothing installs as before and still gets the library, with no promise to check. A malformed value (anything other than `MAJOR.MINOR`) is refused.

An extension that wants to use a newer component when it is there, and fall back when it is not, can read `Rundock.ui.version` or test for the factory (`typeof Rundock.ui.meter === 'function'`).

## Components

Twenty-two components and twenty-three factories: empty state and loading are one component with a factory each.

### button

`Rundock.ui.button({ label, variant, onClick, disabled, type })`

| Option | Type | Default | Notes |
|---|---|---|---|
| `label` | string or node | | |
| `variant` | `primary`, `secondary`, `danger`, `danger-confirm` | `secondary` | |
| `onClick` | function `(event)` | | Not called when disabled |
| `disabled` | boolean | `false` | |
| `type` | `button` or `submit` | `button` | |

Returns a native `<button>`. States: default, hover, focus-visible, active, disabled.

- **primary** fills with `--accent-action` and white text.
- **secondary** is the ordinary button.
- **danger** is for a button that *starts* a destructive action from a list or a menu (Uninstall, Remove): red text on a red outline, never a fill.
- **danger-confirm** is the one solid red button: the final, destructive action itself.

The rule is about where the click lands, not whether a dialog exists. A button that *starts* a destructive action, one that a confirmation step follows, is the outline. A button that *is* the destructive action, with nothing after it to confirm, is solid: the confirm button inside a dialog, and also a button that acts at once with no dialog at all, such as Rundock's own "Stop this run". If a confirmation step is ever added in front of such a button, it becomes the outline half of the pair and the new confirm button carries the solid fill.

### iconButton

`Rundock.ui.iconButton({ label, icon, variant, state, cancelLabel, cancelIcon, disabled, onClick })`

A button that is only an icon. `label` is required: it is the button's accessible name and its tooltip, and all a screen reader has. `icon` is an SVG element of your own or a built-in name: `send`, `stop`, `close`, `plus`, `more` (default), `chevron`, `inbox`, `attention`, `danger`, `success`, `kebab`. The icon is marked decorative.

- **`default`** is Rundock's own 32px icon button: transparent at rest, `--elevated` with a border on hover.
- **`send`** is the chat composer's send button, property for property: 42px and round, `--card` at rest (`state: 'empty'`), action orange with white and a lift when there is something to send (`state: 'active'`), and a quiet danger tint with a stop square while work runs (`state: 'cancel'`, named by `cancelLabel`, default "Stop"). Change the state as the person types with `button.setState('empty' | 'active' | 'cancel')`.

`onClick(event, state)`.

### card

`Rundock.ui.card({ title, subtitle, actions, children, interactive, onClick })`

A container. `children` is a node, a string, or an array of either. The header (title, then subtitle) stands 16px clear of the children, with or without a subtitle, so content never sits against the line above it; a card with no children adds nothing below its header. The title is `--body` bold on a 1.5 line height.

`actions` puts controls on the title line: an element, or an array of elements (tabs, a hint, a button), placed in order at the end of a header row and centred vertically on the title. The title and subtitle are drawn exactly as without it; on a card too narrow for both, the actions wrap under the title. With `interactive: true` the card needs `onClick`, and becomes `role="button"` with a tab stop, answering Enter and Space. Prefer a real button inside the card when the card holds other controls.

### field

`Rundock.ui.field({ label, control, help, error })`

Wraps a control (an `input`, the element `select` returns, or any element holding an input, select or textarea) with a label and help or error text. The field wires the accessibility: `<label for>` to the control's id, `aria-describedby` to the help or the error, and `aria-invalid="true"` while there is an error. The error text replaces the help while it shows.

The returned element has one method, `field.setError(message)`: pass text to show an error, `null` or `''` to clear it. The wiring follows.

### input

`Rundock.ui.input({ type, value, placeholder, align, readOnly, disabled, invalid, label, onChange })`

| Option | Notes |
|---|---|
| `type` | `text` (default) or `number`. A number is typed as text with a decimal keyboard, right-aligned with tabular figures, so formatted values such as `196,500.00` display as written |
| `align` | `left` or `right`; defaults to right for numbers |
| `readOnly` | Stays focusable and readable, with a dashed edge |
| `invalid` | Sets `aria-invalid="true"`; `field` does this for you |
| `label` | An `aria-label`, for an input used without a field |
| `onChange` | `(value, event)` on every input event |

### select

`Rundock.ui.select({ options, value, label, disabled, onChange })`

`options` is an array of strings or `{ value, label, disabled }`. Returns a wrapper around a native `<select>`; the wrapper draws the arrow and never takes a click. `onChange(value, event)` on change. Give `label` (an `aria-label`) when the select is not inside a `field`.

### checkbox

`Rundock.ui.checkbox({ label, checked, indeterminate, disabled, onChange })`

A native checkbox inside its `<label>`, with a 24 by 24 pixel click target around a 16 pixel box. `indeterminate` is set as the DOM property (there is no attribute). `onChange(checked, event)`.

### toggle

`Rundock.ui.toggle({ label, checked, disabled, onChange })`

A native checkbox with `role="switch"`, so it is announced as on or off. `onChange(checked, event)`.

### slider

`Rundock.ui.slider({ label, value, min, max, step, format, disabled, onChange })`

A native range input under a label and its current value. `min` defaults to 0, `max` to 100, `step` to 1. `format(value)` turns the number into what is shown and announced (for example `v => v + '%'`); the slider sets `aria-valuetext` from it on every input, so a screen reader hears "35%" rather than "35", and points `aria-describedby` at the visible value. `onChange(number, event)` on every input.

### tabs

`Rundock.ui.tabs({ label, options, value, orientation, onChange })`

The WAI-ARIA Tabs pattern with automatic activation.

- `label` is required: the tab list's accessible name.
- `options` is an array of strings or `{ value, label, panel }`. When an option carries a `panel` element, the tabs wire it (`role="tabpanel"`, `aria-controls`, `aria-labelledby`) and show it only while its tab is selected. Without panels, swap content in `onChange`.
- `orientation` is `horizontal` (default) or `vertical`.
- Exactly one tab is a tab stop: the selected one. ArrowRight and ArrowLeft (ArrowDown and ArrowUp when vertical) move focus and select, wrapping at the ends. Home and End jump to the first and last. A click selects.
- `onChange(value, event)` when the selection changes.

Rundock's own Notes and Code control in Settings follows the same pattern.

### optionList

`Rundock.ui.optionList({ label, options, value, onChange })`

A single choice from a short list, drawn in the tabs' visual language as a vertical stack: the WAI-ARIA Radio Group pattern.

- `label` is required: the group's accessible name.
- Each option is `role="radio"` with `aria-checked`. The checked option is the one tab stop; with nothing checked, the first is.
- All four arrow keys move focus and selection together, wrapping. Space checks the focused option. Home and End jump to the first and last.
- `onChange(value, event)` when the selection changes.

### table

`Rundock.ui.table({ columns, rows, caption, onEdit, resizable, onResize, stateKey })`

`columns` is an array of `{ key, label, numeric, align, render, width, minWidth, widest, grow, resizable, format, edit }`; `rows` an array of objects. A `numeric` column is right-aligned with tabular figures. `render(value, row)` may return a node (a chip, for example) or text. `caption` is read by assistive technology and not shown. Header cells carry `scope="col"`. There is no sorting in this version.

**Widths.** A table measures each column once, the first time it is laid out: its natural width is the header and the widest value on one line, plus padding. It then locks the widths (a fixed layout), so editing a cell never shifts a column. By default:

- every column takes exactly its natural width, except text wider than 280px, which is capped there: a value cut off by the cap ends in an ellipsis with its whole text in the cell's title. A numeric column, a checkbox or a row menu is never capped, and no column is narrower than its header;
- spare room goes to one main column, which takes all of it, past its cap if need be, while every other column keeps its natural width. So a sparse table fills its width with its main text column, its short columns stay tight and a row menu sits at the right edge. The main column is the one whose natural width (before the cap) is the widest, the first on a tie, among the columns that are not fixed by an explicit or saved `width`, not a control (a checkbox, or a column none of whose cells shows text, such as a row menu) and not numeric;
- a column with `grow: true` is the main column instead, for a view that wants to choose it (a notes column, say, when another column is wider);
- only when no column qualifies, or the main column is fixed by a resize or a saved width, does the spare room go to an empty filler column after the last, so rows (their hover, separators and the active row) still run the full width. The filler has no header text, is hidden from assistive technology and is never focusable;
- a table wider than its container keeps its widths and scrolls sideways inside its own wrapper, never the page.

A column that may show something wider than its first rows do (a "Not priced", a stale date) names it in `widest`: text or an element, or an array of them, measured with the cells. `minWidth` (pixels) sets a floor. When the container's width changes the spare room is given out again, but never while a cell is being edited: a change that arrives then is applied as soon as the editor closes, for the container's size at that moment. New rows are a new table, measured afresh.

**Resizing.** `resizable: true` on the table gives every column a resize handle on its header's right edge; `resizable` on a column turns it on or off for that column alone. The filler never has one. A handle is a focusable vertical separator (`role="separator"`, `aria-orientation="vertical"`, `aria-valuenow` and `aria-valuemin` in pixels), named "Resize the <Column> column". Drag it, or focus it and press the arrow keys (8px a step, 32px with Shift). Enter or a double-click puts the column back to the default rule. A column never goes below its header or its `minWidth`. A resized column is fixed at its new width, and the rest is given out again by the same rule: resizing a column beside the main column changes the main column by the difference and moves no other column, and resizing the main column itself fixes it, so the spare room it gives up goes to the filler; when the fixed columns alone are wider than the container, the table scrolls in its wrapper, never the page. There is no reset-all control in this version: to put every column back, redraw the table without the kept widths. `onResize({ key, width })` reports each resize (on release, and on each key step) and `width: null` after a reset, so a view can keep the widths for as long as it is open: pass a kept width back as that column's `width` when it redraws the table, and it wins over the default rule until the person resets it. Never write widths into the person's notes; a width is a view preference, not their data.

**Kept widths.** `stateKey: '<name>'` on a resizable table keeps its widths across a reload and a return to the note, with no code in the view: the table reads them from the view's own state (`Rundock.viewState`, see [EXTENSION-HOST.md](EXTENSION-HOST.md#a-views-own-state)) when it is created, under the key `rui.table.<name>` as `{ <column key>: <px> }`, and writes them on each resize and reset (a reset removes that column's entry). A kept width is treated as a saved width: it wins over the default rule until the person resets it, applies only to a column that resizes, and never falls below the column's header or `minWidth`. `stateKey` is 1 to 54 letters, digits, `.`, `_`, `:` or `-`, so the whole key stays within the view state's own rule; any other is refused by name. Give each table in a view its own `stateKey`. `onResize` still reports every resize. Where there is no `Rundock.viewState` (the gallery, a region renderer, a test page), a table with `stateKey` behaves exactly as one without it, and a table with no `stateKey` never reads or writes the view's state. Keys starting `rui.` belong to Rundock UI; a view's own keys should not use that prefix. Like all view state, kept widths are per machine, and a renamed or moved note starts without them.

`width` fixes a column: a positive number of pixels or a CSS length (`"96px"`, `"20%"`, `"8rem"`, `"12ch"`). An explicit width always wins, and overlong text in it ends in an ellipsis. A row menu (`Rundock.ui.menu`) in a narrow column still opens whole, because its list is placed against the viewport.

**Format.** `format(value, row)` is what a cell shows, as text or a node; a column takes `format` or `render`, not both. An editable column must use `format`, because the table redraws the cell from its value after an edit.

**Editing.** A column with `edit` can be changed in place; one without is read-only.

```js
Rundock.ui.table({
  caption: 'Positions',
  columns: [
    { key: 'ticker', label: 'Ticker', width: 78 },
    { key: 'account', label: 'Account' },
    { key: 'quantity', label: 'Quantity', numeric: true, width: 96,
      edit: { type: 'number', min: 0, label: (row) => `${row.ticker} in ${row.account}` } },
    { key: 'held', label: 'Held', width: 64, edit: { type: 'checkbox', when: (row) => !row.locked } },
  ],
  rows,
  onEdit: ({ row, key, value, previous }) => save(row, key, value), // true, a message, or a promise of either
});
```

- `edit.type` is `number` (the default), `text`, `select` or `checkbox`. `min` and `max` bound a number. `options` (required for `select`) are strings or `{ value, label }`, as for `select`, and the cell shows the option's label. `label(row)` names the row for assistive technology (by default, the text of the row's first cell). `when(row)` returning false leaves that one cell read-only.
- **A value reads as text**, in a button named "<Column> of <row>, <value>". Click, tap, Enter or F2 opens the editor, named "<Column> of <row>". Enter commits. Escape cancels and returns focus to the cell. Tab commits and opens the next editable cell, Shift+Tab the one before; at either end focus rests on the cell, so the next Tab leaves the table. Leaving the editor (a click elsewhere) commits without taking focus back. The table is a native table whose editable cells are each a tab stop: there is no arrow-key movement between cells.
- **The editor is laid over the cell** while the value stays in place underneath, so opening it moves no column and changes no row height. It takes the column's alignment, padding, font and figures, so the text does not move either: a number opens on the text the cell shows ("1,250.5", "290.00") whenever that reads back as the same value, and on the raw value otherwise.
- **How it looks.** Square, and inside the cell. A hovered row takes the row tint (`--elevated` in dark, `--base` in light), and a hovered editable cell a tint of its own (`--surface`); there is no pencil. The cell with keyboard focus, being edited, refused or saving keeps the active surface after the pointer leaves the row: `--border` in dark, lighter than the table so it reads as raised, and white (`--elevated`) in light. An inset ring on the cell's own edge says which state it is in: 1px `--text-2` for keyboard focus, 2px `--accent-text` while editing, 2px `--danger-text` while refused. Every ring clears 3:1 against the active surface and the row separator in both themes. The editor has no border or radius of its own.
- **A number** is digits with an optional `-` and one `.`, and `,` is read as grouping (`1,250.5`). Anything else, or a number outside `min` and `max`, is refused by the table with the range in words ("Enter a number of 0 or more.") and never reaches `onEdit`. An unchanged value closes without asking.
- **`onEdit({ row, key, value, previous })` decides.** Return `true` to accept: the cell shows the new value. Return a message to refuse: the value reverts, the message shows on a line of its own directly under the row, spanning the table and naming the column ("Quantity: More than this account holds."), announced as an alert and describing the editor, and focus stays in the editor. That line pushes the rows below down while it shows, and goes when the refusal is cleared; opening and editing a cell move nothing. Return a promise to hold the cell while you save: the editor is read-only (a select is `aria-disabled` and keeps focus, and no key or press changes it), Enter and Escape are ignored, Tab still moves focus on without committing again, and the cell is `aria-busy`, and "Saving…" shows inside the cell and is announced politely, until it settles as `true` or a message. Anything else, a throw or a promise that fails, refuses with "This change was not saved.", so the table never shows a value you did not confirm. A refusal after focus has left closes the editor on the old value and leaves its line under the row, described by the cell.
- **A checkbox** is the one exception to reading as text: a boolean shows as a checkbox all the time and toggles in place, as it does in spreadsheets and databases, because ticked or unticked already reads as content. One activation (a click or Space) toggles it and asks `onEdit` with `true` or `false`; a refusal unticks it again. While a promise holds it, it is `aria-disabled` and keeps focus.
- **The table never writes anything**: not the file, not your `rows`. The accepted value is shown; updating your own data, and anything derived from it (a total, another column), is yours to do in `onEdit`. With no `onEdit`, nothing can enter edit mode: every cell reads as text, and a checkbox is shown disabled.

### chip

`Rundock.ui.chip({ tone, label })`

A status label. `tone` is `neutral` (default), `accent`, `attention`, `success` or `danger`, drawn as a solid fill with dark or white text, never tone text on a tint. `accent` fills with `--accent-action` and white, because it carries a label. The label is centred on its ink: where the engine supports `text-box`, the label's box is trimmed to cap height and baseline, so a capitals-only label no longer sits off centre. Not interactive.

### emptyState and loading

`Rundock.ui.emptyState({ icon, title, subtitle, children })`

`icon` is `'inbox'` for the built-in icon, or an SVG element of your own (it is marked decorative).

`Rundock.ui.loading({ label })`

A placeholder that breathes on the product's two-second rhythm, still under reduced motion. It is `role="status"` and `aria-live="polite"`, with `label` (default "Loading") read to assistive technology.

### board

`Rundock.ui.board({ columns, onCardMove })`

`columns` is an array of `{ id, title, cards }`, each card `{ id, title, meta, statusOptions }`.

Every card has a menu button (named "Move <title>") listing the columns, its own marked current. Choosing a column moves the card, keeps focus on the card's menu button in its new place, announces the move ("Moved PLTR to Thesis built") and calls `onCardMove(cardId, toColumnId, fromColumnId)`. Drag and drop moves cards the same way, as an enhancement: the menu is the path that always works. `statusOptions`, a list of column ids, narrows where a card may go.

### canvas

`Rundock.ui.canvas({ render, label, failedText })`

The one place an extension draws as it likes. `render(element)` draws into the element it is given, and may return a promise.

- While a returned promise is pending, a skeleton shows (`role="status"`).
- If `render` throws or rejects, a quiet failure card shows `failedText` (default "This could not be drawn.") with a Retry button that calls `render` again.
- `label` gives the drawing `role="img"` and that accessible name. Name what you draw; the host cannot.

### meter

`Rundock.ui.meter({ label, value, limit, isMinimum, marker, format, ariaLabel })`

A share of something against an optional limit. `value`, `limit` and `marker` are fractions from 0 to 1. With a `limit` it reads "21% of 30% max" (or "min" with `isMinimum`), and a value past the limit (below it, for a minimum) turns the value and the fill to danger. The marker defaults to the limit. `format(fraction)` changes how a number is written. It is a display, not a control: the whole meter is `role="img"` with one sentence as its name ("Largest sector, 21% of a 30% maximum"), or `ariaLabel` if you give one.

### alert

`Rundock.ui.alert({ tone, message, action, urgent })`

An inline banner. `tone` is `attention` (default), `danger` or `success`, shown on the edge and the icon; the body stays ordinary text. The icon is decorative: write the message so it states its tone in words, because in light the attention and success icons do not reach 3:1 and nothing may depend on seeing their colour. `action` is `{ label, onClick }` or a node. It is `role="status"`; `urgent: true` makes it `role="alert"`, for something that cannot wait.

### stat

`Rundock.ui.stat({ label, value, delta, trend, negative })`

A headline number. `trend` is `up` or `down`: the `delta` stays in the ordinary text colour, with an arrow and the words "Up" or "Down" carrying the direction and a small coloured dot as decoration. `negative` colours the value; a negative number is negative without being told.

### relativeTime

`Rundock.ui.relativeTime({ iso, now, staleAfterMs, prefix, locale })`

A native `<time datetime>` saying how long ago `iso` was ("Updated 12 minutes ago"), with the full date as its title. Past `staleAfterMs` it is stale: amber in dark, and in light the words stay dark and an amber dot carries the signal. Stale is also said in words (", stale") for assistive technology. `now` defaults to the current time; `locale` to English.

### liveChip

`Rundock.ui.liveChip({ label })`

A small "Live" chip with a pulsing dot on the product's two-second rhythm, still under reduced motion. The dot is decorative; the label is the text.

### menu

`Rundock.ui.menu({ trigger, label, items, onSelect })`

The WAI-ARIA menu button pattern.

- The trigger is a small icon button named by `label` (required), or a text button when `trigger` is a string.
- `items` is an array of strings or `{ value, label, disabled, checked }`. Items that carry `checked` are radio items (`role="menuitemradio"` with `aria-checked`), for a choice of one of several; the current one is drawn bold with a check mark.
- `{ separator: true }` in `items` draws a full-width rule between groups (`role="separator"`), for example between the moves and a Remove. It is never an item: the keys pass over it, a click on it chooses nothing, and a menu needs at least one real item.
- Enter, Space or ArrowDown on the trigger opens the menu on the current item (or the first); ArrowUp opens it on the last. ArrowDown and ArrowUp move with wrapping, Home and End jump, Enter or a click chooses, Escape closes and returns focus to the trigger. Tab, a press outside and a scroll close it.
- `onSelect(value, event)` after the menu closes.

## Design rules the components follow

These are the decisions behind the look, so an extension that draws its own canvas can follow them too.

- **Action orange carries text or an icon.** `--accent-action` fills the primary button, the accent chip and the send button, always with white: 4.50:1, and 5.07:1 on its darker hover.
- **Control orange is a bare shape.** `--accent-control` fills the checked checkbox, the toggle when on, the slider's fill and thumb, the selected option's dot and the meter's fill. These need 3:1 against the surface they sit on, not 4.5:1: in dark it is the brand itself (4.43:1 against `--card`), in light `#DB5933` (3.28 to 3.83:1 on the light surfaces).
- **One accepted exception:** the white tick and thumb on control orange measure 2.85:1 in dark (3.83:1 in light). The state is carried by shape and position, a filled box against an empty one and a thumb at one end or the other, and the control stands at 4.43:1 against its card; a dark glyph would pass and is the look this design moved away from.
- **The brand `--accent` is never written as a fill.** It is for outlines, focus rings, hover and drag highlights, and links, and it is `--chart-1` in a chart's palette. A test sorts every fill in the stylesheet: brand fills are refused, and action and control orange are each held to their own kind of shape.
- **Danger differs by form as well as colour.** `--accent-action` and `--danger` sit 1.11:1 apart in luminance, so colour alone cannot tell them apart. Starting a destructive action is an outline; only the final destructive action is solid, whether it sits in a dialog or acts at once.
- **Status and brand colours are not text colours on light surfaces.** Where a tone must read as text, it is `--text-1` with a coloured mark beside it, or a `-text` token made for the job (`--danger-text`, and in light `--accent-text`).
- **A control's edge is `--text-3`**, which clears 3:1 against the surfaces controls sit on; `--border` is for decorative dividers only.
- **Status colour is a solid fill with dark or white text**, never tone text on a tint of itself, which measured as low as 1.66:1 in light.
- **Named, not only coloured.** Every state a component shows by colour is also carried by a word, a role, a shape or a mark.
- **Motion stops under reduced motion**, and there is one waiting rhythm across the product: two seconds.

`test/unit/rundock-ui-contrast.test.js` measures every component's colour pairing in both themes from the real tokens on every run. A few pairings copy patterns the app already uses and fall short of their bar (secondary `--text-2` text on `--card`, for example); each is pinned at its measured ratio in that file with the reason, so it can improve but never slip.
