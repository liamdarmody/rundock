# Design standard

This is what Rundock's interface is made of and the rules for adding to it.

Read it before writing CSS. Most of what looks like a judgement call here has
already been decided, and the reasons are recorded so you can tell the
difference between a rule and a habit.

Everything in this document is checkable against the code. The tokens live in
`public/styles/tokens.css`, and `npm run lint:styles` fails a change that
invents a value one of them already covers.

## The shape of it

```
public/styles/
  tokens.css              every colour, size, radius and duration
  base.css                resets, the canvas, typography defaults
  components/*.css        things that appear in more than one view
  views/*.css             things that belong to one view
```

`index.html` carries no styles. Neither should anything you add. Two guards
enforce this and both are load-bearing: one checks that every stylesheet the
page links is served, the other checks that nothing is inlined back in.

**Import order is the cascade.** `tokens.css` is linked first, so everything
below resolves against it. Component files come before view files, so a view
can override a component and a component cannot accidentally override a view.
Moving a link in `index.html` changes which rule wins, so it is a real change
even when no rule text changes.

## Colour

Two themes, one set of names. The dark values are declared on `:root`; the
light theme restates a subset on `body.light` and inherits the rest.

**Declare on `:root` and override on `body.light`, never the other way round.**
A token declared only in the light block resolves in light and is undefined in
dark, which fails silently: an undefined custom property does not fall back to
anything sensible, it inherits whatever surrounds it. `--text-3` did exactly
that for three releases and nine declarations rendered the wrong colour without
a single error. Two tests now check this.

### Surfaces, back to front

| Token | Value (dark) | What it is for |
|---|---|---|
| `--base` | `#1A1A1A` | The window's canvas, behind everything |
| `--surface` | `#212121` | Panels that sit on the canvas: sidebars, the main pane |
| `--elevated` | `#272727` | Anything raised off a panel: hovers, menus, popovers |
| `--chrome` | `#131313` | The nav rail and title bar, which recede rather than rise |
| `--card` | `#333333` | Discrete objects on a panel: board cards, org nodes |
| `--border` | `#3D3D3D` | Every hairline |

`--chrome` is deliberately its own token and not a shade of `--surface`.
`--surface` appears in eleven places including every hover state, so moving it
to gain one edge would have moved all of them. `--base` to `--surface` is a
6-point luma step, too soft to delineate the rail once its border was removed;
chrome to surface is 14.

### Text

| Token | What it is for |
|---|---|
| `--text-1` | Body text and anything you are meant to read |
| `--text-2` | Secondary text: labels, metadata, inactive states |
| `--text-3` | Tertiary: placeholders, controls that appear on hover |

`--text-3` is the dimmest tone that still reads. It was picked against measured
contrast, not by eye: both themes clear 3:1 on every surface they can land on,
including the worst case of `--elevated`. If you need something fainter than
`--text-3`, you almost certainly need a different layout instead.

### Meaning

| Token | Means |
|---|---|
| `--accent` | Rundock's colour. Primary actions, focus, selection |
| `--accent-hover` | The accent, lifted, on hover only |
| `--accent-glow` | The accent at low alpha, for tinted backgrounds |
| `--success` | Something succeeded or is allowed |
| `--attention` | Something needs the user, and is not an error |
| `--working` | Something is running |
| `--idle` | Something is present but not doing anything |
| `--danger` | Destructive actions and errors |

Use these for what they mean, never for what colour they happen to be. If you
want a red border and nothing has gone wrong, `--danger` is the wrong token and
the design is probably the thing to revisit.

The status set had no red until 0.11.7, so every destructive surface reached for
a hex of its own and they drifted. Three near-identical reds were in the
stylesheets when `--danger` was added. That is what this table exists to
prevent.

## Type

| Token | Size | Used for |
|---|---|---|
| `--heading` | 22px | Page and view titles |
| `--title` | 18px | Section titles |
| `--body` | 14px | Default |
| `--caption` | 12px | Secondary and metadata |
| `--label` | 11px | Small caps labels, badges |

`--org-name` (20px) and `--org-role` (15px) belong to the org chart, which sizes
itself against node geometry rather than the page scale. They are named for
where they are used so nobody reaches for them elsewhere.

## Radius

| Token | Value | Used for |
|---|---|---|
| `--radius-xs` | 3px | Inline marks inside dense text |
| `--radius-sm` | 4px | Small controls, tags |
| `--radius-md` | 6px | Inputs, buttons |
| `--radius-lg` | 8px | Rows, cards, menus |
| `--radius-xl` | 12px | Panels and large containers |
| `--radius-bubble` | 16px | Chat bubbles, which are their own shape |
| `--radius-pill` | 999px | Fully rounded ends |
| `--radius-circle` | 50% | Dots and avatars |

Two rules decide between them, and they outrank the table:

**Concentric corners.** An element inside a rounded container gets
`inner = outer - padding`. A 12px panel with 4px padding holds an 8px child. Get
this wrong and the gap between the two curves visibly varies, which reads as
sloppy even to someone who cannot say why.

**A radius over half the height is already a pill.** `border-radius` clamps at
half the shorter side, so 20px on a 35px-tall element is a pill and writing
`--radius-pill` there changes nothing. Use the pill token when a pill is what
you mean, so the intent survives a change in height.

## Motion

| Token | Value | Used for |
|---|---|---|
| `--duration-fast` | 0.12s | Hover feedback, anything under the cursor |
| `--duration-base` | 0.15s | The default for a state change |
| `--duration-slow` | 0.2s | Theme changes and larger transitions |

Motion is a state change made legible, not decoration. If a transition is doing
work an instant change would not do, keep it. If it only looks nice, it is
costing the user time.

## Layout

`--nav-rail-width`, `--topbar-height`, `--content-radius` and `--tb-cluster` are
measurements the shell depends on, not a spacing scale. Read them; do not
restate their values.

`--chrome-inset-left` and `--chrome-inset-right` are set from JavaScript because
only the running platform knows them: macOS puts its traffic lights on the left,
Windows puts its caption buttons on the right. `--chrome-gutter` derives one
usable gutter from both so layout code does not branch on platform.

**There is no spacing scale.** Padding and margins are written as literals
today. That is a known gap rather than a decision, and inventing a private scale
in one file makes it worse, so match the values around you.

## What is deliberately not tokenised

Do not tidy these. Each is a decision with a reason, and each is recorded in
`test/tools/style-drift-allowlist.json` with that reason next to it.

- **Shadow blacks.** There is no elevation scale, so every raised surface picked
  its own alpha. Unifying them means designing the scale first, which is a
  larger piece of work than replacing the values.
- **Dark text on a bright fill.** `#1a1a1a` on an `--attention` or `--success`
  background is deliberate: the text is dark because the fill is bright, and it
  must not follow the theme. It looks like a stray literal and is not one.
- **Alpha tints of tokenised colours.** `rgba(232,122,90,0.12)` is the accent at
  low alpha. Where a tint is used once, it stays a literal. Where it is used
  enough to matter it gets a token, which is where `--accent-glow` came from.
- **The editor's injected stylesheet.** `public/editor/styles.js` builds CSS as
  a string at runtime and cannot see custom properties the same way. It carries
  its own literals on purpose.

If you think one of these should change, change the reason in the allowlist
first. A test checks that every reason actually names the values it covers, so
the explanation cannot drift away from what it is explaining.

## The drift lint

`npm run lint:styles` fails when a colour, radius or duration literal appears
outside `tokens.css` and is not in the allowlist. CI runs it, and so does the
release gate.

It exists because the alternative is review. Three near-identical reds and 224
hardcoded literals accumulated while every individual change looked reasonable
to whoever wrote it.

**If it fails you, one of two things is true.** Either a token already covers
the value, in which case use it. Or the value is genuinely new, in which case
the question is whether it should be a token. Adding it to the allowlist is the
last option, not the first, and it requires writing down why in the same edit.

The allowlist ratchets both ways: adding an entry is a visible change in a
review, and removing the last literal from a file removes the file.

**The lint ignores comments.** It used to count literals inside them, which
meant explaining a value raised its own allowance. That is fixed, and it is the
kind of thing worth knowing before you trust a count.

## Adding a token

Ask, in this order:

1. **Does one already cover this?** Most of the time the answer is yes and the
   real question was which one.
2. **Would a second use appear within a release?** One use is a literal. A
   pattern is a token.
3. **Does it have a meaning, or only a value?** `--danger` earns its place
   because it says what it is for. A token called `--grey-4` does not.

If you add one: declare it on `:root`, add the light override if the value
should differ, and describe its purpose in this file. A token with no stated
purpose gets used for the wrong thing within a release.

## Checking your work

```bash
npm run lint:styles      # no invented values
npm test                 # includes the token and stylesheet guards
npm run test:e2e         # includes both themes, rendered
```

The theme suite renders real elements in both themes and reads their computed
values back, because a token can be correct in the file and wrong on screen.
Read tokens off `body` and never off `:root` when writing such a test: the light
theme overrides on `body`, so `:root` reports the dark values whatever theme is
showing.
