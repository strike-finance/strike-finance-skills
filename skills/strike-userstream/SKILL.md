---
name: strike-userstream
description: Strike Finance user stream — real-time order fills, account updates, position changes, strategy updates via authenticated WebSocket. Critical for trading bots.
---

# Strike Finance User Stream WebSocket

## Connection

| Property | Value |
|----------|-------|
| URL | `wss://v2.strikefinance.org/ws` |
| Auth | JWT token or API wallet |

## Authentication (JWT Method)

```json
SEND:    {"method": "AUTH", "params": {"token": "<JWT_TOKEN>"}}
RECEIVE: {"status": 200, "result": {"account_id": "<ID>", "authenticated": true}}
```

## Subscription

```json
SEND:    {"method": "subscribe", "channel": "userstream", "account_id": "<ID>", "id": "1"}
RECEIVE: {"id": "1", "result": null}
```

For vaults, use `vault_id` instead of `account_id` (no auth needed).

## Event Types

### ORDER_TRADE_UPDATE

Received for every order state change and fill.

```json
{
  "e": "ORDER_TRADE_UPDATE",
  "data": {
    "s": "BTC-USD",
    "c": "my-order-001",
    "S": "BUY",
    "o": "LIMIT",
    "f": "GTC",
    "q": "0.5",
    "p": "45000.00",
    "X": "FILLED",
    "x": "TRADE",
    "i": 12345,
    "z": "0.5",
    "l": "0.5",
    "L": "45000.00",
    "n": "0.0005",
    "N": "USD",
    "t": 99999,
    "m": false,
    "R": false,
    "sp": "0",
    "wt": "MARK_PRICE",
    "cp": false,
    "AP": "67000",
    "CR": "5",
    "rp": "0",
    "T": 1234567890000,
    "E": 1234567890000
  }
}
```

**Field Reference:**

| Field | Description |
|-------|-------------|
| `s` | Symbol |
| `c` | Client order ID |
| `S` | Side: `BUY` or `SELL` |
| `o` | Order type: `MARKET`, `LIMIT`, `STOP`, `STOP_LIMIT`, `TAKE_PROFIT`, `TAKE_PROFIT_LIMIT`, `TRAILING_STOP_MARKET` |
| `f` | Time in force: `GTC`, `FOK`, `IOC` |
| `q` | Original quantity |
| `p` | Original price |
| `X` | Status: `NEW`, `PARTIALLY_FILLED`, `FILLED`, `CANCELED`, `REJECTED`, `EXPIRED` |
| `x` | Execution type: `NEW`, `CANCELED`, `REJECTED`, `TRADE`, `EXPIRED` |
| `i` | Order ID |
| `z` | Cumulative filled quantity |
| `l` | Last filled quantity (THIS fill) |
| `L` | Last filled price (THIS fill) |
| `n` | Commission/fee amount |
| `N` | Commission asset |
| `t` | Trade ID (0 for non-fills) |
| `m` | Is maker |
| `R` | Is reduce only |
| `sp` | Stop price |
| `wt` | Working type: `MARK_PRICE` or `CONTRACT_PRICE` |
| `cp` | Is close position |
| `AP` | Activation price (trailing stop) |
| `CR` | Callback rate (trailing stop %) |
| `rp` | Realized profit |
| `T` | Timestamp (ms) |
| `E` | Event time (ms) |

**Detecting real fills vs preview messages:**

- Real fill: `t > 0` AND `l` populated AND `L` populated AND `n` populated AND `N` populated
- Toast/process only when: (`FILLED`/`PARTIALLY_FILLED` with fill data) OR (`REJECTED`/`CANCELLED`)

### ACCOUNT_UPDATE

Received on balance or position changes.

```json
{
  "e": "ACCOUNT_UPDATE",
  "E": 1234567890000,
  "T": 1234567890000,
  "r": "DEPOSIT",
  "B": [{
    "a": "USD",
    "wb": "10000.00",
    "cw": "9500.00",
    "bc": "500.00"
  }],
  "P": [{
    "s": "BTC-USD",
    "pa": "1.5",
    "ep": "42000.00",
    "mt": "cross",
    "ib": "0",
    "ps": "LONG",
    "i": "pos-123"
  }]
}
```

**Field Reference:**

| Field | Description |
|-------|-------------|
| `r` | Reason: `DEPOSIT`, `WITHDRAW`, `WITHDRAWAL_SETTLED`, `WITHDRAWAL_FAILED`, `FUNDING`, `PARTIAL_LIQUIDATED`, `FULLY_LIQUIDATED`, `ADL` |
| `B[].a` | Asset |
| `B[].wb` | Wallet balance |
| `B[].cw` | Cross wallet balance |
| `B[].bc` | Balance change |
| `P[].s` | Symbol |
| `P[].pa` | Position amount (absolute value) |
| `P[].ep` | Entry price |
| `P[].mt` | Margin type: `cross` or `isolated` |
| `P[].ib` | Isolated balance (only for isolated) |
| `P[].ps` | Position side: `LONG` or `SHORT` |
| `P[].i` | Position ID (optional) |

### STRATEGYUPDATE

Received when TWAP/bracket strategy status changes.

```json
{
  "e": "STRATEGYUPDATE",
  "data": {
    "strategy_id": "twap-123",
    "market": "BTC-USD",
    "status": "completed",
    "filled_size": "1.0",
    "total_size": "1.0",
    "last_error": null
  }
}
```

| Status Values |
|---------------|
| `completed` |
| `expired` |
| `cancelled` |
| `failed` |
| `liquidated` |

## Position Merging Logic

- **Key:** `symbol + positionSide` (e.g. `"BTC-USD-LONG"`)
- If size near zero (`< 1e-12`): delete position
- Otherwise: update or add
- Remove opposite side if position flips
- Preserve `accumulatedFundingFees` from existing state (not provided in WS events)

## Order State Management

- **Final statuses:** `FILLED`, `CANCELED`, `CANCELLED`, `REJECTED`, `EXPIRED` -- remove from open orders
- **Non-final:** update in-place or add
- **Deduplicate** by `orderId`, keep most recent by `EventTimestamp`

## Reconnection

| Rule | Value |
|------|-------|
| Max attempts | 10 |
| Delay between attempts | 5 seconds |
| Auth error codes (do NOT reconnect) | `1008`, `4001`, `4003`, `4401`, `4403` |
| Tab visibility | Reconnect when tab becomes visible if WS not OPEN |
| Rebuffer | 300ms batch timer for `ORDER_TRADE_UPDATE` to handle rapid replace-order sequences |

## TypeScript Example

```typescript
type OrderStatus = "NEW" | "PARTIALLY_FILLED" | "FILLED" | "CANCELED" | "CANCELLED" | "REJECTED" | "EXPIRED";
type PositionSide = "LONG" | "SHORT";
type Side = "BUY" | "SELL";

interface OrderTradeUpdate {
  s: string;
  c: string;
  S: Side;
  o: string;
  f: string;
  q: string;
  p: string;
  X: OrderStatus;
  x: string;
  i: number;
  z: string;
  l: string;
  L: string;
  n: string;
  N: string;
  t: number;
  m: boolean;
  R: boolean;
  sp: string;
  wt: string;
  cp: boolean;
  AP: string;
  CR: string;
  rp: string;
  T: number;
  E: number;
}

interface BalanceUpdate {
  a: string;
  wb: string;
  cw: string;
  bc: string;
}

interface PositionUpdate {
  s: string;
  pa: string;
  ep: string;
  mt: "cross" | "isolated";
  ib: string;
  ps: PositionSide;
  i?: string;
}

interface AccountUpdate {
  e: "ACCOUNT_UPDATE";
  E: number;
  T: number;
  r: string;
  B: BalanceUpdate[];
  P: PositionUpdate[];
}

interface StrategyUpdate {
  strategy_id: string;
  market: string;
  status: "completed" | "expired" | "cancelled" | "failed" | "liquidated";
  filled_size: string;
  total_size: string;
  last_error: string | null;
}

const FINAL_STATUSES: Set<string> = new Set([
  "FILLED", "CANCELED", "CANCELLED", "REJECTED", "EXPIRED",
]);

const AUTH_ERROR_CODES: Set<number> = new Set([1008, 4001, 4003, 4401, 4403]);

class StrikeUserStream {
  private ws: WebSocket | null = null;
  private accountId: string | null = null;
  private reconnectAttempt = 0;
  private maxReconnectAttempts = 10;
  private reconnectDelay = 5000;
  private orderBatchTimer: ReturnType<typeof setTimeout> | null = null;
  private orderBatch: OrderTradeUpdate[] = [];

  // State
  private openOrders = new Map<number, OrderTradeUpdate>();
  private positions = new Map<string, PositionUpdate>();

  constructor(
    private jwtToken: string,
    private url = "wss://v2.strikefinance.org/ws"
  ) {}

  connect(): void {
    this.ws = new WebSocket(this.url);

    this.ws.onopen = () => {
      console.log("Connected to Strike user stream");
      this.reconnectAttempt = 0;
      this.authenticate();
    };

    this.ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      this.handleMessage(data);
    };

    this.ws.onclose = (event) => {
      if (AUTH_ERROR_CODES.has(event.code)) {
        console.error(`Auth error (code ${event.code}): not reconnecting`);
        return;
      }
      this.scheduleReconnect();
    };

    this.ws.onerror = (err) => {
      console.error("User stream WS error:", err);
    };
  }

  private authenticate(): void {
    this.ws?.send(
      JSON.stringify({
        method: "AUTH",
        params: { token: this.jwtToken },
      })
    );
  }

  private subscribe(): void {
    if (!this.accountId) return;
    this.ws?.send(
      JSON.stringify({
        method: "subscribe",
        channel: "userstream",
        account_id: this.accountId,
        id: String(Date.now()),
      })
    );
  }

  private handleMessage(data: Record<string, unknown>): void {
    // Auth response
    if (data.status === 200 && (data.result as Record<string, unknown>)?.authenticated) {
      this.accountId = (data.result as Record<string, unknown>).account_id as string;
      console.log(`Authenticated as ${this.accountId}`);
      this.subscribe();
      return;
    }

    // Event routing
    switch (data.e) {
      case "ORDER_TRADE_UPDATE":
        this.handleOrderTradeUpdate(data.data as OrderTradeUpdate);
        break;
      case "ACCOUNT_UPDATE":
        this.handleAccountUpdate(data as unknown as AccountUpdate);
        break;
      case "STRATEGYUPDATE":
        this.handleStrategyUpdate(data.data as StrategyUpdate);
        break;
    }
  }

  private handleOrderTradeUpdate(update: OrderTradeUpdate): void {
    // Buffer rapid updates (e.g. replace-order sequences)
    this.orderBatch.push(update);

    if (this.orderBatchTimer) clearTimeout(this.orderBatchTimer);
    this.orderBatchTimer = setTimeout(() => {
      this.processOrderBatch();
    }, 300);
  }

  private processOrderBatch(): void {
    // Deduplicate by orderId, keep most recent by event time
    const deduped = new Map<number, OrderTradeUpdate>();
    for (const update of this.orderBatch) {
      const existing = deduped.get(update.i);
      if (!existing || update.E > existing.E) {
        deduped.set(update.i, update);
      }
    }

    for (const update of deduped.values()) {
      if (FINAL_STATUSES.has(update.X)) {
        this.openOrders.delete(update.i);
      } else {
        this.openOrders.set(update.i, update);
      }

      // Detect real fills
      if (this.isRealFill(update)) {
        console.log(
          `Fill: ${update.S} ${update.l} ${update.s} @ ${update.L} | Fee: ${update.n} ${update.N}`
        );
      }

      if (update.X === "REJECTED") {
        console.warn(`Order rejected: ${update.c} (${update.s})`);
      }
    }

    this.orderBatch = [];
    this.orderBatchTimer = null;
  }

  private isRealFill(update: OrderTradeUpdate): boolean {
    return (
      update.t > 0 &&
      !!update.l &&
      !!update.L &&
      !!update.n &&
      !!update.N &&
      (update.X === "FILLED" || update.X === "PARTIALLY_FILLED")
    );
  }

  private handleAccountUpdate(update: AccountUpdate): void {
    console.log(`Account update (${update.r}):`);

    // Process balance changes
    for (const balance of update.B) {
      console.log(
        `  Balance ${balance.a}: ${balance.wb} (change: ${balance.bc})`
      );
    }

    // Process position changes
    for (const pos of update.P) {
      const key = `${pos.s}-${pos.ps}`;
      const size = Math.abs(parseFloat(pos.pa));

      if (size < 1e-12) {
        // Position closed
        this.positions.delete(key);
        console.log(`  Position closed: ${key}`);
      } else {
        // Preserve accumulatedFundingFees from existing state
        const existing = this.positions.get(key);
        this.positions.set(key, pos);
        console.log(
          `  Position ${key}: size=${pos.pa} entry=${pos.ep} margin=${pos.mt}`
        );
      }

      // Remove opposite side if position flipped
      const oppositeSide = pos.ps === "LONG" ? "SHORT" : "LONG";
      const oppositeKey = `${pos.s}-${oppositeSide}`;
      if (size > 0 && this.positions.has(oppositeKey)) {
        const oppositeSize = Math.abs(
          parseFloat(this.positions.get(oppositeKey)!.pa)
        );
        if (oppositeSize < 1e-12) {
          this.positions.delete(oppositeKey);
        }
      }
    }
  }

  private handleStrategyUpdate(update: StrategyUpdate): void {
    console.log(
      `Strategy ${update.strategy_id} (${update.market}): ${update.status} — filled ${update.filled_size}/${update.total_size}`
    );
    if (update.last_error) {
      console.warn(`  Error: ${update.last_error}`);
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempt >= this.maxReconnectAttempts) {
      console.error("Max reconnect attempts reached");
      return;
    }

    this.reconnectAttempt++;
    console.log(
      `Reconnecting in ${this.reconnectDelay}ms (attempt ${this.reconnectAttempt}/${this.maxReconnectAttempts})`
    );
    setTimeout(() => this.connect(), this.reconnectDelay);
  }

  // Handle tab visibility for reconnection
  setupVisibilityHandler(): void {
    document.addEventListener("visibilitychange", () => {
      if (
        document.visibilityState === "visible" &&
        this.ws?.readyState !== WebSocket.OPEN
      ) {
        this.reconnectAttempt = 0;
        this.connect();
      }
    });
  }

  // Public accessors
  getOpenOrders(): Map<number, OrderTradeUpdate> {
    return this.openOrders;
  }

  getPositions(): Map<string, PositionUpdate> {
    return this.positions;
  }
}

// Usage
const stream = new StrikeUserStream("your-jwt-token-here");
stream.connect();
stream.setupVisibilityHandler();
```
