'use strict';

const core = window.GameCore;
const stateElement = document.querySelector('#state');
const investmentsElement = document.querySelector('#investments');
const messageElement = document.querySelector('#message');
const secondaryElement = document.querySelector('#secondary');
const conditionsElement = document.querySelector('#conditions');
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

// game-core のエラーは英語かつ生の数値なので、UI側で日本語と丸めた金額に置き換える。
// （game-core を変更しないため、メッセージ本文には手を入れていない）
const ERROR_MESSAGES = {
  'Secondary processor is already purchased': '二次加工器は購入済みです',
  'Secondary processor is already reserved': '二次加工器はすでに予約中です',
  'Secondary processor is not reserved': '二次加工器は予約されていません',
};

function describeError(error, cost) {
  if (/^Insufficient money/.test(error.message)) {
    return cost === undefined
      ? `所持金が足りません（所持 ${format(game.state.money)}）`
      : `所持金が足りません（必要 ${format(cost)} / 所持 ${format(game.state.money)}）`;
  }
  return ERROR_MESSAGES[error.message] ?? error.message;
}

function purchase(action, slot) {
  const cost = action === 'new' ? core.calculateNewCost(game, slot) : core.calculateUpgradeCost(game, slot);
  try {
    if (action === 'new') core.buyNew(game, slot);
    else core.buyUpgrade(game, slot);
    showMessage('購入しました');
  } catch (error) {
    showMessage(describeError(error, cost));
  }
  render();
}

function reserveSecondary(rate) {
  try {
    core.reserveSecondaryProcessor(game, rate);
    showMessage(`予約しました（天引き${rate * 100}%）`);
  } catch (error) {
    showMessage(describeError(error));
  }
  render();
}

function cancelReservation() {
  try {
    core.cancelSecondaryReservation(game);
    showMessage('予約を解除しました');
  } catch (error) {
    showMessage(describeError(error));
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

/*
 * 投資の「効果」を示す記号。何を買うべきかは示さない（docs/design.md §4 A-6）。
 * ⚡ = 効果が即座に出る（新設）、⏳ = 効果が立ち上がるまで時間がかかる（強化）。
 */
const EFFECT_MARKS = { new: '⚡', upgrade: '⏳' };

function investmentButton(action, slot, cost) {
  const glyph = SLOT_GLYPHS[slot];
  const mark = action === 'new' ? '＋1' : '⬆';
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = `${glyph.icon} ${mark}${EFFECT_MARKS[action]} (${format(cost)})`;
  button.title = action === 'new'
    ? `${glyph.where}を1つ増やす。⚡処理量がすぐに増える（コスト ${format(cost)}）`
    // 立ち上がり時間は game-core の実効値（シナジー・補正で変わる）を UI で再計算せず、
    // 「時間がかかる」ことだけを伝える。装置上の充填ゲージ（A-4）が進行を示す。
    : `${glyph.where}の能力を+${Math.round(game.config.upgradeRateBonus * 100)}%強化する。`
      + `⏳効果は徐々に立ち上がる（コスト ${format(cost)}）`;
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
      button.textContent = `◆ 二次加工器 予約 単価×${game.config.secondaryProcessorPriceMultiplier} ↧${rate * 100}% (${format(game.config.secondaryProcessorCost)})`;
      button.title = `出荷収入の${rate * 100}%を積み立てて二次加工器を購入する。`
        + `精錬品の単価は${game.config.secondaryProcessorPriceMultiplier}倍になるが、`
        + `積立中は収入の${rate * 100}%が天引きされる（必要額 ${format(game.config.secondaryProcessorCost)}）`;
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

function formatClock(milliseconds) {
  const total = Math.max(0, Math.round(milliseconds / 1000));
  const minutes = Math.floor(total / 60);
  return `${minutes}:${String(total % 60).padStart(2, '0')}`;
}

function formatFlow(perSecond) {
  return `${(Math.round(perSecond * 10) / 10).toFixed(1)}/秒`;
}

// 滞留・在庫は「0.00」ではなく「なし」と出す。0という数字だけだと詰まりの有無が読めない。
function formatBacklog(amount, capacity, noun = '滞留') {
  return amount < 0.05
    ? `${noun}なし`
    : `${noun} ${format(amount)} / ${format(capacity)}`;
}

// 容量に近づいた滞留は、数値を読まなくても分かるよう色を変える。
// 色は「滞留の度合い」だけを示し、どの投資をすべきかは示さない。
function backlogLevel(amount, capacity) {
  if (!capacity) return null;
  const ratio = amount / capacity;
  if (ratio >= 0.8) return 'danger';
  if (ratio >= 0.5) return 'warn';
  return null;
}

// シナジーと周回補正が「何を有利にしているか」を、内部名ではなく効果で示す。
function synergyEffect() {
  const { config } = game;
  if (game.state.synergy === 'unified') {
    return `統一 新設 −${Math.round(config.unifiedNewCostDiscount * 100)}% / 立上り ×${config.unifiedRampDurationMultiplier}`;
  }
  if (game.state.synergy === 'mixed') {
    return `混成 単価 +${Math.round(config.mixedUnitPriceBonus * 100)}%`;
  }
  return '混在 効果なし';
}

function modifierEffect() {
  const { config } = game;
  const effects = {
    fastRamp: `補正 立上り ×${config.fastRampDurationMultiplier}`,
    compactBuffers: `補正 容量 ×${config.compactBufferCapacityMultiplier} / 単価 +${Math.round(config.compactBufferUnitPriceBonus * 100)}%`,
    gentleNewCosts: `補正 新設の値上がり ${config.newCostGrowth} → ${config.gentleNewCostGrowth}`,
  };
  return effects[game.state.roundModifier] ?? '補正なし';
}

// 現在のラン条件（シナジー・周回補正）をバッジで示す。内部名ではなく効果を出す。
function renderConditions() {
  const badges = [
    { text: synergyEffect(), title: '工程の系統が揃っているか（統一）／すべて異なるか（混成）で変わる効果' },
    { text: modifierEffect(), title: 'このランに抽選された周回補正の効果' },
  ].map(({ text, title }) => {
    const badge = document.createElement('span');
    badge.className = 'condition-badge';
    badge.textContent = text;
    badge.title = title;
    return badge;
  });
  conditionsElement.replaceChildren(...badges);
}

function render() {
  const { state } = game;
  const remainingMs = game.config.runDurationMs - state.elapsedMs;
  const rows = [
    // 残り時間を主表示にする（強化の回収可能性を判断する材料）
    ['残り時間', `${formatClock(remainingMs)} / ${formatClock(game.config.runDurationMs)}`],
    ['所持金', format(state.money)],
    ['スコア', format(state.score)],
    // 主表示は流量（個/秒）。在庫は補助として括弧で示す
    ['採取 ▸▸ 加工', `${formatFlow(state.throughput.collection)}（${formatBacklog(state.buffers.A, state.capacities.A)}）`,
      backlogLevel(state.buffers.A, state.capacities.A)],
    ['加工 ▸▸ 出荷', `${formatFlow(state.throughput.processing)}（${formatBacklog(state.buffers.B, state.capacities.B)}）`,
      backlogLevel(state.buffers.B, state.capacities.B)],
    ['出荷 ▸▸ 工場外', formatFlow(state.throughput.shipping)],
    ['精錬', `${formatFlow(state.throughput.secondary)}（${formatBacklog(state.secondaryProcessor.refinedProducts, state.secondaryProcessor.refinedCapacity, '在庫')}）`,
      backlogLevel(state.secondaryProcessor.refinedProducts, state.secondaryProcessor.refinedCapacity)],
    // 二次加工器の積立は「二次加工器」パネルへ移設（テキスト1行に埋もれさせない）
    ['採取 / 加工 / 出荷', `${state.statuses.collection} / ${state.statuses.processing} / ${state.statuses.shipping}`],
  ];
  stateElement.replaceChildren(...rows.flatMap(([label, value, level]) => {
    const term = document.createElement('dt');
    term.textContent = label;
    const description = document.createElement('dd');
    description.textContent = value;
    if (level) description.dataset.level = level;
    return [term, description];
  }));
  renderConditions();
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
