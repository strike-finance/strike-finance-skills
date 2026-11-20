---
name: strike-orderbook
description: Strike Finance orderbook integration — REST depth snapshots, full-depth WebSocket diffs chained by pu, bookticker, local book sync, VWAP estimation, and the public L3 market-by-order feed (snapshot + sequenced order events). Use when building orderbook displays, market-making bots or calculating fill prices.
---

# Strike Finance Orderbook

Two public, unauthenticated order-book products:

| Product | REST | WebSocket | Use for |
|---------|------|-----------|---------|
| L2 (price levels) | `GET https://<host>/price/v2/depth` | `wss://<host>/ws/price`, stream `<symbol>@depth` (full book) and `<symbol>@bookticker` | UIs, top-of-book, VWAP |
| L3 (individual orders, FIFO) | `GET https://<host>/v2/l3/snapshot` | `wss://<host>/ws/l3`, stream `<symbol>@l3` | Exact book reconstruction, queue position |

`<host>` = `api.strikefinance.org` (mainnet) or `api-v2-testnet.strikefinance.org` (testnet).

## REST Depth Snapshot

**GET** `https://api.strikefinance.org/price/v2/depth?symbol=BTC-USD`

- `symbol` (required, case-sensitive, e.g. `BTC-USD`); `limit` levels per side, default **1000**, up to 65534 (larger values are clamped; missing, non-numeric or <= 0 → 1000).
- Returns the full book the `<symbol>@depth` stream **last published**, so `lastUpdateId` is exactly the `u` of that `depthUpdate` and the next one has `pu == lastUpdateId`. Not cached.
- Unknown symbol, or no book published for it yet → `200` with `lastUpdateId: 0` and empty arrays. Missing symbol → `400 {"code":"MISSING_PARAMETER",...}`.
- A side that returns fewer than `limit` levels is complete. If a side hits `limit`, your copy lacks the deeper levels until they change, so request a `limit` above the depth you care about.

```typescript
interface DepthSnapshot {
  lastUpdateId: number; // u of the last published depthUpdate (uint64)
  E: number;            // server response time (ms)
  T: number;            // matching-engine time of this book (ms); response time when nothing has been published
  bids: [string, string][]; // [price, quantity], highest first; never a zero size
  asks: [string, string][]; // [price, quantity], lowest first
}
```

## WebSocket Depth Diffs

**URL:** `wss://api.strikefinance.org/ws/price` (public, no auth). Full protocol (framing, keepalive, limits) is in `strike-price-feeds`.

```json
{"method": "subscribe", "channel": "depth", "symbol": "BTC-USD", "id": 1}
{"method": "unsubscribe", "channel": "depth", "symbol": "BTC-USD", "id": 2}
```

Equivalent Binance form: `{"method":"SUBSCRIBE","params":["btc-usd@depth"],"id":1}` (stream names lowercase, integer `id`).

```typescript
interface DepthUpdateEvent {
  e: "depthUpdate";
  E: number;              // server event time (ms)
  s: string;              // "BTC-USD"
  U: number;              // first order-book update ID coalesced into this message
  u: number;              // final order-book update ID
  pu: number;             // u of the previous depthUpdate for this symbol (0 on the very first one)
  b: [string, string][] | null; // changed bid levels [price, qty]; null when no bid level changed
  a: [string, string][] | null; // changed ask levels [price, qty]; null when no ask level changed
}
```

How the stream is produced:

- It covers the **whole book** (every level). Each message lists the levels whose size changed since the previous message for that symbol, with their **absolute** new size; `qty = "0"` means the price level is gone.
- Updates are coalesced and flushed every 100 ms, and sent only when the book changed.
- **Continuity:** each message's `pu` equals the previous message's `u`, and the REST snapshot's `lastUpdateId` is the `u` of the last message. A `pu` that does not match the last `u` you applied means a message was missed. `U` need not equal `pu + 1` (engine IDs are coalesced), so only check `pu`.
- The published book and its `u` survive service restarts, so the chain continues across them.
- `b` or `a` is JSON `null` (not `[]`) when that side has no changes; always read them as `ev.b ?? []`.
- There is no snapshot on subscribe — use the REST endpoint.
- A client that falls 1024 queued messages behind is **disconnected** (the socket is dropped without a close frame), never left open with a hole in the stream. Reconnect and re-sync.
- One frame may contain several `\n`-separated JSON messages.

## Synchronization Pattern (Critical)

1. **Subscribe** to `<symbol>@depth`, **buffer** incoming events, and wait for the ack `{"id":1,"result":null}` (the subscription is registered just before the ack is sent).
2. **Fetch** `GET /price/v2/depth?symbol=...` and record `lastUpdateId`.
3. **Drop** buffered events with `u <= lastUpdateId`. The first remaining event must have `pu == lastUpdateId`, and every later one `pu ==` the previous event's `u`.
4. **Apply:** for each `[price, qty]` in `ev.b ?? []` / `ev.a ?? []` — `qty === "0"` → delete; else `set(price, qty)`.
5. **Re-sync** (back to step 2, keep buffering) on any `pu` mismatch, and after every reconnect. No periodic re-sync is needed.

For a top-of-book view only, subscribe to `<symbol>@bookticker` instead: every message is a complete best bid/ask (no sync needed) and only the newest pending message is kept for slow clients.

```json
{"e":"bookTicker","E":1792438776570,"T":1792438776512,"s":"BTC-USD","u":93450741,"b":"82.55","B":"1.82","a":"82.67","A":"39.31"}
```

`b`/`B` = best bid price/size, `a`/`A` = best ask price/size (`""` when that side is empty), `u` = order-book update ID, `E` = publication time, `T` = matching-engine book time.

## VWAP Fill Estimation

```typescript
function estimateMarketFillPrice(
  orderBook: { bids: [string, string][]; asks: [string, string][] },
  side: "Long" | "Short",
  size: number
): number | null {
  const levels = side === "Long" ? orderBook.asks : orderBook.bids;
  let cost = 0;
  let filled = 0;
  for (const [priceStr, qtyStr] of levels) {
    const price = parseFloat(priceStr);
    const fill = Math.min(size - filled, parseFloat(qtyStr));
    cost += fill * price;
    filled += fill;
    if (filled >= size) break;
  }
  return filled >= size ? cost / filled : null;
}
```

Returns `null` when the visible book cannot fill the size.

## Full Implementation Example

```typescript
type PriceLevel = [string, string];
const BASE = "https://api.strikefinance.org/price/v2";
const SNAPSHOT_LIMIT = 5000; // levels per side; a side that returns fewer is the complete side

class OrderBookManager {
  private bids = new Map<string, string>();
  private asks = new Map<string, string>();
  private lastU = 0; // u of the last applied update (or the snapshot's lastUpdateId)
  private synced = false;
  private generation = 0; // bumped by every resync; stale snapshot fetches are discarded
  private buffer: DepthUpdateEvent[] = [];
  private ws: WebSocket | null = null;

  constructor(private symbol: string, private onUpdate: () => void) {}

  start(): void {
    this.ws = new WebSocket("wss://api.strikefinance.org/ws/price");
    this.ws.onopen = () => {
      this.ws!.send(JSON.stringify({ method: "subscribe", channel: "depth", symbol: this.symbol, id: 1 }));
    };
    this.ws.onmessage = (ev) => {
      for (const line of String(ev.data).split("\n")) {
        if (!line) continue;
        const msg = JSON.parse(line);
        if (msg.id === 1 && "result" in msg) void this.resync(); // subscribed: now take the snapshot
        else if (msg.e === "depthUpdate" && msg.s === this.symbol) this.onDepth(msg);
      }
    };
    this.ws.onclose = () => {
      // Also fires when the server drops a slow consumer.
      this.synced = false;
      this.generation++;
      setTimeout(() => this.start(), 1000); // reconnect; the new ack triggers a resync
    };
  }

  private async resync(): Promise<void> {
    const gen = ++this.generation;
    this.synced = false;
    this.buffer = [];
    try {
      const res = await fetch(`${BASE}/depth?symbol=${encodeURIComponent(this.symbol)}&limit=${SNAPSHOT_LIMIT}`);
      if (!res.ok) throw new Error(`depth HTTP ${res.status}`);
      const snap: DepthSnapshot = await res.json();
      if (gen !== this.generation) return; // a newer resync (or reconnect) superseded this one
      this.bids = new Map(snap.bids);
      this.asks = new Map(snap.asks);
      this.lastU = snap.lastUpdateId;
      const pending = this.buffer.filter((ev) => ev.u > this.lastU);
      this.buffer = [];
      this.synced = true;
      for (const ev of pending) if (!this.apply(ev)) return void this.resync();
      this.onUpdate();
    } catch {
      if (gen === this.generation) setTimeout(() => void this.resync(), 1000); // retry, never stay unsynced
    }
  }

  private onDepth(ev: DepthUpdateEvent): void {
    if (!this.synced) {
      this.buffer.push(ev);
      return;
    }
    if (ev.u <= this.lastU) return; // already contained in the snapshot
    if (!this.apply(ev)) return void this.resync(); // pu gap: a message was missed
    this.onUpdate();
  }

  /** Applies ev if it continues the pu chain; returns false on a gap. */
  private apply(ev: DepthUpdateEvent): boolean {
    if (ev.pu !== this.lastU) return false;
    for (const [p, q] of ev.b ?? []) q === "0" ? this.bids.delete(p) : this.bids.set(p, q);
    for (const [p, q] of ev.a ?? []) q === "0" ? this.asks.delete(p) : this.asks.set(p, q);
    this.lastU = ev.u;
    return true;
  }

  getSortedBids(depth = 20): PriceLevel[] {
    return [...this.bids.entries()].sort((a, b) => parseFloat(b[0]) - parseFloat(a[0])).slice(0, depth);
  }

  getSortedAsks(depth = 20): PriceLevel[] {
    return [...this.asks.entries()].sort((a, b) => parseFloat(a[0]) - parseFloat(b[0])).slice(0, depth);
  }

  estimateFillPrice(side: "Long" | "Short", size: number): number | null {
    return estimateMarketFillPrice(
      { bids: this.getSortedBids(Infinity), asks: this.getSortedAsks(Infinity) }, side, size
    );
  }

  destroy(): void {
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }
  }
}

// Usage
const book = new OrderBookManager("BTC-USD", () => {
  console.log("best bid", book.getSortedBids(1)[0], "best ask", book.getSortedAsks(1)[0]);
});
book.start();
```

For UIs, batch renders (e.g. `requestAnimationFrame`, ~150 ms throttle) instead of re-rendering on every message.

## L3 Market-by-Order Feed

Every visible resting order, in exact price/FIFO priority, plus a lossless per-symbol sequence of order events. Public and anonymous (no API wallet, no `session.logon`). Served by a separate service directly on the API host (no `/price` prefix):

| | Mainnet | Testnet |
|--|---------|---------|
| Snapshot | `https://api.strikefinance.org/v2/l3/snapshot?symbol=BTC-USD` | `https://api-v2-testnet.strikefinance.org/v2/l3/snapshot?symbol=BTC-USD` |
| WebSocket | `wss://api.strikefinance.org/ws/l3` | `wss://api-v2-testnet.strikefinance.org/ws/l3` |

Every market the engine publishes is served (a new market joins when it is created, starting at sequence 0); take symbols from `GET /v2/markets` rather than a fixed list. Any other symbol gets `400 unsupported or missing symbol` (REST) or `unsupported L3 channel` (WS).

### Snapshot

`symbol` is trimmed and upper-cased. The book is complete (never truncated or paginated); bids descending, asks ascending, orders within a level in FIFO priority. Prices and sizes, here and in updates, are canonical decimal strings without trailing zeros (`"72247.3"`, not `"72247.30"`).

```json
{
  "type": "l3_snapshot",
  "symbol": "BTC-USD",
  "last_sequence": 11197,
  "timestamp": 1792438895126,
  "bids": [
    {"price": "72247.3", "orders": [{"order_id": "9Ix5zep5IpZafACmP1p_3Q", "size": "0.01107"}]},
    {"price": "72178.8", "orders": [{"order_id": "OKIEOZ727YYzn5Cy8JOxGA", "size": "0.01108"}]}
  ],
  "asks": []
}
```

`last_sequence` is the symbol's sequence the snapshot corresponds to; `timestamp` is the server time of the read.

| Status | Body |
|--------|------|
| 400 | `{"error":"unsupported or missing symbol"}`, `{"error":"invalid client IP"}` |
| 403 | `{"error":"L3 is unavailable on this host"}` |
| 429 | `{"error":"L3 request limit exceeded"}` |
| 503 | `{"error":"L3 snapshot unavailable"}` (state not ready / publisher down), `{"error":"L3 request limit unavailable"}` |

### WebSocket

```json
{"method": "SUBSCRIBE", "params": ["btc-usd@l3"], "id": 1}
{"method": "UNSUBSCRIBE", "params": ["btc-usd@l3"], "id": 2}
```

- Only `SUBSCRIBE`/`UNSUBSCRIBE` (uppercase). Channel names are lower-cased by the server. `id` is echoed (any JSON value).
- Ack: `{"id": 1, "result": null}`. Error: `{"error": {"code": 400, "msg": "unsupported L3 channel"}, "id": 1}`; other messages are `L3 subscription limit exceeded`, `params must contain at least one L3 channel`, `unsupported method`, `invalid JSON` (the last three with `"id": null`).
- No app-level ping. The server sends a ping frame every 54 s; the 60 s read deadline is extended **only by pong frames** (not by your messages), so the client must answer pings (most libraries do automatically).
- One update per frame (no `\n` batching).
- Handshake (HTTP) errors: `403 {"error":"L3 is unavailable on this host"}`, `400 {"error":"invalid client IP"}`, `429 {"error":"L3 request limit exceeded"}`, `503 {"error":"L3 request limit unavailable"}`, `503 {"error":"L3 state is not ready"}`, `429 {"error":"L3 WebSocket connection limit exceeded"}`, `503 {"error":"L3 WebSocket connection limit unavailable"}`.

Update event:

```json
{
  "type": "l3_update",
  "symbol": "BTC-USD",
  "action": "partial_fill",
  "order_id": "9Ix5zep5IpZafACmP1p_3Q",
  "taker_order_id": "Qm3x0bJr2dW8cT1uVf5yHg",
  "side": "buy",
  "price": "72247.3",
  "delta_size": "-0.004",
  "remaining_size": "0.00707",
  "sequence": 11198,
  "trade_id": 18072,
  "order_type": "fill",
  "timestamp": 1792438901234
}
```

| `action` | Fields present | Effect on local book |
|----------|----------------|----------------------|
| `open` | `order_id`, `side`, `price`, `delta_size` (= `remaining_size`, > 0) | Append order at the **tail** of its price level |
| `cancel` | same, `delta_size` < 0, `remaining_size` `"0"` | Remove order (no trade) |
| `partial_fill` | + `trade_id`, `taker_order_id`, `order_type`; `remaining_size` > 0 | Set order size to `remaining_size` (keeps queue position) |
| `full_fill` | + `trade_id`, `taker_order_id`, `order_type`; `remaining_size` `"0"` | Remove order |
| `clear` | only `type`, `symbol`, `action`, `sequence`, `timestamp` | Discard the local book and re-bootstrap from a snapshot |

- `side` is `"buy"` or `"sell"`; `order_id` is an opaque 22-character base64url ID, stable for the order's lifetime (a cancel-and-replace gets a new ID). `taker_order_id` matches the later `open` `order_id` if the taker's remainder rests.
- `trade_id` is the public trade ID (same as `/price/v2/trades` `id` and WS `trade.t`).
- `order_type` (fills only): `liquidation` when the taker was a position being liquidated, otherwise `fill`; it matches `order_type` on the public trade with the same `trade_id`. ADL settles off the book, so it never appears in L3.
- `timestamp` is the engine mutation time (ms).
- Every update, including `clear`, advances the symbol's `sequence` by exactly 1. The engine emits one `clear` per symbol on every restart. There is no `modify` action: a replace is a `cancel` plus an `open` with a new `order_id`.

### L3 bootstrap and recovery

1. Connect, `SUBSCRIBE` to `<symbol>@l3`, buffer updates, and wait for the ack (the subscription is registered just before it is sent; a snapshot fetched earlier can miss updates).
2. `GET /v2/l3/snapshot?symbol=...` → build the book; `last = last_sequence`.
3. Drop buffered updates with `sequence <= last`; apply the rest. Each must have `sequence === last + 1`.
4. On a gap, a `clear`, or a socket close, throw the book away and repeat from step 1.

Price strings are canonical in both the snapshot and updates, so they can key price levels directly.

The server never drops an update to keep a socket alive: it **closes** the connection instead — `1013` (client too slow or connection lease lost) or `1012` (server-side sequence gap, stream or publisher unavailable). Reconnect and re-snapshot on any close.

```typescript
type L3Order = { id: string; size: string };
type L3Side = Map<string, L3Order[]>; // price (canonical string) -> FIFO queue

function runL3(symbol = "BTC-USD", host = "api.strikefinance.org") {
  const bids: L3Side = new Map(), asks: L3Side = new Map();
  let last = -1;
  let dead = false;
  const buffered: any[] = [];
  const ws = new WebSocket(`wss://${host}/ws/l3`);
  const restart = () => { dead = true; ws.close(); }; // onclose re-bootstraps

  const apply = (u: any) => {
    if (dead) return;
    if (u.sequence !== last + 1 || u.action === "clear") return restart();
    last = u.sequence;
    const book = u.side === "buy" ? bids : asks;
    const key = u.price;
    const queue = book.get(key) ?? [];
    if (u.action === "open") queue.push({ id: u.order_id, size: u.remaining_size });
    else {
      const i = queue.findIndex((o) => o.id === u.order_id);
      if (i < 0) return restart();
      if (u.remaining_size === "0") queue.splice(i, 1);
      else queue[i].size = u.remaining_size;
    }
    queue.length ? book.set(key, queue) : book.delete(key);
  };

  const bootstrap = async () => {
    const res = await fetch(`https://${host}/v2/l3/snapshot?symbol=${symbol}`);
    if (!res.ok) return restart(); // 429/503: back off and retry
    const snap = await res.json();
    if (dead) return;
    for (const [side, levels] of [[bids, snap.bids], [asks, snap.asks]] as const) {
      for (const lvl of levels) side.set(lvl.price, lvl.orders.map((o: any) => ({ id: o.order_id, size: o.size })));
    }
    last = snap.last_sequence;
    for (const u of buffered) if (u.sequence > last) apply(u);
    buffered.length = 0;
  };

  ws.onopen = () => ws.send(JSON.stringify({ method: "SUBSCRIBE", params: [`${symbol.toLowerCase()}@l3`], id: 1 }));
  ws.onclose = () => { dead = true; setTimeout(() => runL3(symbol, host), 1000); };
  ws.onmessage = (ev) => {
    const msg = JSON.parse(String(ev.data));
    if (msg.id === 1) {
      if (msg.error) return restart();       // e.g. unsupported L3 channel
      void bootstrap().catch(restart);       // subscribed: now take the snapshot
    } else if (msg.type === "l3_update") {
      if (last < 0) buffered.push(msg);
      else apply(msg);
    }
  };
}
```

### L3 limits

- 10 requests/s per source IP, shared by snapshot requests and WebSocket handshakes.
- 10 concurrent L3 WebSocket connections per source IP; 10 subscriptions per connection.
- Client messages up to 4 KiB.
