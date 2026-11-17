# Reads of the sign-in files under the sandbox block: a real run

`test/unit/sandbox-read-deny.test.js` shows that the block `sandboxSettings` writes names each sign-in credential file in its read-deny list. It cannot show that the runtime honours that list, or that the operating system then refuses the read whatever the command calls the file. This records two real runs that can show it, and what they found, then a run of the app showing that nothing a person uses changed.

## Which key the runtime reads

Before the block was changed, one headless Claude Code run in a test workspace, holding dummy files only and started with `--setting-sources project,local`, put one named file in the project layer's `sandbox.filesystem.denyRead` and another in the local layer's.

- A sandboxed `cat` of each named file failed with "Operation not permitted".
- The same `cat` of an unnamed file in the same folder printed its contents.

So the key is `sandbox.filesystem.denyRead`, a list of absolute paths, and the lists from the two layers are merged, as `denyWrite`'s are. The block writes its read deny under that key.

## What was run

`test/integration/credential-reads-real-sandbox.test.js`, which:

- builds a made-up home under the temp folder, with a workspace inside it;
- puts a file with dummy contents at every path the permission hook's secrets registry names under that home, and an unnamed file beside each;
- builds the block with `sandboxSettings(<workspace>, 'darwin', <home>, undefined, [], 'knowledge')`, the block Notes mode writes with the sandbox on, and checks its `denyRead` is the registry's list;
- hands the block's `denyRead`, `allowWrite` and `denyWrite` lists, unchanged, to the sandbox runtime Claude Code's command sandbox is built on, and runs one `sh` script inside it. The script travels in the environment, so the command line names no file;
- reads each credential file four ways: its plain path, a quoted path, a path built from `$HOME` as the command runs, and a symbolic link in the workspace that leads to it. It also appends to each, reads each unnamed file, and makes a hard link to each with `ln` before reading it.

A control writes a file outside every writable root, which must be refused, so the run can't pass with the sandbox off.

The command, run with no other sandbox around it, since the runtime starts its own:

```
RUNDOCK_SANDBOX_RUNTIME=<path to the package's dist/cli.js> node --test test/integration/credential-reads-real-sandbox.test.js
```

## Versions

| | |
|---|---|
| Date | 2026-11-17 |
| macOS | 26.4.1 (build 25E253) |
| Claude Code, for the key | 2.1.326 |
| Sandbox runtime | `@anthropic-ai/sandbox-runtime` 0.0.81, the standalone package and its CLI |
| Node | v24.12.0 |

The run used the standalone package. Which version of it a given Claude Code release bundles was not determined.

## Results

The first column is this change's block. The second is the same block with its `denyRead` list removed, run the same way to show that the first test fails without it.

| Each of `.claude/.credentials.json`, `.claude/.config.json`, `.codex/auth.json`, `.claude.json`, `.claude.json.backup` | This change's block | Without the read deny |
|---|---|---|
| Read by its plain path | refused | read |
| Read by a quoted path | refused | read |
| Read by a path built from `$HOME` | refused | read |
| Read through a symbolic link in the workspace | refused | read |
| Append | refused, bytes unchanged | refused, bytes unchanged |
| The unnamed file beside it, read | read | read |
| A hard link made by a sandboxed `ln`, then read | not made: `ln` exits 1 | not made: `ln` exits 1 |
| Control: a file outside every writable root | refused | refused |

Every refused read failed with "Operation not permitted" and printed none of the file's contents.

## The links

A symbolic link in the workspace doesn't get past the read deny: the operating system judges the file the link leads to.

A hard link was never made. The sandboxed `ln` failed for every file in both columns, so what stops it is not the read deny, and the run doesn't say which rule does. `SECURITY.md` names a hard link to a sign-in file as a known limit and claims nothing either way, which this run doesn't change: a later runtime that allows the link would leave a second name for the file that the block doesn't list.

## Result

All four tests passed under this change's block. Without the read deny, the first test failed and named all twenty reads, four for each file.

## In the app: what a person uses still works

The runs above use the sandbox runtime directly. A third run used the app as a person does, once with this change and once with the commit it is based on, to show the read deny breaks nothing a person relies on.

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

Versions: Claude Code 2.1.326, Codex CLI 0.156.1, with macOS and Node as in the table above.

## What this doesn't cover

- A sandboxed command that starts Claude Code or Codex itself, such as `claude -p` run through the shell tool. It can no longer read their sign-in files in Notes mode with the sandbox on, so it is expected to fail to sign in. Not run here.
- Code mode with the sandbox off, where the permission hook is the only check.
- A runtime version that stops honouring `denyRead`. Rundock pins none, so this run says only what the versions above do.
