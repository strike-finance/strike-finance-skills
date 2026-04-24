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
| `strike-auth` | Authentication, builder connect, Ed25519 API wallet signing |
| `strike-account` | Account management, balances, portfolio |
| `strike-deposit` | Multi-chain deposit flow (quote, build-tx, confirm) |
| `strike-withdraw` | Withdrawal flow with chain-specific signatures |
| `strike-trading` | Orders, batch orders, bracket strategies, TWAP, leverage, margin |
| `strike-market-data` | Public market data (depth, trades, prices, tickers, klines, OI) |
| `strike-orderbook` | Orderbook REST snapshots + WebSocket delta patching |
| `strike-trades` | Real-time market trades + user fill history |
| `strike-klines` | Chart/candlestick data with mark/index price klines |
| `strike-price-feeds` | WebSocket channels for real-time prices, mark/index, funding |
| `strike-userstream` | Authenticated WebSocket for order fills, account updates, positions |
| `strike-calculations` | Liquidation prices, PnL, margin tiers, available balance |
| `strike-history` | Order, fill, funding, and transaction history |

## API Base URLs

| Environment | URL |
|-------------|-----|
| Mainnet | `https://api.strikefinance.org` |
| Testnet | `https://api-v2-testnet.strikefinance.org` |
| Market Data | `https://api.strikefinance.org/price` |
| Public WS | `wss://v2.strikefinance.org/ws/stream` |
| User WS | `wss://v2.strikefinance.org/ws` |

## OpenAPI Specs

Full OpenAPI 3.0 specs are included in `openapi/` for reference:
- `trade-api.yaml` — Order management, leverage, margin, TWAP
- `user-api.yaml` — Account, positions, history
- `market-api.yaml` — Public market data

## Manual Install

If you prefer not to use npx, clone and copy:

```bash
git clone https://github.com/strike-finance/builder-skills.git
# Claude Code
cp -r builder-skills/skills/* .claude/skills/
# Cursor
cp -r builder-skills/skills/* .cursor/skills/
# Codex
cp -r builder-skills/skills/* .codex/skills/
```

## Resources

- [Strike Finance](https://strikefinance.org)
- [API Documentation](https://docs.strikefinance.org)
- [Builder Reference](https://github.com/strike-finance/strike-builder-reference)

## License

MIT
