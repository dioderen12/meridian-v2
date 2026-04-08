// Learn From Winners - Analyze winning patterns
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WINNERS_DB = join(__dirname, '..', 'winner-patterns.json');

let patterns = {
  byHour: {},      // Wins by hour of day
  byPoolType: {},  // Wins by pool characteristics
  byTIR: {},       // Wins by TIR percentage
  byFeeYield: {},  // Wins by fee yield
  fastWins: [],    // Wins < 5 min
  bigWins: [],     // Wins > 15%
  recentWins: []   // Recent winning pools
};

function load() {
  try {
    if (existsSync(WINNERS_DB)) {
      patterns = JSON.parse(readFileSync(WINNERS_DB, 'utf8'));
    }
  } catch(e) {}
}
load();

function save() {
  try {
    writeFileSync(WINNERS_DB, JSON.stringify(patterns, null, 2));
  } catch(e) {}
}

// Analyze a winning trade
export function analyzeWinner({
  pair,
  poolAddress,
  pnlPct,
  age,
  tirPercent,
  feeYield,
  timestamp
}) {
  const hour = new Date(timestamp).getHours();
  
  // Record by hour
  if (!patterns.byHour[hour]) patterns.byHour[hour] = { wins: 0, total: 0 };
  patterns.byHour[hour].wins++;
  patterns.byHour[hour].total++;
  
  // Record by TIR bucket
  const tirBucket = Math.floor(tirPercent / 10) * 10; // 0-10, 10-20, etc
  if (!patterns.byTIR[tirBucket]) patterns.byTIR[tirBucket] = { wins: 0, total: 0 };
  patterns.byTIR[tirBucket].wins++;
  patterns.byTIR[tirBucket].total++;
  
  // Record by fee yield bucket
  const feeBucket = Math.floor(feeYield / 5) * 5;
  if (!patterns.byFeeYield[feeBucket]) patterns.byFeeYield[feeBucket] = { wins: 0, total: 0 };
  patterns.byFeeYield[feeBucket].wins++;
  patterns.byFeeYield[feeBucket].total++;
  
  // Fast wins
  if (age < 5 && pnlPct > 0) {
    patterns.fastWins.push({
      pair,
      pnlPct,
      age,
      tirPercent,
      timestamp
    });
    if (patterns.fastWins.length > 20) patterns.fastWins = patterns.fastWins.slice(-20);
  }
  
  // Big wins
  if (pnlPct > 15) {
    patterns.bigWins.push({
      pair,
      pnlPct,
      age,
      tirPercent,
      timestamp
    });
    if (patterns.bigWins.length > 20) patterns.bigWins = patterns.bigWins.slice(-20);
  }
  
  // Recent wins
  patterns.recentWins.push({
    pair,
    poolAddress,
    pnlPct,
    age,
    tirPercent,
    feeYield,
    timestamp
  });
  if (patterns.recentWins.length > 50) patterns.recentWins = patterns.recentWins.slice(-50);
  
  save();
  log('winners', `Analyzed winner: ${pair} ${pnlPct}% in ${age}min`);
}

// Get best trading hours
export function getBestHours() {
  const hours = Object.entries(patterns.byHour)
    .map(([hour, data]) => ({
      hour: parseInt(hour),
      winRate: data.wins / data.total,
      wins: data.wins
    }))
    .filter(h => h.wins >= 2)
    .sort((a, b) => b.winRate - a.winRate);
  
  return hours.slice(0, 3); // Top 3 hours
}

// Get best TIR range
export function getBestTIRRange() {
  const tirRanges = Object.entries(patterns.byTIR)
    .map(([bucket, data]) => ({
      minTIR: parseInt(bucket),
      maxTIR: parseInt(bucket) + 10,
      winRate: data.wins / data.total,
      wins: data.wins
    }))
    .filter(t => t.wins >= 2)
    .sort((a, b) => b.winRate - a.winRate);
  
  return tirRanges[0] || { minTIR: 70, maxTIR: 100 };
}

// Get winning pattern score for a candidate
export function scoreCandidate({ tirPercent, feeYield, hour }) {
  let score = 50; // Base score
  
  // Score by TIR
  const bestTIR = getBestTIRRange();
  if (tirPercent >= bestTIR.minTIR) {
    score += 20;
  } else if (tirPercent >= 70) {
    score += 10;
  }
  
  // Score by best hours
  const bestHours = getBestHours();
  if (bestHours.some(h => h.hour === hour)) {
    score += 15;
  }
  
  // Score by fee yield
  const feeBucket = Math.floor(feeYield / 5) * 5;
  if (patterns.byFeeYield[feeBucket]) {
    const winRate = patterns.byFeeYield[feeBucket].wins / patterns.byFeeYield[feeBucket].total;
    score += Math.round(winRate * 15);
  }
  
  return Math.min(100, score);
}

export function getWinnerStats() {
  return {
    totalWins: patterns.recentWins.length,
    avgPnL: patterns.recentWins.length > 0 
      ? patterns.recentWins.reduce((s, w) => s + w.pnlPct, 0) / patterns.recentWins.length 
      : 0,
    bestHours: getBestHours(),
    bestTIR: getBestTIRRange(),
    fastWins: patterns.fastWins.length,
    bigWins: patterns.bigWins.length
  };
}
