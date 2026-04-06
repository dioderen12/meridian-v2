/**
 * Deployer Blacklist Module
 * Block wallets that deploy suspicious/scam pools
 */

import { log } from "../logger.js";

let _blacklist = null;

export async function getDeployerBlacklist() {
  if (_blacklist) return _blacklist;
  
  try {
    const { readFileSync } = await import('fs');
    const data = readFileSync('./deployer-blacklist.json', 'utf8');
    _blacklist = JSON.parse(data);
    return _blacklist;
  } catch(e) {
    _blacklist = { blocked_deployers: {} };
    return _blacklist;
  }
}

export async function saveDeployerBlacklist(blacklist) {
  try {
    const { writeFileSync } = await import('fs');
    writeFileSync('./deployer-blacklist.json', JSON.stringify(blacklist, null, 2));
    _blacklist = blacklist;
    return true;
  } catch(e) {
    log("error", `Failed to save deployer blacklist: ${e.message}`);
    return false;
  }
}

export async function isDeployerBlacklisted(deployer_address) {
  if (!deployer_address) return false;
  const blacklist = await getDeployerBlacklist();
  return deployer_address in blacklist.blocked_deployers;
}

export async function addDeployerToBlacklist(deployer_address, info = {}) {
  const blacklist = await getDeployerBlacklist();
  const entry = {
    address: deployer_address,
    name: info.name || 'Unknown',
    reason: info.reason || 'Manual block',
    added_at: new Date().toISOString(),
    deployed_pools: info.deployed_pools || [],
  };
  blacklist.blocked_deployers[deployer_address] = entry;
  await saveDeployerBlacklist(blacklist);
  log("safety", `DEPLOYER BLACKLISTED: ${info.name || deployer_address} - ${info.reason}`);
  return true;
}

export async function removeDeployerFromBlacklist(deployer_address) {
  const blacklist = await getDeployerBlacklist();
  if (deployer_address in blacklist.blocked_deployers) {
    delete blacklist.blocked_deployers[deployer_address];
    await saveDeployerBlacklist(blacklist);
    return true;
  }
  return false;
}

export async function listBlockedDeployers() {
  const blacklist = await getDeployerBlacklist();
  return Object.values(blacklist.blocked_deployers);
}
