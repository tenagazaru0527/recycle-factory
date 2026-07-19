'use strict';

const fs = require('node:fs');
const path = require('node:path');
const core = require('./game-core');

const BUFFER_CAPACITIES = [10, 20, 40];
const TRIALS_PER_SCENARIO = 1;
const PROBE_BUFFER_AMOUNT = 1_000_000;

const STRATEGIES = {
  collectionFirst(game) {
    return buyFirstAvailable(game, [
      ['new', 'collection'], ['new', 'bufferA'], ['new', 'processing'],
      ['new', 'bufferB'], ['new', 'shipping'],
      ['upgrade', 'processing'], ['upgrade', 'shipping'], ['upgrade', 'collection'],
    ]);
  },
  upgradeFirst(game) {
    return buyFirstAvailable(game, [
      ['upgrade', 'processing'], ['upgrade', 'shipping'], ['upgrade', 'collection'],
      ['new', 'processing'], ['new', 'shipping'], ['new', 'collection'],
    ]);
  },
  shippingFirst(game) {
    return buyFirstAvailable(game, [
      ['new', 'shipping'], ['upgrade', 'shipping'], ['new', 'processing'],
      ['upgrade', 'processing'], ['new', 'collection'], ['upgrade', 'collection'],
    ]);
  },
  saveForSecondary(game) {
    const secondary = game.state.secondaryProcessor;
    if (!secondary.purchased && !secondary.reserved) return tryReserveSecondaryProcessor(game);
    return buyFirstAvailable(game, [
      ['new', 'shipping'], ['new', 'processing'], ['upgrade', 'shipping'],
      ['upgrade', 'processing'], ['new', 'collection'], ['upgrade', 'collection'],
    ]);
  },
  bottleneckFollow(game) {
    const bottleneck = Object.entries(measureEffectiveThroughputs(game))
      .sort((left, right) => left[1] - right[1])[0][0];
    if (bottleneck === 'bufferA' || bottleneck === 'bufferB') return tryPurchase(game, 'new', bottleneck);

    const newCost = core.calculateNewCost(game, bottleneck);
    const upgradeCost = core.calculateUpgradeCost(game, bottleneck);
    return tryPurchase(game, newCost <= upgradeCost ? 'new' : 'upgrade', bottleneck);
  },
};

function createProbe(game) {
  return { config: game.config, state: structuredClone(game.state) };
}

function measureEffectiveThroughputs(game) {
  const dtSeconds = game.config.tickMs / 1000;
  const collection = createProbe(game);
  collection.state.buffers.A = 0;
  collection.state.capacities.A = PROBE_BUFFER_AMOUNT;
  collection.state.machines.processing = 0;
  collection.state.machines.shipping = 0;
  core.tick(collection);

  const processing = createProbe(game);
  processing.state.buffers.A = PROBE_BUFFER_AMOUNT;
  processing.state.buffers.B = 0;
  processing.state.capacities.B = PROBE_BUFFER_AMOUNT;
  processing.state.machines.collection = 0;
  processing.state.machines.shipping = 0;
  core.tick(processing);

  const shipping = createProbe(game);
  shipping.state.buffers.B = PROBE_BUFFER_AMOUNT;
  shipping.state.buffers.A = 0;
  shipping.state.machines.collection = 0;
  shipping.state.machines.processing = 0;
  shipping.state.secondaryProcessor.purchased = false;
  shipping.state.secondaryProcessor.refinedProducts = 0;
  const shippingBefore = shipping.state.buffers.B;
  core.tick(shipping);

  return {
    collection: collection.state.buffers.A / dtSeconds,
    bufferA: (game.state.capacities.A - game.state.buffers.A) / dtSeconds,
    processing: processing.state.buffers.B / dtSeconds,
    bufferB: (game.state.capacities.B - game.state.buffers.B) / dtSeconds,
    shipping: (shippingBefore - shipping.state.buffers.B) / dtSeconds,
  };
}

function buyFirstAvailable(game, actions) {
  for (const [kind, slot] of actions) {
    if (tryPurchase(game, kind, slot)) return true;
  }
  return false;
}

function tryPurchase(game, kind, slot) {
  try {
    if (kind === 'new') core.buyNew(game, slot);
    else core.buyUpgrade(game, slot);
    return true;
  } catch {
    return false;
  }
}

function tryReserveSecondaryProcessor(game) {
  try {
    core.reserveSecondaryProcessor(game, 0.50);
    return true;
  } catch {
    return false;
  }
}

function runScenario({ strategyName, roundModifier, bufferCapacity }) {
  const game = core.createGame({ roundModifier, bufferCapacity });
  const purchaseTimes = [];
  const strategy = STRATEGIES[strategyName];

  while (!game.state.finished) {
    if (strategy(game)) purchaseTimes.push(game.state.elapsedMs);
    core.tick(game);
  }

  return {
    strategy: strategyName,
    roundModifier,
    bufferCapacity,
    score: game.state.score,
    purchases: purchaseTimes.length,
    purchaseIntervalsMs: intervals(purchaseTimes),
    longestIdleMs: longestIdle(game.config.runDurationMs, purchaseTimes),
    secondaryProcessorPurchased: game.state.secondaryProcessor.purchased,
  };
}

function intervals(times) {
  return times.slice(1).map((time, index) => time - times[index]);
}

function longestIdle(runDurationMs, purchaseTimes) {
  const checkpoints = [0, ...purchaseTimes, runDurationMs];
  return Math.max(...intervals(checkpoints));
}

function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor((sorted.length - 1) * fraction)];
}

function scoreSummary(results) {
  const scores = results.map((result) => result.score);
  return {
    average: scores.reduce((total, score) => total + score, 0) / scores.length,
    median: percentile(scores, 0.5),
    lowerQuartile: percentile(scores, 0.25),
  };
}

function summarize(results) {
  const byModifier = Object.fromEntries(core.ROUND_MODIFIERS.map((modifier) => [modifier, {}]));
  const bufferCapacitySweep = [];
  const leaderCounts = Object.fromEntries(Object.keys(STRATEGIES).map((strategy) => [strategy, 0]));
  const topTwoGaps = [];

  for (const modifier of core.ROUND_MODIFIERS) {
    for (const strategy of Object.keys(STRATEGIES)) {
      const matches = results.filter((result) => result.roundModifier === modifier && result.strategy === strategy);
      byModifier[modifier][strategy] = scoreSummary(matches);
    }
  }

  for (const bufferCapacity of BUFFER_CAPACITIES) {
    for (const modifier of core.ROUND_MODIFIERS) {
      const summaries = Object.fromEntries(Object.keys(STRATEGIES).map((strategy) => {
        const matches = results.filter((result) => (
          result.bufferCapacity === bufferCapacity
          && result.roundModifier === modifier
          && result.strategy === strategy
        ));
        return [strategy, scoreSummary(matches)];
      }));
      bufferCapacitySweep.push({ bufferCapacity, roundModifier: modifier, strategies: summaries });
      const ranked = Object.entries(summaries)
        .map(([strategy, summary]) => ({ strategy, score: summary.average }))
        .sort((left, right) => right.score - left.score);
      leaderCounts[ranked[0].strategy] += 1;
      topTwoGaps.push({
        bufferCapacity,
        roundModifier: modifier,
        scoreDifference: ranked[0].score - ranked[1].score,
      });
    }
  }

  return {
    scoreByModifier: byModifier,
    bufferCapacitySweep,
    fixedStrategyLeaderCounts: leaderCounts,
    topTwoScoreDifferences: topTwoGaps,
    purchaseTiming: results.map(({ strategy, roundModifier, bufferCapacity, purchases, longestIdleMs }) => ({
      strategy, roundModifier, bufferCapacity, purchases, longestIdleMs,
    })),
    secondaryProcessorOutcomes: results.map(({ strategy, roundModifier, bufferCapacity, secondaryProcessorPurchased }) => ({
      strategy, roundModifier, bufferCapacity, secondaryProcessorPurchased,
    })),
  };
}

function runAll() {
  const results = [];
  for (const bufferCapacity of BUFFER_CAPACITIES) {
    for (const roundModifier of core.ROUND_MODIFIERS) {
      for (const strategyName of Object.keys(STRATEGIES)) {
        for (let trial = 0; trial < TRIALS_PER_SCENARIO; trial += 1) {
          results.push({ ...runScenario({ strategyName, roundModifier, bufferCapacity }), trial: trial + 1 });
        }
      }
    }
  }
  return {
    generatedAt: new Date().toISOString(),
    bufferCapacities: BUFFER_CAPACITIES,
    roundModifiers: core.ROUND_MODIFIERS,
    strategies: Object.keys(STRATEGIES),
    results,
    metrics: summarize(results),
  };
}

const output = runAll();
const logsDirectory = path.join(__dirname, 'logs');
fs.mkdirSync(logsDirectory, { recursive: true });
const outputPath = path.join(logsDirectory, 'simulation-results.json');
fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`);
console.log(`wrote ${path.relative(process.cwd(), outputPath)}`);
