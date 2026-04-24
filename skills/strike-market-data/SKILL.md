---
name: strike-market-data
description: Strike Finance public market data -- orderbook depth, trades, prices, tickers, klines, open interest. Use when fetching market data or building trading interfaces.
---

# Strike Finance Market Data

Base URL: `https://api.strikefinance.org/price` (mainnet)

All endpoints are PUBLIC -- no authentication required.

---

## Endpoints

### GET /v2/depth -- Orderbook Depth

Query params:
- `symbol` (required) -- e.g. `"BTC-USD"`
- `limit` -- 1 to 1000, default 20

Response:
```json
{
  "lastUpdateId": 1234567890123456789,
  "E": 1700000000000,
  "T": 1700000000000,
  "bids": [["50000.00", "1.5"], ["49999.00", "2.0"]],
  "asks": [["50001.00", "0.8"], ["50002.00", "1.2"]]
}
```

- `lastUpdateId` (uint64) -- **can exceed Number.MAX_SAFE_INTEGER, always use BigInt**
- `E` -- event time in milliseconds
- `T` -- transaction time in milliseconds
- `bids` -- string[][] sorted highest first (price, quantity)
- `asks` -- string[][] sorted lowest first (price, quantity)
- Cached 5s server-side. Check `X-Cache` response header (`HIT` or `MISS`).

---

### GET /v2/trades -- Recent Trades

Query params:
- `symbol` (required)
- `limit` (optional)

---

### GET /v2/markPrice -- Mark Price

Query params:
- `symbol` (optional) -- omit for all symbols

Response:
```json
{
  "symbol": "BTC-USD",
  "markPrice": "50123.45",
  "indexPrice": "50120.00",
  "estimatedSettlePrice": "50122.00",
  "lastFundingRate": "0.0001",
  "nextFundingTime": 1700003600000,
  "interestRate": "0.0001",
  "time": 1700000000000
}
```

---

### GET /v2/ticker/24hr -- 24h Ticker Statistics

Query params:
- `symbol` (required)

---

### GET /v2/ticker/bookTicker -- Best Bid/Ask

Query params:
- `symbol` (optional) -- omit for all symbols

---

### GET /v2/exchangeInfo -- Exchange Info

Returns markets, trading rules, and filters. No query params required.

---

### GET /v2/klines -- Candlestick / Kline Data

Query params:
- `symbol` (required)
- `interval` -- `1m`, `3m`, `5m`, `15m`, `30m`, `1h`, `2h`, `4h`, `6h`, `8h`, `12h`, `1d`, `3d`, `1w`, `1M`
- `startTime` (ms, optional)
- `endTime` (ms, optional)
- `limit` (optional)

---

### GET /v2/openInterest -- Open Interest

Query params:
- `symbol` (required)

---

## Important Notes

- **BigInt required**: `lastUpdateId` in depth responses can exceed `Number.MAX_SAFE_INTEGER`. Always parse with `BigInt`.
- **Caching**: Depth endpoint is cached for 5 seconds server-side. Use the `X-Cache` response header to detect `HIT` vs `MISS`.
- **Real-time data**: For streaming updates, combine REST polling with WebSocket subscriptions (see `strike-orderbook` and `strike-price-feeds` skills).
