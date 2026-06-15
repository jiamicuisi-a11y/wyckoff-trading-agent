# Wyckoff Trading Agent

An autonomous AI trading agent that reads real market data, identifies the current **Wyckoff phase**, detects classic structural events, generates trade decisions with risk control, and validates the whole loop through backtesting.

**🛰️ Live demo:** _deploying — link in repo description_

Built for the **Bitget AI Base Camp Hackathon S1** — Track 1: Trading Agent.

---

## What it does

Paste a symbol (BTCUSDT / ETHUSDT / SOLUSDT) and the agent runs a full closed loop:

```
PERCEIVE  →  DECIDE  →  EXECUTE  →  RISK-CONTROL  →  BACKTEST
```

1. **Perceive** — pulls real OHLCV candles from the Bitget public market API and classifies each window into a Wyckoff phase: **Accumulation / Markup / Distribution / Markdown**.
2. **Detect structure** — flags classic Wyckoff events: **Spring, SOS (Sign of Strength), LPS (Last Point of Support), UTAD (Upthrust After Distribution), SOW (Sign of Weakness)**.
3. **Decide** — converts structural events into long/short signals with entry, stop-loss, target, and reward/risk ratio.
4. **Execute + risk-control** — fixed-fractional position sizing, 1.5% risk per trade, single concurrent position, every trade carries an explicit stop and R:R.
5. **Backtest** — replays the strategy over historical candles and reports PnL, win rate, profit factor, max drawdown, Sharpe, and an equity curve — always compared against Buy & Hold.

## Why Wyckoff

Most "AI trading" demos are black-box indicators. Wyckoff method is a **transparent, structural** way to read markets — accumulation by smart money, markup, distribution, markdown. By teaching an agent to recognise these phases and their confirmation points, the decisions are **explainable**: every signal traces back to a named structure (a Spring, an SOS, a UTAD), not an opaque score.

## Data source

Real-time and historical data from the **Bitget public market API** (`api.bitget.com`). No API key required, no trading permissions used — this agent is **research / backtest only** and never places real orders.

## Tech

- **Next.js 14 + TypeScript**, full-stack, deployable to Vercel.
- `lib/wyckoff.ts` — phase classification + structure-point detection (the perception core).
- `lib/strategy.ts` — signal generation, position sizing, risk control.
- `lib/backtest.ts` — historical replay engine with Buy & Hold benchmark.
- `lib/bitget.ts` — Bitget public market data client.
- `app/WyckoffChart.tsx` — candlestick chart with phase shading + structure-point markers (lightweight-charts).

## Run locally

```bash
npm install
npm run dev      # http://localhost:3000
# or production:
npm run build && npm start
```

Then open the dashboard, pick a symbol and timeframe, and the agent analyses live.

## Sample result

`BTCUSDT 1day` (300 candles, BTC drawdown window):

| Metric | Agent | Buy & Hold |
|---|---|---|
| Total return | **+8.2%** | -40.5% |
| Win rate | 46.2% | — |
| Profit factor | 1.79 | — |
| Max drawdown | 4.4% | — |
| Sharpe | 0.98 | — |
| Trades | 13 | — |

The agent stays defensive through a Markdown phase and outperforms Buy & Hold by ~48 points — exactly what a Wyckoff-aware agent should do in a downtrend.

## Disclaimer

Research and educational tool. Not financial advice. Backtest results do not guarantee future performance.
