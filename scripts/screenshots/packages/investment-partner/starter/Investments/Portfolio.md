---
investment-partner: portfolio
---

# Portfolio

Sample data, so the dashboard has something to show on the first day. While `"sample": true` is in the block below, the dashboard offers to set you up with Lead Partner or to start empty; your first edit clears it.

The block below is the data the dashboard draws. Anything you write outside it is yours and is never touched by a save.

```json
{
  "schemaVersion": 2,
  "sample": false,
  "updatedAt": "2026-07-17T21:00:00.000Z",
  "baseCurrency": "USD",
  "accounts": [
    {
      "name": "Taxable Brokerage",
      "type": "Taxable",
      "cashBalance": 17400,
      "positions": [
        { "ticker": "VTI", "quantity": 290, "assetClass": "Diversified", "sector": "Broad market", "geography": "United States", "fund": true, "currentPrice": { "amount": 290, "currency": "USD", "asOf": "2026-07-17T21:00:00.000Z" } },
        { "ticker": "NVDA", "quantity": 250, "assetClass": "Equity", "sector": "Technology", "geography": "United States", "currentPrice": { "amount": 180, "currency": "USD", "asOf": "2026-07-17T21:00:00.000Z" } },
        { "ticker": "CRWD", "quantity": 75, "assetClass": "Equity", "sector": "Technology", "geography": "United States", "currentPrice": { "amount": 400, "currency": "USD", "asOf": "2026-07-17T21:00:00.000Z" } },
        { "ticker": "SNOW", "quantity": 100, "assetClass": "Equity", "sector": "Technology", "geography": "United States", "currentPrice": { "amount": 200, "currency": "USD", "asOf": "2026-07-15T21:00:00.000Z" } }
      ]
    },
    {
      "name": "Roth IRA",
      "type": "Roth IRA",
      "cashBalance": 0,
      "positions": [
        { "ticker": "VXUS", "quantity": 950, "assetClass": "Diversified", "sector": "Broad market", "geography": "International", "fund": true, "currentPrice": { "amount": 53, "currency": "USD", "asOf": "2026-07-17T21:00:00.000Z" } }
      ]
    },
    {
      "name": "Traditional IRA",
      "type": "Traditional IRA",
      "cashBalance": 0,
      "positions": [
        { "ticker": "MSFT", "quantity": 50, "assetClass": "Equity", "sector": "Technology", "geography": "United States", "currentPrice": { "amount": 500, "currency": "USD", "asOf": "2026-07-17T21:00:00.000Z" } },
        { "ticker": "BND", "quantity": 260, "assetClass": "Diversified", "sector": "Fixed income", "geography": "United States", "fund": true, "currentPrice": { "amount": 78, "currency": "USD", "asOf": "2026-07-17T21:00:00.000Z" } }
      ]
    },
    {
      "name": "Crypto Wallet",
      "type": "Crypto",
      "cashBalance": 0,
      "positions": [
        { "ticker": "BTC", "quantity": 0.7, "assetClass": "Crypto", "sector": "Digital assets", "geography": "Global", "currentPrice": { "amount": 90000, "currency": "USD", "asOf": "2026-07-17T21:00:00.000Z" } },
        { "ticker": "ETH", "quantity": 5, "assetClass": "Crypto", "sector": "Digital assets", "geography": "Global", "currentPrice": { "amount": 3658, "currency": "USD", "asOf": "2026-07-17T21:00:00.000Z" } }
      ]
    },
    {
      "name": "Cash Vault",
      "type": "Cash",
      "cashBalance": 26500,
      "positions": []
    }
  ]
}
```
