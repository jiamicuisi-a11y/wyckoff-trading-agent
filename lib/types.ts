// Core domain types for Wyckoff Trading Agent

export interface Candle {
  time: number; // unix seconds
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number; // base volume
}

export type WyckoffPhaseType =
  | "Accumulation"
  | "Markup"
  | "Distribution"
  | "Markdown"
  | "Undefined";

export interface PhaseSegment {
  phase: WyckoffPhaseType;
  startIndex: number;
  endIndex: number;
  startTime: number;
  endTime: number;
  note: string;
}

export type StructureType =
  | "Spring"
  | "SOS"
  | "LPS"
  | "UTAD"
  | "SOW";

export interface StructurePoint {
  type: StructureType;
  index: number;
  time: number;
  price: number;
  bias: "bullish" | "bearish";
  explanation: string;
}

export type SignalDirection = "long" | "short";

export interface TradeSignal {
  index: number;
  time: number;
  direction: SignalDirection;
  entry: number;
  stop: number;
  target: number;
  positionPct: number; // fraction of equity allocated as notional
  riskReward: number;
  reason: string;
  sourceStructure: StructureType;
}

export interface ClosedTrade {
  direction: SignalDirection;
  entryIndex: number;
  entryTime: number;
  entryPrice: number;
  exitIndex: number;
  exitTime: number;
  exitPrice: number;
  stop: number;
  target: number;
  outcome: "win" | "loss";
  pnlPct: number; // return on equity for the trade
  rMultiple: number;
  reason: string;
}

export interface EquityPoint {
  time: number;
  equity: number;
  benchmark: number;
}

export interface BacktestResult {
  totalReturnPct: number;
  buyHoldReturnPct: number;
  winRate: number;
  profitFactor: number;
  maxDrawdownPct: number;
  sharpe: number;
  tradeCount: number;
  wins: number;
  losses: number;
  trades: ClosedTrade[];
  equityCurve: EquityPoint[];
}

export interface RiskConfig {
  riskPerTradePct: number; // % of equity risked per trade
  maxConcurrentPositions: number;
}

export interface AnalyzeResponse {
  symbol: string;
  granularity: string;
  candles: Candle[];
  phases: PhaseSegment[];
  structurePoints: StructurePoint[];
  signals: TradeSignal[];
  backtest: BacktestResult;
  riskConfig: RiskConfig;
  generatedAt: string;
}
