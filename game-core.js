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
const ROUND_MODIFIERS = Object.freeze(['fastRamp', 'compactBuffers', 'gentleNewCosts']);

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
  stageTypes: Object.freeze({ collection: 'metal', processing: 'plastic', shipping: 'glass' }),
  unifiedNewCostDiscount: 0.20,
  unifiedRampDurationMultiplier: 0.5,
  mixedUnitPriceBonus: 0.40,
  secondaryProcessorCost: 200,
  secondaryProcessorRatePerSecond: 1,
  secondaryProcessorPriceMultiplier: 3,
  secondaryProcessorBufferCapacity: 10,
  roundModifier: null,
  random: Math.random,
  fastRampDurationMultiplier: 0.5,
  compactBufferCapacityMultiplier: 0.7,
  compactBufferUnitPriceBonus: 0.30,
  gentleNewCostGrowth: 1.10,
});

function mergeConfig(overrides = {}) {
  return {
    ...DEFAULT_CONFIG,
    ...overrides,
    initialMachines: { ...DEFAULT_CONFIG.initialMachines, ...overrides.initialMachines },
    baseRatePerSecond: { ...DEFAULT_CONFIG.baseRatePerSecond, ...overrides.baseRatePerSecond },
    newCostBase: { ...DEFAULT_CONFIG.newCostBase, ...overrides.newCostBase },
    upgradeCostBase: { ...DEFAULT_CONFIG.upgradeCostBase, ...overrides.upgradeCostBase },
    stageTypes: { ...DEFAULT_CONFIG.stageTypes, ...overrides.stageTypes },
  };
}

function createGame(configOverrides) {
  const config = mergeConfig(configOverrides);
  const synergy = determineSynergy(config.stageTypes);
  const roundModifier = selectRoundModifier(config);
  const capacityMultiplier = roundModifier === 'compactBuffers'
    ? config.compactBufferCapacityMultiplier : 1;
  const state = {
    elapsedMs: 0,
    money: config.initialMoney,
    score: 0,
    buffers: { A: 0, B: 0 },
    capacities: {
      A: config.bufferCapacity * capacityMultiplier,
      B: config.bufferCapacity * capacityMultiplier,
    },
    machines: { ...config.initialMachines },
    upgrades: { collection: [], processing: [], shipping: [] },
    newPurchaseCounts: Object.fromEntries(ALL_SLOTS.map((slot) => [slot, 0])),
    statuses: { collection: 'starved', processing: 'starved', shipping: 'starved' },
    synergy,
    roundModifier,
    secondaryProcessor: {
      purchased: false,
      refinedProducts: 0,
      refinedCapacity: config.secondaryProcessorBufferCapacity,
    },
    finished: false,
  };

  return { config, state };
}

function enhancementMultiplier(game, slot) {
  const { upgrades } = game.state;
  const { upgradeRateBonus } = game.config;
  const rampDurationMs = effectiveRampDurationMs(game);
  const bonus = upgrades[slot].reduce(
    (sum, upgrade) => sum + upgradeRateBonus * Math.min(1, upgrade.elapsedMs / rampDurationMs),
    0,
  );
  return 1 + bonus;
}

function isRamping(game, slot) {
  const rampDurationMs = effectiveRampDurationMs(game);
  return game.state.upgrades[slot].some((upgrade) => upgrade.elapsedMs < rampDurationMs);
}

function machineRate(game, slot) {
  const { machines } = game.state;
  const { baseRatePerSecond } = game.config;
  return machines[slot] * baseRatePerSecond[slot] * enhancementMultiplier(game, slot);
}

function calculateNewCost(game, slot) {
  assertSlot(slot);
  const { newCostBase, unifiedNewCostDiscount, gentleNewCostGrowth } = game.config;
  const newCostGrowth = game.state.roundModifier === 'gentleNewCosts'
    ? gentleNewCostGrowth : game.config.newCostGrowth;
  const synergyMultiplier = game.state.synergy === 'unified' ? 1 - unifiedNewCostDiscount : 1;
  return newCostBase[slot] * synergyMultiplier * (newCostGrowth ** game.state.newPurchaseCounts[slot]);
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

function buySecondaryProcessor(game) {
  if (game.state.secondaryProcessor.purchased) throw new Error('Secondary processor is already purchased');
  spend(game, game.config.secondaryProcessorCost);
  game.state.secondaryProcessor.purchased = true;
  return game.config.secondaryProcessorCost;
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

  refineProducts(game, dtSeconds);

  const shippingCapacity = machineRate(game, 'shipping') * dtSeconds;
  const refinedShippingAmount = Math.min(shippingCapacity, state.secondaryProcessor.refinedProducts);
  state.secondaryProcessor.refinedProducts -= refinedShippingAmount;
  const shippingAmount = refinedShippingAmount + Math.min(shippingCapacity - refinedShippingAmount, state.buffers.B);
  if (shippingAmount <= 0) state.statuses.shipping = 'starved';
  else {
    state.buffers.B -= shippingAmount - refinedShippingAmount;
    const income = (
      refinedShippingAmount * effectiveUnitPrice(game) * config.secondaryProcessorPriceMultiplier
      + (shippingAmount - refinedShippingAmount) * effectiveUnitPrice(game)
    );
    state.money += income;
    state.score += income;
    state.statuses.shipping = isRamping(game, 'shipping') ? 'ramping' : 'running';
  }

  state.elapsedMs += config.tickMs;
  state.finished = state.elapsedMs >= config.runDurationMs;
}

function determineSynergy(stageTypes) {
  const types = Object.values(stageTypes);
  if (new Set(types).size === 1) return 'unified';
  if (new Set(types).size === types.length) return 'mixed';
  return 'none';
}

function selectRoundModifier(config) {
  if (config.roundModifier !== null) {
    if (!ROUND_MODIFIERS.includes(config.roundModifier)) throw new Error(`Unknown round modifier: ${config.roundModifier}`);
    return config.roundModifier;
  }
  return ROUND_MODIFIERS[Math.floor(config.random() * ROUND_MODIFIERS.length)];
}

function effectiveRampDurationMs(game) {
  const { state, config } = game;
  const synergyMultiplier = state.synergy === 'unified' ? config.unifiedRampDurationMultiplier : 1;
  const roundMultiplier = state.roundModifier === 'fastRamp' ? config.fastRampDurationMultiplier : 1;
  return config.rampDurationMs * synergyMultiplier * roundMultiplier;
}

function effectiveUnitPrice(game) {
  const { state, config } = game;
  let multiplier = state.synergy === 'mixed' ? 1 + config.mixedUnitPriceBonus : 1;
  if (state.roundModifier === 'compactBuffers') multiplier *= 1 + config.compactBufferUnitPriceBonus;
  return config.unitPrice * multiplier;
}

function refineProducts(game, dtSeconds) {
  const { state, config } = game;
  if (!state.secondaryProcessor.purchased) return;
  const refinedAmount = Math.min(
    config.secondaryProcessorRatePerSecond * dtSeconds,
    state.buffers.B,
    state.secondaryProcessor.refinedCapacity - state.secondaryProcessor.refinedProducts,
  );
  state.buffers.B -= refinedAmount;
  state.secondaryProcessor.refinedProducts += refinedAmount;
}

function spend(game, cost) {
  if (game.state.money < cost) throw new Error(`Insufficient money: need ${cost}, have ${game.state.money}`);
  game.state.money -= cost;
}

function assertSlot(slot) {
  if (!ALL_SLOTS.includes(slot)) throw new Error(`Unknown investment slot: ${slot}`);
}

const exportedGameCore = {
  ALL_SLOTS,
  BUFFER_SLOTS,
  DEFAULT_CONFIG,
  MACHINE_SLOTS,
  RAMP_DURATION_MS,
  ROUND_MODIFIERS,
  RUN_DURATION_MS,
  TICK_MS,
  buyNew,
  buySecondaryProcessor,
  buyUpgrade,
  calculateNewCost,
  calculateUpgradeCost,
  createGame,
  tick,
};

if (typeof module !== 'undefined' && module.exports) module.exports = exportedGameCore;
if (typeof window !== 'undefined') window.GameCore = exportedGameCore;
