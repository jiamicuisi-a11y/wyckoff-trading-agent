import { Kline, AnomalyFactors } from './types';

/**
 * A档异动因子计算模块
 * 基于K线数据计算各异动得分
 */

// OI异动（简化版：用成交量代理，后续可接真实OI数据）
export function calculateOiFactor(klines: Kline[]): number {
  if (klines.length < 20) return 0;
  
  const recentVol = klines.slice(-5).reduce((sum, k) => sum + k.volume, 0) / 5;
  const avgVol = klines.slice(0, -5).reduce((sum, k) => sum + k.volume, 0) / (klines.length - 5);
  
  const change = (recentVol - avgVol) / avgVol;
  return Math.min(Math.max(change * 100, 0), 100);
}

// 主动买盘异动（用收盘价位置估算）
export function calculateActiveBuyFactor(klines: Kline[]): number {
  if (klines.length < 10) return 0;
  
  let strongBuy = 0;
  for (let i = klines.length - 10; i < klines.length; i++) {
    const k = klines[i];
    const body = k.close - k.open;
    const range = k.high - k.low;
    if (range > 0 && body / range > 0.6) strongBuy++;
  }
  return (strongBuy / 10) * 100;
}

// 价格异动
export function calculatePriceFactor(klines: Kline[], period = 5): number {
  if (klines.length < period + 1) return 0;
  
  const recent = klines[klines.length - 1].close;
  const prev = klines[klines.length - period - 1].close;
  const change = ((recent - prev) / prev) * 100;
  
  return Math.min(Math.abs(change) * 8, 100);
}

// 成交额异动
export function calculateVolumeSurge(klines: Kline[]): number {
  if (klines.length < 20) return 0;
  
  const recent = klines.slice(-3).reduce((s, k) => s + k.volume, 0) / 3;
  const avg = klines.slice(0, -3).reduce((s, k) => s + k.volume, 0) / (klines.length - 3);
  
  const ratio = recent / avg;
  return Math.min((ratio - 1) * 50, 100);
}

export function getAllFactors(klines: Kline[]): AnomalyFactors {
  return {
    oiChange: calculateOiFactor(klines),
    activeBuy: calculateActiveBuyFactor(klines),
    priceMove: calculatePriceFactor(klines),
    volumeSurge: calculateVolumeSurge(klines),
    fundingExtreme: 0, // 暂时占位，后续接真实资金费率
  };
}