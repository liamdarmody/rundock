// Motion layer: records the scripted interactions in CLIPS with Playwright video,
// then converts each to a web-optimized, palette-optimized, infinitely looping
// GIF with ffmpeg (palettegen/paletteuse). Clips are short (roughly 4-8s),
// silent, and loopable.
//
// ffmpeg is resolved in priority order: FFMPEG_PATH env, a system ffmpeg on
// PATH, then the ffmpeg-static dev dependency. The first that works wins, so CI
// can use a system binary while a local run falls back to ffmpeg-static.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import {
  newContext, gotoWorkspace, openFile,
  seedWorking, seedLastActive, fitOrgChart, installCursor, cursorTo, cursorKind,
  ORG_WORKING, ORG_LAST_ACTIVE,
} from './harness.mjs';
import {
  DEMO_IDS, ARTIFACT_REVIEW_REL, artifactSidecarContent, sidecarNameFor,
  MARKDOWN_REVIEW_NOTE_REL, markdownReviewNoteContent, ROSTER, agentFile,
} from './generate-workspace.mjs';

// The one agent assigned the 'meeting-notes' skill (see generate-workspace
// .mjs's AGENT_SKILLS), which is why clipRoutineEditor's ".re-row:has-text
// ('Meeting Notes')" click resolves to exactly one row and saves the new
// routine into this agent's file rather than asking which agent first.
const ROUTINE_EDITOR_AGENT_ID = 'rea';

const require = createRequire(import.meta.url);

// --- ffmpeg resolution -----------------------------------------------------
let _ffmpeg;
export function resolveFfmpeg() {
  if (_ffmpeg) return _ffmpeg;
  const candidates = [];
  if (process.env.FFMPEG_PATH) candidates.push(process.env.FFMPEG_PATH);
  candidates.push('ffmpeg'); // system PATH
  try { candidates.push(require('ffmpeg-static')); } catch { /* not installed */ }
  for (const c of candidates) {
    if (!c) continue;
    try { execFileSync(c, ['-version'], { stdio: 'ignore' }); _ffmpeg = c; return c; }
    catch { /* try next */ }
  }
  throw new Error('No usable ffmpeg found (set FFMPEG_PATH, install ffmpeg, or `npm install`).');
}

export function ffmpegAvailable() {
  try { resolveFfmpeg(); return true; } catch { return false; }
}

// Two-pass palette conversion: webm -> optimized looping GIF. `ss` trims the
// pre-roll (navigation and settling) so the GIF opens on the feature itself.
export function gifFromWebm(webmPath, gifPath, { fps = 15, width = 1280, ss = 0 } = {}) {
  const ffmpeg = resolveFfmpeg();
  const palette = path.join(os.tmpdir(), `pal-${path.basename(gifPath, '.gif')}-${width}.png`);
  const filters = `fps=${fps},scale=${width}:-1:flags=lanczos`;
  const seek = ss > 0.05 ? ['-ss', ss.toFixed(2)] : [];
  execFileSync(ffmpeg, ['-y', ...seek, '-i', webmPath, '-vf', `${filters},palettegen=stats_mode=diff`, palette], { stdio: 'ignore' });
  execFileSync(ffmpeg, ['-y', ...seek, '-i', webmPath, '-i', palette,
    '-lavfi', `${filters} [x]; [x][1:v] paletteuse=dither=bayer:bayer_scale=3`,
    '-loop', '0', gifPath], { stdio: 'ignore' });
  try { fs.unlinkSync(palette); } catch { /* ignore */ }
  return gifPath;
}

// --- Clip scripts ----------------------------------------------------------
// Each clip drives one scripted interaction. Kept short and loopable.

async function clipKanbanDrag(page, { mark }) {
  await openFile(page, 'Backlog.md');
  await page.waitForSelector('.board-card', { timeout: 10000 });
  await installCursor(page);
  await page.waitForTimeout(500);
  // Bring the cursor onto the first Backlog card before the drag begins.
  const start = await page.evaluate(() => {
    const r = document.querySelector('.board-lane .board-card').getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  // hand1 (open grab hand) for the whole board interaction: hover, lift, drag,
  // and drop. It never switches while the pointer is over the board.
  await cursorKind(page, 'hand1');
  await cursorTo(page, start.x, start.y, 450);
  await page.waitForTimeout(500);
  mark();
  // Animate a lifted clone (and the cursor) gliding from the first Backlog card
  // to the In Progress lane, then dispatch the real HTML5 drag-and-drop so the
  // board model actually moves the card and re-renders it in the target lane.
  const dest = await page.evaluate(() => {
    const card = document.querySelector('.board-lane .board-card');
    const lanes = document.querySelectorAll('.board-lane-body');
    const target = lanes[1] || lanes[0];
    const cr = card.getBoundingClientRect();
    const tr = target.getBoundingClientRect();
    const clone = card.cloneNode(true);
    Object.assign(clone.style, {
      position: 'fixed', left: cr.left + 'px', top: cr.top + 'px', width: cr.width + 'px',
      margin: '0', zIndex: '9999', pointerEvents: 'none', transition: 'transform 0.9s cubic-bezier(.2,.7,.3,1)',
      boxShadow: '0 18px 40px rgba(0,0,0,0.28)', transform: 'scale(1.03)',
    });
    document.body.appendChild(clone);
    card.style.opacity = '0.35';
    const dx = (tr.left + 24) - cr.left;
    const dy = (tr.top + 16) - cr.top;
    requestAnimationFrame(() => { clone.style.transform = `translate(${dx}px, ${dy}px) scale(1.03)`; });
    window.__dragClone = clone; window.__dragCard = card; window.__dragTarget = target;
    return { x: tr.left + 60, y: tr.top + 34 };
  });
  await cursorTo(page, dest.x, dest.y, 900);
  await page.waitForTimeout(1000);
  await page.evaluate(() => {
    const card = window.__dragCard, target = window.__dragTarget;
    const dt = new DataTransfer();
    const fire = (el, type, cx, cy) => el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt, clientX: cx, clientY: cy }));
    const cr = card.getBoundingClientRect(), tr = target.getBoundingClientRect();
    fire(card, 'dragstart', cr.left + cr.width / 2, cr.top + cr.height / 2);
    fire(target, 'dragenter', tr.left + tr.width / 2, tr.top + 20);
    fire(target, 'dragover', tr.left + tr.width / 2, tr.top + 20);
    fire(target, 'drop', tr.left + tr.width / 2, tr.top + 20);
    fire(card, 'dragend', tr.left + tr.width / 2, tr.top + 20);
    if (window.__dragClone) window.__dragClone.remove();
  });
  // hand1 stays: the pointer never leaves the board, so the cursor does not
  // switch back on drop.
  await page.waitForTimeout(1100);
}

async function clipArtifactComment(page, { mark }) {
  await openFile(page, 'Artifacts/Launch Page.html');
  await page.waitForTimeout(1600);
  await installCursor(page);
  // Move the cursor onto the lead line before selecting it.
  const at = await page.evaluate(() => {
    const frame = document.querySelector('iframe.viewer-frame');
    if (!frame) return null;
    const fr = frame.getBoundingClientRect();
    const doc = frame.contentDocument;
    const el = [...doc.querySelectorAll('p.lead, p, h1')].find((n) => /sits beside the agent/i.test(n.textContent));
    if (!el) return null;
    const er = el.getBoundingClientRect();
    return { x: fr.left + er.left + er.width / 2, y: fr.top + er.top + er.height / 2 };
  });
  // I-beam over the text you are about to select.
  await cursorKind(page, 'text');
  if (at) { await cursorTo(page, at.x, at.y, 500); await page.waitForTimeout(450); }
  mark();
  // Select the lead line inside the sandboxed preview and raise the Comment
  // affordance, exactly as a user selecting text would.
  await page.evaluate(() => {
    const frame = document.querySelector('iframe.viewer-frame');
    if (!frame) return;
    const doc = frame.contentDocument;
    const el = [...doc.querySelectorAll('p.lead, p, h1')].find((n) => /sits beside the agent/i.test(n.textContent));
    if (!el) return;
    const range = doc.createRange();
    range.selectNodeContents(el);
    const sel = frame.contentWindow.getSelection();
    sel.removeAllRanges(); sel.addRange(range);
    doc.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
  await page.waitForTimeout(800);
  // Click the Comment button if it surfaced.
  const btn = await page.$('.artifact-comment-btn.visible, .artifact-comment-btn');
  if (btn) {
    const bb = await btn.boundingBox();
    if (bb) {
      // hand2 (pointing hand) to hover and click the Comment button.
      await cursorKind(page, 'hand2');
      await cursorTo(page, bb.x + bb.width / 2, bb.y + bb.height / 2, 400); await page.waitForTimeout(320);
    }
    await btn.click().catch(() => {}); await page.waitForTimeout(700);
  }
  // Type into the comment composer if it opened.
  const composer = await page.$('.review-comment-input, textarea.review-input, .review-sidebar textarea');
  if (composer) {
    // I-beam over the comment box as you type into it.
    const cb = await composer.boundingBox();
    if (cb) { await cursorKind(page, 'text'); await cursorTo(page, cb.x + Math.min(60, cb.width / 2), cb.y + cb.height / 2, 380); await page.waitForTimeout(250); }
    await composer.type('Agreed, let us pull this line up.', { delay: 35 }); await page.waitForTimeout(700);
  }
  await page.waitForTimeout(700);
}

// The markdown counterpart to clipArtifactComment above: select a passage,
// leave a comment, and an agent's suggestion sits right there in the sidebar
// to accept. Real interactions throughout (a genuine triple-click selection,
// the real floating toolbar, the real composer, the real Accept button), not
// scripted state.
//
// The comment and the accept are both live, so, same as the artifact clip,
// this clip needs its note reset before each theme run; see the `reset` hook
// on this clip's CLIPS entry.
async function clipMarkdownReview(page, { mark }) {
  await openFile(page, MARKDOWN_REVIEW_NOTE_REL);
  await page.waitForSelector('.ProseMirror h1', { timeout: 10000 });
  await installCursor(page);
  await page.waitForTimeout(500);

  // Locate the passage to comment on.
  const at = await page.evaluate(() => {
    const p = [...document.querySelectorAll('.ProseMirror p')]
      .find((n) => /earn the scroll/i.test(n.textContent));
    if (!p) return null;
    const r = p.getBoundingClientRect();
    return { x: r.left + Math.min(50, r.width / 3), y: r.top + r.height / 2 };
  });
  await cursorKind(page, 'text');
  if (at) { await cursorTo(page, at.x, at.y, 500); await page.waitForTimeout(450); }
  mark();

  // Triple-click selects the whole paragraph: a real native selection, so the
  // editor's own selectionchange handling (not a scripted Range) drives the
  // floating toolbar exactly as a user's selection would.
  if (at) await page.mouse.click(at.x, at.y, { clickCount: 3 });
  const toolbar = await page.waitForSelector('#tiptap-toolbar.visible', { timeout: 3000 }).catch(() => null);
  await page.waitForTimeout(500);

  // Comment button on the floating toolbar.
  const commentBtn = toolbar ? await page.$('#tiptap-toolbar .tb-comment') : null;
  if (commentBtn) {
    const bb = await commentBtn.boundingBox();
    if (bb) {
      await cursorKind(page, 'hand2');
      await cursorTo(page, bb.x + bb.width / 2, bb.y + bb.height / 2, 400);
      await page.waitForTimeout(320);
    }
    await commentBtn.click().catch(() => {});
  }
  await page.waitForTimeout(600);

  // Type the comment into the composer.
  const composer = await page.$('.review-composer textarea');
  if (composer) {
    const cb = await composer.boundingBox();
    if (cb) {
      await cursorKind(page, 'text');
      await cursorTo(page, cb.x + Math.min(60, cb.width / 2), cb.y + cb.height / 2, 380);
      await page.waitForTimeout(280);
    }
    await composer.type('Can we open with a stronger claim?', { delay: 35 });
    await page.waitForTimeout(500);
    const sendBtn = await page.$('.review-composer .review-send');
    if (sendBtn) { await cursorKind(page, 'hand2'); await sendBtn.click().catch(() => {}); }
  }
  await page.waitForTimeout(900);

  // The agent's suggestion card is already in the sidebar (pre-authored, as
  // an agent's authoring direction always is for markdown: see
  // markdownReviewNoteContent's comment in generate-workspace.mjs). Move to
  // it and accept it.
  const acceptBtn = await page.$('.review-card.suggestion .review-btn.accept');
  if (acceptBtn) {
    const bb = await acceptBtn.boundingBox();
    if (bb) {
      await cursorKind(page, 'hand2');
      await cursorTo(page, bb.x + bb.width / 2, bb.y + bb.height / 2, 450);
      await page.waitForTimeout(350);
    }
    await acceptBtn.click().catch(() => {});
  }
  await page.waitForTimeout(1000);
}

async function clipSearch(page, { mark }) {
  await page.evaluate(() => switchNav('team'));
  await page.waitForTimeout(400);
  await installCursor(page);
  mark();
  // Drive the control a user drives. Search expands in place from the field in
  // the top bar, and this clip exists to show that behaviour, so calling the
  // function behind the control would demonstrate the wrong thing.
  const field = await page.$('#tb-search');
  const box = field && await field.boundingBox();
  if (box) {
    // cursorTo starts a CSS transition and returns immediately, so the wait
    // has to EXCEED the travel time. Waiting less clicks while the cursor is
    // still moving, and the panel then opens with the pointer nowhere near the
    // control, which is the opposite of what this clip is for.
    const TRAVEL_MS = 620;
    await cursorTo(page, box.x + Math.min(120, box.width / 2), box.y + box.height / 2, TRAVEL_MS);
    await page.waitForTimeout(TRAVEL_MS + 260);
  }
  await page.click('#tb-search');
  await page.waitForSelector('#palette-input', { state: 'visible', timeout: 8000 });
  await page.waitForTimeout(400);
  await page.type('#palette-input', 'launch', { delay: 150 });
  await page.waitForTimeout(1300);
  // Open the top result (the Launch Page file) to show how a search lands you
  // straight on the thing you were looking for.
  await page.keyboard.press('Enter');
  await page.waitForSelector('iframe.viewer-frame, .editor-surface, #editor', { timeout: 6000 }).catch(() => {});
  await page.waitForTimeout(2000);
}

// Orchestrator answers, then routes the task to a specialist who streams the
// real work. Uses the app's own effect executors (start-streaming-bubble,
// show-delegation-divider via buildDelegationDivider, render-stream-text) so
// the handoff renders exactly as a live delegation would.
async function clipStreamingHandoff(page, { mark }) {
  // Ids come from the shared DEMO_IDS source so this clip cannot drift from the
  // generated fixtures. Threaded into each evaluate rather than inlined.
  const CONVO = DEMO_IDS.convos.planWeek;
  const COS = DEMO_IDS.agents.cos;
  const CLEO = DEMO_IDS.agents.cleo;
  await page.evaluate(() => switchNav('conversations'));
  await page.evaluate((id) => openConversation(id), CONVO);
  await page.waitForTimeout(500);
  await page.evaluate(() => addUserMsg('Can you make the landing hook shorter and punchier?'));
  await page.waitForTimeout(600);
  mark();
  // 1) Orchestrator (Cos) acknowledges and routes.
  await page.evaluate(({ id, cos }) => executeEffects(id, [{ type: 'start-streaming-bubble', agentId: cos }]), { id: CONVO, cos: COS });
  let cosText = '';
  for (const c of ['That is Cleo’s wheelhouse. ', 'Handing it to her with the brief now.']) {
    cosText += c;
    await page.evaluate(({ id, t }) => executeEffects(id, [{ type: 'render-stream-text', text: t }]), { id: CONVO, t: cosText });
    await page.waitForTimeout(520);
  }
  await page.waitForTimeout(450);
  await page.evaluate(({ id, cos, t }) => executeEffects(id, [
    { type: 'promote-handoff-message', agentId: cos, text: t },
    { type: 'clear-streaming-bubble' },
  ]), { id: CONVO, cos: COS, t: cosText });
  // 2) Delegation divider Cos -> Cleo, header follows the active agent.
  await page.evaluate(({ id, cos, cleo }) => executeEffects(id, [
    { type: 'show-delegation-divider', toAgentId: cleo, fromAgentId: cos, isReturn: false },
    { type: 'update-chat-header', toAgentId: cleo },
  ]), { id: CONVO, cos: COS, cleo: CLEO });
  await page.waitForTimeout(700);
  // 3) The specialist (Cleo) streams the actual rework.
  await page.evaluate(({ id, cleo }) => executeEffects(id, [{ type: 'start-streaming-bubble', agentId: cleo }]), { id: CONVO, cleo: CLEO });
  let cleoText = '';
  for (const c of ['On it. ', 'Shorter is better here: ', 'lead with the reader, ',
    'name the outcome in six words, ', 'then let the proof carry the rest. ',
    'Drafting two options and marking my pick.']) {
    cleoText += c;
    await page.evaluate(({ id, t }) => executeEffects(id, [{ type: 'render-stream-text', text: t }]), { id: CONVO, t: cleoText });
    await page.waitForTimeout(430);
  }
  await page.waitForTimeout(1100);
}

async function clipOrgStatus(page, { mark }) {
  await page.evaluate(() => switchNav('team'));
  await page.waitForSelector('.org-card', { timeout: 10000 });
  await seedWorking(page, ORG_WORKING);
  await seedLastActive(page, ORG_LAST_ACTIVE);
  await fitOrgChart(page);
  // Settle fully on the org chart before marking. Paired with ssBuffer:0 in the
  // registry, this keeps any earlier view out of the trimmed clip, so the loop
  // never flashes the conversation view at the wrap point.
  await page.waitForTimeout(600);
  mark();
  // Let the CSS pulse (orgPulse, 2s loop) run for a couple of cycles, and end on
  // a whole number of loops so the wrap is seamless.
  await page.waitForTimeout(4000);
}

// The routine editor: Add routine -> pick a skill -> say when -> confirm,
// ending back on the routines list with the new routine showing. Real
// interactions throughout (the actual "+" control, the actual skill row, the
// actual time <select>, the actual Save button), not scripted state, so this
// demonstrates exactly the form 0.12.0 shipped rather than a mocked-up one.
//
// Meeting Notes (Rea) is picked deliberately: it has no demo routine already
// (unlike Weekly Digest, Publish Check, Daily Brief, Nightly Build Check,
// which are all seeded with run history for the `routines` still), so this
// clip visibly adds a fifth, fresh routine rather than re-creating one that
// already exists.
// Paced for reading, not just for the cursor to arrive: this is a 3-screen
// wizard (pick a skill, say when, confirm), and the first cut of this clip
// moved through all three screens too fast to actually read any of them.
// Cursor travel stays quick and natural; the dwell time AFTER each screen
// settles is what got lengthened, so a viewer has time to read "Step 1 of 2"
// before the skill list changes, and to read the sentence before it changes.
async function clipRoutineEditor(page, { mark }) {
  await page.evaluate(() => switchNav('routines'));
  await page.waitForSelector('#routines-content .routine-row', { timeout: 10000 });
  await installCursor(page);
  await page.waitForTimeout(600);

  const addBtn = await page.$('#routines-add-btn');
  const bb0 = addBtn && await addBtn.boundingBox();
  if (bb0) {
    await cursorKind(page, 'hand2');
    await cursorTo(page, bb0.x + bb0.width / 2, bb0.y + bb0.height / 2, 500);
    await page.waitForTimeout(500);
  }
  mark();
  if (addBtn) await addBtn.click();
  await page.waitForSelector('#routine-editor-content .re-row', { timeout: 8000 });
  // Let "Add routine, Step 1 of 2" and the skill list actually register.
  await page.waitForTimeout(1000);

  // Step 1: pick a skill.
  const skillRow = await page.$('#routine-editor-content .re-row:has-text("Meeting Notes")');
  if (skillRow) {
    const bb = await skillRow.boundingBox();
    if (bb) {
      await cursorKind(page, 'hand2');
      await cursorTo(page, bb.x + bb.width / 2, bb.y + bb.height / 2, 450);
      await page.waitForTimeout(400);
    }
    await skillRow.click();
  }
  // Hold on the selected (checked) row before moving to Continue.
  await page.waitForTimeout(900);
  let continueBtn = await page.$('#routine-editor-content .re-actions button:not([disabled])');
  if (continueBtn) {
    const bb = await continueBtn.boundingBox();
    if (bb) { await cursorTo(page, bb.x + bb.width / 2, bb.y + bb.height / 2, 400); await page.waitForTimeout(350); }
    await continueBtn.click();
  }

  // Step 2: say when. Frequency defaults to "day"; only the time needs
  // setting for the sentence to read as a deliberate choice, not a default
  // left untouched.
  await page.waitForSelector('#routine-editor-content select[data-routine-field="time"]', { timeout: 8000 });
  // Let "Step 2 of 2" and the default sentence ("...every day at 9:00am")
  // actually register before it changes under the reader.
  await page.waitForTimeout(1100);
  const timeSelect = await page.$('#routine-editor-content select[data-routine-field="time"]');
  if (timeSelect) {
    const bb = await timeSelect.boundingBox();
    if (bb) {
      await cursorKind(page, 'text');
      await cursorTo(page, bb.x + bb.width / 2, bb.y + bb.height / 2, 400);
      await page.waitForTimeout(350);
    }
    await timeSelect.selectOption('21:00');
  }
  // Hold on the updated sentence ("...every day at 9:00pm") so it reads as a
  // deliberate choice, not a flicker.
  await page.waitForTimeout(1300);
  continueBtn = await page.$('#routine-editor-content .re-actions button:not([disabled])');
  if (continueBtn) {
    const bb = await continueBtn.boundingBox();
    if (bb) {
      await cursorKind(page, 'hand2');
      await cursorTo(page, bb.x + bb.width / 2, bb.y + bb.height / 2, 400);
      await page.waitForTimeout(350);
    }
    await continueBtn.click();
  }

  // Step 3: confirm. Saving is a real write to the demo workspace's agent
  // file, exactly as a real save would be; the workspace is discarded after
  // capture.
  await page.waitForSelector('#routine-editor-content [data-routine-editor="save"]', { timeout: 8000 });
  // Let the confirm sentence be read before the button gets pressed.
  await page.waitForTimeout(1300);
  const saveBtn = await page.$('#routine-editor-content [data-routine-editor="save"]');
  if (saveBtn) {
    const bb = await saveBtn.boundingBox();
    if (bb) {
      await cursorKind(page, 'hand2');
      await cursorTo(page, bb.x + bb.width / 2, bb.y + bb.height / 2, 450);
      await page.waitForTimeout(400);
    }
    await saveBtn.click();
  }
  // routineEditorSaved() navigates back to the routines list on its own; the
  // new routine is what proves the save actually landed. Hold on it so the
  // new, highlighted row is legible, not just glimpsed.
  await page.waitForSelector('#routines-content .routine-row', { timeout: 10000 });
  await page.waitForTimeout(1600);
}

// Clip registry. `themes` is which themes to record (theme reads in all of
// these, but the spec only mandates parity for the org-status clip; the others
// default to both for completeness).
// `gif` overrides the default {fps:15, width:1280} for clips that would
// otherwise crowd the file-size budget (the review clip has a lot of motion:
// a selection highlight plus type-in).
// `reset(workspace)` runs before EVERY theme run of that clip, not just once
// per pipeline run. Both theme runs of a clip share one server/workspace
// (captureMotion below), and any clip whose live actions save to disk (a
// comment, an accepted suggestion, a saved routine) would otherwise have its
// dark run open a file (or read routine state) the light run already left
// mutated. See generate-workspace.mjs's ARTIFACT_REVIEW_REL and
// MARKDOWN_REVIEW_NOTE_REL comments for the fuller version of this story.
export const CLIPS = [
  { name: 'kanban-drag', feature: 'Kanban card drag between columns', run: clipKanbanDrag },
  {
    name: 'review-comment', feature: 'Adding a comment on an artifact', run: clipArtifactComment, gif: { width: 1152 },
    reset: (workspace) => fs.writeFileSync(
      path.join(workspace, '.rundock', 'reviews', sidecarNameFor(ARTIFACT_REVIEW_REL)),
      JSON.stringify(artifactSidecarContent(), null, 2),
    ),
  },
  {
    name: 'markdown-review', feature: 'Adding a comment on a markdown note, and accepting an agent\'s suggestion',
    run: clipMarkdownReview, gif: { width: 1152 },
    reset: (workspace) => fs.writeFileSync(
      path.join(workspace, MARKDOWN_REVIEW_NOTE_REL), markdownReviewNoteContent(),
    ),
  },
  { name: 'search', feature: 'Cmd+K universal search, then opening the result', run: clipSearch },
  // Streaming plus a handoff has continuous type-in over a longer clip (high
  // entropy); trim width and fps to stay inside the size budget.
  { name: 'streaming', feature: 'Orchestrator routes to a specialist, whose reply streams in', run: clipStreamingHandoff, gif: { fps: 12, width: 1080 } },
  // ssBuffer:0 keeps the pre-mark navigation frames out of the trimmed clip.
  { name: 'org-chart-status', feature: 'Org chart live status', run: clipOrgStatus, ssBuffer: 0 },
  {
    name: 'routine-editor', feature: 'Schedule a skill to a cadence, through a form',
    run: clipRoutineEditor, gif: { width: 1152 },
    // Saving is a real write to the demo workspace's agent file (see
    // clipRoutineEditor's own comment), and both theme runs share one
    // workspace: without this, the dark run would find the routine the light
    // run already saved sitting on the same file, and either save a
    // duplicate or read a workspace that no longer shows a fresh add. Rewrite
    // the one agent file this clip can touch back to its pristine, routine-
    // free content before every theme run.
    reset: (workspace) => fs.writeFileSync(
      path.join(workspace, '.claude', 'agents', `${ROUTINE_EDITOR_AGENT_ID}.md`),
      agentFile(ROSTER.find((a) => a.id === ROUTINE_EDITOR_AGENT_ID)),
    ),
  },
];

export const MOTION_THEMES = ['light', 'dark'];

// Records every clip in both themes and converts each to an optimized GIF in
// `outDir`. Returns produced assets: { name, theme, feature, file, bytes }.
export async function captureMotion({ browser, url, workspace, outDir, log = () => {} }) {
  fs.mkdirSync(outDir, { recursive: true });
  const videoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rundock-motion-'));
  const produced = [];

  for (const clip of CLIPS) {
    for (const theme of MOTION_THEMES) {
      let ctx;
      try {
        // Reset before EVERY theme run, not just once: see the CLIPS registry
        // comment above for why a clip with live, disk-writing actions needs
        // this on both its light and dark runs, not only the first.
        if (clip.reset) clip.reset(workspace);
        // Boot already in the target theme so the clip never flips mid-record.
        ctx = await newContext(browser, { motion: true, recordVideoDir: videoDir, theme });
        const page = await ctx.newPage();
        const recStart = Date.now();
        await gotoWorkspace(page, url);
        // mark() fires when the demonstrated action begins; everything before it
        // (load, navigation, settling) is trimmed so the GIF opens on the feature.
        let actionAt = null;
        const mark = () => { if (actionAt === null) actionAt = Date.now(); };
        await clip.run(page, { workspace, mark });
        const video = page.video();
        await page.close();
        const webm = await video.path();
        await ctx.close(); ctx = null;

        const buffer = clip.ssBuffer ?? 0.4;
        const ss = actionAt ? Math.max(0, (actionAt - recStart) / 1000 - buffer) : 0;
        const gif = path.join(outDir, `${clip.name}.${theme}.gif`);
        gifFromWebm(webm, gif, { fps: clip.gif?.fps ?? 15, width: clip.gif?.width ?? 1280, ss });
        const bytes = fs.statSync(gif).size;
        produced.push({ name: clip.name, theme, feature: clip.feature, file: gif, bytes });
        log(`  motion ${clip.name}.${theme} -> ${(bytes / 1e6).toFixed(2)} MB`);
      } catch (err) {
        log(`  ! clip ${clip.name}.${theme} failed: ${err.message.split('\n')[0]}`);
        if (ctx) { try { await ctx.close(); } catch { /* ignore */ } }
      }
    }
  }
  try { fs.rmSync(videoDir, { recursive: true, force: true }); } catch { /* ignore */ }
  return produced;
}
