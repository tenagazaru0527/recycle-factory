'use strict';

const assert = require('node:assert/strict');
const {
  RAMP_DURATION_MS,
  RUN_DURATION_MS,
  buyNew,
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

console.log('game-core tests passed');
