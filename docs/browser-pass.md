# The browser pass

**A change to anything a person can see is not done until the machine has driven it in a browser.** Sent the prompts a user would send, read what came back, and looked at the screen. The owner's testing confirms rather than discovers.

## Why this exists

Measured across 0.13.3: twelve defects. Four were found by the suite or a gate. **Eight were found by one person noticing that something on screen looked odd.** Twice as much test code as product code shipped in that release, a suite of 4,333 tests, ten gate runs and twelve CI runs, and the majority of real defects were still found by eye.

Browser tooling was available the entire time and was used once, for a CSS measurement, which immediately found a real defect. A four-minute browser pass over the already-shipped release found two more.

Each missed defect became a field report, an investigation, a fix, a gate cycle and a re-test. Looking first collapses that whole chain.

## What the e2e suite does not cover, and cannot

`test/e2e/serve.js` seeds a disposable workspace, points `HOME` at a fake home, and puts a **stub runtime** first on `PATH` so no real agent is ever spawned. That is correct for a hermetic suite and it is why the e2e specs are fast and deterministic.

It also means the e2e suite structurally cannot see:

- permission cards, their wording, their buttons, or which folder they offer
- what an agent says about the product, including claims about what the product will and will not do
- anything that depends on a real workspace, a real home directory, or real credentials
- anything about the first screen a person sees before they open a workspace

Every one of those categories produced defects in 0.13.3. Adding e2e specs would not have caught them. The gap is a live pass, not more fixtures.

## Running one

```bash
npm run look                 # serves this branch on the first free port, prints the URL
```

Nothing gates this and nothing needs to. Run the gate and CI alongside, not in front:

```bash
npm run precommit:detached
```

Then drive the real interface at that URL. Not the classifier, not the HTTP payload, not a unit test standing in for the screen: **the surface whose wording the claim names.** A proxy one layer in is the failure mode this project has paid for five times in one release.

## What to cover

Derived from where defects actually came from, not from a guess. The defect ledger records a surface for each one, so this list is maintained from evidence.

1. **The change itself**, driven as a user would drive it, including the path that is awkward rather than the one that is convenient.
2. **The first screen**, before opening anything. Two escapes lived here: a recent-workspaces list with eight of ten slots filled by test fixtures, and a caption describing a list it no longer matched.
3. **Permission cards**, if the change touches the permission layer at all. Read the card's full text, every button, and the folder any standing grant would name. Approve one and check what it actually granted.
4. **What the agent says about the product.** Ask it to do the thing the change is about and read the reply. Four defects in 0.13.3 were the product stating something untrue about itself, and an agent will repeat that to a user with the product's authority.
5. **The shipped artefact**, for anything release-shaped. Every check was green while the tag pointed two days behind main, because no check was looking at the artefact.

## Recording what it finds

Every defect gets a row when it is found, whether the machine or a person found it:

```bash
python3 System/Automations/sdlc-metrics.py defect \
  --title "..." --found-by machine --surface browser --release 0.14.0
python3 System/Automations/sdlc-metrics.py verified --id dN
```

`found_by owner` or `found_by user` means it escaped. That number is the point. A pass that finds nothing and records nothing is indistinguishable from a pass nobody ran, and the escape rate is what tells the two apart over a release rather than on the day.

**Baseline to beat, from 0.13.3:** escape rate 0.57, median report-to-verifiable-fix 16.5 minutes.
