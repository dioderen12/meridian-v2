import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USER_CONFIG_PATH = path.join(__dirname, "user-config.json");

// ⚠️ CRITICAL: V2 STRATEGY LOCK - PROTECT THESE VALUES FROM MODIFICATION
export const V2_STRATEGY_LOCK = {
  deployAmountSol: 2,
  maxPositions: 1, // (GE test: 3 positions max - different pools
  binsBelow: 0, // For SPOT: single bin AT current price
  binsAbove: 0, // For SPOT: single bin only
  timeframe: "5m",
  minVolume: 13, // Minimum volume in SOL (~12.5 SOL = $1000 at $80/SOL)
  maxVolume: 150000,
  minVolume5m: 1000, // Minimum active volume in 5min for hit-and-run
  minMcap: 150000,
  maxMcap: 7500000,
  takeProfitFeePct: 10,
  stopLossPct: -5,
  maxHoldMinutes: 15, // Exit at 15 min (GE changed from 30 to 15)
  // Token age filter (rug prevention)
  minTokenAgeHours: 0.5,   // Min 30 minutes (was 0, GE changed to 30min-720h)
  maxTokenAgeHours: 720,  // Max 30 days old
  // Trailing take profit
  trailingTakeProfit: true,
  trailingTriggerPct: 3,   // Trigger at +3%
  trailingDropPct: 1.5,    // Exit when drop 1.5% from peak
  maxDeployAmount: 2, // Also lock nested risk.maxDeployAmount
  managementIntervalMin: 1,  // 1 min for management cycle (faster exit check)
  screeningIntervalMin: 15, // 15 min for screening cycle (GE changed from 30)
  organicScore: 65,
  organicScoreEnabled: true,
  minHolderCount: 500,
  holderCountEnabled: true,
  minTokenFeesSol: 30,
  minFeePct: 2,           // Min 2% fee (GE changed from 0.1 to 2-10%)
  maxFeePct: 10,          // Max 10% fee (GE changed from 0.1 to 2-10%)
  outOfRangeWaitMinutes: 0, // IMMEDIATE EXIT if OOR (critical for 30-min strategy!)
  // ⚠️ HARDCODED: RANGE MODE (20/-20) - GE approved 2026-04-03
  // 41 bins total (20 below + 20 above + current)
  // Balance between fee concentration and range coverage
  // ⚠️ HARDCODED: SPOT ONLY - GE confirmed 2026-04-03
  // Single bin at current price - simpler, faster exit
  strategyMode: "fixed_spot",
};

// Validate and lock v2 strategy params
function applyV2Lock(userConfig) {
  if (!userConfig) return {};
  for (const [key, lockedValue] of Object.entries(V2_STRATEGY_LOCK)) {
    if (userConfig[key] !== undefined && userConfig[key] !== lockedValue) {
      console.log(`⚠️ V2 LOCK: Rejecting change to ${key} (${userConfig[key]} → ${lockedValue})`);
      userConfig[key] = lockedValue;
    }
  }
  return userConfig;
}

const u = fs.existsSync(USER_CONFIG_PATH)
  ? applyV2Lock(JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8")))
  : {};

// Apply wallet/RPC from user-config if not already in env
if (u.rpcUrl)         process.env.RPC_URL            ||= u.rpcUrl;
if (u.rpcUrlFallback) process.env.RPC_URL_FALLBACK  ||= u.rpcUrlFallback;
if (u.walletKey)      process.env.WALLET_PRIVATE_KEY ||= u.walletKey;
if (u.llmModel)  process.env.LLM_MODEL          ||= u.llmModel;
if (u.dryRun !== undefined) process.env.DRY_RUN ||= String(u.dryRun);

export const config = {
  // ─── Risk Limits ─────────────────────────
  risk: {
    maxPositions:    u.maxPositions    ?? V2_STRATEGY_LOCK.maxPositions,
    maxDeployAmount: u.maxDeployAmount ?? V2_STRATEGY_LOCK.maxDeployAmount,
  },

  // ─── Pool Screening Thresholds ───────────
  screening: {
    minFeeActiveTvlRatio: u.minFeeActiveTvlRatio ?? 0.05,
    minTvl:            u.minTvl            ?? 5_000, // Lowered from 10K to get more pools from Meteora
    maxTvl:            u.maxTvl            ?? 150_000,
    minVolume:         V2_STRATEGY_LOCK.minVolume ?? 10_000,
    maxVolume:         V2_STRATEGY_LOCK.maxVolume ?? 150_000,
    minVolume5m:       V2_STRATEGY_LOCK.minVolume5m ?? 500,
    minOrganic:        V2_STRATEGY_LOCK.organicScore ?? 65,
    minHolders:        V2_STRATEGY_LOCK.minHolderCount ?? 500,
    minMcap:           V2_STRATEGY_LOCK.minMcap ?? 150_000,
    maxMcap:           V2_STRATEGY_LOCK.maxMcap ?? 10_000_000,
    minBinStep:        100, // Min bin step 100 (was 80, GE changed to 100-125)
    maxBinStep:        V2_STRATEGY_LOCK.maxBinStep        ?? 125,
    timeframe:         V2_STRATEGY_LOCK.timeframe ?? "5m",
    category: "trending",
    minTokenFeesSol:   V2_STRATEGY_LOCK.minTokenFeesSol ?? 30,
    maxBundlersPct:    V2_STRATEGY_LOCK.maxBundlersPct    ?? 30,  // max bot/bundler holders % (from Jupiter audit)
    maxTop10Pct:       V2_STRATEGY_LOCK.maxTop10Pct       ?? 60,  // max top 10 holders concentration
    blockedLaunchpads: u.blockedLaunchpads ?? [],  // e.g. ["letsbonk.fun", "pump.fun"]
  },

  // ─── Position Management ────────────────
  management: {
    minClaimAmount:        u.minClaimAmount        ?? V2_STRATEGY_LOCK.minClaimAmount ?? 5,
    autoSwapAfterClaim:    u.autoSwapAfterClaim    ?? false,
    outOfRangeBinsToClose: u.outOfRangeBinsToClose ?? 10,
    outOfRangeWaitMinutes: V2_STRATEGY_LOCK.outOfRangeWaitMinutes ?? 0,
    minVolumeToRebalance:  u.minVolumeToRebalance  ?? 1000,
    emergencyPriceDropPct: u.emergencyPriceDropPct ?? -50,
    takeProfitFeePct:      u.takeProfitFeePct      ?? V2_STRATEGY_LOCK.takeProfitFeePct ?? 3,
    minFeePerTvl24h:       u.minFeePerTvl24h       ?? 7,
    minSolToOpen:          u.minSolToOpen          ?? 0.55,
    deployAmountSol:       u.deployAmountSol       ?? V2_STRATEGY_LOCK.deployAmountSol,
    gasReserve:            u.gasReserve            ?? 0.2,
    positionSizePct:       u.positionSizePct       ?? 0.35,
    maxHoldMinutes:       15,
    stopLossPct:          u.stopLossPct          ?? V2_STRATEGY_LOCK.stopLossPct ?? -5,
    // Token age filter - avoid newly created tokens (rug prevention)
    minTokenAgeHours:     u.minTokenAgeHours     ?? 12,  // Min 12 hours old
    maxTokenAgeHours:     u.maxTokenAgeHours     ?? 720, // Max 30 days old
    // Trailing take profit - lock more profit when trending
    trailingTakeProfit:    u.trailingTakeProfit    ?? true,
    trailingTriggerPct:   u.trailingTriggerPct   ?? 3,   // Trigger at +3%
    trailingDropPct:      u.trailingDropPct      ?? 1.5, // Exit when drop 1.5% from peak
  },

  // ─── Strategy Mapping ───────────────────
  strategy: {
    strategy:  u.strategyMode ?? V2_STRATEGY_LOCK.strategyMode ?? "adaptive",
    binsBelow: u.binsBelow ?? V2_STRATEGY_LOCK.binsBelow ?? 15,
    binsAbove: u.binsAbove ?? V2_STRATEGY_LOCK.binsAbove ?? 0,
    spotThresholdVolume5m: u.spotThresholdVolume5m ?? V2_STRATEGY_LOCK.spotThresholdVolume5m ?? 200000,
    bidAskThresholdVolume5m: u.bidAskThresholdVolume5m ?? V2_STRATEGY_LOCK.bidAskThresholdVolume5m ?? 20000,
  },

  // ─── Scheduling ─────────────────────────
  schedule: {
    managementIntervalMin:  u.managementIntervalMin  ?? V2_STRATEGY_LOCK.managementIntervalMin ?? 1,
    screeningIntervalMin:   u.screeningIntervalMin   ?? V2_STRATEGY_LOCK.screeningIntervalMin ?? 15,
    healthCheckIntervalMin: u.healthCheckIntervalMin ?? 60,
  },

  // ─── LLM Settings ──────────────────────
  llm: {
    temperature: u.temperature ?? 0.373,
    maxTokens:   u.maxTokens   ?? 4096,
    maxSteps:    u.maxSteps    ?? 20,
    managementModel: u.managementModel ?? process.env.LLM_MODEL ?? "MiniMax-M2.7",
    screeningModel:  u.screeningModel  ?? process.env.LLM_MODEL ?? "MiniMax-M2.7",
    generalModel:    u.generalModel    ?? process.env.LLM_MODEL ?? "MiniMax-M2.7",
  },

  // ─── Common Token Mints ────────────────
  tokens: {
    SOL:  "So11111111111111111111111111111111111111112",
    USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    USDT: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
  },
};

/**
 * Compute the optimal deploy amount for a given wallet balance.
 * Scales position size with wallet growth (compounding).
 *
 * Formula: clamp(deployable × positionSizePct, floor=deployAmountSol, ceil=maxDeployAmount)
 *
 * Examples (defaults: gasReserve=0.2, positionSizePct=0.35, floor=0.5):
 *   0.8 SOL wallet → 0.6 SOL deploy  (floor)
 *   2.0 SOL wallet → 0.63 SOL deploy
 *   3.0 SOL wallet → 0.98 SOL deploy
 *   4.0 SOL wallet → 1.33 SOL deploy
 */
export function computeDeployAmount(walletSol) {
  const reserve  = config.management.gasReserve      ?? 0.2;
  const pct      = config.management.positionSizePct ?? 0.35;
  const floor    = config.management.deployAmountSol;
  const ceil     = config.risk.maxDeployAmount;
  const deployable = Math.max(0, walletSol - reserve);
  const dynamic    = deployable * pct;
  const result     = Math.min(ceil, Math.max(floor, dynamic));
  return parseFloat(result.toFixed(2));
}

/**
 * Reload user-config.json and apply updated screening thresholds to the
 * in-memory config object. Called after threshold evolution so the next
 * agent cycle uses the evolved values without a restart.
 */
export function reloadScreeningThresholds() {
  if (!fs.existsSync(USER_CONFIG_PATH)) return;
  try {
    const fresh = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"));
    const s = config.screening;
    if (fresh.minFeeActiveTvlRatio != null) s.minFeeActiveTvlRatio = fresh.minFeeActiveTvlRatio;
    if (fresh.minOrganic     != null) s.minOrganic     = fresh.minOrganic;
    if (fresh.minHolders     != null) s.minHolders     = fresh.minHolders;
    if (fresh.minMcap        != null) s.minMcap        = fresh.minMcap;
    if (fresh.maxMcap        != null) s.maxMcap        = fresh.maxMcap;
    if (fresh.minTvl         != null) s.minTvl         = fresh.minTvl;
    if (fresh.maxTvl         != null) s.maxTvl         = fresh.maxTvl;
    if (fresh.minVolume      != null) s.minVolume      = fresh.minVolume;
    if (fresh.minBinStep     != null) s.minBinStep     = fresh.minBinStep;
    if (fresh.maxBinStep     != null) s.maxBinStep     = fresh.maxBinStep;
    if (fresh.timeframe      != null) s.timeframe      = fresh.timeframe;
    if (fresh.category       != null) s.category       = fresh.category;
  } catch { /* ignore */ }
}


// DAILY LIMITS (GE added 2026-04-04)
const DAILY_LIMITS = {
  profitTarget: 30,      // $30-$50 daily profit target
  profitTargetMax: 50,  // Max $50
  lossLimit: -20,        // -$20 daily loss limit
  enabled: true,        // Enable/disable
};
