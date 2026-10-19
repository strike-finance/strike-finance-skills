---
name: strike-klines
description: Strike Finance kline/candlestick data — historical candles via REST (/price/v2/klines, last/mark/index), real-time candles via WebSocket (kline_<interval>, kline_<interval>_mark, kline_<interval>_index), and compact sparklines. Use when building charts, TradingView datafeeds or price analysis tools.
---

# Strike Finance Klines (Candlestick Data)

Historical and real-time OHLCV candles for three price series: **last** trade price, **mark** price and **index** price. All public, no auth.

Intervals (case-sensitive): `1m`, `3m`, `5m`, `15m`, `30m`, `1h`, `2h`, `4h`, `6h`, `8h`, `12h`, `1d`, `3d`, `1w`, `1M` (`1M` = month).
Candles are UTC-aligned: `1w` opens Monday 00:00 UTC, `1M` on the 1st 00:00 UTC, `3d` in day-of-year blocks of 3 that restart every 1 January. `closeTime = nextOpenTime - 1`, except the last `3d` block of a year: its `closeTime` (open + 3 days − 1 ms) runs past 1 January, while the next block already opens on 1 January.

## REST Endpoint

**GET** `https://api.strikefinance.org/price/v2/klines` (testnet `https://api-v2-testnet.strikefinance.org/price/v2/klines`)

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `symbol` | string | Yes | Case-sensitive, e.g. `BTC-USD` |
| `interval` | string | Yes | One of the intervals above |
| `priceType` | string | No | `last` (default), `mark`, `index` |
| `limit` | number | No | Default 500, max 1500 (clamped; non-numeric or <= 0 → 500) |
| `startTime` | number | No | Unix ms, lower bound (only reliable when `endTime` is omitted; see below) |
| `endTime` | number | No | Unix ms, upper bound on candle open time |

### Response

An array of 12-element arrays, oldest first:

```json
[
  [1792170000000, "79980", "79980", "77117.60", "77117.60", "0.0099", 1792173599999, "763.464240", 1, "0.0099", "763.464240", "0"]
]
```

| Index | Field | Type |
|-------|-------|------|
| 0 | openTime (ms) | number |
| 1-4 | open, high, low, close | string |
| 5 | volume (base) | string |
| 6 | closeTime (ms) | number |
| 7 | quoteVolume | string |
| 8 | trades | number |
| 9 | "takerBuyBase" — despite the name, base volume of trades with `isBuyerMaker = true` (taker **sells**) | string |
| 10 | "takerBuyQuote" — quote volume of those same trades | string |
| 11 | unused, always `"0"` | string |

True taker-buy volume = `volume − row[9]` (quote: `quoteVolume − row[10]`).

### Which candles come back

- **No `startTime`/`endTime`:** the newest `limit` candles, ending at the newest stored candle plus the in-progress candle if one exists. Not forward-filled to "now" (an idle market's last candle can be old).
- **`endTime` set:** the newest `limit` candles with open time <= `endTime`, gap-filled forward to `endTime` (never into the in-progress period, which is included as observed when `endTime` reaches it). Anchored at `endTime` — if you also pass `startTime` and need a strict lower bound, drop rows with `openTime < startTime`.
- **Only `startTime` set:** the first `limit` candles from `startTime` forward. If that window has no data, the server seeds it with the last candle **before** `startTime`, so a row with `openTime < startTime` can appear; drop it if you need a strict bound.
- Gaps **between** candles are filled with flat candles at the previous close and zero volume. Nothing is generated before the market's first candle.
- For `last`, each closed candle's `open` is set to the previous candle's `close` (the WebSocket `k.o` is the period's first trade price, so REST and WS opens can differ for the same candle).
- For `mark`/`index`, volume, trades and taker fields are copied from the matching `last` candles.
- Responses that do not include the in-progress candle are cached about 5 s (`X-Cache`).

Errors (`400`): `{"code":"MISSING_PARAMETER","msg":"symbol parameter is required"}` (or `interval ...`), `{"code":"INVALID_PARAMETER","msg":"invalid interval"}`, `"invalid startTime"`, `"invalid endTime"`, `"priceType must be 'last', 'mark', or 'index'"`.

### Fetching and parsing

```typescript
type KlineRow = [number, string, string, string, string, string, number, string, number, string, string, string];

interface KlineBar {
  openTime: number;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  closeTime: number;
  quoteVolume: string;
  trades: number;
}

const toBar = (r: KlineRow): KlineBar => ({
  openTime: r[0], open: r[1], high: r[2], low: r[3], close: r[4],
  volume: r[5], closeTime: r[6], quoteVolume: r[7], trades: r[8],
});

async function fetchKlines(
  symbol: string,
  interval: string,
  opts: { limit?: number; startTime?: number; endTime?: number; priceType?: "last" | "mark" | "index" } = {}
): Promise<KlineBar[]> {
  const params = new URLSearchParams({ symbol, interval, limit: String(Math.min(opts.limit ?? 500, 1500)) });
  if (opts.startTime) params.set("startTime", String(opts.startTime));
  if (opts.endTime) params.set("endTime", String(opts.endTime));
  if (opts.priceType) params.set("priceType", opts.priceType);
  const res = await fetch(`https://api.strikefinance.org/price/v2/klines?${params}`);
  if (!res.ok) throw new Error(JSON.stringify(await res.json()));
  return ((await res.json()) as KlineRow[]).map(toBar);
}

// Last 500 15-minute mark-price candles
const bars = await fetchKlines("BTC-USD", "15m", { limit: 500, priceType: "mark" });

// Page backwards: newest 1500 candles before the oldest one we have
const older = await fetchKlines("BTC-USD", "15m", { limit: 1500, endTime: bars[0].openTime - 1 });
```

## WebSocket Klines

**URL:** `wss://api.strikefinance.org/ws/price` (public). Framing, keepalive and limits: see `strike-price-feeds`.

| Stream | Series | Updates |
|--------|--------|---------|
| `<symbol>@kline_<interval>` | last price | On every trade; final update with `x: true` when the period closes; a flat candle at the previous close when a new period opens |
| `<symbol>@kline_<interval>_mark` | mark price | On every mark-price tick; `x: true` on close |
| `<symbol>@kline_<interval>_index` | index price | On every index-price tick; `x: true` on close |

```json
{"method": "subscribe", "channel": "kline_15m", "symbol": "BTC-USD", "id": 1}
{"method": "subscribe", "channel": "kline_1M_mark", "symbol": "BTC-USD", "id": 2}
{"method": "SUBSCRIBE", "params": ["btc-usd@kline_1h_index"], "id": 3}
```

In the simple format the `kline_...` channel keeps its case (so `kline_1M` is monthly) and the symbol is lower-cased by the server. In `SUBSCRIBE` params write the exact stream name with a lowercase symbol.

```json
{"e":"kline","E":1792438738388,"s":"BTC-USD","k":{"t":1792438680000,"T":1792438739999,"s":"BTC-USD","i":"1m",
 "f":0,"L":0,"o":"81905.92917310","c":"81922.34641572","h":"81922.62624529","l":"81899.08236664",
 "v":"0","n":0,"x":false,"q":"0","V":"0","Q":"0","B":"0"}}
```

| Field | Meaning |
|-------|---------|
| `k.t` / `k.T` | Open / close time (ms) |
| `k.s` | Symbol with hyphen, e.g. `BTC-USD` (same as top-level `s`) |
| `k.i` | Interval |
| `k.o` `h` `l` `c` | OHLC strings |
| `k.v` `q` `n` | Base volume, quote volume, trade count |
| `k.V` / `k.Q` | Despite the names, base / quote volume of trades with `isBuyerMaker = true` (taker sells); taker-buy = `v − V` (quote `q − Q`) |
| (volume fields) | **Always `"0"`/`0` on `_mark`/`_index` streams** (only REST overlays volume) |
| `k.x` | `true` on the final update of a closed candle |
| `k.f`, `k.L`, `k.B` | Always `0`, `0`, `"0"` |

Payloads do not carry the stream name: last, `_mark` and `_index` candles are identical in shape (`e: "kline"`, same `s`, `k.i`). To consume more than one of last/mark/index for the same symbol and interval, use **separate sockets** (one series per socket). Each update carries the full candle: replace the bar with the same `k.t` rather than accumulating.

## Sparklines

**GET** `https://api.strikefinance.org/price/v2/sparklines?interval=1h&points=24&priceType=last&symbol=BTC-USD,ETH-USD`

Close-price series for every trading market in one call (list/heatmap UIs).

| Param | Default | Values |
|-------|---------|--------|
| `interval` | `1h` | `5m`, `15m`, `30m`, `1h`, `2h`, `4h` |
| `points` | `24` | integer >= 2, clamped to 288 |
| `priceType` | `mark` | `last`, `mark`, `index` — **use `last`**; see below |
| `symbol` | all trading markets | comma-separated filter (case-insensitive) |

```json
{"status":"OK","interval":"1h","priceType":"last","points":5,
 "data":{"BTC-USD":{"openTime":1792116000000,"closes":["80000.0","79980","77117.60"]}}}
```

Served only from Redis. **Today only `priceType=last` returns data**: closed mark/index candles for these intervals are moved to PostgreSQL and removed from Redis by the klines worker, so `mark`/`index` (including the default) return `"data": {}`. For mark/index mini charts call `/v2/klines?priceType=mark` per symbol.

`closes` are oldest first and may be shorter than `points`. Redis keeps roughly the 24h before each market's **newest** candle (not before now), so an idle market's series can be old. Only candles with trades are stored, so a `last` series skips idle periods and is not evenly spaced — `openTime` + index × interval is only exact for markets that trade every period. Only trading markets are included; markets without candles are omitted. Errors: `400 INVALID_PARAMETER` for a bad `interval`, `priceType`, or `points < 2` (`points > 288` is clamped). Sent with `Cache-Control: public, max-age=30`.

## TradingView Datafeed Pattern

```typescript
const RESOLUTIONS: Record<string, string> = {
  "1": "1m", "3": "3m", "5": "5m", "15": "15m", "30": "30m", "60": "1h", "120": "2h", "240": "4h",
  "360": "6h", "480": "8h", "720": "12h", "1D": "1d", "3D": "3d", "1W": "1w", "1M": "1M",
};

type PriceType = "last" | "mark" | "index";

class StrikeDatafeed {
  private ws: WebSocket | null = null;
  private stream = "";
  private onTick: ((bar: any) => void) | null = null;

  constructor(private priceType: PriceType = "last") {}

  onReady(cb: (cfg: any) => void) {
    setTimeout(() => cb({ supported_resolutions: Object.keys(RESOLUTIONS) }), 0);
  }

  resolveSymbol(name: string, onResolve: (info: any) => void) {
    setTimeout(() => onResolve({
      name, ticker: name, description: name, type: "crypto", session: "24x7", timezone: "Etc/UTC",
      exchange: "Strike", listed_exchange: "Strike", format: "price",
      has_intraday: true, has_daily: true, has_weekly_and_monthly: true,
      supported_resolutions: Object.keys(RESOLUTIONS),
      pricescale: 100, minmov: 1, volume_precision: 4,
    }), 0);
  }

  async getBars(
    info: any, resolution: string,
    p: { from: number; to: number; countBack?: number; firstDataRequest: boolean },
    onResult: (bars: any[], meta: { noData: boolean }) => void, onError: (e: string) => void
  ) {
    try {
      const rows = await fetchKlines(info.name, RESOLUTIONS[resolution], {
        endTime: p.to * 1000 - 1,                       // TradingView "to" is exclusive
        limit: Math.min(1500, Math.max(p.countBack ?? 300, 2)),
        priceType: this.priceType,
      });
      const bars = rows.map((k) => ({
        time: k.openTime, open: +k.open, high: +k.high, low: +k.low, close: +k.close, volume: +k.volume,
      }));
      onResult(bars, { noData: bars.length === 0 });
    } catch (e) {
      onError(String(e));
    }
  }

  subscribeBars(info: any, resolution: string, onTick: (bar: any) => void) {
    const suffix = this.priceType === "last" ? "" : `_${this.priceType}`;
    this.stream = `${info.name.toLowerCase()}@kline_${RESOLUTIONS[resolution]}${suffix}`;
    this.onTick = onTick;
    this.ws = new WebSocket("wss://api.strikefinance.org/ws/price");
    this.ws.onopen = () => this.ws!.send(JSON.stringify({ method: "SUBSCRIBE", params: [this.stream], id: 1 }));
    this.ws.onmessage = (ev) => {
      for (const line of String(ev.data).split("\n")) {
        if (!line) continue;
        const m = JSON.parse(line);
        if (m.e !== "kline") continue;
        const k = m.k;
        this.onTick?.({ time: k.t, open: +k.o, high: +k.h, low: +k.l, close: +k.c, volume: +k.v });
      }
    };
  }

  unsubscribeBars() {
    this.ws?.close();
    this.ws = null;
    this.onTick = null;
  }
}

// const widget = new TradingView.widget({ datafeed: new StrikeDatafeed("mark"), symbol: "BTC-USD", interval: "15", ... });
```

- Use one socket per stream (as above) whenever you need more than one of last/mark/index for the same symbol and interval — the payloads cannot be told apart.
- `_mark`/`_index` WS candles report volume `0`; if the chart shows volume, keep the volume from the REST bars for the in-progress candle or subscribe to the `last` stream too.
- After a reconnect, call TradingView's `resetData()` (or refetch with `endTime = Date.now()`) to close any gap.
