---
name: my-tracker
description: Keeps a tracker note up to date. Use when the person asks to add, move, rename, finish or remove an item in a note marked my-tracker.
---

# My tracker

A tracker note is a markdown file whose frontmatter carries `my-tracker: true`. Its body is a list of sections, each a level two heading (`## Now`) followed by one item per line (`- An item`). Rundock draws it as a board and a table with the My Tracker view.

- **Add** an item: append `- <item>` after the last item of the section it belongs to.
- **Move** one: cut its line and paste it after the last item of the other section.
- **Rename** one: change the text after `- ` on its line, and nothing else.
- **Finish** one: move it under `## Done`.
- **Remove** one: delete its line.

Keep the frontmatter as it is: the marker is what tells Rundock to draw the note as a tracker. Keep any text that is not a heading or an item where it is; the view keeps it too.
