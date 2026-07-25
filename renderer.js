'use strict';

/**
 * renderer.js — Canvas projection of game-core state (design §4 A-1〜A-7, §4-V, §5).
 * Pure display: reads window.debugGame every animation frame, never writes
 * game state and never re-implements game-core formulas. Particle motion and
 * lane appearance derive only from published state (buffers, capacities,
 * statuses, throughput, utilization).
 *
 * §4-V: colour is split into three registers (decor / state / material) and the
 * ranges are checked at startup instead of by hand. Static art is baked once
 * into offscreen layers; the frame loop only composites.
 */

(() => {
  const mainCanvas = document.querySelector('#factory-canvas');
  if (!mainCanvas) return;

  // 論理座標系。キャンバスの実ピクセルは devicePixelRatio でスケールする（V-7）。
  const WIDTH = mainCanvas.width;
  const HEIGHT = mainCanvas.height;
  const GROUND_Y = Math.round(HEIGHT * 0.47); // V-5: 接地線はキャンバス高の 42〜52%
  const MAX_DPR = 2; // V-7: devicePixelRatio は最大 2.0 に制限

  /*
   * §4-V V-1 色の四重防御。
   *   decor    : S ≤ 10% / L ≤ 0.42 / source-over
   *   state    : S ≥ 55%（材料待ちの白のみ L ≥ 0.90 で分離）/ L ≥ 0.60 / H 0〜40° or 140°
   *   material : H 190〜265° / S 30〜70% / L 0.50〜0.72（精錬品のみ L ≥ 0.78）
   * 描画コードに色リテラルを直書きしない（V-3）。白黒αの重ねだけは
   * 「登録する色」ではなく合成結果なので別枠（whiteVeil / blackVeil）。
   */
  const PALETTE = {
    decor: {
      wallTop: '#16181A',
      wallBottom: '#1E2124',
      midground: '#1A1C1F',
      floorFar: '#202327',
      floorNear: '#2A2D32',
      machineTop: '#4E545B',
      machineFront: '#3D4249',
      machineDeep: '#2F3339',
      edgeLight: '#646A72',
      edgeShadow: '#151719',
      laneFrame: '#26292E',
      laneBelt: '#33373D',
      laneSeam: '#3F444B',
      label: '#646A72',
    },
    state: {
      running: '#57E28C',
      starved: '#E9EEF3',
      blocked: '#F0554F',
      ramping: '#F5A340',
    },
    material: {
      metal: '#8FA8C4', // 角
      plastic: '#9B7FE6', // 丸
      glass: '#4FBCD6', // 三角（破片）
      refined: '#ADE0EB', // 菱形＋発光縁。輝度で素材3種の上に立つ
    },
  };

  const COLOUR_RULES = {
    decor: { maxSaturation: 0.10, maxLightness: 0.42 },
    state: { minSaturation: 0.55, minLightness: 0.60, whiteMinLightness: 0.90, hues: [[0, 40], [130, 150]] },
    material: { hue: [190, 265], saturation: [0.30, 0.70], lightness: [0.50, 0.72], refinedMinLightness: 0.78 },
  };

  // 白黒αの重ねは合成結果なのでパレット検査の対象外だが、歯止めとして上限を持つ。
  const MAX_WHITE_VEIL_ALPHA = 0.12;
  const MAX_BLACK_VEIL_ALPHA = 0.50;

  function toHsl(hex) {
    const value = parseInt(hex.slice(1), 16);
    const r = ((value >> 16) & 0xff) / 255;
    const g = ((value >> 8) & 0xff) / 255;
    const b = (value & 0xff) / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const lightness = (max + min) / 2;
    const delta = max - min;
    if (delta === 0) return { h: 0, s: 0, l: lightness };
    const saturation = delta / (1 - Math.abs(2 * lightness - 1));
    let hue;
    if (max === r) hue = ((g - b) / delta) % 6;
    else if (max === g) hue = (b - r) / delta + 2;
    else hue = (r - g) / delta + 4;
    hue = (hue * 60 + 360) % 360;
    return { h: hue, s: saturation, l: lightness };
  }

  // V-3: 起動時に全登録色をHSLへ変換して範囲を検査し、外れたら console.error。
  function assertPalette() {
    const problems = [];
    Object.entries(PALETTE.decor).forEach(([name, hex]) => {
      const { s, l } = toHsl(hex);
      if (s > COLOUR_RULES.decor.maxSaturation + 1e-6) problems.push(`decor.${name} ${hex}: S ${(s * 100).toFixed(1)}% > 10%`);
      if (l > COLOUR_RULES.decor.maxLightness + 1e-6) problems.push(`decor.${name} ${hex}: L ${l.toFixed(3)} > 0.42`);
    });
    Object.entries(PALETTE.state).forEach(([name, hex]) => {
      const { h, s, l } = toHsl(hex);
      const white = l >= COLOUR_RULES.state.whiteMinLightness;
      if (!white && s < COLOUR_RULES.state.minSaturation - 1e-6) problems.push(`state.${name} ${hex}: S ${(s * 100).toFixed(1)}% < 55%`);
      if (l < COLOUR_RULES.state.minLightness - 1e-6) problems.push(`state.${name} ${hex}: L ${l.toFixed(3)} < 0.60`);
      const hueOk = white || COLOUR_RULES.state.hues.some(([from, to]) => h >= from && h <= to);
      if (!hueOk) problems.push(`state.${name} ${hex}: H ${h.toFixed(1)}° outside 0-40 / 130-150`);
    });
    Object.entries(PALETTE.material).forEach(([name, hex]) => {
      const { h, s, l } = toHsl(hex);
      const [hueFrom, hueTo] = COLOUR_RULES.material.hue;
      const [satFrom, satTo] = COLOUR_RULES.material.saturation;
      const [lightFrom, lightTo] = COLOUR_RULES.material.lightness;
      if (h < hueFrom - 1e-6 || h > hueTo + 1e-6) problems.push(`material.${name} ${hex}: H ${h.toFixed(1)}° outside ${hueFrom}-${hueTo}`);
      if (s < satFrom - 1e-6 || s > satTo + 1e-6) problems.push(`material.${name} ${hex}: S ${(s * 100).toFixed(1)}% outside 30-70%`);
      if (name === 'refined') {
        if (l < COLOUR_RULES.material.refinedMinLightness - 1e-6) problems.push(`material.refined ${hex}: L ${l.toFixed(3)} < 0.78`);
      } else if (l < lightFrom - 1e-6 || l > lightTo + 1e-6) {
        problems.push(`material.${name} ${hex}: L ${l.toFixed(3)} outside ${lightFrom}-${lightTo}`);
      }
    });
    if (problems.length > 0) console.error('[palette] §4-V colour rules violated:', problems);
    return problems;
  }

  const paletteProblems = assertPalette();
  window.__rendererPaletteProblems = paletteProblems; // 検証用（表示には使わない）

  function whiteVeil(alpha) {
    if (alpha > MAX_WHITE_VEIL_ALPHA + 1e-6) console.error(`[palette] white veil alpha ${alpha} > ${MAX_WHITE_VEIL_ALPHA}`);
    return `rgba(255, 255, 255, ${Math.min(alpha, MAX_WHITE_VEIL_ALPHA)})`;
  }

  function blackVeil(alpha) {
    if (alpha > MAX_BLACK_VEIL_ALPHA + 1e-6) console.error(`[palette] black veil alpha ${alpha} > ${MAX_BLACK_VEIL_ALPHA}`);
    return `rgba(0, 0, 0, ${Math.min(alpha, MAX_BLACK_VEIL_ALPHA)})`;
  }

  function withAlpha(hex, alpha) {
    const value = parseInt(hex.slice(1), 16);
    return `rgba(${(value >> 16) & 0xff}, ${(value >> 8) & 0xff}, ${value & 0xff}, ${alpha})`;
  }

  function darken(hex, factor) {
    const value = parseInt(hex.slice(1), 16);
    const scale = (channel) => Math.round(((value >> channel) & 0xff) * factor);
    return `rgb(${scale(16)}, ${scale(8)}, ${scale(0)})`;
  }

  // --- layers (V-7: 背景 / 設備 / 動的エフェクトの3層) ---

  function createLayer(reference, behind) {
    const layer = document.createElement('canvas');
    layer.width = reference.width;
    layer.height = reference.height;
    layer.style.position = 'absolute';
    layer.style.left = '0';
    layer.style.top = '0';
    layer.style.width = '100%';
    layer.style.height = '100%';
    layer.style.pointerEvents = 'none';
    layer.style.zIndex = behind ? '0' : '2';
    return layer;
  }

  const wrapper = document.createElement('div');
  wrapper.style.position = 'relative';
  wrapper.style.display = 'block';
  wrapper.style.maxWidth = `${WIDTH}px`;
  mainCanvas.parentNode.insertBefore(wrapper, mainCanvas);
  const bgCanvas = createLayer(mainCanvas, true);
  const fxCanvas = createLayer(mainCanvas, false);
  wrapper.append(bgCanvas, mainCanvas, fxCanvas);
  mainCanvas.style.position = 'relative';
  mainCanvas.style.zIndex = '1';

  const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);

  function scaleForDpr(canvas) {
    if (dpr === 1) return canvas.getContext('2d');
    canvas.width = Math.round(WIDTH * dpr);
    canvas.height = Math.round(HEIGHT * dpr);
    canvas.style.width = '100%';
    const context = canvas.getContext('2d');
    context.scale(dpr, dpr);
    return context;
  }

  const ctx = scaleForDpr(mainCanvas);
  const bgCtx = scaleForDpr(bgCanvas);
  const fxCtx = scaleForDpr(fxCanvas);

  const MAX_PARTICLES_PER_LANE = 12; // A-1: 最大表示粒数（1粒=N個の代表表示）
  // A-1: 粒の「数・流れる速さ」は流量（個/秒）由来、「密集・滞留・停止」は在庫由来。
  const FLOW_REFERENCE_PER_SECOND = 6;
  const MIN_FLOW_SPEED_SCALE = 0.3;
  const MIN_STATUS_DISPLAY_MS = 300; // A-3: 表示切替の最低継続時間
  const BASE_PARTICLE_SPEED = 30; // px/s
  const MIN_MOTION_SCALE = 0.22; // A-3: 動いている装置の下限速度

  // A-2 詰まり判定（容量非依存）
  const JAM_SMOOTHING_PER_SECOND = 2;
  const JAM_GROWTH_EPSILON = 0.05;
  const JAM_ONSET_SECONDS = 4;
  const JAM_FULL_SECONDS = 10;
  const JAM_RELEASE_RATE = 3;

  // 抑制理由
  const RESTRAINT_UTILIZATION = 0.95;
  const OUTPUT_PRESSURE_RATIO = 0.5;
  const INPUT_SHORTAGE_RATIO = 0.15;

  // A-5 出荷の出口表現
  const EXIT_PARTICLES_PER_UNIT = 0.6;
  const EXIT_PARTICLE_SPEED = 70;
  const EXIT_PARTICLE_LIFE = 1.1;
  const INCOME_WINDOW_MS = 400;
  const INCOME_POPUP_LIFE = 1.4;

  const METER_FULL_UTILIZATION = 0.98; // A-6: 振り切れ

  // V-4/V-5: 接地線に装置の底辺を合わせ、下部は床と手前の設備に使う
  const MACHINES = {
    collection: { x: 40, y: GROUND_Y - 70, w: 96, h: 70, label: '採取' },
    processing: { x: 330, y: GROUND_Y - 70, w: 96, h: 70, label: '加工' },
    shipping: { x: 620, y: GROUND_Y - 70, w: 110, h: 70, label: '出荷' },
    secondary: { x: 436, y: GROUND_Y + 66, w: 96, h: 58, label: '二次加工' },
  };
  const LANE_Y = GROUND_Y - 35;
  const LANES = {
    bufferA: { from: [136, LANE_Y], to: [330, LANE_Y] },
    bufferB: { from: [426, LANE_Y], to: [620, LANE_Y] },
    refined: { from: [532, GROUND_Y + 66], to: [640, GROUND_Y - 12] },
  };

  const LIGHT_ANGLE = -15 * (Math.PI / 180); // V-4: 光源は真上やや左に固定

  // Particle pools: fixed-size, objects reused across frames (A-1).
  const pools = {};
  Object.keys(LANES).forEach((lane) => {
    pools[lane] = {
      scroll: 0,
      particles: Array.from({ length: MAX_PARTICLES_PER_LANE }, (_, index) => ({ slot: index, bobPhase: index * 1.7 })),
    };
  });

  const statusHold = {};
  const animPhases = { collection: 0, processing: 0, shipping: 0, secondary: 0 };
  const jamTrackers = {};
  let hoveredMachine = null;
  const exitParticles = [];
  let exitSpawnCarry = 0;
  const incomePopups = [];
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

  function motionScale(status, utilization) {
    if (isHalted(status) || status === null) return 0;
    const ratio = Math.min(1, Math.max(0, utilization));
    return MIN_MOTION_SCALE + (1 - MIN_MOTION_SCALE) * ratio;
  }

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

  // --- particle shapes (§4 ビジュアル仕様表 / V-1: 色だけに依存せず形でも分ける) ---
  // 金属 = 角 / 樹脂 = 丸 / ガラス = 三角（破片）/ 精錬品 = 菱形＋発光縁

  function tracePath(target, kind, x, y, size) {
    if (kind === 'metal') {
      target.moveTo(x - size, y - size);
      target.lineTo(x + size, y - size * 0.7);
      target.lineTo(x + size, y + size);
      target.lineTo(x - size, y + size * 0.7);
      target.closePath();
      return;
    }
    if (kind === 'plastic') {
      target.moveTo(x + size, y);
      target.arc(x, y, size, 0, Math.PI * 2);
      return;
    }
    if (kind === 'glass') {
      target.moveTo(x - size, y + size * 0.8);
      target.lineTo(x + size * 1.1, y + size * 0.5);
      target.lineTo(x - size * 0.2, y - size);
      target.closePath();
      return;
    }
    if (kind === 'refined') {
      target.moveTo(x, y - size * 1.2);
      target.lineTo(x + size * 0.8, y);
      target.lineTo(x, y + size * 1.2);
      target.lineTo(x - size * 0.8, y);
      target.closePath();
      return;
    }
    // product: 圧縮キューブ
    target.rect(x - size * 0.9, y - size * 0.9, size * 1.8, size * 1.8);
  }

  // V-7: 粒は色ごとにバッチし、beginPath 1回・fill 1回で描く。
  function drawParticleBatch(target, kind, stageType, points, size) {
    if (points.length === 0) return;
    target.save();
    if (kind === 'glass') target.globalAlpha = 0.75;
    target.beginPath();
    points.forEach(([x, y]) => tracePath(target, kind === 'raw' ? stageType : kind, x, y, size));
    target.fillStyle = kind === 'raw' ? PALETTE.material[stageType]
      : kind === 'product' ? darken(PALETTE.material[stageType], 0.62)
        : PALETTE.material.refined;
    target.fill();
    if (kind === 'refined') {
      // 発光縁は加算合成ではなく明るい輪郭で出す（V-8-3: 装飾のグローは使わない）
      target.strokeStyle = whiteVeil(0.12);
      target.lineWidth = 1.5;
      target.stroke();
    } else if (kind === 'product') {
      target.strokeStyle = withAlpha(PALETTE.material[stageType], 0.9);
      target.lineWidth = 1;
      target.stroke();
    }
    target.restore();
  }

  function drawSingleParticle(target, kind, stageType, x, y, size) {
    drawParticleBatch(target, kind, stageType, [[x, y]], size);
  }

  // --- background layer (V-5: 奥壁 / 中景 / 床 を1回だけ焼く) ---

  function bakeBackground() {
    const g = bgCtx;
    g.clearRect(0, 0, WIDTH, HEIGHT);

    const wall = g.createLinearGradient(0, 0, 0, GROUND_Y);
    wall.addColorStop(0, PALETTE.decor.wallTop);
    wall.addColorStop(1, PALETTE.decor.wallBottom);
    g.fillStyle = wall;
    g.fillRect(0, 0, WIDTH, GROUND_Y);

    // 中景シルエット（静止・輝度差は僅か）
    g.fillStyle = PALETTE.decor.midground;
    [[60, 96, 120], [220, 64, 84], [500, 110, 104], [690, 70, 130]].forEach(([x, w, h]) => {
      g.fillRect(x, GROUND_Y - h, w, h);
    });

    // 柱と梁: 装置の大きさを比較する基準（V-5）
    g.fillStyle = PALETTE.decor.machineDeep;
    [186, 466, 752].forEach((x) => g.fillRect(x, 0, 22, GROUND_Y));
    g.fillRect(0, 22, WIDTH, 14);
    g.fillStyle = blackVeil(0.28);
    [186, 466, 752].forEach((x) => g.fillRect(x + 16, 0, 6, GROUND_Y));
    g.fillRect(0, 34, WIDTH, 3);
    g.fillStyle = whiteVeil(0.05);
    [186, 466, 752].forEach((x) => g.fillRect(x, 0, 2, GROUND_Y));
    g.fillRect(0, 22, WIDTH, 1);

    const floor = g.createLinearGradient(0, GROUND_Y, 0, HEIGHT);
    floor.addColorStop(0, PALETTE.decor.floorFar);
    floor.addColorStop(1, PALETTE.decor.floorNear);
    g.fillStyle = floor;
    g.fillRect(0, GROUND_Y, WIDTH, HEIGHT - GROUND_Y);

    // 床グリッド: 手前ほど間隔を等比 1.18 倍で広げる（透視変換なしに奥行きが出る）
    g.strokeStyle = whiteVeil(0.04);
    g.lineWidth = 1;
    g.beginPath();
    let spacing = 6;
    for (let y = GROUND_Y + spacing; y < HEIGHT; y += spacing) {
      g.moveTo(0, Math.round(y) + 0.5);
      g.lineTo(WIDTH, Math.round(y) + 0.5);
      spacing *= 1.18;
    }
    for (let x = 0; x <= WIDTH; x += 78) {
      g.moveTo(x + 0.5, GROUND_Y);
      g.lineTo(x + 0.5, HEIGHT);
    }
    g.stroke();

    // 接地線を1pxのハイライトで締める
    g.fillStyle = whiteVeil(0.06);
    g.fillRect(0, GROUND_Y, WIDTH, 1);

    // 精錬レーンは二次加工器の購入後にだけ見せるので、背景には焼かない
    bakeLaneBed(g, 'bufferA', LANES.bufferA);
    bakeLaneBed(g, 'bufferB', LANES.bufferB);

    // ビネット（四隅・黒 α0.35）は静的に焼く
    const vignette = g.createRadialGradient(WIDTH / 2, HEIGHT * 0.45, HEIGHT * 0.25, WIDTH / 2, HEIGHT * 0.5, WIDTH * 0.72);
    vignette.addColorStop(0, blackVeil(0));
    vignette.addColorStop(1, blackVeil(0.35));
    g.fillStyle = vignette;
    g.fillRect(0, 0, WIDTH, HEIGHT);
  }

  function laneGeometry(lane) {
    const [fromX, fromY] = lane.from;
    const [toX, toY] = lane.to;
    const length = Math.hypot(toX - fromX, toY - fromY);
    return { fromX, fromY, unitX: (toX - fromX) / length, unitY: (toY - fromY) / length, length, angle: Math.atan2(toY - fromY, toX - fromX) };
  }

  // V-4: 搬送レーンは一本線ではなく多層構造
  // （下部フレーム / ベルト面 / 下側影 / ローラー継ぎ目 / 上辺ハイライト1px）
  function bakeLaneBed(g, name, lane) {
    const geometry = laneGeometry(lane);
    g.save();
    g.translate(geometry.fromX, geometry.fromY);
    g.rotate(geometry.angle);
    const length = geometry.length;

    g.fillStyle = PALETTE.decor.laneFrame; // 下部フレーム
    g.fillRect(0, -9, length, 20);
    g.fillStyle = blackVeil(0.32); // 下側影
    g.fillRect(0, 7, length, 4);

    const belt = g.createLinearGradient(0, -8, 0, 8); // ベルト面（縦グラデ）
    belt.addColorStop(0, PALETTE.decor.laneSeam);
    belt.addColorStop(0.22, PALETTE.decor.laneBelt);
    belt.addColorStop(0.26, PALETTE.decor.edgeLight);
    belt.addColorStop(0.30, PALETTE.decor.laneBelt);
    belt.addColorStop(1, PALETTE.decor.laneFrame);
    g.fillStyle = belt;
    g.fillRect(0, -8, length, 16);

    g.fillStyle = blackVeil(0.25); // ローラー継ぎ目
    for (let x = 8; x < length; x += 16) g.fillRect(x, -8, 1, 16);

    g.fillStyle = whiteVeil(0.10); // 上辺ハイライト1px
    g.fillRect(0, -8, length, 1);
    g.fillStyle = PALETTE.decor.edgeShadow;
    g.fillRect(0, 7, length, 1);
    g.restore();
  }

  // --- machine sprites (V-7: 静的部分はオフスクリーンに1回焼く) ---

  const machineSprites = {};
  const SPRITE_PAD = 18;
  let refinedLaneSprite = null;

  // 精錬レーンの床は購入後にだけ描く。焼いたものを1回 drawImage する。
  function bakeRefinedLane() {
    const sprite = document.createElement('canvas');
    sprite.width = Math.round(WIDTH * dpr);
    sprite.height = Math.round(HEIGHT * dpr);
    const g = sprite.getContext('2d');
    g.scale(dpr, dpr);
    bakeLaneBed(g, 'refined', LANES.refined);
    return sprite;
  }

  function bakeMachineSprite(machine) {
    const sprite = document.createElement('canvas');
    sprite.width = Math.round((machine.w + SPRITE_PAD * 2) * dpr);
    sprite.height = Math.round((machine.h + SPRITE_PAD * 2) * dpr);
    const g = sprite.getContext('2d');
    g.scale(dpr, dpr);
    const x = SPRITE_PAD;
    const y = SPRITE_PAD;
    const { w, h } = machine;
    const radius = 5; // V-4: 角丸半径は 4〜6px

    // V-4: 重量感は接地影で。横長楕円の放射グラデ＋本体形状のオフセット影
    const shadow = g.createRadialGradient(x + w / 2, y + h + 5, 2, x + w / 2, y + h + 5, w * 0.62);
    shadow.addColorStop(0, blackVeil(0.5));
    shadow.addColorStop(1, blackVeil(0));
    g.save();
    g.translate(x + w / 2, y + h + 5);
    g.scale(1, 0.28);
    g.translate(-(x + w / 2), -(y + h + 5));
    g.fillStyle = shadow;
    g.fillRect(x - SPRITE_PAD, y + h - 24, w + SPRITE_PAD * 2, 60);
    g.restore();

    g.fillStyle = blackVeil(0.38);
    g.beginPath();
    g.roundRect(x + 3, y + 5, w, h, radius); // オフセット影 dx=3, dy=5
    g.fill();

    // 本体: 金属は輝度の急な折り返し。明るい帯の幅は 0.04 に抑える
    const body = g.createLinearGradient(0, y, 0, y + h);
    body.addColorStop(0, PALETTE.decor.machineTop);
    body.addColorStop(0.18, PALETTE.decor.machineFront);
    body.addColorStop(0.22, PALETTE.decor.edgeLight);
    body.addColorStop(0.26, PALETTE.decor.machineFront);
    body.addColorStop(0.72, PALETTE.decor.machineFront);
    body.addColorStop(1, PALETTE.decor.machineDeep);
    g.fillStyle = body;
    g.beginPath();
    g.roundRect(x, y, w, h, radius);
    g.fill();

    // エッジ: 上端1px明色・下端1px暗色（strokeRect は 0.5px ずれるので fillRect）
    g.fillStyle = PALETTE.decor.edgeLight;
    g.fillRect(x + radius, y, w - radius * 2, 1);
    g.fillStyle = PALETTE.decor.edgeShadow;
    g.fillRect(x + radius, y + h - 1, w - radius * 2, 1);
    g.fillStyle = whiteVeil(0.06);
    g.fillRect(x, y + radius, 1, h - radius * 2);
    g.fillStyle = blackVeil(0.35);
    g.fillRect(x + w - 1, y + radius, 1, h - radius * 2);

    // ボルト（光源は真上やや左に固定）
    const boltOffsetX = Math.cos(LIGHT_ANGLE) * 0.8;
    const boltOffsetY = Math.sin(LIGHT_ANGLE) * 0.8;
    [[x + 8, y + 8], [x + w - 8, y + 8], [x + 8, y + h - 8], [x + w - 8, y + h - 8]].forEach(([bx, by]) => {
      g.fillStyle = PALETTE.decor.edgeShadow;
      g.beginPath();
      g.arc(bx, by, 2.4, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = PALETTE.decor.edgeLight;
      g.beginPath();
      g.arc(bx + boltOffsetX, by + boltOffsetY, 1.4, 0, Math.PI * 2);
      g.fill();
    });

    // ノイズと傷は焼き込み時のみ。傷の角度は -12〜-18° に揃える
    g.save();
    g.beginPath();
    g.roundRect(x, y, w, h, radius);
    g.clip();
    g.globalCompositeOperation = 'overlay';
    g.fillStyle = whiteVeil(0.04);
    for (let index = 0; index < 90; index += 1) {
      const nx = x + Math.random() * w;
      const ny = y + Math.random() * h;
      g.fillRect(nx, ny, 1, 1);
    }
    g.strokeStyle = whiteVeil(0.04);
    g.lineWidth = 1;
    g.beginPath();
    for (let index = 0; index < 6; index += 1) {
      const sx = x + Math.random() * w;
      const sy = y + 6 + Math.random() * (h - 12);
      const len = 8 + Math.random() * 20;
      const angle = (-12 - Math.random() * 6) * (Math.PI / 180);
      g.moveTo(sx, sy);
      g.lineTo(sx + Math.cos(angle) * len, sy + Math.sin(angle) * len);
    }
    g.stroke();
    g.restore();

    return sprite;
  }

  function bakeMachines() {
    Object.entries(MACHINES).forEach(([slot, machine]) => {
      machineSprites[slot] = bakeMachineSprite(machine);
    });
  }

  function drawMachineBody(machine, slot) {
    const sprite = machineSprites[slot];
    ctx.drawImage(sprite, machine.x - SPRITE_PAD, machine.y - SPRITE_PAD, machine.w + SPRITE_PAD * 2, machine.h + SPRITE_PAD * 2);
    ctx.fillStyle = PALETTE.decor.label;
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(machine.label, machine.x + machine.w / 2, machine.y + machine.h + 15);
  }

  // --- machines (A-3 state motion + static differentiators) ---

  function drawStatusLamp(machine, status) {
    const cx = machine.x + machine.w - 12;
    const cy = machine.y + 12;
    if (status === 'running' || status === 'ramping') {
      ctx.fillStyle = status === 'running' ? PALETTE.state.running : PALETTE.state.ramping;
      ctx.beginPath();
      ctx.arc(cx, cy, 5, 0, Math.PI * 2);
      ctx.fill();
    } else if (status === 'starved') {
      ctx.strokeStyle = PALETTE.state.starved;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(cx, cy, 5, 0, Math.PI * 2);
      ctx.stroke();
    } else if (status === 'blocked') {
      ctx.fillStyle = PALETTE.state.blocked;
      ctx.fillRect(cx - 5, cy - 5, 10, 10);
    }
  }

  function drawRampGauge(machine, timeSeconds) {
    const gx = machine.x + 8;
    const gy = machine.y - 12;
    const gw = machine.w - 16;
    ctx.strokeStyle = PALETTE.state.ramping;
    ctx.lineWidth = 1;
    ctx.strokeRect(gx, gy, gw, 7);
    const sweep = (timeSeconds * 0.7) % 1;
    ctx.fillStyle = PALETTE.state.ramping;
    ctx.fillRect(gx + gw * Math.max(0, sweep - 0.25), gy, gw * Math.min(0.25, sweep), 7);
  }

  function drawCountDots(machine, count) {
    ctx.fillStyle = PALETTE.decor.edgeLight;
    const shown = Math.min(count, 8);
    for (let index = 0; index < shown; index += 1) {
      ctx.beginPath();
      ctx.arc(machine.x + 10 + index * 9, machine.y + machine.h - 20, 2.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function drawCollection(machine, stageType, phase) {
    drawMachineBody(machine, 'collection');
    const cx = machine.x + machine.w / 2;
    const cy = machine.y + machine.h / 2 - 4;
    ctx.strokeStyle = PALETTE.material[stageType];
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx, cy, 16, 0, Math.PI * 2);
    for (let index = 0; index < 3; index += 1) {
      const angle = phase + (index * Math.PI * 2) / 3;
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + 16 * Math.cos(angle), cy + 16 * Math.sin(angle));
    }
    ctx.stroke();
  }

  function drawProcessing(machine, stageType, phase) {
    drawMachineBody(machine, 'processing');
    const plateY = machine.y + 16 + Math.abs(Math.sin(phase)) * (machine.h - 46);
    ctx.fillStyle = PALETTE.material[stageType];
    ctx.fillRect(machine.x + 16, plateY, machine.w - 32, 7);
    ctx.strokeStyle = blackVeil(0.4);
    ctx.lineWidth = 1;
    ctx.strokeRect(machine.x + 16, machine.y + 12, machine.w - 32, machine.h - 34);
  }

  function drawShipping(machine, phase) {
    drawMachineBody(machine, 'shipping');
    const beltY = machine.y + machine.h / 2 - 4;
    ctx.strokeStyle = PALETTE.decor.edgeLight;
    ctx.lineWidth = 3;
    ctx.setLineDash([8, 6]);
    ctx.lineDashOffset = -phase * 20;
    ctx.beginPath();
    ctx.moveTo(machine.x + 10, beltY);
    ctx.lineTo(machine.x + machine.w - 24, beltY);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = PALETTE.decor.edgeLight;
    ctx.beginPath();
    ctx.moveTo(machine.x + machine.w - 22, beltY - 8);
    ctx.lineTo(machine.x + machine.w - 22, beltY + 8);
    ctx.lineTo(machine.x + machine.w - 8, beltY);
    ctx.closePath();
    ctx.fill();
  }

  function drawSecondary(machine, phase) {
    drawMachineBody(machine, 'secondary');
    const cx = machine.x + machine.w / 2;
    const cy = machine.y + machine.h / 2 - 4;
    ctx.strokeStyle = PALETTE.material.refined;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx, cy, 10, 0, Math.PI * 2);
    for (let index = 0; index < 8; index += 1) {
      const angle = phase + (index * Math.PI) / 4;
      ctx.moveTo(cx + 10 * Math.cos(angle), cy + 10 * Math.sin(angle));
      ctx.lineTo(cx + 15 * Math.cos(angle), cy + 15 * Math.sin(angle));
    }
    ctx.stroke();
  }

  // 完全停止の離散表現（点滅に依存しない静的バッジ）
  function drawHaltBadge(machine, status) {
    const cx = machine.x + machine.w / 2;
    const cy = machine.y + machine.h / 2 - 4;
    ctx.fillStyle = blackVeil(0.5);
    ctx.beginPath();
    ctx.arc(cx, cy, 15, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = status === 'blocked' ? PALETTE.state.blocked : PALETTE.state.starved;
    ctx.fillRect(cx - 7, cy - 8, 5, 16);
    ctx.fillRect(cx + 2, cy - 8, 5, 16);
  }

  // starved: 入力側に「空の受け皿」
  function drawEmptyTray(machine, timeSeconds) {
    const x = machine.x - 20;
    const y = machine.y + machine.h / 2;
    const pulse = 0.55 + 0.45 * Math.sin(timeSeconds * 4);
    ctx.save();
    ctx.globalAlpha = 0.5 + 0.4 * pulse;
    ctx.strokeStyle = PALETTE.state.starved;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x - 9, y - 5);
    ctx.lineTo(x - 7, y + 5);
    ctx.lineTo(x + 7, y + 5);
    ctx.lineTo(x + 9, y - 5);
    ctx.stroke();
    ctx.setLineDash([2, 3]);
    ctx.beginPath();
    ctx.moveTo(x - 7, y + 2);
    ctx.lineTo(x + 7, y + 2);
    ctx.stroke();
    ctx.restore();
  }

  // blocked: 出力側に「溢れる粒」
  function drawOverflowHeap(machine, kind, stageType, timeSeconds) {
    const x = machine.x + machine.w + 20;
    const y = machine.y + machine.h / 2;
    ctx.save();
    ctx.strokeStyle = PALETTE.state.blocked;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x - 9, y - 5);
    ctx.lineTo(x - 7, y + 5);
    ctx.lineTo(x + 7, y + 5);
    ctx.lineTo(x + 9, y - 5);
    ctx.stroke();
    ctx.restore();
    const spill = Math.sin(timeSeconds * 4) * 1.5;
    drawParticleBatch(ctx, kind, stageType, [[x - 4, y + 1], [x + 4, y + 1], [x, y - 6 + spill]], 4);
  }

  // A-6: 全装置共通の稼働メーター。装置本体の下端に埋め込む
  function drawUtilizationMeter(machine, utilization) {
    const width = machine.w - 12;
    const x = machine.x + 6;
    const y = machine.y + machine.h - 11;
    const ratio = Math.min(1, Math.max(0, utilization));
    ctx.fillStyle = blackVeil(0.5);
    ctx.fillRect(x, y, width, 7);
    ctx.strokeStyle = PALETTE.decor.edgeShadow;
    ctx.lineWidth = 1;
    ctx.strokeRect(x, y, width, 7);
    ctx.fillStyle = ratio >= METER_FULL_UTILIZATION ? PALETTE.state.blocked : PALETTE.state.starved;
    ctx.fillRect(x + 1, y + 1, Math.max(0, (width - 2) * ratio), 5);
    ctx.fillStyle = PALETTE.decor.edgeLight;
    ctx.fillRect(x + width / 2, y, 1, 2);
    if (ratio >= METER_FULL_UTILIZATION) {
      ctx.fillStyle = PALETTE.state.blocked;
      ctx.beginPath();
      ctx.moveTo(machine.x + machine.w, y);
      ctx.lineTo(machine.x + machine.w + 8, y + 3.5);
      ctx.lineTo(machine.x + machine.w, y + 7);
      ctx.closePath();
      ctx.fill();
    }
  }

  // 抑制理由: 装置の辺そのものを変化させて示す（材料待ち=左辺 / 出口待ち=右辺）
  function drawRestraintHint(machine, side, level, timeSeconds) {
    const pulse = 0.65 + 0.35 * Math.sin(timeSeconds * 3);
    const thickness = 3 + 4 * level;
    const x = side === 'input' ? machine.x - thickness / 2 : machine.x + machine.w + thickness / 2;
    const color = side === 'input' ? PALETTE.state.starved : PALETTE.state.blocked;
    ctx.save();
    ctx.globalAlpha = Math.min(0.95, 0.4 + 0.55 * level) * pulse;
    ctx.strokeStyle = color;
    ctx.lineWidth = thickness;
    ctx.lineCap = 'butt';
    if (side === 'input') ctx.setLineDash([6, 5]);
    ctx.beginPath();
    ctx.moveTo(x, machine.y + 4);
    ctx.lineTo(x, machine.y + machine.h - 4);
    ctx.stroke();
    ctx.setLineDash([]);
    const cy = machine.y + machine.h / 2;
    const direction = side === 'input' ? 1 : -1;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(x + direction * thickness, cy - 6);
    ctx.lineTo(x + direction * (thickness + 6), cy);
    ctx.lineTo(x + direction * thickness, cy + 6);
    ctx.closePath();
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

  // --- lanes (A-1 flow + A-2 backlog) ---

  function drawLane(name, lane, flow, kind, stageType, dtSeconds, timeSeconds) {
    const geometry = laneGeometry(lane);
    const pool = pools[name];
    const { fillRatio, upstreamStatus, flowPerSecond } = flow;
    const flowRatio = Math.min(1, Math.max(0, flowPerSecond) / FLOW_REFERENCE_PER_SECOND);
    const upstreamHalted = isHalted(upstreamStatus);
    const saturated = fillRatio >= 0.999 || upstreamStatus === 'blocked';
    const jamLevel = Math.max(flow.jamLevel, saturated ? 1 : 0);

    // 詰まり中: 搬送路の圧縮/点滅表現（A-2）。発動条件は滞留の継続増加。
    if (jamLevel > 0) {
      const pulse = 0.45 + 0.4 * Math.sin(timeSeconds * 10);
      ctx.save();
      ctx.strokeStyle = withAlpha(PALETTE.state.blocked, Number((pulse * jamLevel).toFixed(3)));
      ctx.lineWidth = 14 + 4 * jamLevel;
      ctx.lineCap = 'butt';
      ctx.beginPath();
      ctx.moveTo(geometry.fromX, geometry.fromY);
      ctx.lineTo(geometry.fromX + geometry.unitX * geometry.length, geometry.fromY + geometry.unitY * geometry.length);
      ctx.stroke();
      ctx.restore();
    }

    if (saturated) {
      ctx.fillStyle = PALETTE.state.blocked;
      ctx.save();
      ctx.translate(geometry.fromX, geometry.fromY);
      ctx.rotate(geometry.angle);
      ctx.fillRect(-3, -14, 6, 28);
      ctx.restore();
    }

    const flowCount = flowRatio > 0 ? Math.max(1, Math.round(MAX_PARTICLES_PER_LANE * flowRatio)) : 0;
    const fillCount = fillRatio <= 0.001 ? 0
      : fillRatio < 0.5 ? Math.max(1, Math.round(MAX_PARTICLES_PER_LANE * (fillRatio / 0.5)))
        : MAX_PARTICLES_PER_LANE;
    const jamCount = jamLevel > 0 ? Math.round(MAX_PARTICLES_PER_LANE * (0.5 + 0.5 * jamLevel)) : 0;
    const count = Math.max(flowCount, fillCount, jamCount);
    const fillCompression = fillRatio < 0.5 ? 0 : Math.min(1, (fillRatio - 0.5) / 0.4);
    const compression = Math.max(fillCompression, jamLevel);
    const packedLength = geometry.length * (1 - 0.45 * compression);

    const flowSpeedScale = flowRatio > 0
      ? MIN_FLOW_SPEED_SCALE + (1 - MIN_FLOW_SPEED_SCALE) * flowRatio
      : 0;
    const jamScale = upstreamHalted ? 0 : 1 - 0.65 * jamLevel;
    pool.scroll += dtSeconds * BASE_PARTICLE_SPEED * flowSpeedScale * jamScale;

    if (count === 0) return;
    const spacing = packedLength / count;
    const packedStart = geometry.length - packedLength;
    const points = [];
    for (let index = 0; index < count; index += 1) {
      const particle = pool.particles[index];
      const along = packedStart + ((particle.slot * spacing) + pool.scroll) % packedLength;
      const bob = Math.sin(timeSeconds * 3 + particle.bobPhase) * 1.5;
      points.push([
        geometry.fromX + geometry.unitX * along,
        geometry.fromY + geometry.unitY * along + bob - 2,
      ]);
    }
    drawParticleBatch(ctx, kind, stageType, points, 5);
  }

  // --- effects layer (A-5) ---

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
      if (particle.age >= EXIT_PARTICLE_LIFE || particle.x > WIDTH) exitParticles.splice(index, 1);
    }
  }

  function drawExitParticles() {
    exitParticles.forEach((particle) => {
      fxCtx.save();
      fxCtx.globalAlpha = Math.max(0, 1 - particle.age / EXIT_PARTICLE_LIFE);
      drawSingleParticle(fxCtx, particle.refined ? 'refined' : 'product', particle.stageType, particle.x, particle.y, 5);
      fxCtx.restore();
    });
  }

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
        const popup = incomePopups[0] ?? {};
        popup.text = `+${Math.round(gained)} / ${Math.round(units)}個`;
        popup.age = 0;
        if (incomePopups.length === 0) incomePopups.push(popup);
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
    fxCtx.font = 'bold 12px sans-serif';
    fxCtx.textAlign = 'right';
    incomePopups.forEach((popup) => {
      const progress = popup.age / INCOME_POPUP_LIFE;
      fxCtx.save();
      fxCtx.globalAlpha = Math.max(0, 1 - progress);
      fxCtx.fillStyle = PALETTE.state.running;
      fxCtx.fillText(popup.text, machine.x + machine.w, machine.y - 8 - progress * 18);
      fxCtx.restore();
    });
  }

  function drawRefiningMotion(machine, stageType, phase) {
    const cy = machine.y + machine.h / 2 + 12;
    const left = machine.x + 16;
    const right = machine.x + machine.w - 16;
    drawSingleParticle(ctx, 'product', stageType, left, cy, 4);
    drawSingleParticle(ctx, 'refined', null, right, cy, 4);
    const travel = (Math.sin(phase) + 1) / 2;
    ctx.save();
    ctx.fillStyle = PALETTE.material.refined;
    ctx.beginPath();
    ctx.arc(left + (right - left) * travel, cy - 12, 2.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // --- hover tooltip (補足テキストはマウスオーバー時のみ) ---

  const STATUS_TEXT = {
    running: '稼働中',
    ramping: '立ち上げ中',
    starved: '入力待ち（材料が届いていない）',
    blocked: '出力詰まり（次の工程が受け取れない）',
  };

  mainCanvas.addEventListener('mousemove', (event) => {
    const box = mainCanvas.getBoundingClientRect();
    const x = (event.clientX - box.left) * (WIDTH / box.width);
    const y = (event.clientY - box.top) * (HEIGHT / box.height);
    hoveredMachine = Object.keys(MACHINES).find((slot) => {
      const machine = MACHINES[slot];
      return x >= machine.x && x <= machine.x + machine.w
        && y >= machine.y && y <= machine.y + machine.h + 26;
    }) || null;
  });
  mainCanvas.addEventListener('mouseleave', () => { hoveredMachine = null; });

  function updateHoverTooltip(state) {
    if (!hoveredMachine) {
      if (mainCanvas.title) mainCanvas.title = '';
      return;
    }
    const label = MACHINES[hoveredMachine].label;
    const status = state.statuses[hoveredMachine];
    if (!status) {
      mainCanvas.title = `${label}: 未購入`;
      return;
    }
    const utilization = state.utilization[hoveredMachine];
    mainCanvas.title = utilization === undefined
      ? `${label}: ${STATUS_TEXT[status] ?? status}`
      : `${label}: 稼働率 ${Math.round(utilization * 100)}% / ${STATUS_TEXT[status] ?? status}`;
  }

  // --- frame loop ---

  bakeBackground();
  bakeMachines();

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
    ctx.clearRect(0, 0, WIDTH, HEIGHT); // 背景は焼き込み済みの下層が担当する
    fxCtx.clearRect(0, 0, WIDTH, HEIGHT);

    const shown = {
      collection: displayedStatus('collection', state.statuses.collection, nowMs),
      processing: displayedStatus('processing', state.statuses.processing, nowMs),
      shipping: displayedStatus('shipping', state.statuses.shipping, nowMs),
      secondary: displayedStatus('secondary', state.statuses.secondary ?? null, nowMs),
    };

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
      if (!refinedLaneSprite) refinedLaneSprite = bakeRefinedLane();
      ctx.drawImage(refinedLaneSprite, 0, 0, WIDTH, HEIGHT);
      drawLane('refined', LANES.refined, {
        fillRatio: state.secondaryProcessor.refinedProducts / state.secondaryProcessor.refinedCapacity,
        jamLevel: updateJamLevel('refined', state.secondaryProcessor.refinedProducts, dtSeconds),
        upstreamStatus: shown.secondary,
        flowPerSecond: state.throughput.secondary,
      }, 'refined', null, dtSeconds, timeSeconds);
    }

    updateExitParticles(state, dtSeconds, config.stageTypes.processing);
    updateIncomePopups(state, nowMs, dtSeconds);
    drawExitParticles();

    const restraints = {
      collection: restraintOf('collection', state),
      processing: restraintOf('processing', state),
      shipping: restraintOf('shipping', state),
    };

    drawCollection(MACHINES.collection, config.stageTypes.collection, animPhases.collection);
    drawCountDots(MACHINES.collection, state.machines.collection);
    applyStatusDecoration(MACHINES.collection, shown.collection, 'raw', config.stageTypes.collection, timeSeconds);
    drawUtilizationMeter(MACHINES.collection, state.utilization.collection);

    drawProcessing(MACHINES.processing, config.stageTypes.processing, animPhases.processing);
    drawCountDots(MACHINES.processing, state.machines.processing);
    applyStatusDecoration(MACHINES.processing, shown.processing, 'product', config.stageTypes.processing, timeSeconds);
    drawUtilizationMeter(MACHINES.processing, state.utilization.processing);

    drawShipping(MACHINES.shipping, animPhases.shipping);
    drawCountDots(MACHINES.shipping, state.machines.shipping);
    applyStatusDecoration(MACHINES.shipping, shown.shipping, 'product', config.stageTypes.processing, timeSeconds);
    drawUtilizationMeter(MACHINES.shipping, state.utilization.shipping);

    ['collection', 'processing', 'shipping'].forEach((slot) => {
      const restraint = restraints[slot];
      if (!restraint || isHalted(shown[slot])) return;
      drawRestraintHint(MACHINES[slot], restraint.side, restraint.level, timeSeconds);
    });

    if (state.secondaryProcessor.purchased) {
      drawSecondary(MACHINES.secondary, animPhases.secondary);
      if (state.throughput.secondary > 0) {
        drawRefiningMotion(MACHINES.secondary, config.stageTypes.processing, animPhases.secondary);
      }
      if (shown.secondary) {
        applyStatusDecoration(MACHINES.secondary, shown.secondary, 'refined', null, timeSeconds);
      }
      drawUtilizationMeter(MACHINES.secondary, shown.secondary === 'running' ? 1 : 0);
    }

    drawIncomePopups();
    updateHoverTooltip(state);
  }

  requestAnimationFrame(frame);
})();
