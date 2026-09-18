'use strict';
// Port selection for `npm run look`.
//
// WHY THIS IS TESTED AT ALL, for a developer script. The whole point of `look`
// is that a person sees the branch they think they are seeing. Every failure
// mode here ends the same way: someone spends twenty minutes forming an
// opinion about the wrong build. 0.13.3 shipped a tag two days behind main for
// exactly that reason, with every check green, because nothing was looking at
// the artefact rather than at the checks.
//
// The two behaviours below are the ones that decide it. A scan that hands back
// a busy port fails loudly and harmlessly, because the server will not bind.
// A scan that silently MOVES an explicitly requested port fails quietly and
// expensively, because it serves the right code at the wrong address while the
// address the person is watching still holds the old build.

const test = require('node:test');
const assert = require('node:assert');
const net = require('node:net');

const { free, pickPort, PORT_SCAN } = require('../../scripts/look.js');

/** Hold a real port for the duration of one test. Nothing is mocked: the
 * question "is this port free" has exactly one honest answer and it comes from
 * the operating system. */
function hold() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      resolve({ port: srv.address().port, release: () => new Promise((r) => srv.close(r)) });
    });
  });
}

test('a held port is not reported free', async () => {
  const taken = await hold();
  try {
    assert.equal(await free(taken.port), false);
  } finally {
    await taken.release();
  }
});

test('a released port is reported free again', async () => {
  const taken = await hold();
  const { port } = taken;
  await taken.release();
  assert.equal(await free(port), true);
});

test('the scan steps over a busy port rather than returning it', async () => {
  const taken = await hold();
  try {
    const got = await pickPort(null, taken.port);
    assert.notEqual(got, taken.port);
    assert.ok(got > taken.port, `expected a port above ${taken.port}, got ${got}`);
    assert.equal(await free(got), true, 'the port handed back must actually be bindable');
  } finally {
    await taken.release();
  }
});

test('the scan returns the first port when nothing holds it', async () => {
  const taken = await hold();
  const { port } = taken;
  await taken.release();
  assert.equal(await pickPort(null, port), port);
});

test('an explicitly requested busy port is refused, not quietly reassigned', async () => {
  // THE ONE THAT MATTERS. Moving someone to the next port without telling them
  // is the failure that costs real time: they keep watching the address they
  // asked for, which is still serving whatever it served before.
  const taken = await hold();
  try {
    await assert.rejects(
      () => pickPort(taken.port),
      (err) => err.message.includes(String(taken.port)) && /in use/.test(err.message),
      'the refusal must name the port, or the reader cannot act on it',
    );
  } finally {
    await taken.release();
  }
});

test('an explicitly requested free port is honoured exactly', async () => {
  const taken = await hold();
  const { port } = taken;
  await taken.release();
  assert.equal(await pickPort(port), port);
});

test('the scan is bounded rather than infinite', () => {
  // A machine with nothing free should say so. An unbounded loop would hang
  // with no output, which is the state this project has twice paid for: a
  // ninety-five minute CI step that was waiting on a port it could never bind.
  assert.ok(Number.isInteger(PORT_SCAN) && PORT_SCAN > 0 && PORT_SCAN < 1000);
});
