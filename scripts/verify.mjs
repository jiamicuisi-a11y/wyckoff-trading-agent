// 临时验证脚本：打本地 /api/analyze，检查结构点数/交易笔数/逆势违规/阶段段数。
const BASE = process.env.BASE || "http://localhost:4500";
const cases = [
  ["BTCUSDT", "1day"],
  ["ETHUSDT", "1day"],
  ["SOLUSDT", "1day"],
  ["BNBUSDT", "1day"],
  ["XRPUSDT", "1day"],
  ["BTCUSDT", "4h"],
];

// 逆势规则：做空(UTAD/SOW)不得出现在 Markup；做多(Spring/SOS/LPS)不得出现在 Markdown。
function phaseAt(phases, idx) {
  for (const s of phases) if (idx >= s.startIndex && idx <= s.endIndex) return s.phase;
  return "Undefined";
}

for (const [symbol, granularity] of cases) {
  const res = await fetch(`${BASE}/api/analyze`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ symbol, granularity, limit: 300 }),
  });
  const j = await res.json();
  if (!res.ok) {
    console.log(`=== ${symbol} ${granularity} === HTTP ${res.status} ERROR ${j.error}`);
    continue;
  }
  let violations = 0;
  const violDetail = [];
  for (const sp of j.structurePoints) {
    const ph = phaseAt(j.phases, sp.index);
    if (sp.bias === "bearish" && ph === "Markup") { violations++; violDetail.push(`${sp.type}@${sp.index}(Markup)`); }
    if (sp.bias === "bullish" && ph === "Markdown") { violations++; violDetail.push(`${sp.type}@${sp.index}(Markdown)`); }
  }
  const seq = j.phases.map((s) => `${s.phase}:${s.endIndex - s.startIndex + 1}`).join(" | ");
  const pts = j.structurePoints.map((s) => `${s.type}@${s.index}`).join(", ");
  console.log(`=== ${symbol} ${granularity} === HTTP ${res.status}`);
  console.log(`  candles=${j.candles.length} phases=${j.phases.length} structs=${j.structurePoints.length} signals=${j.signals.length} trades=${j.backtest.tradeCount} win%=${j.backtest.winRate} ret%=${j.backtest.totalReturnPct} BH%=${j.backtest.buyHoldReturnPct}`);
  console.log(`  phaseSeq: ${seq}`);
  console.log(`  structs: ${pts}`);
  console.log(`  counterTrendViolations=${violations}${violDetail.length ? " -> " + violDetail.join(", ") : ""}`);
}
