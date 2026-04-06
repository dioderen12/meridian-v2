import { discoverPools, getPoolDetail, getTopCandidates, verifyPoolPassedV2Filters, wasRecentlyScreened } from "./screening.js";
import {
  getActiveBin,
  deployPosition,
  getMyPositions,
  getWalletPositions,
  getPositionPnl,
  claimFees,
  closePosition,
  searchPools,
  withdrawLiquidity,
  addLiquidity,
} from "./dlmm.js";
import { getWalletBalances, swapToken } from "./wallet.js";
import { studyTopLPers } from "./study.js";
import { addLesson, clearAllLessons, clearPerformance, removeLessonsByKeyword, getPerformanceHistory, pinLesson, unpinLesson, listLessons } from "../lessons.js";
import { setPositionInstruction } from "../state.js";

import { getPoolMemory, addPoolNote } from "../pool-memory.js";
import { addStrategy, listStrategies, getStrategy, setActiveStrategy, removeStrategy } from "../strategy-library.js";

// DEPLOY LOCK: Prevent race conditions
const _deployLocks = new Set();
function lockPool(pool_address) {
  if (!pool_address) return true;
  if (_deployLocks.has(pool_address)) return false;
  _deployLocks.add(pool_address); return true;
}
function unlockPool(pool_address) {
  if (!pool_address) return; _deployLocks.delete(pool_address);
}

// RECENT DEPLOY TRACKER: Block same pool within 10 min (force different pools)
const _recentDeploys = new Map(); // pool_address -> timestamp
const POOL_COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes

function isPoolRecentlyDeployed(pool_address) {
  if (!pool_address) return false;
  const lastDeploy = _recentDeploys.get(pool_address);
  if (!lastDeploy) return false;
  const now = Date.now();
  if (now - lastDeploy < POOL_COOLDOWN_MS) {
    return true; // Still in cooldown
  }
  // Clean up expired entry
  _recentDeploys.delete(pool_address);
  return false;
}

function recordRecentDeploy(pool_address) {
  if (!pool_address) return;
  _recentDeploys.set(pool_address, Date.now());
}

import { addToBlacklist, removeFromBlacklist, listBlacklist } from "../token-blacklist.js";
import { addSmartWallet, removeSmartWallet, listSmartWallets, checkSmartWalletsOnPool } from "../smart-wallets.js";
import { getTokenInfo, getTokenHolders, getTokenNarrative } from "./token.js";
import { config, reloadScreeningThresholds } from "../config.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { execSync, spawn } from "child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USER_CONFIG_PATH = path.join(__dirname, "../user-config.json");
import { log, logAction } from "../logger.js";
import { notifyDeploy, notifyClose, notifySwap } from "../telegram.js";

// Registered by index.js so update_config can restart cron jobs when intervals change
let _cronRestarter = null;
export function registerCronRestarter(fn) { _cronRestarter = fn; }

// Map tool names to implementations
const toolMap = {
  discover_pools: discoverPools,
  get_top_candidates: getTopCandidates,
  get_pool_detail: getPoolDetail,
  get_position_pnl: getPositionPnl,
  get_active_bin: getActiveBin,
  deploy_position: deployPosition,
  get_my_positions: getMyPositions,
  get_wallet_positions: getWalletPositions,
  search_pools: searchPools,
  get_token_info: getTokenInfo,
  get_token_holders: getTokenHolders,
  get_token_narrative: getTokenNarrative,
  add_smart_wallet: addSmartWallet,
  remove_smart_wallet: removeSmartWallet,
  list_smart_wallets: listSmartWallets,
  check_smart_wallets_on_pool: checkSmartWalletsOnPool,
  claim_fees: claimFees,
  close_position: closePosition,
  get_wallet_balance: getWalletBalances,
  swap_token: swapToken,
  get_top_lpers: studyTopLPers,
  study_top_lpers: studyTopLPers,
  set_position_note: ({ position_address, instruction }) => {
    const ok = setPositionInstruction(position_address, instruction || null);
    if (!ok) return { error: `Position ${position_address} not found in state` };
    return { saved: true, position: position_address, instruction: instruction || null };
  },
  self_update: async () => {
    try {
      const result = execSync("git pull", { cwd: process.cwd(), encoding: "utf8" }).trim();
      if (result.includes("Already up to date")) {
        return { success: true, updated: false, message: "Already up to date — no restart needed." };
      }
      // Delay restart so this tool response (and Telegram message) gets sent first
      setTimeout(() => {
        const child = spawn(process.execPath, process.argv.slice(1), {
          detached: true,
          stdio: "inherit",
          cwd: process.cwd(),
        });
        child.unref();
        process.exit(0);
      }, 3000);
      return { success: true, updated: true, message: `Updated! Restarting in 3s...\n${result}` };
    } catch (e) {
      return { success: false, error: e.message };
    }
  },
  get_performance_history: getPerformanceHistory,
  add_strategy:        addStrategy,
  list_strategies:     listStrategies,
  get_strategy:        getStrategy,
  set_active_strategy: setActiveStrategy,
  remove_strategy:     removeStrategy,
  get_pool_memory: getPoolMemory,
  add_pool_note: addPoolNote,
  withdraw_liquidity: withdrawLiquidity,
  add_liquidity: addLiquidity,
  add_to_blacklist: addToBlacklist,
  remove_from_blacklist: removeFromBlacklist,
  list_blacklist: listBlacklist,
  add_lesson: ({ rule, tags, pinned, role }) => {
    addLesson(rule, tags || [], { pinned: !!pinned, role: role || null });
    return { saved: true, rule, pinned: !!pinned, role: role || "all" };
  },
  pin_lesson:   ({ id }) => pinLesson(id),
  unpin_lesson: ({ id }) => unpinLesson(id),
  list_lessons: ({ role, pinned, tag, limit } = {}) => listLessons({ role, pinned, tag, limit }),
  clear_lessons: ({ mode, keyword }) => {
    if (mode === "all") {
      const n = clearAllLessons();
      log("lessons", `Cleared all ${n} lessons`);
      return { cleared: n, mode: "all" };
    }
    if (mode === "performance") {
      const n = clearPerformance();
      log("lessons", `Cleared ${n} performance records`);
      return { cleared: n, mode: "performance" };
    }
    if (mode === "keyword") {
      if (!keyword) return { error: "keyword required for mode=keyword" };
      const n = removeLessonsByKeyword(keyword);
      log("lessons", `Cleared ${n} lessons matching "${keyword}"`);
      return { cleared: n, mode: "keyword", keyword };
    }
    return { error: "invalid mode" };
  },
  update_config: ({ changes, reason = "" }) => {
    // Flat key → config section mapping (covers everything in config.js)
    const CONFIG_MAP = {
      // screening
      minFeeActiveTvlRatio: ["screening", "minFeeActiveTvlRatio"],
      minTvl: ["screening", "minTvl"],
      maxTvl: ["screening", "maxTvl"],
      minVolume: ["screening", "minVolume"],
      minOrganic: ["screening", "minOrganic"],
      minHolders: ["screening", "minHolders"],
      minMcap: ["screening", "minMcap"],
      maxMcap: ["screening", "maxMcap"],
      minBinStep: ["screening", "minBinStep"],
      maxBinStep: ["screening", "maxBinStep"],
      timeframe: ["screening", "timeframe"],
      category: ["screening", "category"],
      minTokenFeesSol: ["screening", "minTokenFeesSol"],
      maxBundlersPct: ["screening", "maxBundlersPct"],
      maxTop10Pct: ["screening", "maxTop10Pct"],
      minFeePerTvl24h: ["management", "minFeePerTvl24h"],
      // management
      minClaimAmount: ["management", "minClaimAmount"],
      autoSwapAfterClaim: ["management", "autoSwapAfterClaim"],
      outOfRangeBinsToClose: ["management", "outOfRangeBinsToClose"],
      outOfRangeWaitMinutes: ["management", "outOfRangeWaitMinutes"],
      minVolumeToRebalance: ["management", "minVolumeToRebalance"],
      emergencyPriceDropPct: ["management", "emergencyPriceDropPct"],
      takeProfitFeePct: ["management", "takeProfitFeePct"],
      minSolToOpen: ["management", "minSolToOpen"],
      deployAmountSol: ["management", "deployAmountSol"],
      gasReserve: ["management", "gasReserve"],
      positionSizePct: ["management", "positionSizePct"],
      // risk
      maxPositions: ["risk", "maxPositions"],
      maxDeployAmount: ["risk", "maxDeployAmount"],
      // schedule
      managementIntervalMin: ["schedule", "managementIntervalMin"],
      screeningIntervalMin: ["schedule", "screeningIntervalMin"],
      // models
      managementModel: ["llm", "managementModel"],
      screeningModel: ["llm", "screeningModel"],
      generalModel: ["llm", "generalModel"],
      // strategy
      minBinStep: ["strategy", "minBinStep"],
      binsBelow: ["strategy", "binsBelow"],
    };

    const applied = {};
    const unknown = [];

    // Build case-insensitive lookup
    const CONFIG_MAP_LOWER = Object.fromEntries(
      Object.entries(CONFIG_MAP).map(([k, v]) => [k.toLowerCase(), [k, v]])
    );

    for (const [key, val] of Object.entries(changes)) {
      const match = CONFIG_MAP[key] ? [key, CONFIG_MAP[key]] : CONFIG_MAP_LOWER[key.toLowerCase()];
      if (!match) { unknown.push(key); continue; }
      applied[match[0]] = val;
    }

    if (Object.keys(applied).length === 0) {
      log("config", `update_config failed — unknown keys: ${JSON.stringify(unknown)}, raw changes: ${JSON.stringify(changes)}`);
      return { success: false, unknown, reason };
    }

    // Apply to live config immediately
    for (const [key, val] of Object.entries(applied)) {
      const [section, field] = CONFIG_MAP[key];
      const before = config[section][field];
      config[section][field] = val;
      log("config", `update_config: config.${section}.${field} ${before} → ${val} (verify: ${config[section][field]})`);
    }

    // Persist to user-config.json
    let userConfig = {};
    if (fs.existsSync(USER_CONFIG_PATH)) {
      try { userConfig = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8")); } catch { /**/ }
    }
    Object.assign(userConfig, applied);
    userConfig._lastAgentTune = new Date().toISOString();
    fs.writeFileSync(USER_CONFIG_PATH, JSON.stringify(userConfig, null, 2));

    // Restart cron jobs if intervals changed
    const intervalChanged = applied.managementIntervalMin != null || applied.screeningIntervalMin != null;
    
    // 🚨 CRITICAL: Do NOT allow changes to management/screening intervals
    // These are HARD-CODED for V2 strategy - 15-min max hold requires 1-min management
    if (applied.managementIntervalMin !== undefined || applied.screeningIntervalMin !== undefined) {
      log("config", `⚠️ REJECTED: Cannot change management/screening intervals — V2 STRATEGY LOCKED!`);
      delete applied.managementIntervalMin;
      delete applied.screeningIntervalMin;
    }
    if (intervalChanged && _cronRestarter) {
      _cronRestarter();
      log("config", `Cron restarted — management: ${config.schedule.managementIntervalMin}m, screening: ${config.schedule.screeningIntervalMin}m`);
    }

    // Save as a lesson — but skip ephemeral per-deploy interval changes
    // (managementIntervalMin / screeningIntervalMin change every deploy based on volatility;
    //  the rule is already in the system prompt, storing it 75+ times is pure noise)
    const lessonsKeys = Object.keys(applied).filter(
      k => k !== "managementIntervalMin" && k !== "screeningIntervalMin"
    );
    if (lessonsKeys.length > 0) {
      const summary = lessonsKeys.map(k => `${k}=${applied[k]}`).join(", ");
      addLesson(`[SELF-TUNED] Changed ${summary} — ${reason}`, ["self_tune", "config_change"]);
    }

    log("config", `Agent self-tuned: ${JSON.stringify(applied)} — ${reason}`);
    return { success: true, applied, unknown, reason };
  },
};

// Tools that modify on-chain state (need extra safety checks)
// Tools that LLM can call (WRITE_TOOLS = allowed to modify state)
const WRITE_TOOLS = new Set([
  "deploy_position",
  "claim_fees",
  "close_position",
  "swap_token",
  "withdraw_liquidity",
  "add_liquidity",
]);

/**
 * Execute a tool call with safety checks and logging.
 */
export async function executeTool(name, args) {
  const startTime = Date.now();

  // ─── Validate tool exists ─────────────────
  const fn = toolMap[name];
  if (!fn) {
    const error = `Unknown tool: ${name}`;
    log("error", error);
    return { error };
  }
  // ─── 🚨 HARD FORCED: Always exactly 2 SOL per deploy, no override allowed ───
  if (name === "deploy_position") {
    // 🚨 EMERGENCY STOP CHECK - BLOCK ALL DEPLOYS
    const { isEmergencyStop } = await import('../emergency-stop.mjs');
    if (isEmergencyStop()) {
      log("safety_block", `🚨 EMERGENCY STOP ACTIVE - ALL DEPLOYS BLOCKED`);
      return { blocked: true, reason: "EMERGENCY STOP ACTIVE - Cannot deploy" };
    }
    
    const FORCED_AMOUNT = 2;
    args.amount_y = FORCED_AMOUNT;
    args.amount_sol = FORCED_AMOUNT;
    args.amount_x = 0;
    log("executor", `⚠️ HARD FORCED deploy_amount = ${FORCED_AMOUNT} SOL`);
  }


  // ─── Pre-execution safety checks ──────────
  
  if (WRITE_TOOLS.has(name)) {
    const safetyCheck = await runSafetyChecks(name, args);
    if (!safetyCheck.pass) {
      log("safety_block", `${name} blocked: ${safetyCheck.reason}`);
      return {
        blocked: true,
        reason: safetyCheck.reason,
      };
    }
  }

  // ⚠️ TEMPORARILY DISABLED: DEPLOY GATE was blocking all deploys
  // Root cause: LLM calls getTopCandidates then get_pool_detail on specific pools
  // get_pool_detail doesn't write to cache, so DEPLOY GATE blocks everything
  // V2 filters are already hardcoded in screening.js, so deploy gate is redundant
  // TODO: Fix by making get_pool_detail also record to cache
  /*
  if (name === "deploy_position" && args.pool_address) {
    const poolAddress = args.pool_address;
    
    // Check if pool passed V2 filters
    const v2Passed = verifyPoolPassedV2Filters(poolAddress);
    const recentlyScreened = wasRecentlyScreened(poolAddress, 900000); // 15 min
    
    if (!v2Passed || !recentlyScreened) {
      log("executor", `⚠️ DEPLOY GATE: Pool ${poolAddress.slice(0,8)} not properly screened or not in V2 candidates. v2Passed=${v2Passed}, recentlyScreened=${recentlyScreened}`);
      
      // BLOCK if not screened - do not allow deploy to unscreened pools
      return { 
        blocked: true, 
        reason: `DEPLOY GATE: Pool ${poolAddress.slice(0,8)} not screened via V2 filters. Must use getTopCandidates() first. Deploy blocked for safety.` 
      };
    }
    
    log("executor", `✅ DEPLOY GATE: Pool ${poolAddress.slice(0,8)} verified - passed V2 screening`);
  }
  */

  // ─── Execute ──────────────────────────────
  try {
    // DEPLOY LOCK: Prevent race condition
    if (name === "deploy_position" && args.pool_address) {
      if (!lockPool(args.pool_address)) {
        return { blocked: true, reason: `Deploy to ${args.pool_address} already in progress. Duplicate blocked.` };
      }
    }

    const result = await fn(args);
    const duration = Date.now() - startTime;
    const success = result?.success !== false && !result?.error;

    logAction({
      tool: name,
      args,
      result: summarizeResult(result),
      duration_ms: duration,
      success,
    });

    if (success) {
      if (name === "swap_token" && result.tx) {
        notifySwap({ inputSymbol: args.input_mint?.slice(0, 8), outputSymbol: args.output_mint === "So11111111111111111111111111111111111111112" || args.output_mint === "SOL" ? "SOL" : args.output_mint?.slice(0, 8), amountIn: result.amount_in, amountOut: result.amount_out, tx: result.tx }).catch(() => {});
      } else if (name === "deploy_position") {
        notifyDeploy({ pair: result.pool_name || args.pool_name || args.pool_address?.slice(0, 8), amountSol: args.amount_y ?? args.amount_sol ?? 0, position: result.position, tx: result.txs?.[0] ?? result.tx, priceRange: result.price_range, binStep: result.bin_step, baseFee: result.base_fee }).catch(() => {});
        // Record this deploy for 10-min cooldown (force different pools)
        recordRecentDeploy(args.pool_address);
      } else if (name === "close_position") {
        notifyClose({ pair: result.pool_name || args.position_address?.slice(0, 8), pnlUsd: result.pnl_usd ?? 0, pnlPct: result.pnl_pct ?? 0 }).catch(() => {});
        // 🚨 FORCE AUTO-SWAP: All base tokens to SOL after close
        // No threshold - ANY remaining balance gets swapped to SOL
        // Only internal DLMM swaps allowed (swap_token is blocked for external use)
        log("executor", `🔍 CLOSE RESULT: base_mint=${result.base_mint}, pool_name=${result.pool_name}, pnl_usd=${result.pnl_usd}`);
        if (!args.skip_swap && result.base_mint) {
          try {
            const balances = await getWalletBalances({});
            log("executor", `🔍 WALLET BALANCES: tokens=${balances.tokens?.length || 0}`);
            const token = balances.tokens?.find(t => t.mint === result.base_mint);
            log("executor", `🔍 FOUND TOKEN: ${token ? `${token.symbol} balance=${token.balance} usd=${token.usd}` : 'NOT FOUND'}`);
            // 🚨 FORCE SWAP: Any token with balance > 0 gets swapped to SOL
            // Lowered threshold from $0.01 to $0.001 to catch tiny residuals
            // If balance > 0 and usd >= $0.001, swap it
            if (token && token.balance > 0 && token.usd >= 0.001) {
              log("executor", `🔄 FORCE SWAP: Converting ${token.symbol || result.base_mint.slice(0, 8)} (balance: ${token.balance}, ~$${token.usd.toFixed(3)}) to SOL`);
              const swapResult = await swapToken({ input_mint: result.base_mint, output_mint: "SOL", amount: token.balance, _internal: true });
              log("executor", `✅ FORCE SWAP SUCCESS: ${token.symbol || result.base_mint.slice(0, 8)} → SOL`);
            } else if (token && token.balance > 0 && token.usd < 0.001) {
              // Even if < $0.001, log it for tracking
              log("executor", `⚠️ Tiny residual: ${token.symbol || result.base_mint.slice(0, 8)} balance ${token.balance} (~$${token.usd.toFixed(4)}) - too small to swap`);
            } else if (!token) {
              log("executor", `⚠️ Token ${result.base_mint.slice(0, 8)} not found in wallet after close`);
            } else if (token && token.balance <= 0) {
              log("executor", `⚠️ Token ${token.symbol} has 0 balance - nothing to swap`);
            }
          } catch (e) {
            log("executor_warn", `🔄 FORCE SWAP failed: ${e.message} - trying again with smaller amount`);
            // Retry with half amount if first attempt fails
            try {
              const balances2 = await getWalletBalances({});
              const token2 = balances2.tokens?.find(t => t.mint === result.base_mint);
              if (token2 && token2.balance > 0) {
                const retryAmount = token2.balance * 0.5; // Try half
                log("executor", `🔄 RETRY SWAP: Trying ${retryAmount} of ${token2.balance}`);
                await swapToken({ input_mint: result.base_mint, output_mint: "SOL", amount: retryAmount, _internal: true });
                log("executor", `✅ RETRY SWAP SUCCESS`);
              }
            } catch (e2) {
              log("executor_error", `🔄 RETRY SWAP ALSO FAILED: ${e2.message}`);
            }
          }
        } else {
          log("executor_warn", `⚠️ close_position: result.base_mint is null/undefined - cannot swap`);
        }
        // 🚨 TRIGGER IMMEDIATE SCREENING after close to find next pool
        log("executor", `🔄 Position closed — triggering immediate screening for next pool`);
        import("../index.js").then(m => {
          if (m.runScreeningCycle) {
            m.runScreeningCycle({ silent: true }).catch(e => log("executor_warn", `Post-close screening failed: ${e.message}`));
          }
        }).catch(e => log("executor_warn", `Failed to import index for post-close screening: ${e.message}`));
      } else if (name === "claim_fees" && config.management.autoSwapAfterClaim && result.base_mint) {
        try {
          const balances = await getWalletBalances({});
          const token = balances.tokens?.find(t => t.mint === result.base_mint);
          if (token && token.usd >= 0.01) {
            log("executor", `Auto-swapping claimed ${token.symbol || result.base_mint.slice(0, 8)} ($${token.usd.toFixed(2)}) back to SOL`);
            await swapToken({ input_mint: result.base_mint, output_mint: "SOL", amount: token.balance, _internal: true });
          }
        } catch (e) {
          log("executor_warn", `Auto-swap after claim failed: ${e.message}`);
        }
      }
    }

    const _deployResult = result;
    if (name === "deploy_position" && args.pool_address) unlockPool(args.pool_address);
    return _deployResult;
  } catch (error) {
    // Unlock on error
    if (name === "deploy_position" && args.pool_address) unlockPool(args.pool_address);

    const duration = Date.now() - startTime;

    logAction({
      tool: name,
      args,
      error: error.message,
      duration_ms: duration,
      success: false,
    });

    // Return error to LLM so it can decide what to do
    return {
      error: error.message,
      tool: name,
    };
  }
}

/**
 * Run safety checks before executing write operations.
 */
async function runSafetyChecks(name, args) {
  switch (name) {
    case "deploy_position": {
      // Reject pools with bin_step out of configured range
      const minStep = config.screening.minBinStep;
      const maxStep = config.screening.maxBinStep;
      if (args.bin_step != null && (args.bin_step < minStep || args.bin_step > maxStep)) {
        return {
          pass: false,
          reason: `bin_step ${args.bin_step} is outside the allowed range of [${minStep}-${maxStep}].`,
        };
      }

      // Check position count limit + duplicate pool guard — force fresh scan to avoid stale cache
      const positions = await getMyPositions({ force: true });
      if (positions.total_positions >= config.risk.maxPositions) {
        return {
          pass: false,
          reason: `Max positions (${config.risk.maxPositions}) reached. Close a position first.`,
        };
      }
      const alreadyInPool = positions.positions.some(
        (p) => p.pool === args.pool_address
      );
      if (alreadyInPool && !args.allow_duplicate_pool) {
        return {
          pass: false,
          reason: `Already have an open position in pool ${args.pool_address}. Cannot open duplicate. Pass allow_duplicate_pool: true for multi-layer strategy.`,
        };
      }

      // 🚨 HARD BLOCK: Check if pool was recently deployed (within 10 min)
      if (isPoolRecentlyDeployed(args.pool_address)) {
        return {
          pass: false,
          reason: `Pool ${args.pool_address} was deployed within the last 10 minutes. Cannot deploy again yet. Choose a DIFFERENT pool.`,
        };
      }

      // Block same base token across different pools
      if (args.base_mint) {
        const alreadyHasMint = positions.positions.some(
          (p) => p.base_mint === args.base_mint
        );
        if (alreadyHasMint) {
          return {
            pass: false,
            reason: `Already holding base token ${args.base_mint} in another pool. One position per token only.`,
          };
        }
      }

      // Check amount limits
      const amountX = args.amount_x ?? 0;
      const amountY = args.amount_y ?? args.amount_sol ?? 0;

      // tokenX-only deploy: skip SOL amount checks
      if (amountX > 0 && amountY === 0) {
        // No SOL needed — tokenX-only deploy
      } else if (amountX > 0 && amountY > 0) {
        // Custom ratio dual-sided: skip minimum SOL check, only enforce max
        if (amountY > config.risk.maxDeployAmount) {
          return {
            pass: false,
            reason: `SOL amount ${amountY} exceeds maximum allowed per position (${config.risk.maxDeployAmount}).`,
          };
        }
      } else {
        // Standard SOL-sided deploy
        if (amountY <= 0) {
          return {
            pass: false,
            reason: `Must provide a positive SOL amount (amount_y).`,
          };
        }

        const minDeploy = Math.max(0.1, config.management.deployAmountSol);
        if (amountY < minDeploy) {
          return {
            pass: false,
            reason: `Amount ${amountY} SOL is below the minimum deploy amount (${minDeploy} SOL). Use at least ${minDeploy} SOL.`,
          };
        }
        if (amountY > config.risk.maxDeployAmount) {
          return {
            pass: false,
            reason: `SOL amount ${amountY} exceeds maximum allowed per position (${config.risk.maxDeployAmount}).`,
          };
        }
      }

      // Check SOL balance (skip for tokenX-only deploys)
      if (amountY > 0) {
        const balance = await getWalletBalances();
        const gasReserve = config.management.gasReserve;
        const minRequired = amountY + gasReserve;
        if (balance.sol < minRequired) {
          return {
            pass: false,
            reason: `Insufficient SOL: have ${balance.sol} SOL, need ${minRequired} SOL (${amountY} deploy + ${gasReserve} gas reserve).`,
          };
        }
      }

      return { pass: true };
    }

    case "swap_token": {
      // 🚨 SWAP BLOCK: Only allow internal DLMM operations
      const isInternalCall = args._internal === true;
      const isTokenToSol = args.output_mint === 'So11111111111111111111111111111111111111112' || args.output_mint === 'SOL';
      if (!isInternalCall) return { pass: false, reason: 'SWAP DENIED. Only DLMM auto-swap allowed.' };
      if (!isTokenToSol) return { pass: false, reason: 'SWAP DENIED. Only token-TO-SOL allowed.' };
      return { pass: true };
    }


    default:
      return { pass: true };
  }
}

/**
 * Summarize a result for logging (truncate large responses).
 */
function summarizeResult(result) {
  const str = JSON.stringify(result);
  if (str.length > 1000) {
    return str.slice(0, 1000) + "...(truncated)";
  }
  const _deployResult = result;
    if (name === "deploy_position" && args.pool_address) unlockPool(args.pool_address);
    return _deployResult;
}
