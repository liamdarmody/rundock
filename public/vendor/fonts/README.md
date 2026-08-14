# Inter, vendored

Rundock ships its typeface rather than fetching it. Until 0.11.7 `index.html`
linked `fonts.googleapis.com`, which made a third-party request on every launch,
reported each launch to Google, and rendered in a different typeface whenever
that request was slow or the machine was offline. It failed silently: the
fallback stack is `system-ui, -apple-system, sans-serif`, so the app simply drew
in San Francisco or Segoe and nobody noticed. The app's typography was
non-deterministic across launches and machines.

| | |
| --- | --- |
| Upstream | https://github.com/rsms/inter |
| Release | v4.1 |
| Source asset | `Inter-4.1.zip`, 32.1 MB |
| Asset SHA-256 | `9883fdd4a49d4fb66bd8177ba6625ef9a64aa45899767dde3d36aa425756b11e` |
| Files taken | `web/InterVariable.woff2` (352,240 bytes), `web/InterVariable-Italic.woff2` (387,976 bytes), `LICENSE.txt` |
| Licence | SIL Open Font License 1.1, reproduced verbatim in `Inter-LICENSE.txt` |

The OFL permits redistribution provided the licence travels with the font, which
is why `Inter-LICENSE.txt` sits beside the files rather than being summarised.

## Why the full variable file rather than a subset

Google's endpoint served a subset tuned for web pages. Rundock renders arbitrary
user file content, so a subset breaks the first time someone opens a note
containing a character nobody anticipated, and it breaks as a silent glyph
substitution rather than an error. One variable file also covers every weight
between 100 and 900, which is more than the four the stylesheets ask for.

Both faces ship because the roman variable font contains no true italics, and
`font-style: italic` is used in four places including markdown emphasis in chat
and the editor's italic control. Without the italic file the browser synthesises
an oblique by shearing the roman, which is visibly worse.

## Updating

Download the release asset from the upstream releases page, verify its SHA-256,
extract the two `web/` files and `LICENSE.txt`, and update the table above. The
zip is not committed: only the three files listed are.
