// Poll until a condition holds, or the deadline passes.
//
// A predicate that THROWS means the condition is not met yet, not that the
// caller should stop. These harnesses poll for things a server is still
// producing, so a predicate routinely runs before the thing exists:
// `fs.readdirSync` on a directory scaffolding has not created yet throws
// ENOENT, while `existsSync` returns false. Both mean "not yet", and only one
// of them used to be survivable.
//
// It cost two release gate runs on 2026-08-20. A persona journey aborted on
// ENOENT and reported 5 of 14 checks; the same suite standalone passed 16 of 16
// on the same commit. The difference was load: inside the gate that step
// follows a 140-second browser suite, scaffolding is slower, and the first poll
// landed before the directory existed. A suite that fails for reasons unrelated
// to the change teaches people to stop reading it.
//
// The catch belongs here rather than around the one predicate that tripped it.
// A helper safe only for the predicates it happened to be given leaves the trap
// set for the next one, and the other predicates in these files are safe by
// accident rather than by design.
//
// It lives in its own module because both harnesses had their own copy, and
// fixing this meant patching the same eight lines twice.
export async function waitFor(pred, timeout = 30000, interval = 200) {
  const deadline = Date.now() + timeout;
  for (;;) {
    let v = null;
    try {
      v = await pred();
    } catch {
      v = null; // not yet
    }
    if (v) return v;
    if (Date.now() >= deadline) return null;
    await new Promise(r => setTimeout(r, interval));
  }
}
