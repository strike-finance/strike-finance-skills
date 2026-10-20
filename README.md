# Strike Finance Skills

AI coding assistant skills for integrating with [Strike Finance](https://strikefinance.org) — perpetuals trading, builder APIs, and real-time market data.

Works with **Claude Code**, **Codex**, **Cursor**, **GitHub Copilot**, **Gemini**, **OpenCode**, **Factory Droid**, and **Pi**.

## Install

```bash
npx strike-finance-skills install
```

This detects which AI agents you have installed and copies skills to the correct directories. Use `--yes` to auto-install without prompting:

```bash
npx strike-finance-skills install --yes
```

Install for specific agents only:

```bash
npx strike-finance-skills install --agents claude cursor codex
```

## What's Included

| Skill | Description |
|-------|-------------|
| `strike-auth` | Builder connect, Ed25519 API wallet request signing, builder fee header, auth errors |
| `strike-account` | Account, balances, portfolio, sub-accounts, markets config, fee tiers, server time |
| `strike-deposit` | Multi-chain deposit flow (quote, build-tx, confirm) |
| `strike-withdraw` | Withdrawal flow (quote, estimate, sign, confirm), limits, queue position |
| `strike-trading` | Orders, batch orders, bracket strategies, TWAP, leverage, margin |
| `strike-market-data` | Public market data REST (depth, trades, funding, mark/index, tickers, stats, klines, OI, FX) |
| `strike-orderbook` | Orderbook REST snapshots, top-20 WebSocket depth diffs, L3 market-by-order feed |
| `strike-trades` | Public market trades (REST + real-time WebSocket) |
| `strike-klines` | Chart/candlestick data with mark/index price klines |
| `strike-price-feeds` | Public price WebSocket: depth, trades, mark/index, tickers, klines |
| `strike-userstream` | Authenticated WebSocket (`session.logon`) for orders, fills, balances, positions, strategies |
| `strike-calculations` | Backend-matching formulas: liquidation price, PnL, margin tiers, balances, fees, funding |
| `strike-history` | Positions, closed positions, position history, order/fill/funding/transaction history |
| `strike-grid-bot` | Grid trading bots: create, stop, list, orders, lifecycle, user-stream events |
| `strike-copy-trading` | Copy trading: discover lead traders, subscribe/update/stop, reserved balance, profit share |
| `strike-rfq` | Request-for-quote: requester and quoter flows, RFQ socket, status lifecycle |
| `strike-vaults` | Vaults: public vault data, create, deposit, withdraw, pause/resume, leader trading |

## API Base URLs

| Service | Mainnet | Testnet |
|---------|---------|---------|
| REST API (auth, account, trading) | `https://api.strikefinance.org` | `https://api-v2-testnet.strikefinance.org` |
| Market Data REST | `https://api.strikefinance.org/price` | `https://api-v2-testnet.strikefinance.org/price` |
| Public WS (prices, depth, trades, klines) | `wss://api.strikefinance.org/ws/price` | `wss://api-v2-testnet.strikefinance.org/ws/price` |
| User WS (API wallet auth) | `wss://api.strikefinance.org/ws/user-api` | `wss://api-v2-testnet.strikefinance.org/ws/user-api` |
| L3 order-by-order feed | `https://api.strikefinance.org/v2/l3/snapshot`, `wss://api.strikefinance.org/ws/l3` | `https://api-v2-testnet.strikefinance.org/v2/l3/snapshot`, `wss://api-v2-testnet.strikefinance.org/ws/l3` |

## OpenAPI Specs

Full OpenAPI 3.0 specs are included in `openapi/` for reference:
- `trade-api.yaml` — Order management, leverage, margin, TWAP
- `user-api.yaml` — Account, balances, portfolio, positions, history
- `market-api.yaml` — Public market data (served under `/price`)

## Manual Install

If you prefer not to use npx, clone and copy:

```bash
git clone https://github.com/strike-finance/strike-finance-skills.git
# Claude Code
cp -r strike-finance-skills/skills/* .claude/skills/
# Cursor
cp -r strike-finance-skills/skills/* .cursor/skills/
# Codex
cp -r strike-finance-skills/skills/* .codex/skills/
```

## Resources

- [Strike Finance](https://strikefinance.org)
- [API Documentation](https://docs.strikefinance.org)
- [Builder Reference](https://github.com/strike-finance/strike-builder-reference)

## License

MIT
