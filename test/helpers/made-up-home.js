'use strict';
// A MADE-UP HOME FOLDER FOR THIS TEST PROCESS, so a turn's guard watches
// shell startup files nobody uses. Required for its effect, before anything
// that reads the home folder: HOME points at a fresh temp folder, the desktop
// app's layout puts Rundock's own records there too, and ZDOTDIR and
// XDG_CONFIG_HOME are cleared so the zsh and fish files resolve under it.
// Under test the guard refuses the account's own home anyway, and fails the
// run naming the files (lib/workspace/answer-file-guard.js notTheAccounts).
const fs = require('fs');
const os = require('os');
const path = require('path');

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rundock-made-up-home-')));
process.env.HOME = home;
process.env.RUNDOCK_ELECTRON = '1';
delete process.env.ZDOTDIR;
delete process.env.XDG_CONFIG_HOME;
process.on('exit', () => { try { fs.rmSync(home, { recursive: true, force: true }); } catch (e) { /* best effort */ } });

module.exports = { home };
