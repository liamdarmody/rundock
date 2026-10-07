// Where each asset is meant to go, keyed by shot or clip name. This is the
// MANIFEST's source: run.mjs writes one row per produced file from it. It
// replaces placement-plan.md, which described an older release.
//
// `repo` and `path` name the destination; `file` is the name the destination
// already uses where the asset replaces one in place. A tile (`-tile`) shares
// its shot's entry.

const README = 'Rundock';
const DOCS = 'rundock-docs';
const SITE = 'Rundock Site';

export const TARGETS = {
  // The refreshed shot list (scenes.mjs, plus the IMG-15 clip in motion.mjs).
  'IMG-01-org-chart': { repo: `${README} + ${DOCS} + ${SITE}`, path: 'README hero (docs/rundock-hero-org-chart.png); docs introduction.mdx; Site hero (rundock-hero-org-chart.png)', note: 'The team chart, top-down, with live status and the layout switch.' },
  'IMG-02-org-chart-sideways': { repo: DOCS, path: 'concepts/agents.mdx, "Your team on the chart" (images/team-sideways.png)', note: 'The same team after Switch layout.' },
  'IMG-03-pins': { repo: `${README} + ${DOCS}`, path: 'README "A look inside" (docs/rundock-pins.png); docs concepts/files.mdx Pins (images/pins.png)', note: 'Four pins, the Roadmap board open. The Site Pins section uses IMG-18.' },
  'IMG-04-map': { repo: `${README} + ${DOCS} + ${SITE}`, path: 'README "A look inside" (docs/rundock-map.png); docs concepts/files.mdx Map (images/map.png); Site Map section (rundock-map.png)', note: 'Hover variant: one node and its neighbours named, the rest dimmed.' },
  'IMG-04-map-nohover': { repo: `${README} + ${DOCS} + ${SITE}`, path: 'as IMG-04-map; pick one', note: 'No-hover variant: the full recency shading.' },
  'IMG-05-connections': { repo: DOCS, path: 'concepts/files.mdx Connections (images/connections.png), the tile', note: 'Links to two notes, linked from three.' },
  'IMG-06-packages': { repo: DOCS, path: 'extending/install-a-package.mdx, "Your installed packages"', note: 'Installed packages, one with an update available.' },
  'IMG-07-install-review': { repo: DOCS, path: 'extending/what-can-i-build.mdx and install-a-package.mdx, the tile', note: 'The install review for a package with an extension.' },
  'IMG-08-extension-view': { repo: `${README} + ${DOCS}`, path: 'README "A look inside" (docs/rundock-extension-view.png); docs extending/what-can-i-build.mdx', note: 'Investment Partner\'s dashboard note. The Site uses IMG-18.' },
  'IMG-08-extension-view-portfolio': { repo: `${README} + ${DOCS}`, path: 'alternative to IMG-08-extension-view', note: 'The portfolio note drawn on its own.' },
  'IMG-09-extensions': { repo: DOCS, path: 'extending/install-a-package.mdx, "The Extensions page", the tile', note: 'One extension on, one off, and Pause all.' },
  'IMG-10-settings-permissions': { repo: `${DOCS} + ${SITE}`, path: 'docs concepts/permissions.mdx (images/settings-permissions.png) and reference/workspace-structure.mdx; Site Permissions section (rundock-permissions.png)', note: 'Flat shows the top of the pane; the tile is the whole pane.' },
  'IMG-11-permission-card': { repo: DOCS, path: 'concepts/permissions.mdx (images/permission-card.png), the tile', note: 'A card for an edit outside the workspace, offering the folder.' },
  'IMG-12-connectors': { repo: DOCS, path: 'concepts/workspaces.mdx Connectors (images/connectors.png), the tile', note: 'Two connectors across both runtimes.' },
  'IMG-13-routines': { repo: `${README} + ${DOCS} + ${SITE}`, path: 'README (docs/rundock-routines.png); docs concepts/routines.mdx (images/routines.png); Site Routines section; the tile in guides/set-up-a-routine.mdx', note: 'Every run state, one run still going.' },
  'IMG-14-approvals-dock': { repo: DOCS, path: 'concepts/routines.mdx (images/routine-approvals-dock.png)', note: 'A routine\'s card in the dock over the Team view.' },
  'IMG-15-handover': { repo: `${DOCS} + ${SITE}`, path: 'docs quickstart.mdx and how-rundock-works.mdx (images/conversation-handoff.gif); Site Conversations section (rundock-streaming.gif)', note: 'The handover in the departing agent\'s own words. Check both destinations: they publish it under different names.' },
  'IMG-16-rundock-ui-gallery': { repo: DOCS, path: 'extending/rundock-ui.mdx, the tile', note: 'The gallery\'s dark frame.' },
  'IMG-18-pinned-dashboard': { repo: SITE, path: 'Site Packages and extensions section hero and Pins section hero (one image, both sections; replaces rundock-pins.png there)', note: 'An extension view opened from Pins: the Investment Partner dashboard, three other pins beside it. IMG-03 stays on the docs Pins page; IMG-08 stays on the Extending pages.' },
  'IMG-17-tutorial-tracker': { repo: DOCS, path: 'extending/build-an-extension.mdx, the tile (optional)', note: 'The tutorial\'s Tracker.md drawn by its extension.' },
  'IMG-19-conversation-lists': { repo: `${DOCS} + ${SITE}`, path: 'docs concepts/conversations.mdx, new "Lists" section (images/conversation-lists.png); Site Conversations section 5b, a second screenshot-sm after IMG-15 (rundock-conversation-lists.png)', note: 'No-menu variant: Launch selected, its three conversations listed, Plan the week open. Pick this or the menu variant.' },
  'IMG-19-conversation-lists-menu': { repo: `${DOCS} + ${SITE}`, path: 'as IMG-19-conversation-lists; pick one', note: 'Menu variant: Plan the week\'s right-click menu, Launch and Ops ticked, Hiring not, New list… at the foot.' },

  // Recaptures of existing scenes, replacing the file of the same name.
  'agent-profile': { repo: `${DOCS} + ${SITE}`, path: 'docs images/agent-profile.png; Site rundock-agent-profile.png', note: 'Recapture on the current chrome.' },
  'skills': { repo: `${DOCS} + ${SITE}`, path: 'docs images/skills.png; Site rundock-skills.png', note: 'Recapture on the current chrome.' },
  'conversations': { repo: DOCS, path: 'images/conversations.png', note: 'Recapture on the current chrome.' },
  'files': { repo: `${DOCS} + ${SITE}`, path: 'docs images/files.png; Site rundock-files.png', note: 'Recapture on the current chrome.' },
  'search': { repo: `${README} + ${DOCS} + ${SITE}`, path: 'README docs/rundock-search.png; docs images/search.png; Site rundock-search.png', note: 'Recapture on the current chrome.' },
  'artifact-review': { repo: `${README} + ${DOCS} + ${SITE}`, path: 'README docs/rundock-review.png; docs concepts/files.mdx review; Site rundock-review.png', note: 'Recapture on the current chrome.' },
  'kanban-board': { repo: `${README} + ${DOCS}`, path: 'README docs/rundock-boards.png; docs concepts/files.mdx Kanban boards', note: 'Recapture on the current chrome.' },
  'kanban-drag': { repo: SITE, path: 'rundock-boards.gif', note: 'Recapture on the current chrome.' },
};

// Hero-designated masters get the chrome-framed treatment too.
export const HERO_PLACEMENTS = {
  'IMG-01-org-chart': { repo: `${README} + ${DOCS} + ${SITE}`, path: 'README hero, docs introduction, Site hero', note: 'The team chart, hero framing.' },
  'conversations': { repo: DOCS, path: '(spare hero)', note: 'Product-in-use hero.' },
  'files': { repo: README, path: '(spare hero)', note: 'The file workspace, hero framing.' },
};

// Social cards cut from a master, by the Site file each replaces.
export const SOCIAL_CARDS = {
  from: 'IMG-01-org-chart',
  files: ['rundock-og.png', 'rundock-agent-team-org-chart.png'],
  note: 'Site og and twitter images: rundock-og.png on index, compare and ai-policy; rundock-agent-team-org-chart.png on directory and download.',
};
