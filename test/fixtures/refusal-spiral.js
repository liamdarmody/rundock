'use strict';
// A refusal spiral: an agent asked to back a folder up, refused at each step,
// trying another route each time before it finally asks the person. Pure
// data, so any build of the hook can be replayed against exactly the same
// calls (test/helpers/refusal-replay.js).
//
// The shape is the reported one: a simple copy, a refusal, and a run of
// workarounds (the same copy in other words, the same copy with the sandbox
// off, other copying tools) that each cost another card or another block.
//
// Each step is one tool call and what met it:
//   card     how the person answered the card it raised: 'allow', 'deny', or
//            'none' (nobody answered, so it timed out). Absent: no card.
//   blocked  the error the runtime reported when the sandbox refused the
//            command, in the shape it reports one. Absent: it ran.
// `asks` is the agent's message when it finally stops and asks.
//
// `H` is the home directory the hook sees.
module.exports = function refusalSpiral({ H }) {
  const backup = `${H}/Desktop/notes-backup`;
  const blocked = (cmd, target) => `Exit code 1\n${cmd}: ${target}: Operation not permitted\n<sandbox_violations>\ndeny file-write-create ${target}\n</sandbox_violations>`;
  return {
    steps: [
      { command: 'cp -R notes ~/Desktop/notes-backup', card: 'allow', blocked: blocked('cp', backup) },
      { command: 'mkdir -p ~/Desktop/notes-backup && cp -R notes/. ~/Desktop/notes-backup/', card: 'allow', blocked: blocked('mkdir', backup) },
      { command: 'cp -R notes ~/Desktop/notes-backup', dangerouslyDisableSandbox: true, card: 'deny' },
      { command: 'rsync -a notes/ ~/Desktop/notes-backup/', card: 'none' },
      { command: 'ditto notes ~/Desktop/notes-backup', card: 'allow', blocked: blocked('ditto', backup) },
      { command: `python3 -c "import shutil; shutil.copytree('notes', '${backup}')"`, card: 'allow', blocked: `Exit code 1\nPermissionError: [Errno 1] Operation not permitted: '${backup}'\n<sandbox_violations>\ndeny file-write-create ${backup}\n</sandbox_violations>` },
    ],
    asks: 'I could not copy the folder to your Desktop: each attempt was refused. Would you like to add the Desktop as a working folder, or copy it yourself?',
  };
};
