---
investment-partner: risk-profile
---

# Risk Profile

The limits Lead Partner and Risk Manager check every proposal against, and that the dashboard checks the portfolio against. Fractions are decimals from 0 to 1, so 0.08 is 8%. These are starting limits, not advice: set your own on the dashboard's risk control panel.

```json
{
  "schemaVersion": 2,
  "constraints": {
    "maximumSinglePositionFraction": 0.08,
    "maximumSectorFraction": 0.35,
    "maximumAccountFraction": 0.6,
    "minimumCashReserveFraction": 0.05,
    "maximumIlliquidFraction": 0.15
  },
  "taxPreferences": {
    "preferTaxAdvantagedForDividends": true,
    "avoidShortTermGains": true
  },
  "strategyRegime": "growth-and-income"
}
```
