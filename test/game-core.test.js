'use strict';

const assert = require('node:assert/strict');
const {
  RAMP_DURATION_MS,
  ROUND_MODIFIERS,
  RUN_DURATION_MS,
  buyNew,
  buyUpgrade,
  cancelSecondaryReservation,
  reserveSecondaryProcessor,
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
  game.state.secondaryProcessor.purchased = true;
  game.state.buffers.B = 1;
  tick(game, 1);
  closeTo(game.state.secondaryProcessor.refinedProducts, 0, 'shipping consumes refined product');
  closeTo(game.state.score, 4 * game.config.tickMs / 1000, 'secondary processor quadruples refined unit value');
  assert.throws(() => reserveSecondaryProcessor(game, 0.50), /already purchased/);
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
  game.state.secondaryProcessor.purchased = true;
  game.state.buffers.B = 1;
  tick(game, 1);
  closeTo(game.state.secondaryProcessor.refinedProducts, 0.05, 'refined buffer fills to its capacity');
  assert.equal(game.state.secondaryProcessor.refinedCapacity, 0.05, 'refined capacity is exposed in state');
  closeTo(game.state.buffers.B, 0.95, 'refining stops at the full refined buffer');

  game.state.machines.shipping = 1;
  tick(game, 1);
  closeTo(game.state.buffers.B, 0.90, 'normal products ship while the refined buffer starts full');
  closeTo(game.state.score, 0.25, 'shipping prioritizes refined products before normal products');
}

{
  const game = createGame({
    initialMoney: 100,
    roundModifier: 'fastRamp',
    stageTypes: { collection: 'metal', processing: 'metal', shipping: 'plastic' },
  });
  assert.throws(() => reserveSecondaryProcessor(game, 0.30), /Unknown reserve rate/);
  assert.throws(() => cancelSecondaryReservation(game), /not reserved/);
  reserveSecondaryProcessor(game, 0.25);
  assert.equal(game.state.secondaryProcessor.reserved, true, 'reservation state is exposed');
  assert.equal(game.state.secondaryProcessor.reserveRate, 0.25, 'selected rate is exposed');
  assert.throws(() => reserveSecondaryProcessor(game, 0.50), /already reserved/);

  const moneyBefore = game.state.money;
  game.state.buffers.B = 1;
  tick(game, 1);
  const income = game.config.tickMs / 1000;
  closeTo(game.state.score, income, 'score counts the full shipping income');
  closeTo(game.state.secondaryProcessor.savedAmount, income * 0.25, 'reservation withholds the selected rate');
  closeTo(game.state.money, moneyBefore + income * 0.75, 'remaining income goes to money');

  buyNew(game, 'bufferA');
  assert.equal(game.state.newPurchaseCounts.bufferA, 1, 'normal investment stays possible while saving');

  const savedBefore = game.state.secondaryProcessor.savedAmount;
  const moneyBeforeCancel = game.state.money;
  cancelSecondaryReservation(game);
  closeTo(game.state.money, moneyBeforeCancel + savedBefore, 'cancelling refunds the full savings');
  assert.equal(game.state.secondaryProcessor.reserved, false);
  assert.equal(game.state.secondaryProcessor.reserveRate, null);
  assert.equal(game.state.secondaryProcessor.savedAmount, 0);
}

{
  const game = createGame({
    initialMoney: 0,
    roundModifier: 'fastRamp',
    stageTypes: { collection: 'metal', processing: 'metal', shipping: 'plastic' },
    secondaryProcessorCost: 0.04,
  });
  reserveSecondaryProcessor(game, 0.50);
  game.state.buffers.B = 1;
  tick(game, 1);
  const income = game.config.tickMs / 1000;
  assert.equal(game.state.secondaryProcessor.purchased, true, 'full savings auto-purchase the processor');
  assert.equal(game.state.secondaryProcessor.reserved, false, 'reservation ends after auto-purchase');
  assert.equal(game.state.secondaryProcessor.savedAmount, 0);
  closeTo(game.state.money, income - 0.04, 'excess savings return to money after auto-purchase');
  closeTo(game.state.score, income, 'auto-purchase never reduces score');
}

{
  const game = createGame({
    initialMoney: 0,
    initialMachines: { collection: 0, processing: 0, shipping: 0 },
    roundModifier: 'fastRamp',
    stageTypes: { collection: 'metal', processing: 'metal', shipping: 'plastic' },
    secondaryProcessorBufferCapacity: 0.05,
  });
  assert.equal(game.state.statuses.secondary, null, 'unpurchased secondary has null status');
  reserveSecondaryProcessor(game, 0.25);
  tick(game, 1);
  assert.equal(game.state.statuses.secondary, null, 'reserved secondary keeps null status');
  cancelSecondaryReservation(game);
  game.state.secondaryProcessor.purchased = true;
  tick(game, 1);
  assert.equal(game.state.statuses.secondary, 'starved', 'empty bufferB starves the secondary');
  game.state.buffers.B = 1;
  tick(game, 1);
  assert.equal(game.state.statuses.secondary, 'running', 'refining marks the secondary running');
  tick(game, 1);
  assert.equal(game.state.statuses.secondary, 'blocked', 'full refined buffer blocks the secondary');
}

{
  const game = createGame({ random: () => 0.99 });
  assert.equal(game.state.roundModifier, 'gentleNewCosts', 'round modifier is selected at run start');
}

// #28 statuses.collection の初期値は 'running'（採取器は上流を持たない）
{
  const game = createGame({ roundModifier: 'fastRamp' });
  assert.equal(game.state.statuses.collection, 'running', 'collection starts running, never starved');
}

// #28 採取レートが加工を上回る構成で bufferA が満杯 → collection が 'blocked'
{
  const game = createGame({
    initialMachines: { collection: 1, processing: 0, shipping: 0 },
    roundModifier: 'fastRamp',
    bufferCapacity: 1,
  });
  tick(game, 20); // 0.1/tick で採取、加工は無し。容量1のbufferAは満杯になる
  closeTo(game.state.buffers.A, game.state.capacities.A, 'bufferA is full');
  assert.equal(game.state.statuses.collection, 'blocked', 'full bufferA blocks collection');
  closeTo(game.state.utilization.collection, 0, 'blocked collection has 0 utilization');
}

// #28 加工能力に対し採取が不足 → processing が 'starved'
{
  const game = createGame({
    initialMachines: { collection: 0, processing: 1, shipping: 0 },
    roundModifier: 'fastRamp',
  });
  tick(game, 1);
  assert.equal(game.state.statuses.processing, 'starved', 'empty bufferA starves processing');
  closeTo(game.state.utilization.processing, 0, 'starved processing has 0 utilization');
}

// #28 initialMoney: 0 では buyNew / buyUpgrade が資金不足で throw する
{
  const game = createGame({ initialMoney: 0, roundModifier: 'fastRamp' });
  assert.throws(() => buyNew(game, 'collection'), /Insufficient money/, 'buyNew throws without money');
  assert.throws(() => buyUpgrade(game, 'processing'), /Insufficient money/, 'buyUpgrade throws without money');
}

// #28 reserveSecondaryProcessor の throw 契約（積立予約は頭金不要なので資金では throw しない）
{
  const game = createGame({ initialMoney: 0, roundModifier: 'fastRamp' });
  assert.throws(() => reserveSecondaryProcessor(game, 0.30), /Unknown reserve rate/, 'unknown rate throws');
  reserveSecondaryProcessor(game, 0.25); // initialMoney 0 でも予約は成立する（§3.5）
  assert.throws(() => reserveSecondaryProcessor(game, 0.50), /already reserved/, 're-reserving throws');
  game.state.secondaryProcessor.reserved = false;
  game.state.secondaryProcessor.purchased = true;
  assert.throws(() => reserveSecondaryProcessor(game, 0.50), /already purchased/, 'reserving after purchase throws');
}

// #28 ラン終了（finished）後は tick してもスコア・所持金・バッファが変化しない
{
  const game = createGame({ initialMoney: 1000, roundModifier: 'fastRamp' });
  tick(game, RUN_DURATION_MS / game.config.tickMs);
  assert.equal(game.state.finished, true, 'run reaches finished');
  const frozen = {
    score: game.state.score,
    money: game.state.money,
    a: game.state.buffers.A,
    b: game.state.buffers.B,
  };
  tick(game, 100); // finished 後の追加 tick は無視される
  assert.equal(game.state.score, frozen.score, 'score frozen after finish');
  assert.equal(game.state.money, frozen.money, 'money frozen after finish');
  assert.equal(game.state.buffers.A, frozen.a, 'bufferA frozen after finish');
  assert.equal(game.state.buffers.B, frozen.b, 'bufferB frozen after finish');
}

// #28 utilization: 需要量0（能力0）は 0、制約が無ければ 1、部分充足は比率
{
  // 全工程 能力0 → 需要量0 → utilization 0
  const idle = createGame({
    initialMachines: { collection: 0, processing: 0, shipping: 0 },
    roundModifier: 'fastRamp',
  });
  tick(idle, 1);
  closeTo(idle.state.utilization.collection, 0, 'zero-demand collection utilization is 0');
  closeTo(idle.state.utilization.processing, 0, 'zero-demand processing utilization is 0');
  closeTo(idle.state.utilization.shipping, 0, 'zero-demand shipping utilization is 0');

  // 既定構成の初回 tick は全工程が需要どおり流れる → utilization 1
  const full = createGame({ roundModifier: 'fastRamp' });
  tick(full, 1);
  closeTo(full.state.utilization.collection, 1, 'unconstrained collection utilization is 1');
  closeTo(full.state.utilization.processing, 1, 'unconstrained processing utilization is 1');
  closeTo(full.state.utilization.shipping, 1, 'unconstrained shipping utilization is 1');

  // bufferA の空きが需要の半分 → collection utilization 0.5
  const partial = createGame({
    initialMachines: { collection: 1, processing: 0, shipping: 0 },
    roundModifier: 'fastRamp',
    bufferCapacity: 1,
  });
  partial.state.buffers.A = 0.95; // 空き0.05、需要0.1
  tick(partial, 1);
  closeTo(partial.state.utilization.collection, 0.5, 'limited buffer space halves collection utilization');
}

console.log('game-core tests passed');
