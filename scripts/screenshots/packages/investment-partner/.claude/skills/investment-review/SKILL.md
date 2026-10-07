---
name: Investment Review
description: How to run a sequential investment review across Lead Partner, Equity Analyst, and Risk Manager
---

Use this skill when reviewing a new position, an existing holding, or a thesis someone has raised.

## The data

Four notes in `Investments/` hold everything. The three data notes keep their data in a ```json block, with the person's own writing around it:

- `Investments/Portfolio.md`: accounts, positions, cash and prices
- `Investments/Risk Profile.md`: the five limits, two tax preferences and the strategy regime
- `Investments/Decision Journal.md`: decisions and their status
- `Investments/Investment Dashboard.md` holds no data. It lists the three under `sources:`, and Rundock draws them as one dashboard.

Read them for context. Only Lead Partner writes to them, and only in the two ways its instructions allow: a new journal entry with status `proposed`, or a portfolio change the person has stated. If a note is missing, run the Investment Reset skill first.

## The review sequence

A review runs in order, not in parallel, because each step depends on what came before it:

1. **Business model and unit economics** (Equity Analyst): how the business makes money, what protects its margins, and how unit economics are trending, sourced from primary materials wherever possible.
2. **Bear case and invalidation risk** (Risk Manager): the strongest honest case against the thesis, and exactly three measurable metrics that would mean it is wrong.
3. **Synthesis** (Lead Partner): the thesis, the bear case, and whether the portfolio would stay inside all five limits after the change, checked by the rules below. Present it as a recommendation, not a decision already made, and offer to record it in the journal as `proposed`.

## Checking the limits

The dashboard runs the same check on the portfolio as it stands; yours is on the portfolio as it would stand. Every fraction is of the total: every position's market value plus every account's cash.

- **Max single position** (`maximumSinglePositionFraction`): one ticker, added up across every account that holds it. A position marked `fund: true` (an index or bond fund) is many positions, so it does not count.
- **Max sector concentration** (`maximumSectorFraction`): each sector's positions added up, funds left out for the same reason.
- **Max single account exposure** (`maximumAccountFraction`): each account's positions and cash.
- **Min cash reserve** (`minimumCashReserveFraction`): all cash, across every account. Below it is the breach.
- **Max illiquid assets** (`maximumIlliquidFraction`): every position marked `illiquid: true`.

Exactly at a limit is inside it. A risk profile written before schema 2 may lack the account and illiquid limits; a limit that is not there is not checked, and you say so rather than assuming one.

The tax preferences shape where a trade should sit, not whether it fits: `preferTaxAdvantagedForDividends` means dividend payers belong in a tax-advantaged account where there is room, and `avoidShortTermGains` means flagging any sale of a lot held under a year. The `strategyRegime` (`aggressive-growth`, `growth-and-income`, `capital-preservation` or `value-opportunities`) is the person's stated posture: say when a proposal cuts against it.

## Data conventions

- One currency per portfolio: `baseCurrency` (a three-letter code such as GBP, USD or EUR) applies to every price, cash balance and trade amount, and each price's `currentPrice.currency` matches it. Nothing is ever converted; a change of `baseCurrency` relabels the amounts. Prices are entered by hand, and a price older than 24 hours is still shown but flagged as stale.
- `"sample": true` on the portfolio marks the starter sample data. The first real change removes it.
- Fractions (limits) are stored as decimals from `0` through `1`, not whole percentages; only the display turns them into percentages.
- A trade evaluation cannot proceed if any affected position is unpriced, malformed, or priced in a currency other than the portfolio's.
- A journal entry carries `decisionId`, `ticker`, `action` (`buy`, `sell`, `hold`, `watch` or `avoid`), `status` (`proposed`, `approved`, `executed`, `rejected` or `archived`), `thesis`, `createdAt` and `updatedAt`.

## What this skill does not cover

No agent here places a trade, provides tax advice, or connects to a brokerage. The decision journal records decisions; it does not execute them.
