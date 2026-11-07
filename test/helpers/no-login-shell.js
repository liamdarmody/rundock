'use strict';
// NO TEST RUNS THE DEVELOPER'S OWN LOGIN SHELL.
//
// Rundock finds `claude` the way the person's login shell does
// (lib/runtime/claude-lookup.js): it runs $SHELL as a login shell and reads
// the PATH it prints. Under a test that would be whoever runs the suite,
// reading their own startup files, and the PATH it printed could put a real
// Claude Code ahead of the stub every suite puts first on PATH. So a process
// that loads the fixtures has no $SHELL, and Rundock looks for `claude` on
// the PATH it was started with, which is the lookup every suite was written
// against. A test about the login shell sets a stub shell of its own
// (test/helpers/login-shell.js).
delete process.env.SHELL;
