'use strict';

const core = window.GameCore;
const stateElement = document.querySelector('#state');
const investmentsElement = document.querySelector('#investments');
const messageElement = document.querySelector('#message');
let game = core.createGame();
window.debugGame = game; // renderer.js draws this game as a pure projection
let timerId = null;

function format(value) {
  return Number(value).toFixed(2);
}

function showMessage(message) {
  messageElement.textContent = message;
}

function runTicks(ticks) {
  core.tick(game, ticks);
  if (game.state.finished) stopRun('ラン終了');
  render();
}

function startRun() {
  if (timerId || game.state.finished) return;
  timerId = window.setInterval(() => runTicks(1), game.config.tickMs);
  showMessage('実行中');
}

function stopRun(message = '停止中') {
  if (timerId) window.clearInterval(timerId);
  timerId = null;
  showMessage(message);
}

function purchase(action, slot) {
  try {
    if (action === 'new') core.buyNew(game, slot);
    else core.buyUpgrade(game, slot);
    showMessage('購入しました');
  } catch (error) {
    showMessage(error.message);
  }
  render();
}

function reserveSecondary(rate) {
  try {
    core.reserveSecondaryProcessor(game, rate);
    showMessage(`予約しました（天引き${rate * 100}%）`);
  } catch (error) {
    showMessage(error.message);
  }
  render();
}

function cancelReservation() {
  try {
    core.cancelSecondaryReservation(game);
    showMessage('予約を解除しました');
  } catch (error) {
    showMessage(error.message);
  }
  render();
}

function investmentButton(label, action, slot, cost) {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = `${label} (${format(cost)})`;
  button.addEventListener('click', () => purchase(action, slot));
  return button;
}

function renderInvestments() {
  investmentsElement.replaceChildren();
  core.ALL_SLOTS.forEach((slot) => {
    investmentsElement.append(investmentButton(`${slot} 新設`, 'new', slot, core.calculateNewCost(game, slot)));
  });
  core.MACHINE_SLOTS.forEach((slot) => {
    investmentsElement.append(investmentButton(`${slot} 強化`, 'upgrade', slot, core.calculateUpgradeCost(game, slot)));
  });
  const secondary = game.state.secondaryProcessor;
  if (!secondary.purchased && !secondary.reserved) {
    game.config.secondaryProcessorReserveRates.forEach((rate) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = `二次加工器 予約 天引き${rate * 100}% (${format(game.config.secondaryProcessorCost)})`;
      button.addEventListener('click', () => reserveSecondary(rate));
      investmentsElement.append(button);
    });
  } else if (secondary.reserved) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = '二次加工器 予約解除';
    button.addEventListener('click', cancelReservation);
    investmentsElement.append(button);
  }
}

function render() {
  const { state } = game;
  const rows = [
    ['経過時間', `${format(state.elapsedMs / 1000)} / ${game.config.runDurationMs / 1000} 秒`],
    ['所持金', format(state.money)],
    ['スコア', format(state.score)],
    ['bufferA', `${format(state.buffers.A)} / ${format(state.capacities.A)}`],
    ['bufferB', `${format(state.buffers.B)} / ${format(state.capacities.B)}`],
    ['精錬品', `${format(state.secondaryProcessor.refinedProducts)} / ${format(state.secondaryProcessor.refinedCapacity)}`],
    ['二次加工器 積立', state.secondaryProcessor.reserved
      ? `${format(state.secondaryProcessor.savedAmount)} / ${format(game.config.secondaryProcessorCost)}（天引き${state.secondaryProcessor.reserveRate * 100}%）`
      : (state.secondaryProcessor.purchased ? '購入済み' : '未予約')],
    ['採取 / 加工 / 出荷', `${state.statuses.collection} / ${state.statuses.processing} / ${state.statuses.shipping}`],
    ['シナジー / 補正', `${state.synergy} / ${state.roundModifier}`],
  ];
  stateElement.replaceChildren(...rows.flatMap(([label, value]) => {
    const term = document.createElement('dt');
    term.textContent = label;
    const description = document.createElement('dd');
    description.textContent = value;
    return [term, description];
  }));
  renderInvestments();
}

document.querySelector('[data-action="start"]').addEventListener('click', startRun);
document.querySelector('[data-action="stop"]').addEventListener('click', () => stopRun());
document.querySelector('[data-action="advance"]').addEventListener('click', () => runTicks(100));
document.querySelector('[data-action="reset"]').addEventListener('click', () => {
  stopRun();
  game = core.createGame();
  window.debugGame = game;
  showMessage('リセットしました');
  render();
});

showMessage('停止中');
render();
