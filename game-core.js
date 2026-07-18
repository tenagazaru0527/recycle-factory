'use strict';

/**
 * Fixed-timestep simulation core for one recycling-factory run.
 * All quantities are continuous so a 100 ms tick does not discard partial work.
 */

const TICK_MS = 100;
const RUN_DURATION_MS = 12 * 60 * 1000;
const RAMP_DURATION_MS = 60 * 1000;
const BUFFER_SLOTS = new Set(['bufferA', 'bufferB']);
const MACHINE_SLOTS = new Set(['collection', 'processing', 'shipping']);
const ALL_SLOTS = [...MACHINE_SLOTS, ...BUFFER_SLOTS];

// Balance values marked "仮" in design-v0.2 §3 are deliberately configurable.
const DEFAULT_CONFIG = Object.freeze({
  tickMs: TICK_MS,
  runDurationMs: RUN_DURATION_MS,
  rampDurationMs: RAMP_DURATION_MS,
  bufferCapacity: 20,
  bufferCapacityIncrease: 10,
  initialMoney: 100,
  initialMachines: Object.freeze({ collection: 1, processing: 1, shipping: 1 }),
  baseRatePerSecond: Object.freeze({ collection: 1, processing: 1, shipping: 1 }),
  unitPrice: 1,
  newCostBase: Object.freeze({
    collection: 25,
    bufferA: 15,
    processing: 30,
    bufferB: 15,
    shipping: 25,
  }),
  upgradeCostBase: Object.freeze({ collection: 20, processing: 25, shipping: 20 }),
  newCostGrowth: 1.15,
  upgradeRateBonus: 0.10,
});

function mergeConfig(overrides = {}) {
  return {
    ...DEFAULT_CONFIG,
    ...overrides,
    initialMachines: { ...DEFAULT_CONFIG.initialMachines, ...overrides.initialMachines },
    baseRatePerSecond: { ...DEFAULT_CONFIG.baseRatePerSecond, ...overrides.baseRatePerSecond },
    newCostBase: { ...DEFAULT_CONFIG.newCostBase, ...overrides.newCostBase },
    upgradeCostBase: { ...DEFAULT_CONFIG.upgradeCostBase, ...overrides.upgradeCostBase },
  };
}

function createGame(configOverrides) {
  const config = mergeConfig(configOverrides);
  const state = {
    elapsedMs: 0,
    money: config.initialMoney,
    score: 0,
    buffers: { A: 0, B: 0 },
    capacities: { A: config.bufferCapacity, B: config.bufferCapacity },
    machines: { ...config.initialMachines },
    upgrades: { collection: [], processing: [], shipping: [] },
    newPurchaseCounts: Object.fromEntries(ALL_SLOTS.map((slot) => [slot, 0])),
    statuses: { collection: 'starved', processing: 'starved', shipping: 'starved' },
    finished: false,
  };

  return { config, state };
}

function enhancementMultiplier(game, slot) {
  const { upgrades } = game.state;
  const { rampDurationMs, upgradeRateBonus } = game.config;
  const bonus = upgrades[slot].reduce(
    (sum, upgrade) => sum + upgradeRateBonus * Math.min(1, upgrade.elapsedMs / rampDurationMs),
    0,
  );
  return 1 + bonus;
}

function isRamping(game, slot) {
  const { rampDurationMs } = game.config;
  return game.state.upgrades[slot].some((upgrade) => upgrade.elapsedMs < rampDurationMs);
}

function machineRate(game, slot) {
  const { machines } = game.state;
  const { baseRatePerSecond } = game.config;
  return machines[slot] * baseRatePerSecond[slot] * enhancementMultiplier(game, slot);
}

function calculateNewCost(game, slot) {
  assertSlot(slot);
  const { newCostBase, newCostGrowth } = game.config;
  return newCostBase[slot] * (newCostGrowth ** game.state.newPurchaseCounts[slot]);
}

function calculateUpgradeCost(game, slot) {
  if (!MACHINE_SLOTS.has(slot)) {
    throw new Error(`Slot ${slot} has no machines to upgrade`);
  }
  const { upgradeCostBase, newCostGrowth } = game.config;
  return upgradeCostBase[slot] * game.state.machines[slot]
    * (newCostGrowth ** game.state.upgrades[slot].length);
}

function buyNew(game, slot) {
  assertSlot(slot);
  const cost = calculateNewCost(game, slot);
  spend(game, cost);

  if (slot === 'bufferA') game.state.capacities.A += game.config.bufferCapacityIncrease;
  else if (slot === 'bufferB') game.state.capacities.B += game.config.bufferCapacityIncrease;
  else game.state.machines[slot] += 1;
  game.state.newPurchaseCounts[slot] += 1;
  return cost;
}

function buyUpgrade(game, slot) {
  const cost = calculateUpgradeCost(game, slot);
  spend(game, cost);
  game.state.upgrades[slot].push({ elapsedMs: 0 });
  return cost;
}

function tick(game, ticks = 1) {
  if (!Number.isInteger(ticks) || ticks < 1) throw new Error('ticks must be a positive integer');
  for (let index = 0; index < ticks && !game.state.finished; index += 1) tickOnce(game);
  return game.state;
}

function tickOnce(game) {
  const { state, config } = game;
  const dtSeconds = config.tickMs / 1000;

  state.upgrades.collection.forEach((upgrade) => { upgrade.elapsedMs += config.tickMs; });
  state.upgrades.processing.forEach((upgrade) => { upgrade.elapsedMs += config.tickMs; });
  state.upgrades.shipping.forEach((upgrade) => { upgrade.elapsedMs += config.tickMs; });

  const collectionAmount = Math.min(machineRate(game, 'collection') * dtSeconds, state.capacities.A - state.buffers.A);
  if (collectionAmount <= 0) state.statuses.collection = 'blocked';
  else {
    state.buffers.A += collectionAmount;
    state.statuses.collection = isRamping(game, 'collection') ? 'ramping' : 'running';
  }

  const processingAmount = Math.min(
    machineRate(game, 'processing') * dtSeconds,
    state.buffers.A,
    state.capacities.B - state.buffers.B,
  );
  if (state.buffers.A <= 0) state.statuses.processing = 'starved';
  else if (state.capacities.B - state.buffers.B <= 0) state.statuses.processing = 'blocked';
  else {
    state.buffers.A -= processingAmount;
    state.buffers.B += processingAmount;
    state.statuses.processing = isRamping(game, 'processing') ? 'ramping' : 'running';
  }

  const shippingAmount = Math.min(machineRate(game, 'shipping') * dtSeconds, state.buffers.B);
  if (shippingAmount <= 0) state.statuses.shipping = 'starved';
  else {
    state.buffers.B -= shippingAmount;
    const income = shippingAmount * config.unitPrice;
    state.money += income;
    state.score += income;
    state.statuses.shipping = isRamping(game, 'shipping') ? 'ramping' : 'running';
  }

  state.elapsedMs += config.tickMs;
  state.finished = state.elapsedMs >= config.runDurationMs;
}

function spend(game, cost) {
  if (game.state.money < cost) throw new Error(`Insufficient money: need ${cost}, have ${game.state.money}`);
  game.state.money -= cost;
}

function assertSlot(slot) {
  if (!ALL_SLOTS.includes(slot)) throw new Error(`Unknown investment slot: ${slot}`);
}

module.exports = {
  ALL_SLOTS,
  BUFFER_SLOTS,
  DEFAULT_CONFIG,
  MACHINE_SLOTS,
  RAMP_DURATION_MS,
  RUN_DURATION_MS,
  TICK_MS,
  buyNew,
  buyUpgrade,
  calculateNewCost,
  calculateUpgradeCost,
  createGame,
  tick,
};
