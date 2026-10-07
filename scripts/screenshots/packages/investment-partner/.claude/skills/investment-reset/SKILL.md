---
name: Investment Reset
description: Put back a missing investment note (portfolio, risk profile, decision journal or the dashboard) as an empty, valid note from this skill's templates, never overwriting one that exists
---

The four investment notes arrive with the package: `Investments/Investment Dashboard.md`, `Investments/Portfolio.md`, `Investments/Risk Profile.md` and `Investments/Decision Journal.md`, filled with sample data. Installing never replaces a note the person already has. Use this skill when one of them is missing (deleted, or never installed) and the person wants it back, or when the person wants to start empty instead of from the sample data.

1. Check which of the four notes exist at those paths.
2. For each one that is missing and that the person wants back, create it with the exact contents of the matching file in this skill's `templates/` folder. Each template is empty but valid: no accounts, no decisions, and the risk profile's sample limits.
3. Never overwrite a note that exists, even if it looks empty or wrong, and never "reset" a note by clearing it. Tell the person what you found instead, and offer to fix the specific problem.
4. If the person has moved or renamed a note, do not create a second one. Update the path under `sources:` in `Investments/Investment Dashboard.md` instead, and only when they ask.
5. Tell the person which notes you created and which were already there, and that opening `Investments/Investment Dashboard.md` shows the dashboard.

**Starting empty.** The dashboard offers a Start empty button on its sample-data banner, which does this itself with an Undo. When the person asks you instead, the same rule applies: only a portfolio that still carries `"sample": true` may be emptied, because only then is it not theirs. Ask which currency they want (suggest the one for their country), confirm that the sample portfolio and decision journal will be cleared and the risk profile kept, and then write the empty portfolio and journal from `templates/`, with `baseCurrency` set to their currency and no `sample` flag. A portfolio without `"sample": true` is the person's own and is never emptied, whatever they ask; offer to remove specific accounts or positions instead.

When you create a portfolio from the template for a missing note, set `baseCurrency` to the person's currency too; the template's `USD` is only a placeholder.

The risk profile template's limits are a starting point, not advice: an 8% maximum single position, a 35% maximum sector, a 60% maximum single account, a 5% minimum cash reserve and a 15% maximum in illiquid assets. The person sets their own on the dashboard's risk control panel.
