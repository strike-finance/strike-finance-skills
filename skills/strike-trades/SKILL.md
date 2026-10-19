---
name: strike-trades
description: Strike Finance public market trades — recent trades via REST (/price/v2/trades) and the real-time <symbol>@trade WebSocket stream. Use when building trade tapes / time-and-sales feeds. For a user's own fills see strike-history (REST) and strike-userstream (real time).
---

# Strike Finance Trades

Public, unauthenticated market trades: a REST snapshot of recent trades plus a real-time WebSocket stream.

**A user's own fills are not covered here:** use the `strike-history` skill for fill history over REST and `strike-userstream` for real-time fills (`ORDER_TRADE_UPDATE`).

## REST: Recent Trades

**GET** `https://api.strikefinance.org/price/v2/trades?symbol=BTC-USD&limit=50`

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `symbol` | string | Yes | Case-sensitive market symbol, e.g. `BTC-USD` |
| `limit` | number | No | Default 100, max 1000 (non-numeric or <= 0 → 100) |

- Returns trades **newest first**. The server keeps only the latest 1000 trades per symbol; there is no older paging on this endpoint.
- Unknown symbol → `[]`. Missing symbol → `400 {"code":"MISSING_PARAMETER","msg":"symbol parameter is required"}`.
- Cached about 5 s server-side (`X-Cache: HIT|MISS`), so use the WebSocket for live data.

```typescript
interface RestTrade {
  id: number;           // trade ID (same as WS "t")
  price: string;
  qty: string;          // base quantity
  quoteQty: string;     // price * qty
  time: number;         // trade time (ms)
  isBuyerMaker: boolean;
}
```

```json
[{"id":18071,"price":"77117.60","qty":"0.0099","quoteQty":"763.464240","time":1792172831028,"isBuyerMaker":true}]
```

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
  t: number;    // trade ID
  p: string;    // price
  q: string;    // base quantity
  T: number;    // trade time (ms)
  m: boolean;   // buyer is maker
}
```

```json
{"e":"trade","E":1792172831030,"s":"BTC-USD","t":18071,"p":"77117.60","q":"0.0099","T":1792172831028,"m":true}
```

- `m: true` → the seller was the taker (sell aggressor, red).
- `m: false` → the buyer was the taker (buy aggressor, green).
- One message per trade, no order IDs. Several messages may share one WebSocket frame separated by `\n`.
- A client that falls behind by 1024 queued messages loses messages (the socket stays open); refill from REST after reconnects.
- The same trade ID appears as `trade_id` in the L3 feed fill events (`strike-orderbook`).

## Deduplication

Deduplicate by trade ID (`id` in REST, `t` in WS), prepend new trades, and cap the list (e.g. 50).

## Full Implementation Example

```typescript
interface Trade {
  tradeId: number;
  time: number;
  price: string;
  quantity: string;
  isBuyerMaker: boolean;
}

class TradeManager {
  private trades: Trade[] = [];
  private ids = new Set<number>();
  private ws: WebSocket | null = null;
  private readonly MAX_TRADES = 50;

  constructor(private symbol: string, private onUpdate: (trades: Trade[]) => void) {}

  start(): void {
    this.ws = new WebSocket("wss://api.strikefinance.org/ws/price");
    this.ws.onopen = async () => {
      this.ws!.send(JSON.stringify({ method: "subscribe", channel: "trade", symbol: this.symbol, id: 1 }));
      // Backfill (also after every reconnect)
      const res = await fetch(
        `https://api.strikefinance.org/price/v2/trades?symbol=${encodeURIComponent(this.symbol)}&limit=${this.MAX_TRADES}`
      );
      const initial: RestTrade[] = await res.json(); // newest first
      for (const t of [...initial].reverse()) {
        this.add({ tradeId: t.id, time: t.time, price: t.price, quantity: t.qty, isBuyerMaker: t.isBuyerMaker });
      }
      this.onUpdate([...this.trades]);
    };
    this.ws.onmessage = (ev) => {
      let changed = false;
      for (const line of String(ev.data).split("\n")) {
        if (!line) continue;
        const e = JSON.parse(line);
        if (e.e !== "trade" || e.s !== this.symbol) continue;
        changed = this.add({ tradeId: e.t, time: e.T, price: e.p, quantity: e.q, isBuyerMaker: e.m }) || changed;
      }
      if (changed) this.onUpdate([...this.trades]);
    };
    this.ws.onclose = () => setTimeout(() => this.start(), 1000);
  }

  private add(trade: Trade): boolean {
    if (this.ids.has(trade.tradeId)) return false;
    this.ids.add(trade.tradeId);
    this.trades.unshift(trade);
    this.trades.sort((a, b) => b.tradeId - a.tradeId); // keep newest first after backfill races
    while (this.trades.length > this.MAX_TRADES) this.ids.delete(this.trades.pop()!.tradeId);
    return true;
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
  for (const t of trades.slice(0, 10)) console.log(`${t.isBuyerMaker ? "SELL" : "BUY"} ${t.quantity} @ ${t.price}`);
});
tape.start();
```
