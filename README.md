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

## Bitget 合约情绪增强层（差异化能力）

威科夫识别只看现货 K 线，看不到衍生品资金的真实站位。我们额外接入 **Bitget 公开 USDT 永续合约**的三路实时数据，构建一个「合约情绪增强层」，把衍生品的人群拥挤度叠加到威科夫结构判断之上——让每个信号在结构正确之外，再多一层「情绪是否共振」的确认。

**用到的 Bitget 公开接口**（均无需 API key，纯 GET，`productType=usdt-futures`）：

| 维度 | 接口 | 取值 |
|---|---|---|
| 资金费率 | `/api/v2/mix/market/current-fund-rate` | `data[0].fundingRate` |
| 持仓量 OI | `/api/v2/mix/market/open-interest` | `data.openInterestList[0].size` |
| 账户多空比 | `/api/v2/mix/market/account-long-short` (period=`1H`) | `data[].longAccountRatio` / `shortAccountRatio` |

符号映射：现货 `BTCUSDT` → 同名永续合约 `BTCUSDT`。封装在 `lib/sentiment.ts`，带 6s 超时 + 全失败兜底（`return null`），任一接口抖动都不会让威科夫分析崩。

**如何融入威科夫决策**（`scoreSentimentAgainstSignal`，仅作用于最新一根信号）：

- **做空信号** + 资金费率转正偏高（>0.0001）+ 账户多头过热（longRatio>0.6）→ 多头拥挤、为持仓付费，逆向做空得到情绪支持 → 标记 **「情绪共振增强」**，信心 +0.15。
- **做多信号** + 资金费率为负（<0）+ 账户多头偏低（longRatio<0.5）→ 人群悲观、空头付费，逆向做多得到情绪支持 → 标记 **「情绪共振增强」**。
- 信号方向与人群极端站位矛盾（如追多时多头已过热）→ 标记 **「情绪背离，谨慎」**，信心 -0.12。

**关键：无前视偏差。** 情绪数据是**当前快照**，不是历史逐 K 线序列，因此只用于「最新信号的解读增强 + 面板展示」，**绝不写入历史回测路径**——回测的收益/胜率/夏普完全由现货 K 线 + 威科夫规则决定，保持可复现、无未来函数。

前端 `app/page.tsx` 新增「Bitget 合约情绪」卡片：资金费率（标注正负含义）、持仓量、多空比条形（多头/空头占比）、情绪基调徽章，以及一句针对当前威科夫阶段的情绪解读。

## Disclaimer

Research and educational tool. Not financial advice. Backtest results do not guarantee future performance.
