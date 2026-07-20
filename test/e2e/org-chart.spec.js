'use strict';
// Org chart layout: a lead with a single report must occupy the same width as
// a childless lead, so the row of leads stays evenly spaced. A lead only
// widens when it has two or more reports (to span them), exactly like the top
// row spreads its own children. Regression guard for the d3.tree separation
// setting in renderOrgChart(): without a uniform separation, a single report
// (a cousin of the other leads' slots) doubles a gap and the row goes lopsided.
const { test, expect } = require('@playwright/test');

// A controlled roster injected straight into the client, independent of the
// shared workspace fixture: four leads under one orchestrator, with two
// ADJACENT leads (Two and Three) each carrying a single report. Their reports
// are adjacent cousins, which the default d3 separation spaces at 2x, doubling
// the Two<->Three gap. This mirrors the real roster (Cleo and Dev each with one
// report) that surfaced the lopsided layout.
const ROSTER = [
  { id: 'boss', name: 'boss', displayName: 'Boss',    role: 'Lead', type: 'orchestrator', order: 0, status: 'onTeam', colour: '#E87A5A', icon: 'B' },
  { id: 'l1',   name: 'l1',   displayName: 'One',     role: 'Spec', type: 'specialist',   order: 1, reportsTo: 'boss', status: 'onTeam', colour: '#6B9EF0', icon: '1' },
  { id: 'l2',   name: 'l2',   displayName: 'Two',     role: 'Spec', type: 'specialist',   order: 2, reportsTo: 'boss', status: 'onTeam', colour: '#6BC67E', icon: '2' },
  { id: 'l3',   name: 'l3',   displayName: 'Three',   role: 'Spec', type: 'specialist',   order: 3, reportsTo: 'boss', status: 'onTeam', colour: '#E8A84C', icon: '3' },
  { id: 'l4',   name: 'l4',   displayName: 'Four',    role: 'Spec', type: 'specialist',   order: 4, reportsTo: 'boss', status: 'onTeam', colour: '#A07AE8', icon: '4' },
  { id: 'r2',   name: 'r2',   displayName: 'ReportA', role: 'Sub',  type: 'specialist',   order: 5, reportsTo: 'l2',   status: 'onTeam', colour: '#5BCFC4', icon: 'A' },
  { id: 'r3',   name: 'r3',   displayName: 'ReportB', role: 'Sub',  type: 'specialist',   order: 6, reportsTo: 'l3',   status: 'onTeam', colour: '#7AB8E8', icon: 'B' },
];

test('a single-report lead does not widen the org row', async ({ page }) => {
  await page.goto('/');
  await page.waitForSelector('.nav-item[data-nav="team"]', { state: 'visible' });

  await page.evaluate((roster) => {
    // eslint-disable-next-line no-global-assign
    agents = roster;
    switchNav('team');
    renderOrgChart();
  }, ROSTER);
  await page.waitForSelector('.org-card');

  // Horizontal centre of each card, keyed by its displayed name.
  const centres = await page.$$eval('.org-card', (cards) => {
    const out = {};
    for (const c of cards) {
      const name = c.querySelector('.org-card-name')?.textContent?.trim();
      const b = c.getBoundingClientRect();
      if (name) out[name] = b.left + b.width / 2;
    }
    return out;
  });

  const leads = ['One', 'Two', 'Three', 'Four'].map((n) => centres[n]);
  expect(leads.every((x) => typeof x === 'number')).toBe(true);

  // Even spacing: consecutive gaps differ by at most a couple of rounding
  // pixels. With the default (non-uniform) separation, the single-report lead
  // doubles a gap and this deviation blows past the tolerance.
  const gaps = [leads[1] - leads[0], leads[2] - leads[1], leads[3] - leads[2]];
  expect(Math.max(...gaps) - Math.min(...gaps)).toBeLessThan(4);

  // Each single-report lead sits centred over its report: no lopsided width.
  expect(Math.abs(centres['Two'] - centres['ReportA'])).toBeLessThan(4);
  expect(Math.abs(centres['Three'] - centres['ReportB'])).toBeLessThan(4);
});
