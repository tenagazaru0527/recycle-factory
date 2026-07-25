'use strict';

/**
 * renderer.js — Canvas projection of game-core state (design §4 A-1〜A-3, §5).
 * Pure display: reads window.debugGame every animation frame, never writes
 * game state and never re-implements game-core formulas. Particle motion and
 * lane appearance derive only from published state (buffers, capacities,
 * statuses, machines, stageTypes).
 */

(() => {
  const canvas = document.querySelector('#factory-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');

  // §4 ビジュアル仕様表（MS1: プロシージャル描画）
  const PALETTE = {
    background: '#23262b',
    metal: { fill: '#8a9199', edge: '#5c6166' },
    plastic: { fill: '#e07a3f', edge: '#a85a2c' },
    glass: { fill: '#7fc4d4', edge: '#5c99a6' },
    refined: { fill: '#d9a441', edge: '#f2d38b' },
    shippingBody: '#4a4f55',
    lane: '#3a3f46',
    laneEdge: '#4a4f55',
    label: '#9aa0a8',
    lampRunning: '#58c470',
    lampStarved: '#c9cfd6',
    lampBlocked: '#e05252',
    lampRamping: '#d9a441',
  };

  const MAX_PARTICLES_PER_LANE = 12; // A-1: 最大表示粒数（1粒=N個の代表表示）
  // A-1: 粒の「数・流れる速さ」は流量（個/秒）由来、「密集・滞留・停止」は在庫由来。
  // 2軸は独立で、在庫0でも流量があれば粒は流れ、流量0でも在庫があれば粒は止まる。
  const FLOW_REFERENCE_PER_SECOND = 6; // 表示上の満スケール（粒数・速度が最大になる流量）
  const MIN_FLOW_SPEED_SCALE = 0.3; // 流量がわずかでも動いていると分かる下限速度
  const MIN_STATUS_DISPLAY_MS = 300; // A-3: 表示切替の最低継続時間
  const BASE_PARTICLE_SPEED = 30; // px/s

  // A-3 稼働の連続表現: utilization(0〜1) を可動部の速度へ写像する。
  // 動いている装置は最低でも MIN_MOTION_SCALE の速さで動き、完全停止
  // (starved/blocked) だけが速度0 + 静的な停止バッジという離散表現になる。
  const MIN_MOTION_SCALE = 0.22;

  // A-2 詰まり判定（容量非依存）: 滞留が継続して増え続けた「秒数」で測る。
  // 充填率の固定閾値だと、投資で容量が伸びた局面（容量114/164など）で
  // 実際に詰まっていても発動しないため、容量に依存しない量を使う。
  const JAM_SMOOTHING_PER_SECOND = 2; // 滞留量EMAの追随速度
  const JAM_GROWTH_EPSILON = 0.05; // 個/秒。これ以下の増加は横ばい扱い
  const JAM_ONSET_SECONDS = 4; // 継続増加がこの秒数を超えたら詰まり表現を出す
  const JAM_FULL_SECONDS = 10; // ここで詰まり表現が最大になる
  const JAM_RELEASE_RATE = 3; // 滞留が減り始めたときの解除の速さ（倍率）

  // 抑制理由: utilization がこれ未満なら「抑えられている」とみなす（完全停止でなくても）
  const RESTRAINT_UTILIZATION = 0.95;
  const OUTPUT_PRESSURE_RATIO = 0.5; // 出口側バッファがこれ以上なら出口待ち
  const INPUT_SHORTAGE_RATIO = 0.15; // 入力側バッファがこれ以下なら材料待ち

  // A-5 出荷の出口表現: 出荷粒が工場外へ抜ける演出と、収入の時間集約表示
  const EXIT_PARTICLES_PER_UNIT = 0.6; // 出荷1個あたりの表示粒数
  const EXIT_PARTICLE_SPEED = 70; // px/s
  const EXIT_PARTICLE_LIFE = 1.1; // 秒
  const INCOME_WINDOW_MS = 400; // 収入表示の集約幅（A-5: 100〜500ms）
  const INCOME_POPUP_LIFE = 1.4; // 秒

  // 稼働メーター: 全装置に同じ計器を置き、utilization を目盛りで示す。
  // 律速段は「振り切れ（メーター満杯）」として相対的に読ませる。文字ラベルは置かない。
  const METER_FULL_UTILIZATION = 0.98; // これ以上を振り切れとして形で示す

  const MACHINES = {
    collection: { x: 40, y: 115, w: 90, h: 70, label: '採取' },
    processing: { x: 330, y: 115, w: 90, h: 70, label: '加工' },
    shipping: { x: 620, y: 115, w: 110, h: 70, label: '出荷' },
    secondary: { x: 430, y: 250, w: 90, h: 60, label: '二次加工' },
  };
  const LANES = {
    bufferA: { from: [140, 150], to: [320, 150], upstreamMachine: 'collection' },
    bufferB: { from: [430, 150], to: [610, 150], upstreamMachine: 'processing' },
    refined: { from: [525, 245], to: [655, 190], upstreamMachine: 'secondary' },
  };

  // Particle pools: fixed-size, objects reused across frames (A-1).
  const pools = {};
  Object.keys(LANES).forEach((lane) => {
    pools[lane] = {
      scroll: 0,
      particles: Array.from({ length: MAX_PARTICLES_PER_LANE }, (_, index) => ({ slot: index, bobPhase: index * 1.7 })),
    };
  });

  const statusHold = {}; // slot -> { shown, since } — A-3 minimum display duration
  const animPhases = { collection: 0, processing: 0, shipping: 0, secondary: 0 };
  const jamTrackers = {}; // lane -> { smoothed, growingSeconds }
  let hoveredMachine = null; // マウスオーバー時だけ補足テキストを出す（常設しない）
  const exitParticles = []; // 出荷口から工場外へ抜ける粒（表示専用）
  let exitSpawnCarry = 0;
  const incomePopups = []; // 集約した収入の表示（一定時間で消える）
  const incomeWindow = { sinceMs: 0, score: null, units: 0 };

  function displayedStatus(slot, actual, nowMs) {
    const hold = statusHold[slot] || (statusHold[slot] = { shown: actual, since: nowMs });
    if (actual !== hold.shown && nowMs - hold.since >= MIN_STATUS_DISPLAY_MS) {
      hold.shown = actual;
      hold.since = nowMs;
    }
    return hold.shown;
  }

  function isHalted(status) {
    return status === 'starved' || status === 'blocked';
  }

  // A-3: 稼働率を速度倍率へ。停止だけは 0（連続量と混ざらない離散値）。
  function motionScale(status, utilization) {
    if (isHalted(status) || status === null) return 0;
    const ratio = Math.min(1, Math.max(0, utilization));
    return MIN_MOTION_SCALE + (1 - MIN_MOTION_SCALE) * ratio;
  }

  // A-2: 滞留量の継続的な増加から詰まり度合い(0〜1)を得る。容量には依存しない。
  function updateJamLevel(name, level, dtSeconds) {
    const tracker = jamTrackers[name] || (jamTrackers[name] = { smoothed: level, growingSeconds: 0 });
    const previous = tracker.smoothed;
    const follow = Math.min(1, dtSeconds * JAM_SMOOTHING_PER_SECOND);
    tracker.smoothed = previous + (level - previous) * follow;
    const growthPerSecond = dtSeconds > 0 ? (tracker.smoothed - previous) / dtSeconds : 0;
    if (growthPerSecond > JAM_GROWTH_EPSILON) tracker.growingSeconds += dtSeconds;
    else tracker.growingSeconds = Math.max(0, tracker.growingSeconds - dtSeconds * JAM_RELEASE_RATE);
    const span = JAM_FULL_SECONDS - JAM_ONSET_SECONDS;
    return Math.min(1, Math.max(0, (tracker.growingSeconds - JAM_ONSET_SECONDS) / span));
  }

  // 低稼働の理由を公開状態から求める。材料待ち（上流不足）か出口待ち（下流飽和）か。
  // 採取の入力（採取源）と出荷の出力（工場外）は無限なので、その側は理由になりえない。
  function restraintOf(slot, state) {
    const utilization = state.utilization[slot];
    if (utilization === undefined || utilization >= RESTRAINT_UTILIZATION) return null;
    const level = Math.min(1, 1 - utilization);
    const ratioA = state.buffers.A / state.capacities.A;
    const ratioB = state.buffers.B / state.capacities.B;
    const inputRatio = { collection: null, processing: ratioA, shipping: ratioB }[slot];
    const outputRatio = { collection: ratioA, processing: ratioB, shipping: null }[slot];
    if (outputRatio !== null && outputRatio >= OUTPUT_PRESSURE_RATIO) return { side: 'output', level };
    if (inputRatio !== null && inputRatio <= INPUT_SHORTAGE_RATIO) return { side: 'input', level };
    return null;
  }

  function darken(hex, factor) {
    const value = parseInt(hex.slice(1), 16);
    const scale = (channel) => Math.round(((value >> channel) & 0xff) * factor);
    return `rgb(${scale(16)}, ${scale(8)}, ${scale(0)})`;
  }

  // --- particle shapes (§4 ビジュアル仕様表) ---

  function drawMetalParticle(x, y, size) {
    ctx.fillStyle = PALETTE.metal.fill;
    ctx.strokeStyle = PALETTE.metal.edge;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i < 6; i += 1) {
      const angle = (Math.PI / 3) * i;
      const px = x + size * Math.cos(angle);
      const py = y + size * Math.sin(angle);
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x, y, size * 0.4, 0, Math.PI * 2);
    ctx.stroke();
  }

  function drawPlasticParticle(x, y, size) {
    ctx.fillStyle = PALETTE.plastic.fill;
    ctx.beginPath();
    ctx.roundRect(x - size, y - size, size * 2, size * 2, size * 0.5);
    ctx.fill();
  }

  function drawGlassParticle(x, y, size) {
    ctx.save();
    ctx.globalAlpha = 0.6;
    ctx.fillStyle = PALETTE.glass.fill;
    ctx.beginPath();
    ctx.moveTo(x - size, y + size * 0.8);
    ctx.lineTo(x + size * 1.1, y + size * 0.5);
    ctx.lineTo(x - size * 0.2, y - size);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  function drawProductCube(x, y, size, stageType) {
    ctx.fillStyle = darken(PALETTE[stageType].fill, 0.65);
    ctx.fillRect(x - size, y - size, size * 2, size * 2);
    ctx.strokeStyle = PALETTE[stageType].fill;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x - size * 0.6, y - size * 0.6);
    ctx.lineTo(x + size * 0.6, y - size * 0.6);
    ctx.stroke();
  }

  function drawRefinedParticle(x, y, size) {
    ctx.fillStyle = PALETTE.refined.fill;
    ctx.strokeStyle = PALETTE.refined.edge;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x, y - size * 1.2);
    ctx.lineTo(x + size * 0.8, y);
    ctx.lineTo(x, y + size * 1.2);
    ctx.lineTo(x - size * 0.8, y);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }

  function drawParticle(kind, stageType, x, y, size) {
    if (kind === 'raw') {
      if (stageType === 'metal') drawMetalParticle(x, y, size);
      else if (stageType === 'plastic') drawPlasticParticle(x, y, size);
      else drawGlassParticle(x, y, size);
    } else if (kind === 'product') drawProductCube(x, y, size * 0.9, stageType);
    else drawRefinedParticle(x, y, size);
  }

  // --- lanes (A-1 flow + A-2 fill-ratio stages) ---

  function laneGeometry(lane) {
    const [fromX, fromY] = lane.from;
    const [toX, toY] = lane.to;
    const length = Math.hypot(toX - fromX, toY - fromY);
    return { fromX, fromY, unitX: (toX - fromX) / length, unitY: (toY - fromY) / length, length };
  }

  function drawLane(name, lane, flow, kind, stageType, dtSeconds, timeSeconds) {
    const geometry = laneGeometry(lane);
    const pool = pools[name];
    const { fillRatio, upstreamStatus, flowPerSecond } = flow;
    const flowRatio = Math.min(1, Math.max(0, flowPerSecond) / FLOW_REFERENCE_PER_SECOND);
    const upstreamHalted = isHalted(upstreamStatus);
    // 満杯で張り付いている（上流が押し戻されている）状態は、滞留の増加が
    // 止まって見えても詰まりそのもの。増加ベースの判定と max を取る。
    const saturated = fillRatio >= 0.999 || upstreamStatus === 'blocked';
    const jamLevel = Math.max(flow.jamLevel, saturated ? 1 : 0);

    // Lane bed
    ctx.strokeStyle = PALETTE.lane;
    ctx.lineWidth = 14;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(geometry.fromX, geometry.fromY);
    ctx.lineTo(geometry.fromX + geometry.unitX * geometry.length, geometry.fromY + geometry.unitY * geometry.length);
    ctx.stroke();

    // 詰まり中: 搬送路の圧縮/点滅表現 (A-2)。発動条件は滞留の継続増加であり、
    // 容量が成長しても機能する（充填率の固定閾値には依存しない）。
    if (jamLevel > 0) {
      const pulse = 0.45 + 0.4 * Math.sin(timeSeconds * 10);
      ctx.strokeStyle = `rgba(224, 82, 82, ${(pulse * jamLevel).toFixed(3)})`;
      ctx.lineWidth = 14 + 4 * jamLevel;
      ctx.beginPath();
      ctx.moveTo(geometry.fromX, geometry.fromY);
      ctx.lineTo(geometry.fromX + geometry.unitX * geometry.length, geometry.fromY + geometry.unitY * geometry.length);
      ctx.stroke();
    }

    // 上流が停止している（満杯 or blocked）: 停止が明確に見える静的な赤バー。
    if (saturated) {
      ctx.fillStyle = PALETTE.lampBlocked;
      ctx.save();
      ctx.translate(geometry.fromX, geometry.fromY);
      ctx.rotate(Math.atan2(geometry.unitY, geometry.unitX));
      ctx.fillRect(-3, -14, 6, 28);
      ctx.restore();
    }

    // 粒数: 流量由来（流れている分）と在庫由来（滞留している分）の大きい方。
    // 在庫0でも流量があれば粒は出るし、流量0でも在庫があれば粒は残る。
    const flowCount = flowRatio > 0 ? Math.max(1, Math.round(MAX_PARTICLES_PER_LANE * flowRatio)) : 0;
    const fillCount = fillRatio <= 0.001 ? 0
      : fillRatio < 0.5 ? Math.max(1, Math.round(MAX_PARTICLES_PER_LANE * (fillRatio / 0.5)))
        : MAX_PARTICLES_PER_LANE;
    const jamCount = jamLevel > 0 ? Math.round(MAX_PARTICLES_PER_LANE * (0.5 + 0.5 * jamLevel)) : 0;
    const count = Math.max(flowCount, fillCount, jamCount);
    const fillCompression = fillRatio < 0.5 ? 0 : Math.min(1, (fillRatio - 0.5) / 0.4);
    const compression = Math.max(fillCompression, jamLevel);
    const packedLength = geometry.length * (1 - 0.45 * compression);

    // 粒の速さは流量（個/秒）由来。流量0なら在庫が残っていても粒は動かない。
    // 詰まり（在庫由来）は減速として重ねる。
    const flowSpeedScale = flowRatio > 0
      ? MIN_FLOW_SPEED_SCALE + (1 - MIN_FLOW_SPEED_SCALE) * flowRatio
      : 0;
    const jamScale = upstreamHalted ? 0 : 1 - 0.65 * jamLevel;
    pool.scroll += dtSeconds * BASE_PARTICLE_SPEED * flowSpeedScale * jamScale;

    if (count === 0) return;
    const spacing = packedLength / count;
    const packedStart = geometry.length - packedLength; // queue backs up toward the downstream machine
    for (let index = 0; index < count; index += 1) {
      const particle = pool.particles[index];
      const along = packedStart + ((particle.slot * spacing) + pool.scroll) % packedLength;
      const bob = Math.sin(timeSeconds * 3 + particle.bobPhase) * 1.5;
      const x = geometry.fromX + geometry.unitX * along;
      const y = geometry.fromY + geometry.unitY * along + bob;
      drawParticle(kind, stageType, x, y, 5);
    }
  }

  // --- machines (A-3 state motion + static differentiators) ---

  function drawStatusLamp(machine, status) {
    const cx = machine.x + machine.w - 12;
    const cy = machine.y + 12;
    if (status === 'running') {
      ctx.fillStyle = PALETTE.lampRunning;
      ctx.beginPath();
      ctx.arc(cx, cy, 5, 0, Math.PI * 2);
      ctx.fill();
    } else if (status === 'ramping') {
      ctx.fillStyle = PALETTE.lampRamping;
      ctx.beginPath();
      ctx.arc(cx, cy, 5, 0, Math.PI * 2);
      ctx.fill();
    } else if (status === 'starved') {
      ctx.strokeStyle = PALETTE.lampStarved;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(cx, cy, 5, 0, Math.PI * 2);
      ctx.stroke();
    } else if (status === 'blocked') {
      ctx.fillStyle = PALETTE.lampBlocked;
      ctx.fillRect(cx - 5, cy - 5, 10, 10);
    }
  }

  function drawSideMarker(machine, side, color, timeSeconds) {
    const pulse = 0.5 + 0.5 * Math.sin(timeSeconds * 8);
    const y = machine.y + machine.h / 2;
    const x = side === 'input' ? machine.x - 6 : machine.x + machine.w + 6;
    const direction = side === 'input' ? 1 : -1;
    ctx.save();
    ctx.globalAlpha = 0.4 + 0.5 * pulse;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(x, y - 8);
    ctx.lineTo(x, y + 8);
    ctx.lineTo(x + 8 * direction, y);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  function drawRampGauge(machine, timeSeconds) {
    const gx = machine.x + 8;
    const gy = machine.y - 14;
    const gw = machine.w - 16;
    ctx.strokeStyle = PALETTE.lampRamping;
    ctx.lineWidth = 1;
    ctx.strokeRect(gx, gy, gw, 8);
    // Indeterminate sweep: game-core does not publish ramp progress, so the
    // gauge animates without claiming an exact fraction.
    const sweep = (timeSeconds * 0.7) % 1;
    ctx.fillStyle = PALETTE.lampRamping;
    ctx.fillRect(gx + gw * Math.max(0, sweep - 0.25), gy, gw * Math.min(0.25, sweep), 8);
  }

  function drawMachineBody(machine, bodyColor) {
    ctx.fillStyle = bodyColor;
    ctx.strokeStyle = darken(bodyColor.startsWith('#') ? bodyColor : '#4a4f55', 0.6);
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.roundRect(machine.x, machine.y, machine.w, machine.h, 8);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = PALETTE.label;
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(machine.label, machine.x + machine.w / 2, machine.y + machine.h + 14);
  }

  function drawCountDots(machine, count) {
    ctx.fillStyle = PALETTE.label;
    const shown = Math.min(count, 8);
    for (let index = 0; index < shown; index += 1) {
      ctx.beginPath();
      ctx.arc(machine.x + 10 + index * 9, machine.y + machine.h - 8, 2.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function drawCollection(machine, stageType, status, phase) {
    drawMachineBody(machine, darken(PALETTE[stageType].fill, 0.45));
    const cx = machine.x + machine.w / 2;
    const cy = machine.y + machine.h / 2;
    ctx.strokeStyle = PALETTE[stageType].fill;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx, cy, 18, 0, Math.PI * 2);
    ctx.stroke();
    for (let index = 0; index < 3; index += 1) {
      const angle = phase + (index * Math.PI * 2) / 3;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + 18 * Math.cos(angle), cy + 18 * Math.sin(angle));
      ctx.stroke();
    }
  }

  function drawProcessing(machine, stageType, status, phase) {
    drawMachineBody(machine, darken(PALETTE[stageType].fill, 0.45));
    const plateY = machine.y + 18 + Math.abs(Math.sin(phase)) * (machine.h - 40);
    ctx.fillStyle = PALETTE[stageType].fill;
    ctx.fillRect(machine.x + 15, plateY, machine.w - 30, 8);
    ctx.strokeStyle = darken(PALETTE[stageType].fill, 0.7);
    ctx.strokeRect(machine.x + 15, machine.y + 14, machine.w - 30, machine.h - 28);
  }

  function drawShipping(machine, status, phase) {
    drawMachineBody(machine, PALETTE.shippingBody);
    const beltY = machine.y + machine.h / 2;
    ctx.strokeStyle = '#767c84';
    ctx.lineWidth = 3;
    ctx.setLineDash([8, 6]);
    ctx.lineDashOffset = -phase * 20;
    ctx.beginPath();
    ctx.moveTo(machine.x + 10, beltY);
    ctx.lineTo(machine.x + machine.w - 24, beltY);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#767c84';
    ctx.beginPath();
    ctx.moveTo(machine.x + machine.w - 22, beltY - 8);
    ctx.lineTo(machine.x + machine.w - 22, beltY + 8);
    ctx.lineTo(machine.x + machine.w - 8, beltY);
    ctx.closePath();
    ctx.fill();
  }

  function drawSecondary(machine, status, phase) {
    drawMachineBody(machine, darken(PALETTE.refined.fill, 0.4));
    const cx = machine.x + machine.w / 2;
    const cy = machine.y + machine.h / 2;
    ctx.strokeStyle = PALETTE.refined.fill;
    ctx.lineWidth = 2;
    for (let index = 0; index < 8; index += 1) {
      const angle = phase + (index * Math.PI) / 4;
      ctx.beginPath();
      ctx.moveTo(cx + 10 * Math.cos(angle), cy + 10 * Math.sin(angle));
      ctx.lineTo(cx + 16 * Math.cos(angle), cy + 16 * Math.sin(angle));
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.arc(cx, cy, 10, 0, Math.PI * 2);
    ctx.stroke();
  }

  // 完全停止の離散表現: 可動部を止めるだけでは「低稼働でゆっくり動いている」と
  // 見分けがつかないため、静止画でも区別できる停止バッジを重ねる（点滅に依存しない）。
  function drawHaltBadge(machine, status) {
    const cx = machine.x + machine.w / 2;
    const cy = machine.y + machine.h / 2;
    ctx.save();
    ctx.globalAlpha = 0.55;
    ctx.fillStyle = '#15181c';
    ctx.beginPath();
    ctx.arc(cx, cy, 15, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    ctx.fillStyle = status === 'blocked' ? PALETTE.lampBlocked : PALETTE.lampStarved;
    ctx.fillRect(cx - 7, cy - 8, 5, 16);
    ctx.fillRect(cx + 2, cy - 8, 5, 16);
  }

  // starved: 入力側に「空の受け皿」。粒がゼロであること自体を語彙にする。
  function drawEmptyTray(machine, timeSeconds) {
    const x = machine.x - 20;
    const y = machine.y + machine.h / 2;
    const pulse = 0.55 + 0.45 * Math.sin(timeSeconds * 4);
    ctx.save();
    ctx.globalAlpha = 0.5 + 0.4 * pulse;
    ctx.strokeStyle = PALETTE.lampStarved;
    ctx.lineWidth = 2;
    ctx.beginPath(); // 受け皿（下向きの弧）。中身は描かない = 空
    ctx.moveTo(x - 9, y - 5);
    ctx.lineTo(x - 7, y + 5);
    ctx.lineTo(x + 7, y + 5);
    ctx.lineTo(x + 9, y - 5);
    ctx.stroke();
    ctx.setLineDash([2, 3]); // 空であることを破線の水面で示す
    ctx.beginPath();
    ctx.moveTo(x - 7, y + 2);
    ctx.lineTo(x + 7, y + 2);
    ctx.stroke();
    ctx.restore();
  }

  // blocked: 出力側に「溢れる粒」。受け皿から粒がこぼれている形にする。
  function drawOverflowHeap(machine, kind, stageType, timeSeconds) {
    const x = machine.x + machine.w + 20;
    const y = machine.y + machine.h / 2;
    ctx.save();
    ctx.strokeStyle = PALETTE.lampBlocked;
    ctx.lineWidth = 2;
    ctx.beginPath(); // 受け皿は starved と同じ形。違いは中身の粒の有無
    ctx.moveTo(x - 9, y - 5);
    ctx.lineTo(x - 7, y + 5);
    ctx.lineTo(x + 7, y + 5);
    ctx.lineTo(x + 9, y - 5);
    ctx.stroke();
    ctx.restore();
    const spill = Math.sin(timeSeconds * 4) * 1.5;
    drawParticle(kind, stageType, x - 4, y + 1, 4);
    drawParticle(kind, stageType, x + 4, y + 1, 4);
    drawParticle(kind, stageType, x, y - 6 + spill, 4); // 縁からこぼれる1粒
  }

  // 全装置共通の稼働メーター。装置本体の下端に埋め込み、視線が装置から離れない
  // 位置に置く。utilization を目盛りで示し、律速段は振り切れとして相対的に読ませる
  // （文字ラベルは置かない）。
  function drawUtilizationMeter(machine, utilization) {
    const width = machine.w - 12;
    const x = machine.x + 6;
    const y = machine.y + machine.h - 11; // 本体内に埋め込む
    const ratio = Math.min(1, Math.max(0, utilization));
    ctx.save();
    ctx.fillStyle = 'rgba(10, 12, 14, 0.55)';
    ctx.fillRect(x, y, width, 7);
    ctx.strokeStyle = PALETTE.laneEdge;
    ctx.lineWidth = 1;
    ctx.strokeRect(x, y, width, 7);
    ctx.fillStyle = ratio >= METER_FULL_UTILIZATION ? PALETTE.lampBlocked : PALETTE.lampStarved;
    ctx.fillRect(x + 1, y + 1, Math.max(0, (width - 2) * ratio), 5);
    ctx.fillStyle = PALETTE.laneEdge;
    ctx.fillRect(x + width / 2, y, 1, 2); // 50%の目盛り
    ctx.restore();
    if (ratio >= METER_FULL_UTILIZATION) {
      // 振り切れ: 針が本体の右端を超えた形（色に依存しない差分）
      ctx.fillStyle = PALETTE.lampBlocked;
      ctx.beginPath();
      ctx.moveTo(machine.x + machine.w, y);
      ctx.lineTo(machine.x + machine.w + 8, y + 3.5);
      ctx.lineTo(machine.x + machine.w, y + 7);
      ctx.closePath();
      ctx.fill();
    }
  }

  // 抑制理由（部分的な低稼働）: 完全停止と同じ受け皿の語彙を、小さく淡い形で出す。
  // side='input' は材料待ち（上流不足）、side='output' は出口待ち（下流飽和）。
  function drawRestraintHint(machine, side, level, kind, stageType, timeSeconds) {
    // 搬送路（装置の中心高さ）と重ならないよう、少し下にずらして置く
    const x = side === 'input' ? machine.x - 14 : machine.x + machine.w + 14;
    const y = machine.y + machine.h / 2 + 18;
    const scale = 0.62;
    const pulse = 0.6 + 0.4 * Math.sin(timeSeconds * 3);
    ctx.save();
    ctx.globalAlpha = Math.min(0.9, 0.25 + 0.65 * level) * pulse;
    ctx.strokeStyle = side === 'input' ? PALETTE.lampStarved : PALETTE.lampBlocked;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x - 9 * scale, y - 5 * scale);
    ctx.lineTo(x - 7 * scale, y + 5 * scale);
    ctx.lineTo(x + 7 * scale, y + 5 * scale);
    ctx.lineTo(x + 9 * scale, y - 5 * scale);
    ctx.stroke();
    if (side === 'input') {
      ctx.setLineDash([2, 3]); // 空きぎみ = 破線の水面
      ctx.beginPath();
      ctx.moveTo(x - 6 * scale, y + 2 * scale);
      ctx.lineTo(x + 6 * scale, y + 2 * scale);
      ctx.stroke();
      ctx.restore();
      return;
    }
    ctx.restore();
    ctx.save();
    ctx.globalAlpha = Math.min(0.95, 0.35 + 0.6 * level);
    drawParticle(kind, stageType, x - 3, y + 1, 3); // 出口に溜まりかけの粒
    drawParticle(kind, stageType, x + 3, y + 1, 3);
    ctx.restore();
  }

  // A-5: 出荷口を抜けて工場外へ出る粒。流量（個/秒）から生成する表示専用の粒。
  function updateExitParticles(state, dtSeconds, stageType) {
    const machine = MACHINES.shipping;
    exitSpawnCarry += state.throughput.shipping * dtSeconds * EXIT_PARTICLES_PER_UNIT;
    while (exitSpawnCarry >= 1) {
      exitSpawnCarry -= 1;
      exitParticles.push({
        x: machine.x + machine.w - 6,
        y: machine.y + machine.h / 2 + (Math.random() - 0.5) * 10,
        age: 0,
        refined: state.throughput.secondary > 0 && Math.random() < 0.4,
        stageType,
      });
    }
    for (let index = exitParticles.length - 1; index >= 0; index -= 1) {
      const particle = exitParticles[index];
      particle.age += dtSeconds;
      particle.x += EXIT_PARTICLE_SPEED * dtSeconds;
      if (particle.age >= EXIT_PARTICLE_LIFE || particle.x > canvas.width) exitParticles.splice(index, 1);
    }
  }

  function drawExitParticles() {
    exitParticles.forEach((particle) => {
      ctx.save();
      ctx.globalAlpha = Math.max(0, 1 - particle.age / EXIT_PARTICLE_LIFE);
      drawParticle(particle.refined ? 'refined' : 'product', particle.stageType, particle.x, particle.y, 5);
      ctx.restore();
    });
  }

  // A-5: 収入は 400ms 単位に集約して「+金額 / N個」を短時間だけ出す（常設しない）。
  function updateIncomePopups(state, nowMs, dtSeconds) {
    if (incomeWindow.score === null) {
      incomeWindow.score = state.score;
      incomeWindow.sinceMs = nowMs;
    }
    incomeWindow.units += state.throughput.shipping * dtSeconds;
    if (nowMs - incomeWindow.sinceMs >= INCOME_WINDOW_MS) {
      const gained = state.score - incomeWindow.score;
      const units = incomeWindow.units;
      if (gained > 0.01) {
        incomePopups.push({ text: `+${Math.round(gained)} / ${Math.round(units)}個`, age: 0 });
      }
      incomeWindow.score = state.score;
      incomeWindow.units = 0;
      incomeWindow.sinceMs = nowMs;
    }
    for (let index = incomePopups.length - 1; index >= 0; index -= 1) {
      incomePopups[index].age += dtSeconds;
      if (incomePopups[index].age >= INCOME_POPUP_LIFE) incomePopups.splice(index, 1);
    }
  }

  function drawIncomePopups() {
    const machine = MACHINES.shipping;
    ctx.font = 'bold 12px sans-serif';
    ctx.textAlign = 'right'; // canvas 右端からはみ出さないように右寄せ
    incomePopups.forEach((popup) => {
      const progress = popup.age / INCOME_POPUP_LIFE;
      ctx.save();
      ctx.globalAlpha = Math.max(0, 1 - progress);
      ctx.fillStyle = PALETTE.lampRunning;
      ctx.fillText(popup.text, machine.x + machine.w, machine.y - 6 - progress * 18);
      ctx.restore();
    });
  }

  // 二次加工器: 精錬品在庫が0でも「精錬している」ことが見えるよう、本体内で
  // 製品 → 精錬品の変換を描く。
  function drawRefiningMotion(machine, stageType, phase) {
    const cy = machine.y + machine.h / 2;
    const left = machine.x + 16;
    const right = machine.x + machine.w - 16;
    drawParticle('product', stageType, left, cy, 4);
    drawParticle('refined', null, right, cy, 4);
    const travel = (Math.sin(phase) + 1) / 2;
    ctx.save();
    ctx.globalAlpha = 0.85;
    ctx.fillStyle = PALETTE.refined.edge;
    ctx.beginPath();
    ctx.arc(left + (right - left) * travel, cy - 12, 2.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function applyStatusDecoration(machine, status, kind, stageType, timeSeconds) {
    drawStatusLamp(machine, status);
    if (status === 'starved') {
      drawEmptyTray(machine, timeSeconds);
      drawHaltBadge(machine, status);
    } else if (status === 'blocked') {
      drawOverflowHeap(machine, kind, stageType, timeSeconds);
      drawHaltBadge(machine, status);
    } else if (status === 'ramping') drawRampGauge(machine, timeSeconds);
  }

  // --- hover tooltip (補足テキストはマウスオーバー時のみ。画面に常設しない) ---

  const STATUS_TEXT = {
    running: '稼働中',
    ramping: '立ち上げ中',
    starved: '入力待ち（材料が届いていない）',
    blocked: '出力詰まり（次の工程が受け取れない）',
  };

  canvas.addEventListener('mousemove', (event) => {
    const box = canvas.getBoundingClientRect();
    const x = (event.clientX - box.left) * (canvas.width / box.width);
    const y = (event.clientY - box.top) * (canvas.height / box.height);
    hoveredMachine = Object.keys(MACHINES).find((slot) => {
      const machine = MACHINES[slot];
      return x >= machine.x && x <= machine.x + machine.w
        && y >= machine.y && y <= machine.y + machine.h + 26; // 稼働メーターまで含める
    }) || null;
  });
  canvas.addEventListener('mouseleave', () => { hoveredMachine = null; });

  function updateHoverTooltip(state) {
    if (!hoveredMachine) {
      if (canvas.title) canvas.title = '';
      return;
    }
    const label = MACHINES[hoveredMachine].label;
    const status = state.statuses[hoveredMachine];
    if (!status) {
      canvas.title = `${label}: 未購入`;
      return;
    }
    const utilization = state.utilization[hoveredMachine];
    canvas.title = utilization === undefined
      ? `${label}: ${STATUS_TEXT[status] ?? status}`
      : `${label}: 稼働率 ${Math.round(utilization * 100)}% / ${STATUS_TEXT[status] ?? status}`;
  }

  // --- frame loop ---

  let lastFrameMs = performance.now();

  function frame(nowMs) {
    const dtSeconds = Math.min((nowMs - lastFrameMs) / 1000, 0.1);
    lastFrameMs = nowMs;
    const game = window.debugGame;
    if (game) draw(game, nowMs, dtSeconds);
    requestAnimationFrame(frame);
  }

  function draw(game, nowMs, dtSeconds) {
    const { state, config } = game;
    const timeSeconds = nowMs / 1000;
    ctx.fillStyle = PALETTE.background;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const shown = {
      collection: displayedStatus('collection', state.statuses.collection, nowMs),
      processing: displayedStatus('processing', state.statuses.processing, nowMs),
      shipping: displayedStatus('shipping', state.statuses.shipping, nowMs),
      secondary: displayedStatus('secondary', state.statuses.secondary ?? null, nowMs),
    };

    // A-3: 可動部の速さは utilization の連続写像。停止時のみ速度0（離散）。
    // secondary は utilization が未公開のため、running を等速として扱う。
    const motion = {
      collection: motionScale(shown.collection, state.utilization.collection),
      processing: motionScale(shown.processing, state.utilization.processing),
      shipping: motionScale(shown.shipping, state.utilization.shipping),
      secondary: motionScale(shown.secondary, 1),
    };
    ['collection', 'processing', 'shipping', 'secondary'].forEach((slot) => {
      animPhases[slot] += dtSeconds * 3 * motion[slot];
    });

    drawLane('bufferA', LANES.bufferA, {
      fillRatio: state.buffers.A / state.capacities.A,
      jamLevel: updateJamLevel('bufferA', state.buffers.A, dtSeconds),
      upstreamStatus: shown.collection,
      flowPerSecond: state.throughput.collection,
    }, 'raw', config.stageTypes.collection, dtSeconds, timeSeconds);
    drawLane('bufferB', LANES.bufferB, {
      fillRatio: state.buffers.B / state.capacities.B,
      jamLevel: updateJamLevel('bufferB', state.buffers.B, dtSeconds),
      upstreamStatus: shown.processing,
      flowPerSecond: state.throughput.processing,
    }, 'product', config.stageTypes.processing, dtSeconds, timeSeconds);
    if (state.secondaryProcessor.purchased) {
      drawLane('refined', LANES.refined, {
        fillRatio: state.secondaryProcessor.refinedProducts / state.secondaryProcessor.refinedCapacity,
        jamLevel: updateJamLevel('refined', state.secondaryProcessor.refinedProducts, dtSeconds),
        upstreamStatus: shown.secondary,
        flowPerSecond: state.throughput.secondary,
      }, 'refined', null, dtSeconds, timeSeconds);
    }

    // A-5: 出荷口から工場外へ抜ける粒と、集約した収入表示
    updateExitParticles(state, dtSeconds, config.stageTypes.processing);
    updateIncomePopups(state, nowMs, dtSeconds);
    drawExitParticles();

    const stageKinds = {
      collection: ['raw', config.stageTypes.collection],
      processing: ['product', config.stageTypes.processing],
      shipping: ['product', config.stageTypes.processing],
    };

    // 低稼働の理由（材料待ち / 出口待ち）。完全停止していなくても読み取れるようにする。
    const restraints = {
      collection: restraintOf('collection', state),
      processing: restraintOf('processing', state),
      shipping: restraintOf('shipping', state),
    };

    drawCollection(MACHINES.collection, config.stageTypes.collection, shown.collection, animPhases.collection);
    drawCountDots(MACHINES.collection, state.machines.collection);
    applyStatusDecoration(MACHINES.collection, shown.collection, 'raw', config.stageTypes.collection, timeSeconds);
    drawUtilizationMeter(MACHINES.collection, state.utilization.collection);

    drawProcessing(MACHINES.processing, config.stageTypes.processing, shown.processing, animPhases.processing);
    drawCountDots(MACHINES.processing, state.machines.processing);
    applyStatusDecoration(MACHINES.processing, shown.processing, 'product', config.stageTypes.processing, timeSeconds);
    drawUtilizationMeter(MACHINES.processing, state.utilization.processing);

    drawShipping(MACHINES.shipping, shown.shipping, animPhases.shipping);
    drawCountDots(MACHINES.shipping, state.machines.shipping);
    applyStatusDecoration(MACHINES.shipping, shown.shipping, 'product', config.stageTypes.processing, timeSeconds);
    drawUtilizationMeter(MACHINES.shipping, state.utilization.shipping);

    ['collection', 'processing', 'shipping'].forEach((slot) => {
      const restraint = restraints[slot];
      // 完全停止時は停止の語彙（受け皿・溢れる粒）が出るので、抑制ヒントは重ねない
      if (!restraint || isHalted(shown[slot])) return;
      drawRestraintHint(MACHINES[slot], restraint.side, restraint.level,
        stageKinds[slot][0], stageKinds[slot][1], timeSeconds);
    });

    if (state.secondaryProcessor.purchased) {
      drawSecondary(MACHINES.secondary, shown.secondary, animPhases.secondary);
      if (state.throughput.secondary > 0) {
        drawRefiningMotion(MACHINES.secondary, config.stageTypes.processing, animPhases.secondary);
      }
      if (shown.secondary) {
        applyStatusDecoration(MACHINES.secondary, shown.secondary, 'refined', null, timeSeconds);
      }
      // 二次加工器の utilization は game-core が未公開のため、公開されている
      // status をそのまま写す（稼働=満、停止=空）。推測は行わない。
      drawUtilizationMeter(MACHINES.secondary, shown.secondary === 'running' ? 1 : 0);
    }

    drawIncomePopups();
    updateHoverTooltip(state);
  }

  requestAnimationFrame(frame);
})();
