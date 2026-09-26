# Hostile extension fixtures

These are deliberately misbehaving extension entries. They exist to prove that
Rundock's extension confinement holds in a real browser engine, and they are
safe to run on a developer's machine by construction:

- **They name no host.** Every destination is the placeholder `__LOGGER__`,
  which the confinement harness replaces at run time with a listener it opens
  on `127.0.0.1` itself. `test/unit/confinement-fixtures.test.js` fails if any
  file here contains another address.
- **They see only canary data.** The harness mounts them on files it creates
  in a fresh folder under the system temporary directory, holding fake values
  such as `CANARY-NOT-A-REAL-KEY`, and refuses to run anywhere else.
- **They are never installed.** The harness loads the real host modules into
  its own page and mounts these directly. Nothing here is ever written into a
  workspace's extension records or published as a package.

The harness is `test/helpers/confinement-harness.js`.
