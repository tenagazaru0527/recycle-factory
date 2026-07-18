'use strict';

const assert = require('node:assert/strict');
const {
  RAMP_DURATION_MS,
  ROUND_MODIFIERS,
  RUN_DURATION_MS,
  buyNew,
  buySecondaryProcessor,
  buyUpgrade,
  calculateNewCost,
  calculateUpgradeCost,
  createGame,
  tick,
} = require('../game-core');

function closeTo(actual, expected, message) {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${message}: ${actual} !== ${expected}`);
}

{
  const game = createGame({ initialMoney: 0 });
  tick(game, RUN_DURATION_MS / game.config.tickMs);
  assert.equal(game.state.finished, true);
  assert.equal(game.state.elapsedMs, RUN_DURATION_MS);
  assert.ok(game.state.score > 0);
  assert.equal(game.state.score, game.state.money, 'score and earnings stay separate from spending');
  assert.ok(game.state.buffers.A <= game.state.capacities.A);
  assert.ok(game.state.buffers.B <= game.state.capacities.B);
}

{
  const game = createGame({ initialMoney: 1000 });
  const scoreBefore = game.state.score;
  const moneyBefore = game.state.money;
  const firstCost = calculateNewCost(game, 'collection');
  assert.equal(buyNew(game, 'collection'), firstCost);
  assert.equal(game.state.machines.collection, 2);
  closeTo(game.state.money, moneyBefore - firstCost, 'new machine spends money');
  assert.equal(game.state.score, scoreBefore, 'investment never reduces score');
  assert.ok(calculateNewCost(game, 'collection') > firstCost);

  const capacityBefore = game.state.capacities.A;
  buyNew(game, 'bufferA');
  assert.equal(game.state.capacities.A, capacityBefore + game.config.bufferCapacityIncrease);
}

{
  const game = createGame({ initialMoney: 1000 });
  const cost = calculateUpgradeCost(game, 'processing');
  buyUpgrade(game, 'processing');
  assert.equal(game.state.money, 1000 - cost);
  tick(game, 1);
  assert.equal(game.state.statuses.processing, 'ramping');
  tick(game, (RAMP_DURATION_MS / game.config.tickMs) - 1);
  assert.equal(game.state.statuses.processing, 'running');
  assert.throws(() => buyUpgrade(game, 'bufferA'), /no machines/);
}

{
  const game = createGame({
    initialMoney: 1000,
    stageTypes: { collection: 'metal', processing: 'metal', shipping: 'metal' },
    roundModifier: 'gentleNewCosts',
  });
  assert.equal(game.state.synergy, 'unified');
  closeTo(calculateNewCost(game, 'collection'), 20, 'unified discounts new costs');
  buyUpgrade(game, 'collection');
  tick(game, (RAMP_DURATION_MS * 0.5) / game.config.tickMs);
  assert.equal(game.state.statuses.collection, 'running', 'unified halves upgrade ramp duration');
  buyNew(game, 'collection');
  closeTo(calculateNewCost(game, 'collection'), 22, 'gentle modifier changes new cost growth');
}

{
  const game = createGame({
    initialMoney: 1000,
    stageTypes: { collection: 'metal', processing: 'plastic', shipping: 'glass' },
    roundModifier: 'compactBuffers',
    bufferCapacity: 100,
  });
  assert.equal(game.state.synergy, 'mixed');
  assert.equal(game.state.capacities.A, 70);
  game.state.buffers.B = 1;
  tick(game, 1);
  closeTo(game.state.score, 1.4 * 1.3 * game.config.tickMs / 1000, 'mixed and compact modifiers raise unit price');
}

{
  const game = createGame({
    initialMoney: 1000,
    roundModifier: 'fastRamp',
    stageTypes: { collection: 'metal', processing: 'metal', shipping: 'plastic' },
    secondaryProcessorRatePerSecond: 1,
  });
  assert.ok(ROUND_MODIFIERS.includes(game.state.roundModifier));
  assert.equal(buySecondaryProcessor(game), game.config.secondaryProcessorCost);
  game.state.buffers.B = 1;
  tick(game, 1);
  closeTo(game.state.secondaryProcessor.refinedProducts, 0, 'shipping consumes refined product');
  closeTo(game.state.score, 3 * game.config.tickMs / 1000, 'secondary processor triples refined unit value');
  assert.throws(() => buySecondaryProcessor(game), /already purchased/);
}

{
  const game = createGame({
    initialMoney: 1000,
    initialMachines: { collection: 0, processing: 0, shipping: 0 },
    roundModifier: 'fastRamp',
    stageTypes: { collection: 'metal', processing: 'metal', shipping: 'plastic' },
    secondaryProcessorRatePerSecond: 10,
    secondaryProcessorBufferCapacity: 0.05,
  });
  buySecondaryProcessor(game);
  game.state.buffers.B = 1;
  tick(game, 1);
  closeTo(game.state.secondaryProcessor.refinedProducts, 0.05, 'refined buffer fills to its capacity');
  assert.equal(game.state.secondaryProcessor.refinedCapacity, 0.05, 'refined capacity is exposed in state');
  closeTo(game.state.buffers.B, 0.95, 'refining stops at the full refined buffer');

  game.state.machines.shipping = 1;
  tick(game, 1);
  closeTo(game.state.buffers.B, 0.90, 'normal products ship while the refined buffer starts full');
  closeTo(game.state.score, 0.20, 'shipping prioritizes refined products before normal products');
}

{
  const game = createGame({ random: () => 0.99 });
  assert.equal(game.state.roundModifier, 'gentleNewCosts', 'round modifier is selected at run start');
}

console.log('game-core tests passed');
