"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/** 与 lib/scanner.ts 对齐的前端类型。 */
interface AnomalyFactorScores {
  oi: number;
  activeBuy: number;
  price: number;
  volume: number;
  funding: number;
}
interface AnomalyHit {
  symbol: string;
  score: number;
  direction: "long" | "short";
  tag: string;
  factors: AnomalyFactorScores;
  lastPrice: number;
  oiUsd: number;
  oiChangePct: number | null;
  change24hPct: number;
  fundingRate: number;
  volumeUsd: number;
  bidAskImbalance: number;
}
interface OiSnapshot {
  [symbol: string]: { oi: number; ts: number };
}
interface ScanResponse {
  hits: AnomalyHit[];
  oiSnapshot: OiSnapshot;
  scannedCount: number;
  scannedAt: string;
  config: { minScore: number; minOiUsd: number; maxHits: number; cooldownMinutes: number };
  note: string;
  error?: string;
}

const REFRESH_OPTIONS = [
  { v: 30, label: "30秒" },
  { v: 60, label: "60秒" },
  { v: 120, label: "2分钟" },
];

const POSITIVE_TAGS = ["多头共振", "大户领先做多", "主动买领先多"];

function fmtUsd(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return n.toFixed(0);
}
function fmtPrice(n: number): string {
  if (n >= 1000) return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (n >= 1) return n.toFixed(4);
  return n.toFixed(6);
}
function fmtTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString("zh-CN", { hour12: false });
  } catch {
    return iso;
  }
}

export default function AnomalyScanner() {
  const [hits, setHits] = useState<AnomalyHit[] | null>(null);
  const [scannedCount, setScannedCount] = useState(0);
  const [scannedAt, setScannedAt] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [interval, setIntervalSec] = useState(60);
  const [firstScanDone, setFirstScanDone] = useState(false);

  // OI 快照在两次扫描间保留，用于算 OI 变化率。用 ref 避免触发重渲染。
  const oiSnapshotRef = useRef<OiSnapshot>({});

  const scan = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ oiSnapshot: oiSnapshotRef.current }),
      });
      const json = (await res.json()) as ScanResponse;
      if (!res.ok) throw new Error(json.error || `请求失败 (${res.status})`);
      setHits(json.hits);
      setScannedCount(json.scannedCount);
      setScannedAt(json.scannedAt);
      oiSnapshotRef.current = json.oiSnapshot;
      setFirstScanDone(true);
    } catch (e: any) {
      setError(e?.message || "网络错误");
    } finally {
      setLoading(false);
    }
  }, []);

  // 自动刷新定时器
  useEffect(() => {
    if (!autoRefresh) return;
    const id = setInterval(scan, interval * 1000);
    return () => clearInterval(id);
  }, [autoRefresh, interval, scan]);

  return (
    <>
      <section className="card">
        <div className="card-head">
          <h2>实时异动扫描</h2>
          <span className="muted">
            {scannedAt ? `上次扫描 ${fmtTime(scannedAt)} · 全市场 ${scannedCount} 个合约` : "全市场永续合约 · Bitget 实时"}
          </span>
        </div>

        <div className="scan-controls">
          <button className="btn-primary" onClick={scan} disabled={loading} style={{ maxWidth: 160 }}>
            {loading ? "扫描中…" : "立即扫描"}
          </button>

          <label className={`switch ${autoRefresh ? "on" : ""}`}>
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.target.checked)}
            />
            <span className="switch-track"><span className="switch-thumb" /></span>
            <span className="switch-label">自动刷新</span>
          </label>

          <div className={`seg ${autoRefresh ? "" : "seg-disabled"}`}>
            {REFRESH_OPTIONS.map((o) => (
              <button
                key={o.v}
                className={`seg-item ${interval === o.v ? "active" : ""}`}
                onClick={() => setIntervalSec(o.v)}
                disabled={!autoRefresh}
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>

        {!firstScanDone && (
          <p className="muted scan-hint">
            提示：OI 变化率需要连续两次扫描才能算出，首次扫描的 OI 异动分为 0，再刷新一次即生效。开「自动刷新」会持续滚动更新。
          </p>
        )}
      </section>

      {error && <div className="alert-error">⚠ {error}</div>}

      {!hits && !loading && !error && (
        <div className="empty-state">
          <p>点击「立即扫描」拉取全市场永续合约的实时异动，或打开自动刷新持续监控。</p>
        </div>
      )}

      {loading && !hits && (
        <div className="empty-state">
          <div className="spinner" />
          <p>正在拉取 Bitget 全市场合约并打分…</p>
        </div>
      )}

      {hits && (
        <section className="card">
          <div className="card-head">
            <h2>异动榜 · Top {hits.length}</h2>
            <span className="muted">综合分≥35 · OI≥100万U · 30分钟同向去重</span>
          </div>
          {hits.length === 0 ? (
            <p className="muted">当前全市场无满足条件的异动标的（这很正常，市场平静时榜可能为空）。</p>
          ) : (
            <div className="scan-list">
              {hits.map((h, i) => {
                const isLong = h.direction === "long";
                const positive = POSITIVE_TAGS.includes(h.tag);
                return (
                  <div key={h.symbol} className="scan-card">
                    <div className="scan-rank">#{i + 1}</div>
                    <div className="scan-main">
                      <div className="scan-top">
                        <span className="scan-symbol">{h.symbol.replace("USDT", "")}</span>
                        <span className={`tag ${isLong ? "tag-long" : "tag-short"}`}>
                          {isLong ? "做多 LONG" : "做空 SHORT"}
                        </span>
                        <span className={`scan-tag ${positive ? "scan-tag-pos" : "scan-tag-neg"}`}>
                          {h.tag}
                        </span>
                        <span className="scan-score">分 {h.score}</span>
                      </div>
                      <div className="scan-metrics">
                        <div><label>现价</label><b>{fmtPrice(h.lastPrice)}</b></div>
                        <div>
                          <label>OI异动</label>
                          <b className={h.oiChangePct === null ? "" : h.oiChangePct >= 0 ? "pos" : "neg"}>
                            {h.oiChangePct === null ? "—" : `${h.oiChangePct >= 0 ? "+" : ""}${h.oiChangePct}%`}
                          </b>
                        </div>
                        <div><label>OI</label><b>${fmtUsd(h.oiUsd)}</b></div>
                        <div>
                          <label>24h</label>
                          <b className={h.change24hPct >= 0 ? "pos" : "neg"}>
                            {h.change24hPct >= 0 ? "+" : ""}{h.change24hPct}%
                          </b>
                        </div>
                        <div>
                          <label>资金费率</label>
                          <b className={h.fundingRate >= 0 ? "pos" : "neg"}>
                            {(h.fundingRate * 100).toFixed(4)}%
                          </b>
                        </div>
                        <div><label>成交额</label><b>${fmtUsd(h.volumeUsd)}</b></div>
                        <div>
                          <label>买卖压</label>
                          <b className={h.bidAskImbalance >= 0 ? "pos" : "neg"}>
                            {h.bidAskImbalance >= 0 ? "买" : "卖"} {Math.abs(h.bidAskImbalance * 100).toFixed(0)}%
                          </b>
                        </div>
                      </div>
                      <div className="scan-factors">
                        <FactorBar label="OI" v={h.factors.oi} />
                        <FactorBar label="主动买" v={h.factors.activeBuy} />
                        <FactorBar label="价格" v={h.factors.price} />
                        <FactorBar label="成交额" v={h.factors.volume} />
                        <FactorBar label="费率" v={h.factors.funding} />
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          <div className="disclaimer" style={{ marginTop: 16 }}>
            ⚠ 实时异动扫描仅用于研究与监控，不构成投资建议。异动 ≠ 买卖信号，请结合自身判断。
          </div>
        </section>
      )}
    </>
  );
}

function FactorBar({ label, v }: { label: string; v: number }) {
  return (
    <div className="factor-bar">
      <span className="factor-label">{label}</span>
      <span className="factor-track">
        <span className="factor-fill" style={{ width: `${Math.min(v, 100)}%` }} />
      </span>
      <span className="factor-val">{Math.round(v)}</span>
    </div>
  );
}
