'use strict';

const core = window.GameCore;
const stateElement = document.querySelector('#state');
const investmentsElement = document.querySelector('#investments');
const messageElement = document.querySelector('#message');
const secondaryElement = document.querySelector('#secondary');
const noticeElement = document.querySelector('#notice');
let game = core.createGame();
window.debugGame = game; // renderer.js draws this game as a pure projection
let timerId = null;
let noticeTimerId = null;
// §3.5 の自動購入は game-core 内で無言に成立するため、UI側で前回描画時点の
// purchased と比較して成立を検出する（game-core にイベント機構は足さない）。
let previousPurchased = game.state.secondaryProcessor.purchased;

const NOTICE_DURATION_MS = 12000;

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

/*
 * 画面に内部名（bufferA / bufferB）を出さず、工程列のどこを指すかで示す。
 * 表記は記号中心にし、説明文はマウスオーバー時の title だけに置く。
 * 並び順はゲーム状態に依存しない固定順（強調・並べ替え・色分けはしない）。
 */
const SLOT_GLYPHS = {
  collection: { icon: '▣ 採取', where: '採取工程' },
  processing: { icon: '▣ 加工', where: '加工工程' },
  shipping: { icon: '▣ 出荷', where: '出荷工程' },
  bufferA: { icon: '採取 ▸▸ 加工', where: '採取と加工のあいだの搬送路' },
  bufferB: { icon: '加工 ▸▸ 出荷', where: '加工と出荷のあいだの搬送路' },
};

function investmentButton(action, slot, cost) {
  const glyph = SLOT_GLYPHS[slot];
  const mark = action === 'new' ? '＋1' : '⬆';
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = `${glyph.icon} ${mark} (${format(cost)})`;
  button.title = action === 'new'
    ? `${glyph.where}を1つ増やす（コスト ${format(cost)}）`
    : `${glyph.where}の能力を強化する（コスト ${format(cost)}）`;
  button.addEventListener('click', () => purchase(action, slot));
  return button;
}

function renderInvestments() {
  investmentsElement.replaceChildren();
  core.ALL_SLOTS.forEach((slot) => {
    investmentsElement.append(investmentButton('new', slot, core.calculateNewCost(game, slot)));
  });
  core.MACHINE_SLOTS.forEach((slot) => {
    investmentsElement.append(investmentButton('upgrade', slot, core.calculateUpgradeCost(game, slot)));
  });
  const secondary = game.state.secondaryProcessor;
  if (!secondary.purchased && !secondary.reserved) {
    game.config.secondaryProcessorReserveRates.forEach((rate) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = `◆ 二次加工器 予約 ${rate * 100}% (${format(game.config.secondaryProcessorCost)})`;
      button.title = `出荷収入の${rate * 100}%を積み立てて二次加工器を購入する（必要額 ${format(game.config.secondaryProcessorCost)}）`;
      button.addEventListener('click', () => reserveSecondary(rate));
      investmentsElement.append(button);
    });
  } else if (secondary.reserved) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = '◆ 二次加工器 予約解除';
    button.title = '積立を中止し、積み立てた分を所持金へ戻す';
    button.addEventListener('click', cancelReservation);
    investmentsElement.append(button);
  }
}

function showNotice(text) {
  noticeElement.textContent = text;
  noticeElement.hidden = false;
  if (noticeTimerId) window.clearTimeout(noticeTimerId);
  noticeTimerId = window.setTimeout(() => {
    noticeElement.hidden = true;
    noticeTimerId = null;
  }, NOTICE_DURATION_MS);
}

function secondaryBadge(secondary) {
  const badge = document.createElement('span');
  badge.className = 'secondary-badge';
  if (secondary.purchased) {
    badge.dataset.state = 'purchased';
    badge.textContent = '稼働中';
  } else if (secondary.reserved) {
    badge.dataset.state = 'reserved';
    badge.textContent = `積立中（天引き${secondary.reserveRate * 100}%）`;
  } else {
    badge.dataset.state = 'idle';
    badge.textContent = '未予約';
  }
  return badge;
}

// 未予約 / 予約中 / 購入済み の3状態と、予約中の積立進捗を常時見える形で出す。
function renderSecondary() {
  const secondary = game.state.secondaryProcessor;
  const cost = game.config.secondaryProcessorCost;
  const header = document.createElement('div');
  header.className = 'secondary-state';
  header.append(secondaryBadge(secondary));
  const children = [header];

  if (secondary.reserved) {
    const progress = document.createElement('progress');
    progress.className = 'secondary-progress';
    progress.max = cost;
    progress.value = Math.min(secondary.savedAmount, cost);
    const figures = document.createElement('div');
    figures.className = 'secondary-figures';
    const saved = document.createElement('span');
    saved.textContent = `${format(secondary.savedAmount)} / ${format(cost)}`;
    const remaining = document.createElement('span');
    remaining.className = 'secondary-note';
    remaining.textContent = `残り ${format(Math.max(0, cost - secondary.savedAmount))}`;
    figures.append(saved, remaining);
    children.push(progress, figures);
  } else if (secondary.purchased) {
    const note = document.createElement('div');
    note.className = 'secondary-note';
    note.textContent = `精錬品 ${format(secondary.refinedProducts)} / ${format(secondary.refinedCapacity)}`;
    children.push(note);
  } else {
    const note = document.createElement('div');
    note.className = 'secondary-note';
    note.textContent = `必要額 ${format(cost)}`;
    children.push(note);
  }
  secondaryElement.replaceChildren(...children);

  if (secondary.purchased && !previousPurchased) {
    showNotice('二次加工器が積立完了で購入され、稼働を開始しました');
  }
  previousPurchased = secondary.purchased;
}

function render() {
  const { state } = game;
  const rows = [
    ['経過時間', `${format(state.elapsedMs / 1000)} / ${game.config.runDurationMs / 1000} 秒`],
    ['所持金', format(state.money)],
    ['スコア', format(state.score)],
    // 内部名（bufferA / bufferB）は出さず、搬送路の位置で示す
    ['採取 ▸▸ 加工', `${format(state.buffers.A)} / ${format(state.capacities.A)}`],
    ['加工 ▸▸ 出荷', `${format(state.buffers.B)} / ${format(state.capacities.B)}`],
    ['精錬品', `${format(state.secondaryProcessor.refinedProducts)} / ${format(state.secondaryProcessor.refinedCapacity)}`],
    // 二次加工器の積立は「二次加工器」パネルへ移設（テキスト1行に埋もれさせない）
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
  renderSecondary();
  renderInvestments();
}

document.querySelector('[data-action="start"]').addEventListener('click', startRun);
document.querySelector('[data-action="stop"]').addEventListener('click', () => stopRun());
document.querySelector('[data-action="advance"]').addEventListener('click', () => runTicks(100));
document.querySelector('[data-action="reset"]').addEventListener('click', () => {
  stopRun();
  game = core.createGame();
  window.debugGame = game;
  previousPurchased = game.state.secondaryProcessor.purchased;
  if (noticeTimerId) window.clearTimeout(noticeTimerId);
  noticeTimerId = null;
  noticeElement.hidden = true;
  showMessage('リセットしました');
  render();
});

showMessage('停止中');
render();
