// Time-in-Range Tracking System
import { readFileSync, writeFileSync, existsSync } from 'fs';

const TRACK_FILE = '/tmp/tir-tracking.json';

export function getTIRTracker(position_address) {
  try {
    if (existsSync(TRACK_FILE)) {
      const data = JSON.parse(readFileSync(TRACK_FILE, 'utf8'));
      return data[position_address] || null;
    }
  } catch(e) {}
  return null;
}

export function startTIRTracking(position_address, startTime) {
  try {
    let data = {};
    if (existsSync(TRACK_FILE)) {
      data = JSON.parse(readFileSync(TRACK_FILE, 'utf8'));
    }
    
    data[position_address] = {
      startTime: startTime,
      totalMinutes: 0,
      inRangeMinutes: 0,
      outOfRangeMinutes: 0,
      checks: []
    };
    
    writeFileSync(TRACK_FILE, JSON.stringify(data, null, 2));
  } catch(e) {
    console.log('[TIR] Failed to start:', e.message);
  }
}

export function updateTIRCheck(position_address, isInRange) {
  try {
    if (!existsSync(TRACK_FILE)) return;
    
    let data = JSON.parse(readFileSync(TRACK_FILE, 'utf8'));
    if (!data[position_address]) return;
    
    const now = Date.now();
    const entry = data[position_address];
    
    const lastCheck = entry.checks.length > 0 
      ? entry.checks[entry.checks.length - 1].time 
      : entry.startTime;
    const minutesPassed = (now - lastCheck) / 60000;
    
    entry.totalMinutes += minutesPassed;
    
    if (isInRange) {
      entry.inRangeMinutes += minutesPassed;
    } else {
      entry.outOfRangeMinutes += minutesPassed;
    }
    
    entry.checks.push({
      time: now,
      inRange: isInRange,
      minutesSinceStart: (now - entry.startTime) / 60000
    });
    
    if (entry.checks.length > 20) {
      entry.checks = entry.checks.slice(-20);
    }
    
    writeFileSync(TRACK_FILE, JSON.stringify(data, null, 2));
  } catch(e) {
    console.log('[TIR] Update failed:', e.message);
  }
}

export function getTIRStats(position_address) {
  try {
    if (!existsSync(TRACK_FILE)) return null;
    
    let data = JSON.parse(readFileSync(TRACK_FILE, 'utf8'));
    if (!data[position_address]) return null;
    
    const entry = data[position_address];
    const totalMinutes = entry.totalMinutes || 0;
    const inRangeMinutes = entry.inRangeMinutes || 0;
    const outOfRangeMinutes = entry.outOfRangeMinutes || 0;
    
    const inRangePercent = totalMinutes > 0 
      ? (inRangeMinutes / totalMinutes) * 100 
      : 100;
    
    return {
      totalMinutes: totalMinutes.toFixed(2),
      inRangeMinutes: inRangeMinutes.toFixed(2),
      outOfRangeMinutes: outOfRangeMinutes.toFixed(2),
      inRangePercent: inRangePercent.toFixed(1),
      outOfRangePercent: (100 - inRangePercent).toFixed(1),
      isHealthy: inRangePercent > 70
    };
  } catch(e) {
    return null;
  }
}

export function clearTIRPosition(position_address) {
  try {
    if (!existsSync(TRACK_FILE)) return;
    
    let data = JSON.parse(readFileSync(TRACK_FILE, 'utf8'));
    delete data[position_address];
    writeFileSync(TRACK_FILE, JSON.stringify(data, null, 2));
  } catch(e) {}
}
