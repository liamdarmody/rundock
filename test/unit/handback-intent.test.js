'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..', '..');
const { resolveMarkers, MARKER_TEXT } = require(path.join(ROOT, 'lib', 'delegation', 'markers.js'));
const { buildScopeReturnPrompt } = require(path.join(ROOT, 'lib', 'delegation', 'catch-up.js'));

// THE DEFECT THIS CLOSES, from a real conversation on 10 September 2026.
//
// The user asked for fact-checked research to go back to Vox for a redraft.
// Ren finished, wrote "Passing this back to you to route to Vox for the
// redraft", and emitted COMPLETE. The orchestrator was handed a prompt
// ordering it to output exactly <silent> and stop. It obeyed. No delegation to
// Vox appears anywhere in the server log after that point. The request was
// never carried out, and nothing in the interface said so.
//
// COMPLETE was carrying two meanings: "do not parrot this back" and "my part
// is done, something still needs to happen". One prompt cannot serve both.

const HANDBACK = 'Research is finished and verified. Passing this back to route to Vox.';
const OUTPUT_BLOCK = `\n\n--- research-lead ---\n${HANDBACK}\n---`;
const SILENT_INSTRUCTION = 'MUST be exactly the literal string <silent>';

function promptFor(mode, orchMissed = { text: null }) {
  return buildScopeReturnPrompt({
    mode, orchMissed, specialistId: 'research-lead',
    outputBlock: OUTPUT_BLOCK, pendingRequest: 'pass this back to Vox'
  });
}

describe('a specialist can say its part is done and the request is not', () => {
  test('the three markers resolve to three distinct modes', () => {
    assert.strictEqual(resolveMarkers('done <!-- RUNDOCK:CONTINUE -->').mode, 'continue');
    assert.strictEqual(resolveMarkers('done <!-- RUNDOCK:COMPLETE -->').mode, 'complete');
    assert.strictEqual(resolveMarkers('nope <!-- RUNDOCK:RETURN -->').mode, 'return');
    assert.strictEqual(resolveMarkers('no marker here').mode, null);
  });

  test('and the three modes produce three different prompts', () => {
    const prompts = ['continue', 'complete', 'return'].map((m) => promptFor(m));
    assert.strictEqual(new Set(prompts).size, 3, 'each mode must ask for something different');
  });
});

describe('the orchestrator is not silenced when work remains', () => {
  test('the continue prompt carries no silent instruction', () => {
    assert.ok(!promptFor('continue').includes(SILENT_INSTRUCTION),
      'this is the whole defect: told to say exactly <silent> while holding a '
      + 'handback that asks for the work to be routed onward, it obeyed and the '
      + 'request died');
  });

  test('and it tells the orchestrator to act on what it was handed', () => {
    const p = promptFor('continue');
    assert.match(p, /do what it asks for next/i);
    assert.match(p, /work-continues/, 'and is labelled as its own kind of handback');
  });

  test('the specialist output is in the continue prompt', () => {
    assert.ok(promptFor('continue').includes(HANDBACK),
      'the orchestrator must be able to act on what was delivered without '
      + 're-reading files to work out what happened');
  });
});

describe('the other two paths are untouched', () => {
  test('complete still parks the orchestrator silently', () => {
    const p = promptFor('complete');
    assert.ok(p.includes(SILENT_INSTRUCTION), 'unchanged from today');
    assert.match(p, /pipeline-complete/);
  });

  test('return still produces the out-of-scope routing prompt', () => {
    const p = promptFor('return');
    assert.match(p, /routing-request/);
    assert.match(p, /outside their scope/);
    assert.match(p, /pass this back to Vox/, 'and still carries the pending request');
  });

  test('an unknown mode falls back to routing rather than to silence', () => {
    // Falling back to the silent prompt would turn a typo into a dead
    // conversation. Falling back to routing costs at most one wasted turn.
    assert.ok(!promptFor('nonsense').includes(SILENT_INSTRUCTION));
  });
});

describe('the handback is never sent twice', () => {
  // The orchestrator's catch-up delta and the output block both carry turns.
  // If the delta is not filtered, the specialist's final message arrives in
  // both halves of the same prompt.
  for (const mode of ['continue', 'complete', 'return']) {
    test(`${mode}: the specialist's message appears exactly once`, () => {
      const orchMissed = { text: 'ED: I tightened the opening' };
      const p = promptFor(mode, orchMissed);
      const hits = p.split(HANDBACK).length - 1;
      assert.strictEqual(hits, 1, `found ${hits} copies in the ${mode} prompt`);
      assert.match(p, /I tightened the opening/, 'and the catch-up still arrives');
    });
  }
});

describe('the contract and the server cannot drift apart', () => {
  const contract = fs.readFileSync(path.join(ROOT, 'lib', 'agents', 'prompt.js'), 'utf8');

  // EVERY COPY, NOT THE ONE I LOOKED AT. The contract is written twice: once
  // in prompt.js and again as delegationContext in engine.js, and the second
  // copy goes to exactly the specialist type that caused the incident, a lead
  // with its own reports. It still said "one of two markers" and omitted
  // CONTINUE, more emphatically and closer to the brief than the copy that
  // named it. A lead reading both would have followed the wrong one, so the
  // fix would not have fixed the reported case. The first version of this
  // test bound only prompt.js and would have passed.
  const engineSrc = fs.readFileSync(path.join(ROOT, 'lib', 'delegation', 'engine.js'), 'utf8');
  const CONTRACT_SOURCES = [
    ['lib/agents/prompt.js', contract],
    ['lib/delegation/engine.js delegationContext', engineSrc]
  ];

  test('no contract copy still claims there are only two markers', () => {
    for (const [where, src] of CONTRACT_SOURCES) {
      assert.ok(!/one of two markers/.test(src),
        `${where} still tells an agent there are two markers; a copy that was `
        + 'not updated is worse than no copy, because it is the one nearest the brief');
    }
  });

  test('every contract that names the handoff markers names all three', () => {
    for (const [where, src] of CONTRACT_SOURCES) {
      // Only check sources that actually teach the handoff contract.
      if (!src.includes('RUNDOCK:COMPLETE') || !src.includes('RUNDOCK:RETURN')) continue;
      assert.ok(src.includes(MARKER_TEXT.continue),
        `${where} names RETURN and COMPLETE but not CONTINUE`);
    }
  });

  test('and every branch of the engine contract does, not just the file', () => {
    // WHOLE-FILE WAS NOT ENOUGH. engine.js builds four different contracts and
    // picks one by delegate type. The earlier version of this test read the
    // file as a single string, so one updated branch satisfied it while two
    // others still taught two markers: a Codex-runtime lead is structurally
    // the reported incident on a different runtime, and its contract was one
    // of the two. A whole-file check on a file with four variants proves
    // nothing about the variant an agent is actually handed.
    //
    // The rule per branch: a contract that offers COMPLETE must also offer
    // CONTINUE, because that is exactly where the ambiguity lives. A branch
    // that never mentions COMPLETE has nothing to disambiguate.
    const from = engineSrc.indexOf('delegationContext = ');
    const to = engineSrc.indexOf('const systemPrompt', from);
    assert.ok(from > -1 && to > from, 'the contract assembly is still here');
    const region = engineSrc.slice(from, to);

    const branches = region.split('delegationContext = ').slice(1);
    assert.ok(branches.length >= 3, `expected several contract branches, found ${branches.length}`);

    const offenders = branches
      .map((b, i) => ({ i, b }))
      .filter(({ b }) => b.includes('RUNDOCK:COMPLETE') && !b.includes('RUNDOCK:CONTINUE'))
      .map(({ i }) => `branch ${i + 1}`);

    assert.deepStrictEqual(offenders, [],
      'these contract branches offer COMPLETE without CONTINUE, so a specialist '
      + 'handed one of them has no way to say "my part is done and the request '
      + 'is not" and will emit COMPLETE, which silences the orchestrator. That '
      + 'is the reported defect, reachable for that delegate type.');
  });

  test('every marker the server recognises is named in the contract', () => {
    for (const [mode, marker] of Object.entries(MARKER_TEXT)) {
      assert.ok(contract.includes(marker),
        `${mode} is recognised by the server but never told to a specialist`);
    }
  });

  test('every marker named in the contract is recognised by the server', () => {
    // The binding that matters most: a marker written into the contract that
    // the resolver does not match would be emitted by agents and silently
    // ignored, which is indistinguishable from the agent forgetting to emit it.
    const named = contract.match(/<!-- RUNDOCK:(RETURN|COMPLETE|CONTINUE) -->/g) || [];
    assert.ok(named.length >= 3, 'the contract should name all three');
    for (const marker of new Set(named)) {
      assert.notStrictEqual(resolveMarkers(`text ${marker}`).mode, null,
        `${marker} is in the contract but the resolver ignores it`);
    }
  });

  test('the contract tells a specialist how to choose between them', () => {
    assert.match(contract, /if you find yourself writing/i,
      'the rule must be applicable without guessing, since the observed failure '
      + 'was a specialist picking COMPLETE while asking for onward work');
  });
});

describe('precedence, when an agent emits more than one', () => {
  test('continue beats complete', () => {
    assert.strictEqual(
      resolveMarkers('<!-- RUNDOCK:COMPLETE --> <!-- RUNDOCK:CONTINUE -->').mode,
      'continue',
      'the two failure directions are not symmetric: reading a real CONTINUE as '
      + 'COMPLETE strands the request in silence, while the reverse costs one turn'
    );
  });

  test('continue beats return', () => {
    assert.strictEqual(
      resolveMarkers('<!-- RUNDOCK:RETURN --> <!-- RUNDOCK:CONTINUE -->').mode,
      'continue', 'the work was done, so it is not an out-of-scope return');
  });

  test('complete still beats return, as before', () => {
    assert.strictEqual(
      resolveMarkers('<!-- RUNDOCK:RETURN --> <!-- RUNDOCK:COMPLETE -->').mode,
      'complete');
  });
});

describe('every marker consumer goes through one door', () => {
  // THE GUARD, and the reason this change needed one. A marker was added to
  // the resolver and two consumers kept working while silently ignoring it,
  // because they destructured the raw booleans and rebuilt precedence by hand
  // instead of reading the mode the resolver had already computed. Both then
  // reproduced the original defect: a specialist saying "my part is done,
  // something must happen next" produced no action, in one case, and was told
  // to the orchestrator as "they could not do this" in the other.
  //
  // Adding a marker must not require remembering where all the consumers are.
  // This finds them.
  const fs = require('node:fs');
  const SOURCES = ['lib/delegation/engine.js', 'server.js'];

  // A consumer may read the raw booleans only if it is listed here with a
  // reason a reader can check. The list is the point: it is short, and adding
  // to it is a decision rather than an oversight.
  const BOOLEAN_READERS = [
    { file: 'lib/delegation/engine.js', because:
      'the delegate result site needs hasCrudMarker, which is not a handoff mode: '
      + 'a platform delegate that saved an agent has done its work and returns '
      + 'without a handoff marker. It reads markers.mode for the handoff decision.' }
  ];

  test('no consumer rebuilds the handoff decision from raw booleans', () => {
    const offenders = [];
    for (const rel of SOURCES) {
      const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      for (const m of src.matchAll(/resolveMarkers\(/g)) {
        const after = src.slice(m.index, m.index + 500);
        const readsMode = /\.mode|\{\s*mode\s*\}/.test(after);
        const readsBooleans = /has(Return|Complete|Continue)/.test(after);
        if (readsBooleans && !readsMode) {
          const allowed = BOOLEAN_READERS.some((b) => b.file === rel);
          if (!allowed) {
            const line = src.slice(0, m.index).split('\n').length;
            offenders.push(`${rel}:${line}`);
          }
        }
      }
    }
    assert.deepStrictEqual(offenders, [],
      'these read the marker booleans and rebuild the handoff decision themselves, '
      + 'so the next marker added to the resolver will be silently ignored here. '
      + 'Read markers.mode, or call noteHandoffMarker, or add an entry to '
      + 'BOOLEAN_READERS saying why this one is different.');
  });

  test('the recording of a handback has exactly one implementation', () => {
    // Three sites wrote this block by hand and two of them drifted.
    const offenders = [];
    for (const rel of SOURCES) {
      const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      // `=` not `==`, so a comparison is not mistaken for an assignment.
      for (const m of src.matchAll(/\.scopeReturnMode\s*=(?!=)/g)) {
        // Clearing the record is not recording one.
        if (/scopeReturnMode\s*=\s*null/.test(src.slice(m.index, m.index + 40))) continue;
        const line = src.slice(0, m.index).split('\n').length;
        offenders.push(`${rel}:${line}`);
      }
    }
    assert.deepStrictEqual(offenders, [],
      'scopeReturnMode is assigned outside noteHandoffMarker. Every site that '
      + 'records a handback must go through the one helper, or the modes and '
      + 'their precedence drift apart again.');
  });

  test('the helper records the mode, the guard, and nothing else', () => {
    const { noteHandoffMarker } = require(path.join(ROOT, 'lib', 'delegation', 'markers.js'));
    const e = {};
    assert.strictEqual(noteHandoffMarker(e, 'done <!-- RUNDOCK:CONTINUE -->'), 'continue');
    assert.strictEqual(e.scopeReturnMode, 'continue');
    assert.strictEqual(e.scopeReturn, true);

    // A turn that is itself a delegation is not a handback.
    const d = { delegation: {} };
    assert.strictEqual(noteHandoffMarker(d, '<!-- RUNDOCK:RETURN -->'), null);
    assert.strictEqual(d.scopeReturn, undefined);

    assert.strictEqual(noteHandoffMarker({}, 'no marker at all'), null);
    assert.strictEqual(noteHandoffMarker(null, '<!-- RUNDOCK:RETURN -->'), null);
  });

  test('the mode list covers every marker the resolver can return', () => {
    const { HANDOFF_MODES, MARKER_TEXT } = require(path.join(ROOT, 'lib', 'delegation', 'markers.js'));
    assert.deepStrictEqual([...HANDOFF_MODES].sort(), Object.keys(MARKER_TEXT).sort(),
      'a mode the resolver can return but the list omits is invisible to anything '
      + 'that enumerates them, which is how the telemetry stopped counting handoffs');
  });
});

describe('every path that returns control to a parent consults the marker', () => {
  // THE SECOND AXIS, and the one that kept being missed. The guard above
  // enumerates the sites that READ a marker. This enumerates the branches that
  // ACT on one, which is a different list, and three separate reviews found a
  // different member of it each time:
  //
  //   handleScopeReturn ................ fixed round 1
  //   skip-level to a live orchestrator  fixed round 2
  //   mid-level parent restart ......... fixed round 2
  //   non-intercepted parent restore ... fixed round 3
  //   spawn-error restore .............. correctly marker-free, the delegate
  //                                      never ran, so there is no marker
  //
  // Enumerated here so the sixth is found by this test rather than by an
  // incident. Anchored on the announcement each branch sends, because that is
  // the one thing every restoration does.
  const fs = require('node:fs');

  const RESTORATIONS = [
    { file: 'lib/delegation/engine.js', toAgent: 'orchestrator.id',
      what: 'handleScopeReturn: the orchestrator after a specialist hands back' },
    { file: 'lib/delegation/engine.js', toAgent: 'orchestratorAgentId',
      what: 'skip-level: a live orchestrator when the mid-level parent is skipped' },
    { file: 'lib/delegation/engine.js', toAgent: 'parentAgentId',
      what: 'a mid-level parent resumed after its sub-delegate returns' },
    { file: 'lib/delegation/engine.js', toAgent: 'delegateEntry.delegation.originalAgentId',
      what: 'a parked parent restored after a non-intercepted delegation' },
    { file: 'server.js', toAgent: 'parent.agentId', markerFree: true,
      what: 'spawn failure: the delegate never ran, so no marker exists to read' }
  ];

  test('the list of restoration branches is complete', () => {
    const found = [];
    for (const rel of ['lib/delegation/engine.js', 'server.js']) {
      const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      const lines = src.split('\n');
      lines.forEach((line, i) => {
        if (!line.includes("subtype: 'agent_switch'")) return;
        const window = lines.slice(i, i + 4).join('\n');
        const m = window.match(/toAgent: ([A-Za-z_][\w.]*)/);
        if (!m) return;
        // A delegation START announces the same way; it is not a restoration.
        if (m[1] === 'targetAgent.id') return;
        found.push(`${rel}|${m[1]}`);
      });
    }
    const expected = RESTORATIONS.map((r) => `${r.file}|${r.toAgent}`);
    assert.deepStrictEqual(found.sort(), expected.sort(),
      'a path that returns control to a parent was added or removed. Every such '
      + 'branch must decide what to do from the marker the specialist emitted, '
      + 'or a specialist saying "my part is done, something must happen next" is '
      + 'silently parked. Add it here with what it does and how it reads the marker.');
  });

  test('each marker-reading restoration actually reads one', () => {
    const engine = fs.readFileSync(path.join(ROOT, 'lib', 'delegation', 'engine.js'), 'utf8');
    // Each branch must consult the specialist's declaration somewhere: either
    // the resolved mode, or the flags derived from it in that scope.
    const READS = /returnMarkerSeen|scopeReturnMode|handbackMode|\bmode\b|isContinue|parentMustAct|parentShouldAct/;
    for (const r of RESTORATIONS.filter((x) => !x.markerFree && x.file.endsWith('engine.js'))) {
      const at = engine.indexOf(`toAgent: ${r.toAgent}`);
      assert.ok(at > -1, `${r.what}: the branch is still here`);
      const region = engine.slice(Math.max(0, at - 2500), at + 2500);
      assert.match(region, READS, `${r.what}: decides without reading the marker`);
    }
  });
});

describe('a handoff marker never survives into text a person or an agent reads', () => {
  // THE THIRD AXIS. The first guard enumerates the sites that READ a marker,
  // the second the branches that ACT on one. Neither covers the functions that
  // REMOVE the marker text, and a marker left in place reaches two places it
  // must not: the handback payload an orchestrator is handed as the
  // specialist's "final message", and the preview line a person reads in the
  // conversation list.
  //
  // The client stripper was already missing COMPLETE before CONTINUE existed,
  // which is the tell: a hand-written list of literals drifts from the list
  // the resolver recognises, and nothing notices until someone reads a
  // rendered marker.
  const fs = require('node:fs');
  const { MARKER_TEXT } = require(path.join(ROOT, 'lib', 'delegation', 'markers.js'));

  // THREE STRIPPERS, NOT TWO. The delta renderer strips markers too, and it
  // was added in the same change that consolidated the other two: a fourth
  // independent copy of the marker names, in a file that cannot import the
  // resolver without lib/store depending on lib/delegation. Registered here
  // rather than left to drift, because "we consolidated the marker handling"
  // and "every place that handles markers is consolidated" are different
  // claims and only the second is worth anything.
  const STRIPPERS = [
    { file: 'server.js', fn: 'stripRundockMarkers',
      where: 'sanitises specialist output before it enters an orchestrator prompt' },
    { file: 'public/markers.js', fn: 'stripMarkers',
      where: 'the client mirror, used for rendered text and conversation previews' },
    { file: 'lib/store/transcripts.js', fn: 'renderDeltaEntryBody',
      where: "the catch-up delta, so one agent never reads another's control markers",
      // Driven rather than read. This one strips via a constant the function
      // references, so a source check on the function body would miss it, and
      // widening the window until it matched would be tuning the test to the
      // implementation. Running it proves the thing the guard is for.
      probe: () => {
        const { deltaSince } = require(path.join(ROOT, 'lib', 'store', 'transcripts.js'));
        const out = deltaSince([
          { agent: 'vox', text: 'mine' },
          { agent: 'ren', text: `done ${MARKER_TEXT.continue} ${MARKER_TEXT.complete} ${MARKER_TEXT.return}` }
        ], 'vox');
        return out.text || '';
      } }
  ];

  for (const { file, fn, where, probe } of STRIPPERS) {
    test(`${fn} removes every handoff marker (${where})`, () => {
      if (probe) {
        const out = probe();
        for (const [mode, marker] of Object.entries(MARKER_TEXT)) {
          assert.ok(!out.includes(marker),
            `${file}: ${fn} left ${mode}'s marker in the text an agent reads`);
        }
        assert.match(out, /done/, 'while what was actually said survives');
        return;
      }
      const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
      const at = src.indexOf(`function ${fn}`);
      assert.ok(at > -1, `${file}: ${fn} is still here`);
      // To the end of the function body, which both write as a return chain.
      const body = src.slice(at, src.indexOf('\n  }', at) > -1
        ? Math.min(src.indexOf('\n  }', at), src.indexOf('\n}', at) === -1 ? Infinity : src.indexOf('\n}', at))
        : src.indexOf('\n}', at));
      for (const [mode, marker] of Object.entries(MARKER_TEXT)) {
        assert.ok(body.includes(`RUNDOCK:${mode.toUpperCase()}`),
          `${file}: ${fn} does not strip ${marker}, so it will be rendered to a `
          + 'person or sent to an agent as part of what the specialist said');
      }
    });
  }

  test('the server stripper actually removes them, not just mentions them', () => {
    // The assertions above read source, because these two functions live in
    // different module systems. This one runs the real thing, so a regex that
    // matches nothing is caught rather than counted.
    const { _internal } = require(path.join(ROOT, 'server.js'));
    const strip = _internal && _internal.stripRundockMarkers;
    if (typeof strip !== 'function') return; // not exported in this build
    for (const marker of Object.values(MARKER_TEXT)) {
      const out = strip(`done here ${marker}`);
      assert.ok(!out.includes(marker), `${marker} survived stripping`);
      assert.match(out, /done here/, 'and the real text is kept');
    }
  });
});

describe('an agent is told which agents it may call', () => {
  // WHY THE BLOCK KEPT FIRING. The server refuses a delegation to an agent
  // that is not the caller's direct report, kills the turn, and resumes the
  // caller with a correction. That guard works. What made it fire was a gap
  // in the contract: the orchestrator is told "only delegate to agents listed
  // in YOUR TEAM below", and a lead with its own support team was told no such
  // thing. It sees other agents' names in the conversation, has work that
  // suits one of them, and nothing tells it they are out of reach.
  //
  // Observed: a research lead calling a content writer, blocked, the turn
  // spent, the user shown an error about direct reports they cannot act on.
  const fs = require('node:fs');
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'agents', 'prompt.js'), 'utf8');

  function branch(fromMarker, toMarker) {
    const at = src.indexOf(fromMarker);
    assert.ok(at > -1, `${fromMarker} is still here`);
    const end = src.indexOf(toMarker, at);
    assert.ok(end > at, `${toMarker} still follows it`);
    return src.slice(at, end);
  }

  test('a lead is told its support team is the whole list', () => {
    const lead = branch('You have a support team.', "'YOUR SUPPORT TEAM:',");
    assert.match(lead, /Only delegate to the team members listed/,
      'without this the guard is the only thing standing between a lead and a '
      + 'call it cannot make, and the guard costs a whole turn to say no');
  });

  test('and told what to do instead, not only what it cannot do', () => {
    const lead = branch('You have a support team.', "'YOUR SUPPORT TEAM:',");
    assert.match(lead, /hand back so their leader can route it/,
      'a rule that only forbids invites a workaround; this names the mechanism '
      + 'that actually reaches the other agent');
  });

  test('the orchestrator keeps the equivalent rule it always had', () => {
    assert.match(src, /Only delegate to agents listed in YOUR TEAM below/,
      'the rule that was present for one role and missing for the other');
  });
});

describe('an agent says why it arrived, or does not appear to', () => {
  // TWO DEFECTS FROM TESTING THE 0.13.3 CUT, sharing a cause: an agent's
  // appearance in a conversation carried no information about why it was there.
  const fs = require('node:fs');
  const promptSrc = fs.readFileSync(path.join(ROOT, 'lib', 'agents', 'prompt.js'), 'utf8');
  const engineSrc = fs.readFileSync(path.join(ROOT, 'lib', 'delegation', 'engine.js'), 'utf8');

  function leadContract() {
    const at = promptSrc.indexOf('You have a support team.');
    const end = promptSrc.indexOf("'YOUR SUPPORT TEAM:',", at);
    assert.ok(at > -1 && end > at, 'the lead contract is still here');
    return promptSrc.slice(at, end);
  }

  test('a lead is told to announce a handoff, not merely allowed to', () => {
    // It said a one-sentence handoff "is fine", and the next rule said "Do NOT
    // narrate the delegation brief in visible chat". Permission followed by an
    // emphatic prohibition reads as: stay quiet. Observed: a lead delegated to
    // a fact checker with no visible turn at all.
    const lead = leadContract();
    assert.match(lead, /It is not optional/,
      'permission is not instruction, and the rule beside it forbids speaking');
  });

  test('and told what the line carries', () => {
    assert.match(leadContract(), /who you are handing to and why/,
      'a rule that says "say something" without saying what invites silence or '
      + 'the narration the next rule forbids');
  });

  test('while the prohibition on narrating the brief still stands', () => {
    const lead = leadContract();
    assert.match(lead, /Do NOT narrate the delegation brief/);
    assert.match(lead, /who and why belongs in the chat/,
      'the two rules must be distinguishable, or following one breaks the other');
  });

  test('the orchestrator keeps the instruction it already had', () => {
    assert.match(promptSrc, /A brief one-sentence handoff is fine/,
      'the orchestrator narrates because routing is its job');
  });

  test('an arrival that will produce nothing is drawn as nothing, but the switch is still sent', () => {
    // On a COMPLETE handback the orchestrator is spawned only to park, so the
    // conversation showed it joining and then doing nothing: indistinguishable
    // from a hang, and reported as one.
    //
    // The first fix withheld the switch entirely, on the reasoning that it was
    // only an announcement. It is not: reduceAgentSwitch sets activeAgentId,
    // clears delegationActive and emits clear-outgoing-working, so withholding
    // it left the conversation marked delegated with the DEPARTED specialist
    // still showing as working. The integration suite caught it
    // (delegation-handback-record: a sub-delegate returning to its lead) and
    // this suite did not, because it asserted the shape of the code rather than
    // what a person would see.
    //
    // So the message always goes and the drawing is what is suppressed. The
    // behaviour is proven in test/unit/conversation-state.test.js ('a silent
    // agent_switch draws no divider but still clears the outgoing agent and
    // moves control'); this only pins that the engine still sends it.
    const at = engineSrc.indexOf('NO ARRIVAL DRAWN FOR AN AGENT THAT WILL SAY NOTHING');
    assert.ok(at > -1, 'the reasoning is recorded where the decision is made');
    const region = engineSrc.slice(at, at + 1400);
    assert.doesNotMatch(region, /if \(!wasPipelineComplete\) \{[\s\S]{0,300}subtype: 'agent_switch'/,
      'the switch is NOT gated on the handback mode: withholding it is what broke the indicator');
    assert.match(region, /subtype: 'agent_switch'[\s\S]{0,400}wasPipelineComplete \? \{ silent: true \}/,
      'it is sent either way, carrying the flag that suppresses only the drawing');
  });

  test('and the process is still announced either way', () => {
    // A RETURN or CONTINUE handback drives the orchestrator to act, so the
    // person should see who picked it up.
    const at = engineSrc.indexOf('NO ARRIVAL DRAWN FOR AN AGENT THAT WILL SAY NOTHING');
    const region = engineSrc.slice(at, at + 1600);
    assert.match(region, /process_started/,
      'the process start is not gated on the handback mode either');
  });
});
