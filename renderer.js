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
  const MIN_STATUS_DISPLAY_MS = 300; // A-3: 表示切替の最低継続時間
  const BASE_PARTICLE_SPEED = 30; // px/s

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

  function displayedStatus(slot, actual, nowMs) {
    const hold = statusHold[slot] || (statusHold[slot] = { shown: actual, since: nowMs });
    if (actual !== hold.shown && nowMs - hold.since >= MIN_STATUS_DISPLAY_MS) {
      hold.shown = actual;
      hold.since = nowMs;
    }
    return hold.shown;
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

  function drawLane(name, lane, fillRatio, kind, stageType, dtSeconds, timeSeconds, machineCount) {
    const geometry = laneGeometry(lane);
    const pool = pools[name];

    // Lane bed
    ctx.strokeStyle = PALETTE.lane;
    ctx.lineWidth = 14;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(geometry.fromX, geometry.fromY);
    ctx.lineTo(geometry.fromX + geometry.unitX * geometry.length, geometry.fromY + geometry.unitY * geometry.length);
    ctx.stroke();

    // 90〜100%: 搬送路の圧縮/点滅表現 (A-2)
    if (fillRatio >= 0.9) {
      const pulse = 0.45 + 0.4 * Math.sin(timeSeconds * 10);
      ctx.strokeStyle = `rgba(224, 82, 82, ${pulse.toFixed(3)})`;
      ctx.lineWidth = 18;
      ctx.beginPath();
      ctx.moveTo(geometry.fromX, geometry.fromY);
      ctx.lineTo(geometry.fromX + geometry.unitX * geometry.length, geometry.fromY + geometry.unitY * geometry.length);
      ctx.stroke();
    }

    // 100%: 上流装置の停止が明確に見える — static red stop bar at the lane entry.
    if (fillRatio >= 0.999) {
      ctx.fillStyle = PALETTE.lampBlocked;
      ctx.save();
      ctx.translate(geometry.fromX, geometry.fromY);
      ctx.rotate(Math.atan2(geometry.unitY, geometry.unitX));
      ctx.fillRect(-3, -14, 6, 28);
      ctx.restore();
    }

    // Particle count / spacing from fill ratio (A-2: 0-50% count grows, 50-90% spacing narrows).
    const count = fillRatio <= 0.001 ? 0
      : fillRatio < 0.5 ? Math.max(1, Math.round(MAX_PARTICLES_PER_LANE * (fillRatio / 0.5)))
        : MAX_PARTICLES_PER_LANE;
    const compression = fillRatio < 0.5 ? 0 : Math.min(1, (fillRatio - 0.5) / 0.4);
    const packedLength = geometry.length * (1 - 0.45 * compression);

    // Flow speed: visual mapping from upstream machine count; jammed lanes slow, full lanes stall.
    const speedScale = 1 + 0.25 * Math.min(Math.max(machineCount - 1, 0), 4);
    const jamScale = fillRatio >= 0.999 ? 0 : fillRatio >= 0.9 ? 0.35 : 1;
    pool.scroll += dtSeconds * BASE_PARTICLE_SPEED * speedScale * jamScale;

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

  function applyStatusDecoration(machine, status, timeSeconds) {
    drawStatusLamp(machine, status);
    if (status === 'starved') drawSideMarker(machine, 'input', PALETTE.lampStarved, timeSeconds);
    else if (status === 'blocked') drawSideMarker(machine, 'output', PALETTE.lampBlocked, timeSeconds);
    else if (status === 'ramping') drawRampGauge(machine, timeSeconds);
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

    // Moving parts animate only while running / ramping (A-3).
    ['collection', 'processing', 'shipping', 'secondary'].forEach((slot) => {
      if (shown[slot] === 'running' || shown[slot] === 'ramping') animPhases[slot] += dtSeconds * 3;
    });

    drawLane('bufferA', LANES.bufferA, state.buffers.A / state.capacities.A, 'raw',
      config.stageTypes.collection, dtSeconds, timeSeconds, state.machines.collection);
    drawLane('bufferB', LANES.bufferB, state.buffers.B / state.capacities.B, 'product',
      config.stageTypes.processing, dtSeconds, timeSeconds, state.machines.processing);
    if (state.secondaryProcessor.purchased) {
      drawLane('refined', LANES.refined,
        state.secondaryProcessor.refinedProducts / state.secondaryProcessor.refinedCapacity,
        'refined', null, dtSeconds, timeSeconds, 1);
    }

    drawCollection(MACHINES.collection, config.stageTypes.collection, shown.collection, animPhases.collection);
    drawCountDots(MACHINES.collection, state.machines.collection);
    applyStatusDecoration(MACHINES.collection, shown.collection, timeSeconds);

    drawProcessing(MACHINES.processing, config.stageTypes.processing, shown.processing, animPhases.processing);
    drawCountDots(MACHINES.processing, state.machines.processing);
    applyStatusDecoration(MACHINES.processing, shown.processing, timeSeconds);

    drawShipping(MACHINES.shipping, shown.shipping, animPhases.shipping);
    drawCountDots(MACHINES.shipping, state.machines.shipping);
    applyStatusDecoration(MACHINES.shipping, shown.shipping, timeSeconds);

    if (state.secondaryProcessor.purchased) {
      drawSecondary(MACHINES.secondary, shown.secondary, animPhases.secondary);
      if (shown.secondary) applyStatusDecoration(MACHINES.secondary, shown.secondary, timeSeconds);
    }
  }

  requestAnimationFrame(frame);
})();
