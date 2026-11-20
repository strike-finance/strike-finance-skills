---
name: strike-trades
description: Strike Finance public market trades — recent trades via REST (/price/v2/trades, with per-market seq and fromSeq gap refill) and the real-time <symbol>@trade WebSocket stream, including liquidation/ADL flags (order_type). Use when building trade tapes / time-and-sales feeds. For a user's own fills see strike-history (REST) and strike-userstream (real time).
---

# Strike Finance Trades

Public, unauthenticated market trades: a REST snapshot of recent trades plus a real-time WebSocket stream, both numbered per market so a client can detect and refill gaps.

**A user's own fills are not covered here:** use the `strike-history` skill for fill history over REST and `strike-userstream` for real-time fills (`ORDER_TRADE_UPDATE`).

## Trade IDs, `seq` and `order_type`

- `id` (REST) / `t` (WS) is the trade ID from one exchange-wide sequence shared by every market. A market's IDs increase but skip, so an ID gap is **not** a missed trade.
- `seq` is the trade's number on its market: +1 per trade on that market, the same value on REST and WS. It starts at the market's historical trade count, never goes back or restarts. Use it for gap detection.
- `order_type` says why the trade happened: `fill` (ordinary), `liquidation` (the taker was a position being liquidated on the book) or `adl` (auto-deleveraging closed a position at a settlement price, off the book; one print per deleveraged counterparty, with the force-closed side as the taker). ADL trades are listed and numbered but are **not market prices**: candles, last price and 24h volume leave them out. Trades stored before this field existed report `fill`.

## REST: Recent Trades

**GET** `https://api.strikefinance.org/price/v2/trades?symbol=BTC-USD&limit=50`

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `symbol` | string | Yes | Case-sensitive market symbol, e.g. `BTC-USD` |
| `limit` | number | No | Default 100, max 1000 (non-numeric or <= 0 → 100) |
| `fromSeq` | number | No | Refill mode: the **oldest** `limit` trades with `seq >= fromSeq` (response still newest first). Trades without a `seq` are not returned |

- Returns trades **newest first**. The server keeps only the latest 1000 trades per market; there is no older paging, so a gap longer than that cannot be fully refilled.
- Unknown symbol → `[]`. Missing symbol → `400 {"code":"MISSING_PARAMETER","msg":"symbol parameter is required"}`. Bad `fromSeq` → `400 {"code":"INVALID_PARAMETER","msg":"fromSeq must be a non-negative integer"}`.
- Without `fromSeq`, cached about 5 s server-side (`X-Cache: HIT|MISS`), so use the WebSocket for live data. `fromSeq` requests are never cached.

```typescript
interface RestTrade {
  id: number;           // exchange-wide trade ID (same as WS "t")
  seq?: number;         // per-market trade number (same as WS "seq"); absent for a moment on a trade the stream has not published yet
  price: string;
  qty: string;          // base quantity
  quoteQty: string;     // price * qty
  time: number;         // trade time (ms)
  isBuyerMaker: boolean;
  order_type: "fill" | "liquidation" | "adl";
}
```

```json
[{"id":18071,"seq":812,"price":"77117.60","qty":"0.0099","quoteQty":"763.464240","time":1792172831028,"isBuyerMaker":true,"order_type":"fill"}]
```

**Refilling a gap:** request `fromSeq = lastSeq + 1`, then again with the highest `seq` returned + 1, until the response is empty. Drop duplicates by `seq`.

## WebSocket: `<symbol>@trade`

**URL:** `wss://api.strikefinance.org/ws/price` (testnet `wss://api-v2-testnet.strikefinance.org/ws/price`), public, no auth. See `strike-price-feeds` for framing, keepalive and limits.

```json
{"method": "subscribe", "channel": "trade", "symbol": "BTC-USD", "id": 1}
{"method": "unsubscribe", "channel": "trade", "symbol": "BTC-USD", "id": 2}
```

Binance form: `{"method":"SUBSCRIBE","params":["btc-usd@trade"],"id":1}` (lowercase stream names, integer `id`). Ack: `{"result":null,"id":1}`.

```typescript
interface TradeEvent {
  e: "trade";
  E: number;    // server event time (ms)
  s: string;    // "BTC-USD"
  t: number;    // exchange-wide trade ID
  seq: number;  // per-market trade number, +1 per trade
  p: string;    // price
  q: string;    // base quantity
  T: number;    // trade time (ms)
  m: boolean;   // buyer is maker
  order_type: "fill" | "liquidation" | "adl";
}
```

```json
{"e":"trade","E":1792172831030,"s":"BTC-USD","t":18071,"seq":812,"p":"77117.60","q":"0.0099","T":1792172831028,"m":true,"order_type":"fill"}
```

- `m: true` → the seller was the taker (sell aggressor, red). `m: false` → the buyer was the taker (buy aggressor, green).
- One message per trade, no order IDs. Several messages may share one WebSocket frame separated by `\n`.
- **Gap rule:** if `seq` is not the last `seq` you received + 1, refill from REST with `fromSeq`. In the rare case the service could not read some trades at all, it skips a number on purpose so clients refill.
- A client that falls 1024 queued messages behind is **disconnected** (dropped without a close frame); missed trades are not replayed on reconnect, so refill by `fromSeq` after every reconnect. A service restart does not re-send trades it already published.
- The same trade ID appears as `trade_id` in the L3 feed fill events (`strike-orderbook`), where `order_type` is `fill` or `liquidation`.

## Full Implementation Example

```typescript
interface Trade {
  tradeId: number;
  seq: number;
  time: number;
  price: string;
  quantity: string;
  isBuyerMaker: boolean;
  orderType: "fill" | "liquidation" | "adl";
}

const REST = "https://api.strikefinance.org/price/v2/trades";
const fromRest = (t: RestTrade): Trade => ({
  tradeId: t.id, seq: t.seq!, time: t.time, price: t.price, quantity: t.qty,
  isBuyerMaker: t.isBuyerMaker, orderType: t.order_type,
});

class TradeManager {
  private trades: Trade[] = []; // newest first, at most MAX_TRADES
  private lastSeq = 0;          // last seq applied; 0 until the first backfill
  private pending: Trade[] = []; // WS trades held while a refill runs
  private refilling = false;
  private ws: WebSocket | null = null;
  private readonly MAX_TRADES = 50;

  constructor(private symbol: string, private onUpdate: (trades: Trade[]) => void) {}

  start(): void {
    this.ws = new WebSocket("wss://api.strikefinance.org/ws/price");
    this.ws.onopen = () => {
      this.ws!.send(JSON.stringify({ method: "subscribe", channel: "trade", symbol: this.symbol, id: 1 }));
      void this.refill(); // initial backfill, and catch-up after every reconnect
    };
    this.ws.onmessage = (ev) => {
      for (const line of String(ev.data).split("\n")) {
        if (!line) continue;
        const e = JSON.parse(line);
        if (e.e !== "trade" || e.s !== this.symbol) continue;
        this.onTrade({ tradeId: e.t, seq: e.seq, time: e.T, price: e.p, quantity: e.q, isBuyerMaker: e.m, orderType: e.order_type });
      }
    };
    this.ws.onclose = () => setTimeout(() => this.start(), 1000);
  }

  private onTrade(t: Trade): void {
    if (this.refilling) return void this.pending.push(t);
    if (t.seq <= this.lastSeq) return; // duplicate
    if (t.seq !== this.lastSeq + 1) {  // gap: hold it and fetch the missing range
      this.pending.push(t);
      return void this.refill();
    }
    this.push(t);
    this.onUpdate([...this.trades]);
  }

  /** Latest trades on first load; afterwards every trade from lastSeq + 1 on. */
  private async refill(): Promise<void> {
    if (this.refilling) return;
    this.refilling = true;
    try {
      for (let idle = 0; idle < 3; ) {
        const qs = this.lastSeq ? `fromSeq=${this.lastSeq + 1}&limit=1000` : `limit=${this.MAX_TRADES}`;
        const res = await fetch(`${REST}?symbol=${encodeURIComponent(this.symbol)}&${qs}`);
        if (!res.ok) throw new Error(`trades HTTP ${res.status}`);
        const page: RestTrade[] = await res.json(); // newest first
        const got = page.filter((t) => t.seq !== undefined && t.seq > this.lastSeq).reverse();
        for (const t of got) this.push(fromRest(t));
        if (got.length === 1000) continue; // more to page through
        const nextLive = Math.min(...this.pending.map((t) => t.seq));
        if (nextLive <= this.lastSeq + 1) break; // caught up with the stream (or nothing held)
        idle++; // the missing trade may not be numbered on REST yet
        await new Promise((r) => setTimeout(r, 500));
      }
    } catch {
      // Network error: held trades are applied below; the next gap refills again.
    } finally {
      this.refilling = false;
      // Anything still ahead is older than the kept 1000 trades or unavailable: accept the jump.
      const held = this.pending.sort((a, b) => a.seq - b.seq);
      this.pending = [];
      for (const t of held) if (t.seq > this.lastSeq) this.push(t);
      this.onUpdate([...this.trades]);
    }
  }

  private push(t: Trade): void {
    this.lastSeq = t.seq;
    this.trades.unshift(t);
    if (this.trades.length > this.MAX_TRADES) this.trades.length = this.MAX_TRADES;
  }

  destroy(): void {
    if (!this.ws) return;
    this.ws.onclose = null;
    this.ws.close();
    this.ws = null;
  }
}

// Usage
const tape = new TradeManager("BTC-USD", (trades) => {
  for (const t of trades.slice(0, 10)) {
    const tag = t.orderType === "fill" ? "" : ` [${t.orderType}]`;
    console.log(`${t.isBuyerMaker ? "SELL" : "BUY"} ${t.quantity} @ ${t.price}${tag}`);
  }
});
tape.start();
```

For a price chart, skip `order_type: "adl"` prints (they are settlement prices, not market prices).
