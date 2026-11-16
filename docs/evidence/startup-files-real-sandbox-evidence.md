# Shell startup files under the sandbox block: a real run

`test/unit/sandbox-settings.test.js` shows that the block `sandboxSettings` writes names each shell startup file in its write-deny list. It cannot show that the operating system then refuses the write. This records a run of a real sandboxed process under that block, which can show it, and what it found.

## What was run

`test/integration/startup-files-real-sandbox.test.js`, which:

- builds a made-up home under the temp folder and makes it the workspace;
- puts every listed startup file there, Rundock's record of them included, except `.bash_login`, which is left absent. `.bashrc` is a link to `dotfiles/bashrc`, the way dotfile managers leave it, and `.config/fish/conf.d/` holds one snippet;
- builds the block with `sandboxSettings(home, 'darwin', home, <this machine's temp roots>, [], 'knowledge')` and hands its `allowWrite` and `denyWrite` lists, unchanged, to the sandbox runtime Claude Code's command sandbox is built on;
- runs `node -e` inside that sandbox. The code builds every path from `HOME` and an environment list, so its command line names no file. It appends to each file, creates the absent one, appends to the link's target, appends to the existing fish snippet and creates a new one;
- reads every file's bytes back afterwards.

There are two controls. An ordinary file in the workspace is written, which proves the probe can write at all. A file outside every writable root is refused, which proves the sandbox is on.

The command, run with no other sandbox around it, since the runtime starts its own:

```
RUNDOCK_SANDBOX_RUNTIME=<path to the package's dist/cli.js> node --test --require ./test/helpers/account-home-refused.js test/integration/startup-files-real-sandbox.test.js
```

## Versions

| | |
|---|---|
| Date | 2026-11-08 |
| macOS | 26.4.1 (build 25E253) |
| Sandbox runtime | `@anthropic-ai/sandbox-runtime` 0.0.81, the standalone package and its CLI |
| Node | v24.12.0 |

The run used the standalone package. Which version of it a given Claude Code release bundles was not determined.

## Results

The first column is this change's block. The second is the block on `main` before this change, run the same way to show that the first test fails without the change.

| Write | This change's block | `main`'s block |
|---|---|---|
| `.zshenv`, `.zlogin`, `.zlogout`, `.bash_logout` (append) | refused, bytes unchanged | written |
| `.zprofile`, `.zshrc`, `.bash_profile`, `.profile` (append) | refused, bytes unchanged | refused by the runtime's own list |
| `.bash_login`, not there yet (create) | refused, still absent | written |
| `.config/fish/config.fish` (append) | refused, bytes unchanged | written |
| `.config/fish/conf.d/paths.fish` (append) | refused, bytes unchanged | written |
| `.config/fish/conf.d/zz-planted.fish` (create) | refused, still absent | written |
| `.rundock-startup-file-exposure.json`, the record (append) | refused, bytes unchanged | written |
| `.bashrc`, a link to `dotfiles/bashrc` (append through the link) | **written** | written |
| `dotfiles/bashrc`, the link's target (append) | **written** | written |
| Control: an ordinary file in the workspace | written | written |
| Control: a file outside every writable root | refused | refused |

The runtime's own refusals in the second column come from its built-in list of protected names, which it anchors at its working directory, here the made-up home.

## The link

Writes to a startup file that is a link land, both through the link and straight to its target. The block names `.bashrc`, but a write through it reaches `dotfiles/bashrc`, and the operating system judges the file the write reaches. This runtime version resolves links for its read denies only, and keeps each write deny as it was written. Its own `.bashrc` entry is matched the same way.

The block was not given resolved link targets. Rundock recognizes a block as its own by rebuilding it from the block's own workspace root and home (`isRundockSandbox` in `lib/workspace/scaffold.js`). An entry that depends on where a link leads at the moment the block is written cannot be rebuilt once the link moves. Rundock would then stop recognizing its own block, and so stop updating or withdrawing it. Such an entry would also miss any link made after the workspace opened.

A linked startup file is covered instead by two checks:

- The permission hook's card, which matches the link and its target by real path.
- The guard, which watches each listed file by real path during every turn and puts a change back (`test/unit/startup-file-guard.test.js`, a write through a dotfiles link).

The second test in the file pins this limit, so a runtime that starts refusing these writes turns it red. `ARCHITECTURE.md` states the same limit.

## Result

Both tests passed under this change's block. Under `main`'s block, the first test failed and named the nine writes in the second column that landed.
