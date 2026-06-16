// A档异动扫描策略类型定义

export interface Kline {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface AnomalyFactors {
  oiChange: number;      // 持仓量异动得分
  activeBuy: number;     // 主动买盘异动得分
  priceMove: number;     // 价格异动得分
  volumeSurge: number;   // 成交额异动得分
  fundingExtreme: number; // 资金费率极端值得分
}

export interface AnomalySignal {
  symbol: string;
  direction: 'long' | 'short';
  score: number;
  label: string;
  factors: AnomalyFactors;
  timestamp: number;
}