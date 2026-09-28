'use strict';
/**
 * What the Permissions pane's "Keep agents inside this workspace" row says,
 * decided from the server's status, the host platform and the workspace's
 * default runtime. A module rather than view code so every state the row can
 * take is tested without a DOM, and so the view draws what this returns and
 * decides nothing.
 *
 * The effective state comes first (On, Off, Unavailable, Status unknown) and
 * who controls it second. Only a state Rundock can actually change gets a
 * switch; every other state is read-only, with a lock where something else is
 * in control and nothing switch-shaped at all.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RundockSandboxRowModel = factory();
}(typeof self !== 'undefined' ? self : this, function () {

  const ON_CAPTION = 'Keeps agents inside a wall macOS enforces: they can change files in this workspace, the folders below, and the temporary folders they need. Everything else is blocked.';
  const OFF_CAPTION = 'Removes the wall macOS enforces: agents can then change or delete files outside this workspace wherever your account allows. Rundock still asks before each change there, until you add a folder below.';
  // The same two captions without the folders, for a locked row where
  // Rundock's own block is not what the operating system enforces: the
  // person's own block (no folders listed, their block decides), or a sandbox
  // turned on by another settings file without Rundock's block (the listed
  // folders are not in the write list, so "the folders below" would be untrue).
  const ON_CAPTION_NO_FOLDERS = 'Keeps agents inside a wall macOS enforces: they can change files in this workspace and the temporary folders they need. Everything else is blocked.';
  const OFF_CAPTION_NO_FOLDERS = 'Removes the wall macOS enforces: agents can then change or delete files outside this workspace wherever your account allows. Rundock still asks before each change there.';
  const MACOS_CAPTION = 'Uses macOS\'s built-in sandbox.';
  const CONFIRM_OFF = 'Agents will be able to change or delete files outside this workspace wherever your account allows. Rundock will still ask before each change there, unless a folder is added below.';

  // One word per state, beside the control, so the state reads without colour.
  const LABELS = { on: 'On', off: 'Off', unavailable: 'Unavailable', unknown: 'Status unknown', checking: 'Checking…' };

  // `code` marks a span the view sets in monospace; every other part is text.
  function row(state, control, extra) {
    return {
      state, label: LABELS[state], control,
      rowLabel: null, captions: [], ownership: null, bringIn: false, folders: 'plain',
      ...extra,
    };
  }

  // The Codex row: Codex runs its own sandbox, which Rundock reads on Windows
  // and never writes. A sentence about what Codex does appears only where
  // Rundock detected it.
  function codexRow(runtime, label) {
    const cx = (runtime && runtime.codex) || {};
    const captions = cx.windowsSandbox === false ? ['Codex currently asks before changing files, based on its own settings.'] : [];
    return row('unknown', 'lock', {
      rowLabel: label,
      captions,
      ownership: [{ text: 'Controlled by Codex, in your own config file. Rundock can\'t confirm whether it is active.' }],
    });
  }

  // The Claude Code row. `folders` says what the working folders do under it:
  // 'on' where Rundock's block carries them and the sandbox is on, 'off' where
  // no sandbox runs, 'plain' where Rundock cannot say (a block a person wrote,
  // a sandbox another file turns on without Rundock's block, or not yet known).
  function claudeRow(status, platform) {
    const host = status && status.platform ? status.platform : platform;
    if (host === 'win32') return row('unavailable', 'none', { captions: ['Not available on Windows. Your approval settings still apply.'], folders: 'off' });
    if (host === 'linux') return row('unavailable', 'none', { captions: ['Not available on Linux yet. Your approval settings still apply.'], folders: 'off' });
    if (!status) return row('checking', 'none');
    if (!status.available) return row('unavailable', 'none', { captions: ['Not available on this computer. Your approval settings still apply.'], folders: 'off' });

    const state = status.on ? 'on' : 'off';
    // The folder clause is true only where Rundock's own block is in the file.
    const rundockBlock = !!status.present && !!status.managed;
    const lockedCaptions = [status.on
      ? (rundockBlock ? ON_CAPTION : ON_CAPTION_NO_FOLDERS)
      : (rundockBlock ? OFF_CAPTION : OFF_CAPTION_NO_FOLDERS)];
    const captions = [status.on ? ON_CAPTION : OFF_CAPTION];
    if (!status.managed) {
      return row(state, 'lock', {
        captions: lockedCaptions,
        ownership: [{ text: 'Set up outside Rundock, in ' }, { code: '.claude/settings.local.json' }, { text: '. Rundock cannot change this switch here.' }],
        bringIn: true,
      });
    }
    // Rundock's block carries the folders whenever it exists.
    const folders = status.on ? (status.present ? 'on' : 'plain') : 'off';
    if (status.setBy === 'managed') {
      // An organisation's settings turn it on; Rundock's switch changes nothing.
      return row(state, 'lock', {
        captions: lockedCaptions,
        ownership: [{ text: 'Set by your organisation\'s managed Claude Code settings. Rundock cannot change this switch here.' }],
        folders,
      });
    }
    const elsewhere = Array.isArray(status.enabledElsewhere) ? status.enabledElsewhere : [];
    if (elsewhere.length) {
      // The runtime turns the sandbox on when any file does, so Rundock's own
      // switch cannot turn it off while another file turns it on.
      const ownership = [{ text: 'Turned on in ' }];
      elsewhere.forEach((where, i) => { if (i) ownership.push({ text: ' and ' }); ownership.push({ code: where }); });
      ownership.push({ text: elsewhere.length === 1
        ? '. Rundock\'s switch can\'t turn this off while that file turns it on.'
        : '. Rundock\'s switch can\'t turn this off while those files turn it on.' });
      return row(state, 'lock', { captions: lockedCaptions, ownership, folders });
    }
    return row(state, 'switch', { captions: captions.concat([MACOS_CAPTION]), folders });
  }

  // status: the server's sandbox_status (null until it arrives). runtime: the
  // runtimeStatus the Workspace pane keeps. agents: the roster, whose entries
  // name their runtime. Each runtime in use by the workspace gets its own row,
  // Claude Code first; with no roster, the default runtime decides.
  function sandboxRows(status, platform, runtime, agents) {
    const team = Array.isArray(agents) ? agents : [];
    const codexDefault = !!(runtime && runtime.defaultRuntime === 'codex');
    const hasCodex = team.some((a) => a && a.runtime === 'codex') || codexDefault;
    const hasClaude = team.length ? team.some((a) => a && a.runtime !== 'codex') : !codexDefault;
    const rows = [];
    if (hasClaude) rows.push(claudeRow(status, platform));
    if (hasCodex) rows.push(codexRow(runtime, hasClaude ? 'Keep Codex agents inside this workspace' : null));
    return rows;
  }

  // The first row, for the callers that draw one.
  function sandboxRow(status, platform, runtime, agents) {
    return sandboxRows(status, platform, runtime, agents)[0];
  }

  // What the working folders do, in the words that are true for this state and
  // mode. Checked against scripts/permission-hook.js: a file edit inside a named
  // folder is allowed without a card in every mode, and one outside is carded in
  // every mode; a command outside is carded where the hook reads the path, and
  // in Notes every command that changes anything asks anyway; with the switch on,
  // the operating system refuses a command's write outside the list, and the
  // retry past it is carded.
  function foldersCaption(state, mode) {
    if (state === 'on') return 'Agents can change files in these folders too. Anywhere else, changes are blocked unless you approve them.';
    if (state === 'off') {
      return mode === 'code'
        ? 'Agents can change files in these folders without asking. Anywhere else, Rundock still asks before a file edit, and before a command it can see reaching outside.'
        : 'Agents can edit files in these folders without asking. Anywhere else, changes need your approval.';
    }
    return null;
  }

  // Under the working folders, where the sandbox block in the settings file is
  // the person's own: Rundock rewrites no part of that file, so the folders
  // reach neither the block nor Claude Code's additional directories.
  const OWN_SANDBOX_FOLDERS_NOTE = 'Because this workspace\'s sandbox settings are your own, Rundock doesn\'t add working folders to them. '
    + 'Add each working folder to them yourself so agents can write there and a cd into it carries over.';
  function ownSandboxFoldersNote(status) {
    return status && status.present && status.managed === false ? OWN_SANDBOX_FOLDERS_NOTE : null;
  }

  function noticeText(status) {
    if (!status || (status.notice !== 'on' && status.notice !== 'off')) return null;
    return `Keeping agents inside this workspace is now its own switch. Yours is still ${status.notice}. Switching between Notes and Code won't change it.`;
  }

  // The rules a review names, in words a person reads before confirming.
  const RULE_WORDS = {
    'filesystem.denyWrite': 'a custom deny pattern on',
    'filesystem.denyRead': 'a read block on',
    'filesystem.allowRead': 'a read allowance for',
    'filesystem.allowWrite': 'a write allowance for',
    excludedCommands: 'a command left outside the sandbox:',
  };
  function ruleParts(d) {
    const words = RULE_WORDS[d.rule];
    return words ? [{ text: `${words} ` }, { code: d.value }] : [{ text: 'the setting ' }, { code: `${d.rule}: ${d.value}` }];
  }
  function reviewCopy(review) {
    const dropped = Array.isArray(review && review.dropped) ? review.dropped : [];
    let warn = null;
    if (dropped.length === 1) {
      warn = [{ text: 'Rundock can\'t represent one rule in your file: ' }, ...ruleParts(dropped[0]), { text: '. Bringing your rules in will drop it.' }];
    } else if (dropped.length > 1) {
      warn = [{ text: `Rundock can't represent ${dropped.length} rules in your file: ` }];
      dropped.forEach((d, i) => { if (i) warn.push({ text: '; ' }); warn.push(...ruleParts(d)); });
      warn.push({ text: '. Bringing your rules in will drop them.' });
    }
    return {
      title: 'Bring your custom rules into Rundock?',
      foldersLead: review && review.folders && review.folders.length ? 'These folders you added by hand become Working folders:' : null,
      folders: (review && review.folders) || [],
      warn,
      cancelLabel: 'Cancel',
      confirmLabel: 'Bring in my rules',
    };
  }

  return { sandboxRow, sandboxRows, foldersCaption, ownSandboxFoldersNote, noticeText, reviewCopy, LABELS, ON_CAPTION, OFF_CAPTION, ON_CAPTION_NO_FOLDERS, OFF_CAPTION_NO_FOLDERS, MACOS_CAPTION, CONFIRM_OFF };
}));
