---
name: strike-orderbook
description: Strike Finance orderbook integration — REST depth snapshots, top-20 WebSocket depth diffs, bookticker, local book sync, VWAP estimation, and the public L3 market-by-order feed (snapshot + sequenced order events). Use when building orderbook displays, market-making bots or calculating fill prices.
---

# Strike Finance Orderbook

Two public, unauthenticated order-book products:

| Product | REST | WebSocket | Use for |
|---------|------|-----------|---------|
| L2 (price levels) | `GET https://<host>/price/v2/depth` | `wss://<host>/ws/price`, stream `<symbol>@depth` (top 20) and `<symbol>@bookticker` | UIs, top-of-book, VWAP |
| L3 (individual orders, FIFO) | `GET https://<host>/v2/l3/snapshot` | `wss://<host>/ws/l3`, stream `<symbol>@l3` | Exact book reconstruction, queue position |

`<host>` = `api.strikefinance.org` (mainnet) or `api-v2-testnet.strikefinance.org` (testnet).

## REST Depth Snapshot

**GET** `https://api.strikefinance.org/price/v2/depth?symbol=BTC-USD&limit=20`

- `symbol` (required, case-sensitive, e.g. `BTC-USD`); `limit` levels per side, default 20, max 1000.
- Read live from the engine snapshot on every request (not cached).
- Unknown symbol → `200` with `lastUpdateId: 0` and empty arrays. Missing symbol → `400 {"code":"MISSING_PARAMETER",...}`.

```typescript
interface DepthSnapshot {
  lastUpdateId: number; // uint64 order-book update ID (same domain as WS U/u)
  E: number;            // server response time (ms)
  T: number;            // time the engine produced the snapshot (ms)
  bids: [string, string][]; // [price, quantity], highest first
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
  b: [string, string][] | null; // changed bid levels [price, qty]; null when no bid level changed
  a: [string, string][] | null; // changed ask levels [price, qty]; null when no ask level changed
}
```

How the stream is produced (this drives the sync rules):

- It covers only the **top 20 levels per side**. Each message lists levels whose size changed since the previous message on the channel, with their **absolute** new size.
- `qty = "0"` means the level is no longer in the top 20 — it was removed **or** pushed below level 20.
- Updates are coalesced and flushed every 100 ms, and sent only when the top 20 changed.
- `U`/`u` are **not contiguous** between messages; a gap is not a missed update.
- Each message is a diff against the **previous message published on the channel** (the server's last published top 20), **not against your REST snapshot**. A level that differed between your snapshot and that server state, and is not touched again, stays wrong until you re-sync.
- `b` or `a` is JSON `null` (not `[]`) when that side has no changes; always read them as `ev.b ?? []`.
- There is no snapshot on subscribe — use the REST endpoint.
- When a symbol gets its **first** depth subscriber on the server (no depth subscribers before, or after a service restart), the next message is the **full current top 20 with no `"0"` removals**, sent to whoever is subscribed at that moment. Nothing in the payload marks it, and you cannot know whether you were first. Applied on top of a REST seed, any seed level that is no longer in the book survives, so re-seed after it (step 3 below).
- A client that falls behind (1024 queued messages) silently loses messages while staying connected; IDs cannot reveal this, so re-sync periodically.
- One frame may contain several `\n`-separated JSON messages.

## Synchronization Pattern (Critical)

1. **Subscribe** to `<symbol>@depth`, **buffer** incoming events, and wait for the ack `{"id":1,"result":null}` (the subscription is registered just before the ack is sent).
2. **Fetch** `GET /price/v2/depth?symbol=...&limit=20` and record `lastUpdateId`.
3. **Drop** buffered events with `u <= lastUpdateId`; apply the rest in order. When the **first** `depthUpdate` after a (re)subscribe arrives, re-seed once more from REST (keep that event in the buffer) — it may be a full top-20 push without removals.
4. For each live event: skip if `u <= lastAppliedU`, otherwise apply it and set `lastAppliedU = u`.
5. **Apply:** for each `[price, qty]` in `ev.b ?? []` / `ev.a ?? []` — `qty === "0"` → delete; else `set(price, qty)`. Then keep only the best 20 levels per side (deeper levels are never updated by the stream).
6. **Re-sync** (back to step 2) after every reconnect, if the book crosses (best bid >= best ask), and periodically (e.g. every 60 s). Periodic re-sync is required for **correctness**, not only to recover dropped messages, because diffs are relative to the server's previous message rather than your snapshot.

For a top-of-book view only, subscribe to `<symbol>@bookticker` instead: every message is a complete best bid/ask (no sync needed) and only the newest pending message is kept for slow clients.

```json
{"e":"bookTicker","E":1792438776570,"s":"BTC-USD","u":93450741,"b":"82.55","B":"1.82","a":"82.67","A":"39.31"}
```

`b`/`B` = best bid price/size, `a`/`A` = best ask price/size (`""` when that side is empty), `u` = order-book update ID.

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

Returns `null` when the visible book cannot fill the size. The WS book only has 20 levels per side; for larger sizes fetch `/price/v2/depth` with a higher `limit`.

## Full Implementation Example

```typescript
type PriceLevel = [string, string];
const DEPTH = 20;
const BASE = "https://api.strikefinance.org/price/v2";

class OrderBookManager {
  private bids = new Map<string, string>();
  private asks = new Map<string, string>();
  private lastAppliedU = 0;
  private synced = false;
  private awaitingFirstDiff = false; // first depthUpdate after subscribe may be a full top-20 push
  private generation = 0; // bumped by every resync; stale snapshot fetches are discarded
  private buffer: DepthUpdateEvent[] = [];
  private ws: WebSocket | null = null;
  private resyncTimer: ReturnType<typeof setInterval> | null = null;

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
        if (msg.id === 1 && "result" in msg) {
          this.awaitingFirstDiff = true;
          void this.resync(); // subscribed: now take the snapshot
        }
        else if (msg.e === "depthUpdate" && msg.s === this.symbol) this.onDepth(msg);
      }
    };
    this.ws.onclose = () => {
      this.synced = false;
      this.generation++;
      setTimeout(() => this.start(), 1000); // reconnect; the new ack triggers a resync
    };
    this.resyncTimer ??= setInterval(() => { if (this.synced) void this.resync(); }, 60_000);
  }

  private async resync(keep?: DepthUpdateEvent): Promise<void> {
    const gen = ++this.generation;
    this.synced = false;
    this.buffer = keep ? [keep] : [];
    try {
      const res = await fetch(`${BASE}/depth?symbol=${encodeURIComponent(this.symbol)}&limit=${DEPTH}`);
      if (!res.ok) throw new Error(`depth HTTP ${res.status}`);
      const snap: DepthSnapshot = await res.json();
      if (gen !== this.generation) return; // a newer resync (or reconnect) superseded this one
      this.bids = new Map(snap.bids);
      this.asks = new Map(snap.asks);
      this.lastAppliedU = snap.lastUpdateId;
      for (const ev of this.buffer) if (ev.u > this.lastAppliedU) this.apply(ev);
      this.buffer = [];
      this.synced = true;
      this.onUpdate();
    } catch {
      if (gen === this.generation) setTimeout(() => void this.resync(), 1000); // retry, never stay unsynced
    }
  }

  private onDepth(ev: DepthUpdateEvent): void {
    if (this.awaitingFirstDiff) {
      // Possibly a full top-20 push with no "0" removals: re-seed from REST, keeping this event.
      this.awaitingFirstDiff = false;
      void this.resync(ev);
      return;
    }
    if (!this.synced) {
      this.buffer.push(ev);
      return;
    }
    if (ev.u <= this.lastAppliedU) return;
    this.apply(ev);
    if (this.crossed()) void this.resync();
    else this.onUpdate();
  }

  private apply(ev: DepthUpdateEvent): void {
    for (const [p, q] of ev.b ?? []) q === "0" ? this.bids.delete(p) : this.bids.set(p, q);
    for (const [p, q] of ev.a ?? []) q === "0" ? this.asks.delete(p) : this.asks.set(p, q);
    this.bids = new Map(this.getSortedBids());
    this.asks = new Map(this.getSortedAsks());
    this.lastAppliedU = ev.u;
  }

  private crossed(): boolean {
    const bb = this.getSortedBids()[0], ba = this.getSortedAsks()[0];
    return !!bb && !!ba && parseFloat(bb[0]) >= parseFloat(ba[0]);
  }

  getSortedBids(): PriceLevel[] {
    return [...this.bids.entries()].sort((a, b) => parseFloat(b[0]) - parseFloat(a[0])).slice(0, DEPTH);
  }

  getSortedAsks(): PriceLevel[] {
    return [...this.asks.entries()].sort((a, b) => parseFloat(a[0]) - parseFloat(b[0])).slice(0, DEPTH);
  }

  estimateFillPrice(side: "Long" | "Short", size: number): number | null {
    return estimateMarketFillPrice({ bids: this.getSortedBids(), asks: this.getSortedAsks() }, side, size);
  }

  destroy(): void {
    if (this.resyncTimer) clearInterval(this.resyncTimer);
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }
  }
}

// Usage
const book = new OrderBookManager("BTC-USD", () => {
  console.log("best bid", book.getSortedBids()[0], "best ask", book.getSortedAsks()[0]);
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

Only allowlisted symbols are served (currently `BTC-USD`).

### Snapshot

`symbol` is trimmed and upper-cased. The book is complete (never truncated or paginated); bids descending, asks ascending, orders within a level in FIFO priority.

```json
{
  "type": "l3_snapshot",
  "symbol": "BTC-USD",
  "last_sequence": 11197,
  "timestamp": 1792438895126,
  "bids": [
    {"price": "72247.30", "orders": [{"order_id": "9Ix5zep5IpZafACmP1p_3Q", "size": "0.01107"}]},
    {"price": "72178.80", "orders": [{"order_id": "OKIEOZ727YYzn5Cy8JOxGA", "size": "0.01108"}]}
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
  "price": "72247.30",
  "delta_size": "-0.004",
  "remaining_size": "0.00707",
  "sequence": 11198,
  "trade_id": 18072,
  "timestamp": 1792438901234
}
```

| `action` | Fields present | Effect on local book |
|----------|----------------|----------------------|
| `open` | `order_id`, `side`, `price`, `delta_size` (= `remaining_size`, > 0) | Append order at the **tail** of its price level |
| `modify` | same, `delta_size` < 0, `remaining_size` > 0 | Reduce in place, keep queue position (reserved; no engine operation emits it today) |
| `cancel` | same, `delta_size` < 0, `remaining_size` `"0"` | Remove order (no trade) |
| `partial_fill` | + `trade_id`, `taker_order_id`; `remaining_size` > 0 | Set order size to `remaining_size` |
| `full_fill` | + `trade_id`, `taker_order_id`; `remaining_size` `"0"` | Remove order |
| `clear` | only `type`, `symbol`, `action`, `sequence`, `timestamp` | Discard the local book and re-bootstrap from a snapshot |

- `side` is `"buy"` or `"sell"`; `order_id` is an opaque 22-character base64url ID, stable for the order's lifetime (a cancel-and-replace gets a new ID). `taker_order_id` matches the later `open` `order_id` if the taker's remainder rests.
- `trade_id` is the public trade ID (same as `/price/v2/trades` `id` and WS `trade.t`).
- `timestamp` is the engine mutation time (ms).
- Every update, including `clear`, advances the symbol's `sequence` by exactly 1. The engine emits `clear` on every restart.

### L3 bootstrap and recovery

1. Connect, `SUBSCRIBE` to `<symbol>@l3`, buffer updates, and wait for the ack (the subscription is registered just before it is sent; a snapshot fetched earlier can miss updates).
2. `GET /v2/l3/snapshot?symbol=...` → build the book; `last = last_sequence`.
3. Drop buffered updates with `sequence <= last`; apply the rest. Each must have `sequence === last + 1`.
4. On a gap, a `clear`, or a socket close, throw the book away and repeat from step 1.

Key price levels by a canonical price string: the same price can be spelled with different trailing zeros (`"72247.30"` vs `"72247.3"`), and a snapshot level shows the first order's spelling while each update carries its own order's spelling.

The server never drops an update to keep a socket alive: it **closes** the connection instead — `1013` (client too slow or connection lease lost) or `1012` (server-side sequence gap, stream or publisher unavailable). Reconnect and re-snapshot on any close.

```typescript
type L3Order = { id: string; size: string };
type L3Side = Map<string, L3Order[]>; // canonical price -> FIFO queue
const px = (p: string) => (p.includes(".") ? p.replace(/0+$/, "").replace(/\.$/, "") : p);

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
    const key = px(u.price);
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
      for (const lvl of levels) side.set(px(lvl.price), lvl.orders.map((o: any) => ({ id: o.order_id, size: o.size })));
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
