# Reads of the sign-in files under the sandbox block: real runs

`test/unit/sandbox-read-deny.test.js` shows that the block `sandboxSettings` writes for Notes mode names every sign-in credential file in `sandbox.filesystem.denyRead`. These two runs show what the operating system then does. Both ran on 2026-11-17, on macOS 26.4.1 with Node v24.12.0 and no other sandbox around them, under a made-up home holding a dummy file at every path the permission hook's secrets registry names and an unnamed file beside each.

- **Through the sandbox runtime:** `RUNDOCK_SANDBOX_RUNTIME=<path to the package's dist/cli.js> node --test test/integration/credential-reads-real-sandbox.test.js`, with `@anthropic-ai/sandbox-runtime` 0.0.81. It runs the block's lists three ways: as written, without `denyRead`, and without either deny's credential entries. 5 of 5 tests passed.
- **Through the installed Claude Code:** `RUNDOCK_LIVE_CLAUDE_CODE=1 node --test test/integration/credential-reads-claude-code.test.js`, with Claude Code 2.1.326, signed in. The block goes where Rundock writes it, the workspace's `.claude/settings.local.json`, and `claude -p` runs `sh probe.sh` through its Bash tool. 6 of 6 tests passed. The stream held exactly one Bash call, and it never asked to run outside the sandbox.

## Reads

Under the block as written, in both runs, every read of the five files (`.claude/.credentials.json`, `.claude/.config.json`, `.codex/auth.json`, `.claude.json` and `.claude.json.backup`) by its plain path, a quoted path and a symbolic link in the workspace, and in the first run by a path built from `$HOME`, failed with "Operation not permitted" and printed none of the file. The Claude Code run's row for a link to the Codex token reads `| Claude Code | link 2 | .codex/auth.json | 1 | cat: <home>/workspace/link-2: Operation not permitted |`. The unnamed file beside each read as before. Through Claude Code, a file named only in a read deny in the other project layer, `.claude/settings.json`, was refused too, so the lists from both layers are merged.

## Hard links

Each step is recorded on its own: `ln`, the link count of the destination, then a read through it.

| Block | `ln` of each credential file | Link made | Read through it |
|---|---|---|---|
| As written (both runs) | refused, naming the credential file | no | no such file |
| Without `denyRead` | refused, naming the destination | no | no such file |
| Without either deny's credential entries | exit 0 | yes, link count 2 | printed the dummy contents |

So the route is closed in the measured versions: under the block as written a sandboxed `ln` of each file is refused, with the write deny alone it is still refused, and with neither deny the link is made. The block with the read deny alone was not run.

## The key, measured before the build

Before the block was changed, one headless Claude Code 2.1.326 run in a test workspace, started with `--setting-sources project,local`, put one dummy file in the project layer's `sandbox.filesystem.denyRead` and another in the local layer's. A sandboxed `cat` of each failed with "Operation not permitted", and the same `cat` of an unnamed file beside them printed its contents. That this ran before the build can't be shown after the event, so `test/integration/credential-reads-claude-code.test.js` measures the same things at this head: the key, by writing the block under it (lines 63 to 67) and refusing each named read (lines 117 to 122); the lists of both layers merged (lines 68 and 132 to 134); and named against unnamed reads (lines 117 to 130). A runtime that stops honoring the key is a known limit, since Rundock pins no version.

## In the app: what a person uses still works

The runs above drive the sandbox without the app. A third run used the app as a person does, once with this change and once with the commit it is based on, to show the read deny breaks nothing a person relies on.

What each run did, driving the server over its WebSocket the way the window does:

- started the server from the checkout under test and opened a new test workspace holding one note, `notes/hello.md`, of three lines, and two agents, one on Claude Code and one on Codex;
- set the workspace to Notes mode and turned the sandbox switch on;
- in one conversation with each agent, asked for three shell commands, `pwd`, `ls notes` and `wc -l notes/hello.md`, one at a time, answering any card with "allow once";
- read the Permissions row's sandbox status (`get_sandbox_status`) after the workspace opened, after the switch, and after both conversations, and the block in the workspace's `.claude/settings.local.json`, recording only the length of each list.

Both runtimes started from the sign-ins already on the machine. The run read no sign-in file itself and asked no agent to.

| | With this change | The commit it is based on |
|---|---|---|
| Claude Code conversation | ran all three commands; output correct; no card | the same |
| Codex conversation | replied with all three outputs, correct; no card | the same |
| Permissions row, all three reads | `available`, `present`, `managed`, `on` and `blockOn` true; set by the workspace; nothing enabled elsewhere; no notice | the same, field for field |
| The block's `denyRead` | 5 entries | absent |
| The block's `denyWrite` and `allowWrite` | 36 and 8 entries | 36 and 8 entries |

Rundock doesn't show a Codex command's output in the window, so the Codex row rests on its reply. The server logged the three Claude Code commands as read-only and answered them without a card on both sides.

Versions: Claude Code 2.1.326, Codex CLI 0.156.1, with macOS and Node as above.

## What this does not cover

- A sandboxed command that starts Claude Code or Codex itself, such as `claude -p` run through the shell tool. It can no longer read their sign-in files in Notes mode with the sandbox on, so it is expected to fail to sign in. Not run here.
- Code mode with the sandbox off, where the permission hook is the only check.
