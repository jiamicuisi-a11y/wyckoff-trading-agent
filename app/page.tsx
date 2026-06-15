"use client";

import { useState } from "react";
import WyckoffChart from "./WyckoffChart";
import type {
  AnalyzeResponse,
  PhaseSegment,
  StructurePoint,
  TradeSignal,
  ClosedTrade,
} from "../lib/types";

type FullResponse = AnalyzeResponse & { currentPhase: string };

const SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT"];
const GRANS = [
  { v: "1day", label: "日线 1D" },
  { v: "4h", label: "4小时" },
  { v: "1h", label: "1小时" },
  { v: "1week", label: "周线 1W" },
];

const PHASE_CN: Record<string, string> = {
  Accumulation: "吸筹 Accumulation",
  Markup: "拉升 Markup",
  Distribution: "派发 Distribution",
  Markdown: "下跌 Markdown",
  Undefined: "观望 Undefined",
};

const PHASE_CLASS: Record<string, string> = {
  Accumulation: "badge-accum",
  Markup: "badge-markup",
  Distribution: "badge-dist",
  Markdown: "badge-markdown",
  Undefined: "badge-undef",
};

function fmt(n: number, d = 2): string {
  return n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
}
function fmtDate(unixSec: number): string {
  return new Date(unixSec * 1000).toISOString().slice(0, 10);
}

export default function Home() {
  const [symbol, setSymbol] = useState("BTCUSDT");
  const [granularity, setGranularity] = useState("1day");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<FullResponse | null>(null);

  async function analyze() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol, granularity, limit: 300 }),
      });
      const json = await res.json();
      if (!res.ok) {
        throw new Error(json.error || `请求失败 (${res.status})`);
      }
      setData(json as FullResponse);
    } catch (e: any) {
      setError(e?.message || "网络错误");
      setData(null);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">W</div>
          <div>
            <div className="brand-name">Wyckoff Agent</div>
            <div className="brand-sub">威科夫交易智能体</div>
          </div>
        </div>

        <div className="control-group">
          <label className="control-label">交易对</label>
          <div className="seg">
            {SYMBOLS.map((s) => (
              <button
                key={s}
                className={`seg-item ${symbol === s ? "active" : ""}`}
                onClick={() => setSymbol(s)}
              >
                {s.replace("USDT", "")}
              </button>
            ))}
          </div>
        </div>

        <div className="control-group">
          <label className="control-label">周期</label>
          <div className="seg seg-col">
            {GRANS.map((g) => (
              <button
                key={g.v}
                className={`seg-item ${granularity === g.v ? "active" : ""}`}
                onClick={() => setGranularity(g.v)}
              >
                {g.label}
              </button>
            ))}
          </div>
        </div>

        <button className="btn-primary" onClick={analyze} disabled={loading}>
          {loading ? "分析中…" : "运行威科夫分析"}
        </button>

        <div className="sidebar-foot">
          <p>感知 → 决策 → 执行 → 风控 全闭环</p>
          <p className="muted">数据源：Bitget 公开现货行情</p>
        </div>
      </aside>

      <main className="main">
        <section className="hero">
          <div className="hero-head">
            <div>
              <h1 className="hero-title">威科夫交易 Agent</h1>
              <p className="hero-tagline">
                基于威科夫方法的确定性规则引擎：识别市场阶段与关键结构，自动生成信号并回测验证。
              </p>
            </div>
            {data && (
              <div className={`phase-badge ${PHASE_CLASS[data.currentPhase] || "badge-undef"}`}>
                <span className="phase-badge-label">当前阶段</span>
                <span className="phase-badge-value">
                  {PHASE_CN[data.currentPhase] || data.currentPhase}
                </span>
              </div>
            )}
          </div>
        </section>

        {error && <div className="alert-error">⚠ {error}</div>}

        {!data && !loading && !error && (
          <div className="empty-state">
            <p>选择交易对与周期，点击「运行威科夫分析」开始。</p>
          </div>
        )}

        {loading && (
          <div className="empty-state">
            <div className="spinner" />
            <p>正在拉取行情并运行威科夫识别与回测…</p>
          </div>
        )}

        {data && (
          <>
            <section className="card">
              <div className="card-head">
                <h2>K线 · 威科夫阶段与结构</h2>
                <span className="muted">
                  {data.symbol} · {data.granularity} · {data.candles.length} 根
                </span>
              </div>
              <WyckoffChart
                candles={data.candles}
                phases={data.phases}
                structurePoints={data.structurePoints}
              />
              <div className="legend">
                <span><i className="dot dot-spring" />Spring 弹簧</span>
                <span><i className="dot dot-sos" />SOS 强势</span>
                <span><i className="dot dot-lps" />LPS 支撑</span>
                <span><i className="dot dot-utad" />UTAD 诱多</span>
                <span><i className="dot dot-sow" />SOW 弱势</span>
              </div>
            </section>

            <div className="grid-2">
              <section className="card">
                <div className="card-head">
                  <h2>交易信号</h2>
                  <span className="muted">{data.signals.length} 个</span>
                </div>
                {data.signals.length === 0 ? (
                  <p className="muted">当前数据未触发交易信号。</p>
                ) : (
                  <div className="signal-list">
                    {data.signals.slice(-8).reverse().map((s: TradeSignal, i) => (
                      <div key={i} className="signal-card">
                        <div className="signal-top">
                          <span className={`tag ${s.direction === "long" ? "tag-long" : "tag-short"}`}>
                            {s.direction === "long" ? "做多 LONG" : "做空 SHORT"}
                          </span>
                          <span className="signal-src">{s.sourceStructure}</span>
                          <span className="signal-date">{fmtDate(s.time)}</span>
                        </div>
                        <div className="signal-grid">
                          <div><label>入场</label><b>{fmt(s.entry)}</b></div>
                          <div><label>止损</label><b className="neg">{fmt(s.stop)}</b></div>
                          <div><label>目标</label><b className="pos">{fmt(s.target)}</b></div>
                          <div><label>仓位</label><b>{fmt(s.positionPct * 100, 1)}%</b></div>
                          <div><label>R:R</label><b>{fmt(s.riskReward, 2)}</b></div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </section>

              <section className="card">
                <div className="card-head">
                  <h2>回测结果</h2>
                  <span className="muted">vs Buy & Hold</span>
                </div>
                <div className="metric-grid">
                  <Metric label="策略总收益" value={`${fmt(data.backtest.totalReturnPct)}%`} positive={data.backtest.totalReturnPct >= 0} big />
                  <Metric label="Buy&Hold" value={`${fmt(data.backtest.buyHoldReturnPct)}%`} positive={data.backtest.buyHoldReturnPct >= 0} big />
                  <Metric label="胜率" value={`${fmt(data.backtest.winRate, 1)}%`} />
                  <Metric label="盈亏比" value={fmt(data.backtest.profitFactor, 2)} />
                  <Metric label="最大回撤" value={`${fmt(data.backtest.maxDrawdownPct)}%`} negative />
                  <Metric label="夏普" value={fmt(data.backtest.sharpe, 2)} />
                  <Metric label="交易次数" value={String(data.backtest.tradeCount)} />
                  <Metric label="盈/亏单" value={`${data.backtest.wins}/${data.backtest.losses}`} />
                </div>
                <EquityChart curve={data.backtest.equityCurve} />
              </section>
            </div>

            {data.backtest.trades.length > 0 && (
              <section className="card">
                <div className="card-head">
                  <h2>交易明细</h2>
                  <span className="muted">{data.backtest.trades.length} 笔</span>
                </div>
                <div className="table-wrap">
                  <table className="trades">
                    <thead>
                      <tr>
                        <th>方向</th><th>入场日期</th><th>入场价</th>
                        <th>出场日期</th><th>出场价</th><th>结果</th>
                        <th>收益%</th><th>R</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.backtest.trades.map((t: ClosedTrade, i) => (
                        <tr key={i}>
                          <td><span className={`tag-mini ${t.direction === "long" ? "tag-long" : "tag-short"}`}>{t.direction === "long" ? "多" : "空"}</span></td>
                          <td>{fmtDate(t.entryTime)}</td>
                          <td>{fmt(t.entryPrice)}</td>
                          <td>{fmtDate(t.exitTime)}</td>
                          <td>{fmt(t.exitPrice)}</td>
                          <td className={t.outcome === "win" ? "pos" : "neg"}>{t.outcome === "win" ? "盈利" : "亏损"}</td>
                          <td className={t.pnlPct >= 0 ? "pos" : "neg"}>{fmt(t.pnlPct)}</td>
                          <td className={t.rMultiple >= 0 ? "pos" : "neg"}>{fmt(t.rMultiple, 2)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            )}

            <div className="disclaimer">
              ⚠ 本工具仅用于研究与教育目的，所有信号与回测均为历史模拟，不构成任何投资建议。加密资产风险极高，请勿据此进行真实交易。
            </div>
          </>
        )}
      </main>
    </div>
  );
}

function Metric({
  label,
  value,
  positive,
  negative,
  big,
}: {
  label: string;
  value: string;
  positive?: boolean;
  negative?: boolean;
  big?: boolean;
}) {
  const cls = positive ? "pos" : negative ? "neg" : "";
  return (
    <div className={`metric ${big ? "metric-big" : ""}`}>
      <span className="metric-label">{label}</span>
      <span className={`metric-value ${cls}`}>{value}</span>
    </div>
  );
}

function EquityChart({ curve }: { curve: { time: number; equity: number; benchmark: number }[] }) {
  if (!curve.length) return null;
  const W = 520;
  const H = 120;
  const pad = 4;
  const eqs = curve.map((p) => p.equity);
  const bms = curve.map((p) => p.benchmark);
  const min = Math.min(...eqs, ...bms);
  const max = Math.max(...eqs, ...bms);
  const range = max - min || 1;
  const x = (i: number) => pad + (i / (curve.length - 1)) * (W - 2 * pad);
  const y = (v: number) => H - pad - ((v - min) / range) * (H - 2 * pad);
  const path = (vals: number[]) =>
    vals.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");

  return (
    <div className="equity">
      <div className="equity-head">
        <span><i className="dot dot-eq" />策略权益</span>
        <span><i className="dot dot-bm" />Buy & Hold</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="equity-svg" preserveAspectRatio="none">
        <path d={path(bms)} className="line-bm" fill="none" />
        <path d={path(eqs)} className="line-eq" fill="none" />
      </svg>
    </div>
  );
}
