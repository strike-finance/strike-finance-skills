---
name: strike-price-feeds
description: Strike Finance public price WebSocket (wss://<host>/ws/price) — connection, subscribe formats, every stream (depth, bookticker, trade, markprice, markprice@1s, indexprice, miniticker, kline incl. mark/index), payloads, cadence, keepalive and limits. Use when building real-time trading interfaces, bots or price monitors.
---

# Strike Finance Real-time Price Feeds

## WebSocket URLs

| Endpoint | Mainnet | Testnet | Auth |
|----------|---------|---------|------|
| Public market data | `wss://api.strikefinance.org/ws/price` | `wss://api-v2-testnet.strikefinance.org/ws/price` | None |
| L3 market-by-order | `wss://api.strikefinance.org/ws/l3` | `wss://api-v2-testnet.strikefinance.org/ws/l3` | None (see `strike-orderbook`) |
| User data (API wallet) | `wss://api.strikefinance.org/ws/user-api` | `wss://api-v2-testnet.strikefinance.org/ws/user-api` | API wallet (see `strike-userstream`) |

REST snapshots for the same data live under `https://<host>/price/v2/...` (see `strike-market-data`).

## Framing (read this first)

- **One text frame can contain several JSON messages separated by `\n`.** Always split before parsing:
  `for (const line of String(ev.data).split("\n")) handle(JSON.parse(line))`.
- Array streams (`!markprice@arr`, `!indexprice@arr`, `!miniticker@arr`) send a bare JSON array.
- Event symbols are uppercase (`"BTC-USD"`); prices/sizes are strings; times are Unix ms numbers.

## Subscribing

Two request formats are accepted on the same socket.

**Simple format** — the server builds the stream name as `lowercase(symbol) + "@" + lowercase(channel)`, except channels starting with `kline_`, which keep their case (`kline_1M` = monthly, `kline_1m` = 1 minute). Symbol case does not matter. `id` is echoed as sent.

```json
{"method": "subscribe", "channel": "depth", "symbol": "BTC-USD", "id": 1}
{"method": "subscribe", "channel": "markPrice@1s", "symbol": "BTC-USD", "id": 2}
{"method": "subscribe", "channel": "!markPrice@arr", "id": 3}
{"method": "unsubscribe", "channel": "depth", "symbol": "BTC-USD", "id": 4}
```

Global channels start with `!` and take no `symbol`.

**Binance format** — `params` are exact stream names (use lowercase symbols), `id` must be an integer (a string `id` is rejected with `Unknown method: SUBSCRIBE`).

```json
{"method": "SUBSCRIBE", "params": ["btc-usd@depth", "btc-usd@kline_1m", "!miniticker@arr"], "id": 1}
{"method": "UNSUBSCRIBE", "params": ["btc-usd@depth"], "id": 2}
```

Ack (both formats): `{"result": null, "id": 1}`.

Errors: `{"e": "error", "E": 1792438737716, "error": {"code": 400, "msg": "Unknown method: LIST_SUBSCRIPTIONS"}}` — errors do **not** echo the request `id`. There is no `LIST_SUBSCRIPTIONS`. Stream names are not validated: a misspelled stream is acknowledged but never delivers data.

## Keepalive

- The server sends a WebSocket **ping frame every 54 s**. The connection has a **60 s read deadline that is extended only by pong frames** — your own messages (subscribes, app-level pings) do not extend it, so the client must answer ping frames. Browsers, Node's built-in `WebSocket` and most libraries do this automatically.
- Optional app-level pings (latency checks only; they do not replace pong frames):
  - `{"method": "ping", "id": 99}` → `{"id": 99, "method": "pong"}`
  - `{"e": "ping", "id": "x"}` → `{"e": "pong", "E": 1792438737716, "id": "x"}` (`id` must be a string in this form)

## Limits and delivery

- Client messages are limited to **4 KiB**; a larger frame closes the connection (split long `params` lists).
- No per-connection subscription cap in the service.
- Each client has a 1024-message outbound queue. If you fall behind, queued streams **drop messages for your connection** (it stays open) — for `depth` this silently corrupts a local book, so keep up and re-snapshot after reconnects. `!miniticker@arr` instead **disconnects** a client that cannot keep up. `@markprice@1s` and `@bookticker` keep only the newest message per stream (older pending ones are replaced).
- permessage-deflate is used when the client offers it (frames >= 256 bytes are compressed).

## Streams

`<s>` = lowercase symbol, e.g. `btc-usd`. Intervals: `1m 3m 5m 15m 30m 1h 2h 4h 6h 8h 12h 1d 3d 1w 1M`.

| Stream | Event `e` | Cadence | Delivery |
|--------|-----------|---------|----------|
| `<s>@depth` | `depthUpdate` | Diffs of the top 20 levels, flushed every 100 ms, only when something changed | queued |
| `<s>@bookticker` | `bookTicker` | On each new order-book update (same 100 ms flush; values may repeat) | newest only |
| `<s>@trade` | `trade` | Every public trade | queued |
| `<s>@markprice` | `markPriceUpdate` | Every 3 s | queued |
| `<s>@markprice@1s` | `markPriceUpdate` | Every committed price-engine tick (nominally 1 s); `E` is the engine tick time | newest only |
| `!markprice@arr` | array of `markPriceUpdate` | Every 3 s, all symbols | queued |
| `<s>@indexprice` | `indexPriceUpdate` | Every 3 s (deprecated: use `i` from `@markprice@1s`) | queued |
| `!indexprice@arr` | array of `indexPriceUpdate` | Every 3 s (deprecated) | queued |
| `<s>@miniticker` | `24hrMiniTicker` | Every 1 s, for markets with 24h candle data (an idle market may send nothing) | queued |
| `!miniticker@arr` | array of `24hrMiniTicker` | Full array right after subscribing, then every 1 s **only the markets whose values changed**. Snapshot entries are never removed: a market that stopped reporting keeps its last values (old `E`) | disconnect if slow |
| `<s>@kline_<i>` | `kline` | Last-price candle: on every trade, at close (`x: true`), and a flat candle when a new period opens | queued |
| `<s>@kline_<i>_mark` | `kline` | Mark-price candle on every mark tick | queued |
| `<s>@kline_<i>_index` | `kline` | Index-price candle on every index tick | queued |

**Payloads do not carry the stream name.** `<s>@kline_<i>`, `<s>@kline_<i>_mark` and `<s>@kline_<i>_index` produce identical shapes, as do `<s>@markprice` and `<s>@markprice@1s`. If you need more than one of these for the same symbol (and interval), use separate sockets — on one socket they cannot be told apart.

There is no separate funding stream (funding rate `r` and next funding time `T` are in `markPriceUpdate`), no full 24h `ticker` stream, and no depth level/speed variants. Only `!miniticker@arr` sends an initial snapshot on subscribe; for depth, fetch `GET /price/v2/depth` (see `strike-orderbook`).

## Payloads

```jsonc
// <s>@depth — changed levels only; "0" = level left the top 20
{"e":"depthUpdate","E":1792438776570,"s":"BTC-USD","U":93450700,"u":93450741,
 "b":[["82.55","1.82"],["82.40","0"]],"a":[["82.67","39.31"]]}

// <s>@bookticker — complete best bid/ask; "" when a side is empty
{"e":"bookTicker","E":1792438776570,"s":"BTC-USD","u":93450741,"b":"82.55","B":"1.82","a":"82.67","A":"39.31"}

// <s>@trade — m = buyer is maker (sell-side aggressor)
{"e":"trade","E":1792172831030,"s":"BTC-USD","t":18071,"p":"77117.60","q":"0.0099","T":1792172831028,"m":true}

// <s>@markprice, <s>@markprice@1s, elements of !markprice@arr
{"e":"markPriceUpdate","E":1792438738334,"s":"BTC-USD","p":"81649.00853590","i":"81922.34641572","r":"0.0000125","T":1792440000000}

// <s>@indexprice, elements of !indexprice@arr
{"e":"indexPriceUpdate","E":1792438739344,"s":"BTC-USD","p":"81922.34641572"}

// <s>@miniticker, elements of !miniticker@arr — rolling 24h
{"e":"24hrMiniTicker","E":1792438737344,"s":"SOL-USD","c":"82.67","o":"82.67","h":"82.67","l":"82.67","v":"0.12","q":"9.9204"}

// <s>@kline_<i>[_mark|_index]
{"e":"kline","E":1792438738388,"s":"BTC-USD","k":{"t":1792438680000,"T":1792438739999,"s":"BTC-USD","i":"1m",
 "f":0,"L":0,"o":"81905.92917310","c":"81922.34641572","h":"81922.62624529","l":"81899.08236664",
 "v":"0","n":0,"x":false,"q":"0","V":"0","Q":"0","B":"0"}}
```

| Field | Meaning |
|-------|---------|
| `depthUpdate.U` / `u` | First / final order-book update ID coalesced into this message (uint64; same domain as REST `lastUpdateId`). Not contiguous across messages. |
| `depthUpdate.b` / `a` | Changed `[price, qty]` levels; `null` (not `[]`) when that side did not change. The first message after a symbol gets its first subscriber is the full top 20 without `"0"` removals (see `strike-orderbook`) |
| `markPriceUpdate.p` / `i` / `r` / `T` | Mark price / index price / current funding rate / next funding time (ms) |
| `24hrMiniTicker.c` `o` `h` `l` `v` `q` | Close (last), open, high, low, base volume, quote volume over 24h |
| `kline.k.t` / `T` | Candle open / close time (ms, close inclusive) |
| `kline.k.v` `q` `n` | Base volume, quote volume, trade count |
| `kline.k.V` / `Q` | Despite the names, base / quote volume of trades with `isBuyerMaker = true` (taker sells); taker-buy = `v − V` (quote `q − Q`) |
| (volume fields) | Always `"0"`/`0` on `_mark` and `_index` streams |
| `kline.k.x` | `true` on the final update of a closed candle |
| `kline.k.f`, `L`, `B` | Always `0`, `0`, `"0"` |

## Reconnection Pattern

- **Exponential backoff:** `delay = min(30000, 1000 * 2^attempt)`
- **Tab visibility:** when the tab becomes visible and the socket is not OPEN, reconnect immediately
- **Resubscribe** every active stream on reconnect, and re-fetch REST snapshots for stateful views (depth)

## Reference Counting

Track subscriptions per stream. Only send unsubscribe when the count reaches 0, so one component cannot kill another component's subscription.

## TypeScript Example

```typescript
type Handler = (event: any) => void;

// Streams whose payloads are indistinguishable on one socket.
const ambiguityKey = (stream: string) =>
  stream.replace(/@markprice@1s$/, "@markprice").replace(/@(kline_[0-9]+[mhdwM])_(mark|index)$/, "@$1");

class StrikePriceFeed {
  private ws: WebSocket | null = null;
  private refs = new Map<string, number>();           // stream name -> refcount
  private handlers = new Map<string, Set<Handler>>(); // event type -> handlers
  private attempt = 0;
  private nextId = 1;

  constructor(private url = "wss://api.strikefinance.org/ws/price") {}

  connect(): void {
    this.ws = new WebSocket(this.url);
    this.ws.onopen = () => {
      this.attempt = 0;
      const streams = [...this.refs.keys()];
      // Keep each request well under the 4 KiB inbound limit.
      for (let i = 0; i < streams.length; i += 50) this.send("SUBSCRIBE", streams.slice(i, i + 50));
    };
    this.ws.onmessage = (ev) => {
      for (const line of String(ev.data).split("\n")) {
        if (!line) continue;
        const msg = JSON.parse(line);
        const events = Array.isArray(msg) ? msg : [msg];
        for (const e of events) {
          if (e.e === "error") console.warn("WS error", e.error);
          this.handlers.get(e.e)?.forEach((h) => h(e));
        }
      }
    };
    this.ws.onclose = () => {
      const delay = Math.min(30_000, 1000 * 2 ** this.attempt++);
      setTimeout(() => this.connect(), delay);
    };
  }

  /** stream: "btc-usd@depth", "btc-usd@markprice@1s", "btc-usd@kline_1M_mark", "!miniticker@arr", ... */
  subscribe(stream: string): void {
    const clash = [...this.refs.keys()].find((s) => s !== stream && ambiguityKey(s) === ambiguityKey(stream));
    if (clash) throw new Error(`${stream} is indistinguishable from ${clash}; use another StrikePriceFeed (socket)`);
    const n = this.refs.get(stream) ?? 0;
    this.refs.set(stream, n + 1);
    if (n === 0) this.send("SUBSCRIBE", [stream]);
  }

  unsubscribe(stream: string): void {
    const n = this.refs.get(stream) ?? 0;
    if (n <= 1) {
      this.refs.delete(stream);
      this.send("UNSUBSCRIBE", [stream]);
    } else this.refs.set(stream, n - 1);
  }

  on(eventType: string, h: Handler): () => void {
    if (!this.handlers.has(eventType)) this.handlers.set(eventType, new Set());
    this.handlers.get(eventType)!.add(h);
    return () => this.handlers.get(eventType)?.delete(h);
  }

  private send(method: "SUBSCRIBE" | "UNSUBSCRIBE", params: string[]): void {
    if (this.ws?.readyState !== WebSocket.OPEN || params.length === 0) return;
    this.ws.send(JSON.stringify({ method, params, id: this.nextId++ })); // integer id required
  }
}

// Usage
const feed = new StrikePriceFeed();
feed.connect();
feed.on("markPriceUpdate", (e) => console.log(e.s, "mark", e.p, "index", e.i, "funding", e.r));
feed.on("trade", (e) => console.log(e.s, e.m ? "SELL" : "BUY", e.q, "@", e.p));
feed.on("kline", (e) => console.log(e.s, e.k.i, e.k.c, e.k.x ? "(closed)" : ""));
feed.subscribe("btc-usd@markprice@1s");
feed.subscribe("btc-usd@trade");
feed.subscribe("btc-usd@kline_1m");
feed.subscribe("!miniticker@arr");

// Mark-price candles for the same symbol/interval need their own socket.
const markFeed = new StrikePriceFeed();
markFeed.connect();
markFeed.on("kline", (e) => console.log("mark candle", e.k.t, e.k.c));
markFeed.subscribe("btc-usd@kline_1m_mark");
```
