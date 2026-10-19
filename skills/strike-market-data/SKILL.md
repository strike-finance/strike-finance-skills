---
name: strike-market-data
description: Strike Finance public market data REST (https://<host>/price/v2/...) — depth, trades, premium index/funding, mark/index price, 24h tickers, market stats, exchange info, klines, sparklines, open interest, fear & greed, stablecoin and FX rates — plus an overview of the public price WebSocket. Use when fetching market data or building trading interfaces.
---

# Strike Finance Market Data

| Environment | REST base | WebSocket |
|-------------|-----------|-----------|
| Mainnet | `https://api.strikefinance.org/price` | `wss://api.strikefinance.org/ws/price` |
| Testnet | `https://api-v2-testnet.strikefinance.org/price` | `wss://api-v2-testnet.strikefinance.org/ws/price` |

All endpoints below are called as `<REST base>/v2/...`, e.g. `https://api.strikefinance.org/price/v2/depth?symbol=BTC-USD`. Everything is PUBLIC — no authentication. The OpenAPI spec is `openapi/market-api.yaml`.

Conventions:

- Send the canonical symbol, e.g. `BTC-USD`. Most endpoints are **case-sensitive** (`btc-usd` gives `400 INVALID_SYMBOL`, or an empty result on `/v2/depth` and `/v2/trades`); `/v2/markPrice` and `/v2/indexPrice` also accept lowercase, `/v2/sparklines` upper-cases its filter.
- Prices, sizes and rates are decimal **strings**; times are Unix ms **numbers**.
- Errors: `{"code": "...", "msg": "..."}` with `MISSING_PARAMETER`, `INVALID_PARAMETER`, `INVALID_SYMBOL` (400), `INTERNAL_ERROR` (500), `SERVICE_UNAVAILABLE` (503). Exceptions: `/v2/marketStats` (400/500) and `/v2/sparklines` (500) return `{"error": "..."}`.
- Endpoints marked *cached* use an in-process cache of about 5 s and set `X-Cache: HIT|MISS` (trades, single-symbol markPrice/indexPrice/ticker/24hr, klines, sparklines; exchangeInfo uses a non-expiring cache).
- "Optional `symbol`" endpoints return one object with `symbol`, and an **array** for all markets without it (`/v2/ticker/24hr` without `symbol` lists only markets that have 24h data).

---

## WebSocket (overview)

Public, no auth. Full reference (framing, keepalive, limits, payloads): `strike-price-feeds`.

```json
{"method": "subscribe", "channel": "depth", "symbol": "BTC-USD", "id": 1}
{"method": "SUBSCRIBE", "params": ["btc-usd@depth", "btc-usd@trade"], "id": 2}
```

Ack: `{"result": null, "id": 1}`. App ping `{"method":"ping","id":9}` → `{"id":9,"method":"pong"}`. The server sends a ping frame every 54 s; the 60 s read deadline is extended **only by pong frames** (not by your messages), so the client must answer pings (browsers/most libraries do automatically). **A frame can hold several JSON messages separated by `\n`.** Payloads don't name their stream, so last/`_mark`/`_index` klines (and `@markprice` vs `@markprice@1s`) for the same symbol need separate sockets.

| Stream (`<s>` = `btc-usd`) | Event | Cadence |
|----------------------------|-------|---------|
| `<s>@depth` | `depthUpdate` | Top-20 level diffs, 100 ms flush, on change |
| `<s>@bookticker` | `bookTicker` | Best bid/ask on each book update (≤ every 100 ms) |
| `<s>@trade` | `trade` | Every trade |
| `<s>@markprice` / `!markprice@arr` | `markPriceUpdate` | 3 s |
| `<s>@markprice@1s` | `markPriceUpdate` | Each price-engine tick (~1 s), newest only |
| `<s>@indexprice` / `!indexprice@arr` | `indexPriceUpdate` | 3 s (deprecated) |
| `<s>@miniticker` | `24hrMiniTicker` | 1 s |
| `!miniticker@arr` | array of `24hrMiniTicker` | Full set on subscribe (entries are never removed; idle markets keep old values/`E`), then changed markets every 1 s |
| `<s>@kline_<i>`, `<s>@kline_<i>_mark`, `<s>@kline_<i>_index` | `kline` | Real time (`strike-klines`) |

Order books: `strike-orderbook` (also the L3 market-by-order feed at `/v2/l3/snapshot` and `/ws/l3`). Trades: `strike-trades`.

---

## Endpoints

### GET /v2/depth — Orderbook Depth

- `symbol` (required), `limit` levels per side (default 20, max 1000).
- Not cached. Unknown symbol → empty book with `lastUpdateId: 0`.

```json
{"lastUpdateId": 93450741, "E": 1792438776570, "T": 1792432626597,
 "bids": [["82.55", "1.82"], ["82.5", "2.43"]], "asks": [["82.67", "39.31"], ["82.78", "50"]]}
```

`lastUpdateId` = order-book update ID (same domain as WS `U`/`u`); `E` = response time; `T` = engine snapshot time; bids high→low, asks low→high.

### GET /v2/trades — Recent Trades

- `symbol` (required), `limit` (default 100, max 1000). Newest first; only the latest 1000 trades are kept. *Cached.*

```json
[{"id": 18071, "price": "77117.60", "qty": "0.0099", "quoteQty": "763.464240", "time": 1792172831028, "isBuyerMaker": true}]
```

### GET /v2/premiumIndex — Premium Index / Funding Window

- Optional `symbol`. `503 SERVICE_UNAVAILABLE` while the price engine initializes; unknown symbol → `400 INVALID_SYMBOL`.

```json
{"symbol": "BTC-USD", "markPrice": "81649.00853590", "indexPrice": "81885.03705489",
 "latestPremiumIndex": "0", "averagePremiumIndex": "0", "premiumIndexCount": 0,
 "fundingRate": "0.0000125", "nextFundingTime": 1792440000000,
 "interestRate": "0.0001", "interestRateDampener": "0.0005", "fundingMultiplier": "1", "time": 1792438625706}
```

`latestPremiumIndex`/`averagePremiumIndex`/`premiumIndexCount` describe the active funding window (samples every 5 s; `latestPremiumIndex` is `"0"` before the first sample). `fundingRate` is the rate estimated from that window.

### GET /v2/markPrice — Mark Price

- Optional `symbol` (single symbol *cached*). No data → `400 {"code":"INVALID_SYMBOL","msg":"no mark price data available for symbol"}`. Same shape as WS `markPriceUpdate`:

```json
{"e": "markPriceUpdate", "E": 1792438629661, "s": "BTC-USD", "p": "81649.00853590", "i": "81886.56143616", "r": "0.0000125", "T": 1792440000000}
```

`p` mark, `i` index, `r` funding rate, `T` next funding time.

### GET /v2/indexPrice — Index Price

- Optional `symbol` (single symbol *cached*). → `{"e": "indexPriceUpdate", "E": 1792438630601, "s": "BTC-USD", "p": "81885.90564570"}`

### GET /v2/ticker/24hr — 24h Ticker

- Optional `symbol` (single symbol *cached*); unknown → `400 INVALID_SYMBOL`.
- Without `symbol`: an array of only the markets with 24h candle data (zero-change fallback rows for every market only if no market has data).

```json
{"symbol": "BTC-USD", "priceChange": "-2862.40", "priceChangePercent": "-3.578894723680920230",
 "weightedAvgPrice": "77117.60", "lastPrice": "77117.60", "lastQty": "0", "openPrice": "79980",
 "highPrice": "79980", "lowPrice": "77117.60", "volume": "0.0099", "quoteVolume": "763.464240",
 "openTime": 1792352226669, "closeTime": 1792438626669, "firstId": 0, "lastId": 0, "count": 0}
```

Built from 1m candles. `weightedAvgPrice` = `lastPrice`, `lastQty` = `"0"`, `firstId`/`lastId`/`count` = `0`, `openTime` = now − 24h, `closeTime` = now. A single-symbol request for a market with no 24h data returns its last price with zero change/volume.

### GET /v2/ticker/price — Latest Price

- Optional `symbol`; unknown → `400 INVALID_SYMBOL`. → `{"symbol": "BTC-USD", "price": "77117.60", "time": 1792438627626}` (`time` = response time).

### GET /v2/ticker/bookTicker — Best Bid/Ask

- Optional `symbol`; unknown → `400 INVALID_SYMBOL`.
- → `{"symbol": "BTC-USD", "bidPrice": "77117.60", "bidQty": "0.0099", "askPrice": "80000", "askQty": "0.1", "time": 1792438628708}`

### GET /v2/marketStats — Market Metadata + Live Stats

- Optional `symbol` (exact match; unknown → `400 {"error":"invalid symbol"}`). Always an envelope, sorted by symbol. Not cached.

```json
{"status": "OK", "data": [{
  "symbol": "BTC-USD", "type": "PERPETUAL", "category": "Crypto", "subCategory": "",
  "assetName": "BTC", "collateralAssetName": "USD", "active": true, "status": "ACTIVE",
  "marketStats": {
    "volume24h": "0", "volumeBase24h": "0", "priceChange24h": "0", "priceChangePercentage24h": "0",
    "low24h": "77117.60", "high24h": "77117.60", "lastPrice": "77117.60",
    "markPrice": "81649.00853590", "indexPrice": "81885.93170330", "fundingRate": "0.0000125",
    "nextFundingRate": 1792440000000, "openInterest": "1644224.872173564148", "openInterestBase": "20.13772000000000000"
  },
  "visibleOnUI": true, "createdAt": 0}]}
```

- `status`: `ACTIVE`, `PRE_TRADING`, `BREAK`, `CLOSED`; `active`/`visibleOnUI` true only when trading.
- `category`: `Crypto` (subCategory `""`) or `TradFi` with `FX`, `Commodity`, `Equity`, `Index`.
- `volume24h` = quote volume; `volumeBase24h` = base volume.
- `nextFundingRate` is actually the **next funding time** (ms).
- `openInterestBase` = sum of long + short position sizes (2× `/v2/openInterest`); `openInterest` = `openInterestBase` × mark price.

### GET /v2/fearGreed — Sentiment Index

```json
{"status": "OK", "data": {"value": 40, "classification": "Fear", "timestamp": 1792438627808,
 "components": {"momentum": 50, "breadth": 0, "volatility": 100}, "marketsCounted": 1}}
```

Display only. `value` integer 0–100; bands `<25` Extreme Fear, `<45` Fear, `<55` Neutral, `<75` Greed, else Extreme Greed. `components` are 0–100 floats rounded to 2 decimals. Recomputed every 30 s; `Cache-Control: public, max-age=30`; `503 SERVICE_UNAVAILABLE` before the first reading.

### GET /v2/exchangeInfo — Exchange Info

No params. Built once and served from a non-expiring cache (`X-Cache`): **`serverTime` is when the cache was filled, not the current time**; don't use it for clock sync.

```json
{"timezone": "UTC", "serverTime": 1792351962498,
 "rateLimits": [{"rateLimitType": "REQUEST_WEIGHT", "interval": "MINUTE", "intervalNum": 1, "limit": 2400},
                {"rateLimitType": "ORDERS", "interval": "MINUTE", "intervalNum": 1, "limit": 1200}],
 "symbols": [{"symbol": "BTC-USD", "pair": "BTC-USD", "contractType": "PERPETUAL", "status": "trading",
   "baseAsset": "BTC", "quoteAsset": "USDT", "marginAsset": "USDT",
   "pricePrecision": 8, "quantityPrecision": 8, "baseAssetPrecision": 8, "quotePrecision": 8,
   "underlyingType": "COIN", "underlyingSubType": ["BTC"], "settlePlan": 0,
   "triggerProtect": "0.05", "liquidationFee": "0.0125", "limitTakeBound": "0.05", "marketTakeBound": "0.05",
   "filters": [
     {"filterType": "PRICE_FILTER", "maxPrice": "100000", "minPrice": "10", "tickSize": "0.10"},
     {"filterType": "LOT_SIZE", "maxQty": "1000", "minQty": "0.00001", "stepSize": "0.00001"},
     {"filterType": "MARKET_LOT_SIZE", "maxQty": "120", "minQty": "0.00001", "stepSize": "0.00001"},
     {"filterType": "MIN_NOTIONAL", "notional": "100"}],
   "orderType": ["LIMIT", "MARKET", "STOP", "STOP_MARKET", "TAKE_PROFIT", "TAKE_PROFIT_MARKET"],
   "timeInForce": ["GTC", "IOC", "FOK"]}]}
```

- `status` is lowercase: `pre_trading`, `trading`, `break`, `close`.
- `quoteAsset`/`marginAsset` are always `"USDT"` (placeholders; markets are USD-quoted). `rateLimits`, `orderType`, `timeInForce` are static lists.
- `LOT_SIZE` applies to limit orders, `MARKET_LOT_SIZE` to market orders. `limitTakeBound`/`marketTakeBound` are the order price bounds.

### GET /v2/klines — Candles

- `symbol`, `interval` (required; `1m 3m 5m 15m 30m 1h 2h 4h 6h 8h 12h 1d 3d 1w 1M`), `startTime`, `endTime` (ms), `limit` (default 500, max 1500), `priceType` (`last` default, `mark`, `index`).
- Returns `[[openTime, open, high, low, close, volume, closeTime, quoteVolume, trades, takerBuyBase, takerBuyQuote, "0"], ...]`, oldest first. Despite the names, columns 9/10 hold the volume of trades with `isBuyerMaker = true` (taker **sells**); taker-buy = `volume − col9` (quote: `quoteVolume − col10`).
- *Cached* (`X-Cache`) unless the response includes the in-progress candle. Paging, gap filling and WS candles: `strike-klines`.

### GET /v2/sparklines — Mini-chart Series

- `interval` (`5m 15m 30m 1h 2h 4h`, default `1h`), `points` (default 24; `< 2` → `400 INVALID_PARAMETER`, `> 288` clamped), `priceType` (`last`, `mark`, `index`, default `mark`; anything else → `400 INVALID_PARAMETER`), `symbol` (optional comma list, case-insensitive). Only trading markets. *Cached*, `Cache-Control: public, max-age=30`.
- **Use `priceType=last`** — closed mark/index candles are moved out of Redis, so `mark`/`index` (and the default) currently return `"data": {}`.
- → `{"status":"OK","interval":"1h","priceType":"last","points":5,"data":{"BTC-USD":{"openTime":1792116000000,"closes":["80000.0","79980","77117.60"]}}}`
- Series cover about 24h before each market's newest candle (not before now) and skip periods without trades. Details: `strike-klines`.

### GET /v2/openInterest — Open Interest

- Optional `symbol`; unknown → `400 INVALID_SYMBOL`. One-sided OI in base units (stored long+short total ÷ 2); `"0"` when nothing is stored.
- → `{"symbol": "BTC-USD", "openInterest": "10.06886000000000000", "time": 1792438631552}`

### GET /v2/stablecoin/rates — Stablecoin Rates

No params. Map of tracked stable symbols to USD price (positive prices only). Keys vary by deployment and are mixed-case (testnet also has `USDCx-USD`, `USDrf-USD`, `IUSD-USD`); don't hard-code the set:

```json
{"USDC-USD": "0.99993125", "USDT-USD": "0.9988746153846153846", "USDM-USD": "1.000191116472927282",
 "DEPOSIT-USDM-USD": "0.9974966573897500", "WITHDRAW-USDM-USD": "1.000191116472927282"}
```

### GET /v2/fxRates — Fiat Reference Rates

- Optional `symbols=EUR,JPY` (3-letter codes, case-insensitive; malformed → `400 INVALID_PARAMETER`; unpublished codes are omitted).
- → `{"status": "OK", "base": "USD", "date": "2026-10-19", "updatedAt": 1792438597842, "rates": {"EUR": "0.89087", "JPY": "158.24"}}`

Display only: daily ECB reference rates, units per 1 USD (`USD: "1"` included when unfiltered). `date` lags on weekends/holidays. `503 SERVICE_UNAVAILABLE` until first load. `Cache-Control: public, max-age=300`.

---

## Important Notes

- **Prefer WebSocket for live data**; use REST for snapshots and backfill.
- Update IDs (`lastUpdateId`, `U`, `u`) are uint64; current values fit safely in a JS `number`.
- `/v2/ticker/price` and `/v2/ticker/bookTicker` read the market record; `/v2/depth` reads the engine's book snapshot — they can briefly disagree.
- Response timestamps named `time`/`E` are usually the server response time, not the data's age; use `T` (depth) or the WS event times when freshness matters.
