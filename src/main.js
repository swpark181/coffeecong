'use strict';

(() => {
  // ---------------------------------------------------------------------------
  // 설정값. 거리 단위는 드리퍼 안쪽 반지름 R = 1 기준.
  // ---------------------------------------------------------------------------
  const CFG = {
    coffeeG: 15,
    absorbPerG: 2,        // 원두가 머금고 내보내지 않는 물 (g당 ml)
    // 실제 드립(약 2분 30초)을 15초 안팎으로 압축한 시간값
    pourRate: 35,         // ml/s
    gentleRate: 15,       // 오른쪽 버튼(또는 Shift+클릭)으로 가늘게 붓기
    maxTotal: 400,
    grid: 72,             // 커피 베드 시뮬레이션 격자 (N x N)
    bedR: 0.78,           // 커피 가루 표면 반지름. 바깥은 필터 종이 벽
    evalR: 0.70,          // 고르게 붓기 평가 영역
    sigma: 0.1,           // 물줄기가 퍼지는 반경
    follow: 25,           // 물줄기가 마우스를 따라가는 빠르기 (클수록 즉각적)
    drainK: 0.7,          // 고인 물이 빠지는 속도
    drainC: 4,
    drawdownBoost: 3,     // 마지막 붓기 후에는 더 빨리 빠지게
    gasTau: 1.6,          // 뜸 거품이 잦아드는 시간
    stageGap: 0.6,        // 버튼을 떼고 이 시간이 지나면 단계 종료
    minStageAmount: 3,
    bloom: [30, 45],
    bloomWait: [3, 4.5],
    second: [140, 160],
    final: [244, 256],
    thirdWindow: [15, 50],
    gaugeMax: 150,
  };

  const N = CFG.grid;
  const CELLS = N * N;
  const CELL = 2 / N;
  const cellX = new Float32Array(CELLS);
  const cellY = new Float32Array(CELLS);
  const inBed = new Uint8Array(CELLS);
  const inEval = new Uint8Array(CELLS);
  const bedList = [];
  let nEval = 0;
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const k = j * N + i;
      const x = -1 + (i + 0.5) * CELL;
      const y = -1 + (j + 0.5) * CELL;
      const r = Math.hypot(x, y);
      cellX[k] = x;
      cellY[k] = y;
      if (r <= CFG.bedR) { inBed[k] = 1; bedList.push(k); }
      if (r <= CFG.evalR) { inEval[k] = 1; nEval++; }
    }
  }
  const nBed = bedList.length;
  const WET_SCALE = (nBed / 40) * 2.2;
  const PAPER_BINS = 96;

  // ---------------------------------------------------------------------------
  // DOM
  // ---------------------------------------------------------------------------
  const $ = id => document.getElementById(id);
  const canvas = $('game');
  const ctx = canvas.getContext('2d');
  const bedCanvas = document.createElement('canvas');
  bedCanvas.width = bedCanvas.height = N;
  const bedCtx = bedCanvas.getContext('2d');
  const bedImg = bedCtx.createImageData(N, N);
  const ui = {
    intro: $('intro'), result: $('result'),
    timer: $('timer'), total: $('total'), cup: $('cup'),
    freeVal: $('freeVal'), freeFill: $('freeFill'), freeBand: $('freeBand'),
    steps: [...document.querySelectorAll('#steps li')],
  };
  ui.freeBand.style.left = `${(CFG.thirdWindow[0] / CFG.gaugeMax) * 100}%`;
  ui.freeBand.style.width = `${((CFG.thirdWindow[1] - CFG.thirdWindow[0]) / CFG.gaugeMax) * 100}%`;

  // 캔버스 픽셀 기준 드리퍼 위치와 크기. 그리기와 마우스 좌표 변환이 함께 쓴다.
  function layout(W) {
    return { cx: W / 2, cy: W / 2 + W * 0.03, R: W * 0.37 };
  }

  // ---------------------------------------------------------------------------
  // 입력: 물줄기는 마우스를 따라가고, 왼쪽 버튼 = 붓기, 오른쪽 버튼 = 가늘게 붓기
  // (키보드는 한글 입력 상태에서도 동작하도록 e.code 사용)
  // ---------------------------------------------------------------------------
  const pointer = { x: 0, y: 0, left: false, right: false, shift: false };
  const isPouringInput = () => pointer.left || pointer.right;
  const isGentle = () => pointer.right || pointer.shift;

  function trackPointer(e) {
    const rect = canvas.getBoundingClientRect();
    const scale = canvas.width / rect.width;
    const { cx, cy, R } = layout(canvas.width);
    pointer.x = ((e.clientX - rect.left) * scale - cx) / R;
    pointer.y = ((e.clientY - rect.top) * scale - cy) / R;
  }

  canvas.addEventListener('pointermove', trackPointer);
  canvas.addEventListener('pointerdown', e => {
    trackPointer(e);
    if (e.button === 0) pointer.left = true;
    if (e.button === 2) pointer.right = true;
    pointer.shift = e.shiftKey;
    try { canvas.setPointerCapture(e.pointerId); } catch (_) { /* 캡처 실패해도 진행 */ }
    e.preventDefault();
  });
  addEventListener('pointerup', e => {
    if (e.button === 0) pointer.left = false;
    if (e.button === 2) pointer.right = false;
  });
  addEventListener('pointercancel', () => { pointer.left = pointer.right = false; });
  canvas.addEventListener('contextmenu', e => e.preventDefault());

  addEventListener('keydown', e => {
    if (e.key === 'Shift') pointer.shift = true;
    if (e.repeat) return;
    if (e.code === 'Enter' && G.state === 'intro') start();
    else if (e.code === 'KeyR' && G.state !== 'intro') restart();
    else if (e.code === 'KeyH') G.heat = !G.heat;
  });
  addEventListener('keyup', e => { if (e.key === 'Shift') pointer.shift = false; });
  addEventListener('blur', () => { pointer.left = pointer.right = pointer.shift = false; });
  $('startBtn').addEventListener('click', start);
  $('againBtn').addEventListener('click', restart);

  // ---------------------------------------------------------------------------
  // 게임 상태
  // ---------------------------------------------------------------------------
  let G;

  function newGame(state) {
    G = {
      state,                 // 'intro' | 'play' | 'result'
      started: false,
      t: 0,
      stage: 0,              // 0 뜸, 1 2차, 2 3차
      sub: 'waiting',        // 'waiting' | 'pouring' | 'drawdown'
      sx: 0, sy: 0,
      pouring: false,
      total: 0, bedTotal: 0, bypass: 0, drained: 0, cup: 0, free: 0,
      lastPour: 0,
      dryTime: 0,
      dep: new Float32Array(CELLS),
      fresh: new Float32Array(CELLS),
      gas: new Float32Array(CELLS).fill(1),
      paperWet: new Float32Array(PAPER_BINS),
      snap: null,
      stageStartTotal: 0,
      stages: [],
      bloomWait: 0,
      thirdFree: 0,
      thirdDry: 0,
      bubbles: [],
      ripples: [],
      rippleT: 0,
      heat: G ? G.heat : false,
    };
  }

  function start() {
    G.state = 'play';
    ui.intro.hidden = true;
  }

  function restart() {
    newGame('play');
    ui.intro.hidden = true;
    ui.result.hidden = true;
  }

  // ---------------------------------------------------------------------------
  // 시뮬레이션
  // ---------------------------------------------------------------------------
  // 주전자 물줄기라 마우스를 아주 살짝 늦게 따라간다.
  function updateMovement(dt) {
    let tx = pointer.x, ty = pointer.y;
    const r = Math.hypot(tx, ty);
    const maxR = 0.97;
    if (r > maxR) { tx *= maxR / r; ty *= maxR / r; }
    const a = 1 - Math.exp(-dt * CFG.follow);
    G.sx += (tx - G.sx) * a;
    G.sy += (ty - G.sy) * a;
  }

  // 물줄기 위치를 중심으로 가우시안 분포로 물을 뿌린다.
  function deposit(amount) {
    const s = CFG.sigma;
    const reach = 3 * s;
    const reach2 = reach * reach;
    const inv2s2 = 1 / (2 * s * s);
    const i0 = Math.max(0, Math.floor((G.sx - reach + 1) / CELL));
    const i1 = Math.min(N - 1, Math.floor((G.sx + reach + 1) / CELL));
    const j0 = Math.max(0, Math.floor((G.sy - reach + 1) / CELL));
    const j1 = Math.min(N - 1, Math.floor((G.sy + reach + 1) / CELL));

    let sum = 0;
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const k = j * N + i;
        const dx = cellX[k] - G.sx, dy = cellY[k] - G.sy;
        const d2 = dx * dx + dy * dy;
        if (d2 <= reach2) sum += Math.exp(-d2 * inv2s2);
      }
    }
    if (sum <= 0) return;

    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const k = j * N + i;
        const dx = cellX[k] - G.sx, dy = cellY[k] - G.sy;
        const d2 = dx * dx + dy * dy;
        if (d2 > reach2) continue;
        const amt = amount * Math.exp(-d2 * inv2s2) / sum;
        if (inBed[k]) {
          G.dep[k] += amt;
          G.fresh[k] += amt;
          G.bedTotal += amt;
        } else {
          // 필터 종이 벽에 부은 물은 커피를 거치지 않고 바로 컵으로 빠진다.
          G.bypass += amt;
          G.cup += amt;
          const ang = Math.atan2(cellY[k], cellX[k]);
          const bin = Math.floor(((ang + Math.PI) / (2 * Math.PI)) * PAPER_BINS) % PAPER_BINS;
          G.paperWet[bin] += amt;
        }
      }
    }
  }

  function stageDeposit(k) {
    return G.dep[k] - G.snap[k];
  }

  function evenStats(valueOf) {
    let sum = 0, sq = 0;
    for (let k = 0; k < CELLS; k++) {
      if (!inEval[k]) continue;
      const v = valueOf(k);
      sum += v;
      sq += v * v;
    }
    const mean = sum / nEval;
    if (mean <= 1e-9) return { cv: 2, coverage: 0 };
    const cv = Math.sqrt(Math.max(0, sq / nEval - mean * mean)) / mean;
    let covered = 0;
    for (let k = 0; k < CELLS; k++) {
      if (inEval[k] && valueOf(k) >= 0.2 * mean) covered++;
    }
    return { cv, coverage: covered / nEval };
  }

  function beginStage() {
    const s = G.stage;
    G.sub = 'pouring';
    G.snap = G.dep.slice();
    G.stageStartTotal = G.total;
    if (s === 1) G.bloomWait = G.t - G.stages[0].end;
    if (s === 2) { G.thirdFree = G.free; G.thirdDry = G.dryTime; }
  }

  function endStage() {
    const s = G.stage;
    const stats = evenStats(stageDeposit);
    G.stages[s] = {
      end: G.lastPour,
      cum: G.total,
      amount: G.total - G.stageStartTotal,
      cv: stats.cv,
      coverage: stats.coverage,
    };
    G.stage++;
    G.dryTime = 0;
    G.sub = G.stage >= 3 ? 'drawdown' : 'waiting';
  }

  function simulate(dt) {
    const canPour = G.sub !== 'drawdown' && G.total < CFG.maxTotal;
    G.pouring = canPour && isPouringInput();

    if (G.pouring) {
      G.started = true;
      if (G.sub === 'waiting') beginStage();
      const rate = isGentle() ? CFG.gentleRate : CFG.pourRate;
      const a = Math.min(rate * dt, CFG.maxTotal - G.total);
      deposit(a);
      G.total += a;
      G.lastPour = G.t;
    }
    if (G.started) G.t += dt;

    if (G.sub === 'pouring' && !G.pouring && G.t - G.lastPour > CFG.stageGap
        && G.total - G.stageStartTotal >= CFG.minStageAmount) {
      endStage();
    }

    // 원두가 머금는 물을 빼고 남은 물이 드리퍼에 고였다가 컵으로 빠진다.
    const absorbed = Math.min(G.bedTotal, CFG.coffeeG * CFG.absorbPerG);
    let free = Math.max(0, G.bedTotal - absorbed - G.drained);
    if (free > 0) {
      const boost = G.sub === 'drawdown' ? CFG.drawdownBoost : 1;
      const d = Math.min(free, (CFG.drainK * free + CFG.drainC) * boost * dt);
      G.drained += d;
      G.cup += d;
      free -= d;
    }
    G.free = free;

    if (G.sub === 'waiting' && G.stage === 2 && free < 0.5) G.dryTime += dt;
    if (G.sub === 'drawdown' && free < 0.5) finish();

    // 젖은 가루에서 가스가 빠져나가며 뜸 거품이 생긴다.
    const freshDecay = Math.exp(-dt * 1.5);
    const gasDecay = Math.exp(-dt / CFG.gasTau);
    for (const k of bedList) {
      G.fresh[k] *= freshDecay;
      if (wetness(k) > 0.3) G.gas[k] *= gasDecay;
    }
    for (let n = 0; n < 8; n++) {
      const k = bedList[(Math.random() * nBed) | 0];
      const p = G.gas[k] * wetness(k) * 9 * dt;
      if (Math.random() < p && G.bubbles.length < 300) {
        G.bubbles.push({
          x: cellX[k] + (Math.random() - 0.5) * CELL,
          y: cellY[k] + (Math.random() - 0.5) * CELL,
          r: 0.006 + Math.random() * 0.014,
          age: 0,
          life: 0.6 + Math.random(),
        });
      }
    }

    if (G.pouring) {
      G.rippleT -= dt;
      if (G.rippleT <= 0) {
        G.rippleT = 0.12;
        G.ripples.push({ x: G.sx, y: G.sy, age: 0 });
      }
    }
    for (const b of G.bubbles) b.age += dt;
    for (const r of G.ripples) r.age += dt;
    G.bubbles = G.bubbles.filter(b => b.age < b.life);
    G.ripples = G.ripples.filter(r => r.age < 0.9);
  }

  function wetness(k) {
    return 1 - Math.exp(-G.dep[k] * WET_SCALE);
  }

  // ---------------------------------------------------------------------------
  // 채점
  // ---------------------------------------------------------------------------
  const clamp = v => Math.max(0, Math.min(100, v));
  const band = (x, [lo, hi], per) => (x >= lo && x <= hi ? 100 : clamp(100 - per * (x < lo ? lo - x : x - hi)));
  // 변동계수(CV) 0.45 이하면 만점, 1.6 이상이면 0점
  const evenScore = cv => clamp(((1.6 - cv) / 1.15) * 100);

  function score() {
    const [b, s2, s3] = G.stages;
    const stageEven = G.stages.reduce((acc, s) => acc + evenScore(s.cv) * s.amount, 0) / Math.max(1, G.total);
    const finalEven = evenScore(evenStats(k => G.dep[k]).cv);
    const even = 0.6 * stageEven + 0.4 * finalEven;
    const bypassRatio = G.bypass / Math.max(1, G.total);

    let third;
    const [lo, hi] = CFG.thirdWindow;
    if (G.thirdFree > hi) third = clamp(100 - (G.thirdFree - hi) * 2);
    else if (G.thirdFree < lo) third = clamp(100 - (lo - G.thirdFree) * 3 - G.thirdDry * 40);
    else third = 100;

    const items = [
      { key: 'even', label: '고르게 붓기', w: 25, score: even },
      { key: 'edge', label: '필터 벽 피하기', w: 10, score: clamp(100 - bypassRatio * 800), detail: `벽 ${Math.round(G.bypass)}ml` },
      { key: 'bloomAmt', label: '뜸 물 양', w: 10, score: band(b.amount, CFG.bloom, 3), detail: `${Math.round(b.amount)}ml` },
      { key: 'coverage', label: '뜸 커버리지', w: 10, score: clamp(((b.coverage - 0.6) / 0.35) * 100), detail: `${Math.round(b.coverage * 100)}%` },
      { key: 'bloomWait', label: '뜸 시간', w: 10, score: band(G.bloomWait, CFG.bloomWait, 50), detail: `${G.bloomWait.toFixed(1)}초` },
      { key: 'second', label: '2차 붓기 양', w: 10, score: band(s2.cum, CFG.second, 2), detail: `누적 ${Math.round(s2.cum)}ml` },
      { key: 'third', label: '3차 타이밍', w: 10, score: third, detail: `고인 물 ${Math.round(G.thirdFree)}ml` },
      { key: 'final', label: '최종 물 양', w: 15, score: band(s3.cum, CFG.final, 2), detail: `${Math.round(s3.cum)}ml` },
    ];
    const total = items.reduce((acc, it) => acc + (it.w * it.score) / 100, 0);
    return { items, total, even };
  }

  const TIPS = {
    even: '물이 한 곳에 몰렸어요. 중심에서 바깥으로 나선을 그리며 베드 전체에 골고루 부어보세요.',
    edge: '필터 종이 벽에 직접 부은 물은 커피를 거치지 않고 빠져요. 가루 표면 안쪽에만 부어주세요.',
    bloomAmt: '뜸 물은 원두 무게의 2~3배(30~45ml)가 적당해요.',
    coverage: '뜸 들일 때 마른 가루가 남았어요. 오른쪽 버튼으로 가늘게 부으며 전체를 적셔보세요.',
    bloomWait: '뜸은 3~4.5초 기다린 뒤 2차 붓기를 시작하세요.',
    second: '2차 붓기는 누적 150ml에서 멈추세요. 오른쪽 "부은 물"을 확인!',
    third: '3차 붓기는 고인 물이 15~50ml일 때(게이지 초록 구간) 시작하세요.',
    final: '최종 물 양은 250ml. 끝날 즈음엔 가늘게 부어 양을 맞춰보세요.',
  };

  function flavorText(total, even) {
    const conc = total < 235 ? '진하고 묵직한' : total > 265 ? '묽고 가벼운' : '농도가 알맞은';
    const clarity = even >= 85 ? '단맛이 살아있는 깔끔한'
      : even >= 60 ? '무난한'
      : '쓴맛과 신맛이 뒤섞인';
    return `${conc}, ${clarity} 커피가 내려졌어요.`;
  }

  function finish() {
    G.state = 'result';
    const { items, total, even } = score();
    const pts = Math.round(total);
    const grade = pts >= 90 ? 'S' : pts >= 80 ? 'A' : pts >= 70 ? 'B' : pts >= 55 ? 'C' : 'D';

    let best = 0;
    try {
      best = Number(localStorage.getItem('coffeecong.best')) || 0;
      if (pts > best) localStorage.setItem('coffeecong.best', String(pts));
    } catch (_) { /* 저장소를 못 써도 게임은 계속 */ }

    $('grade').textContent = grade;
    $('scoreTotal').textContent = `${pts}점`;
    $('best').textContent = pts > best ? '최고 기록 갱신!' : `최고 기록 ${best}점 · 추출 ${fmtTime(G.t)}`;
    $('flavor').textContent = flavorText(G.stages[2].cum, even);
    $('breakdown').innerHTML = items.map(it => {
      const color = it.score >= 80 ? 'var(--good)' : it.score >= 50 ? 'var(--accent)' : 'var(--warn)';
      return `<li><span class="name">${it.label}${it.detail ? `<small>${it.detail}</small>` : ''}</span>`
        + `<span class="bar"><i style="width:${it.score.toFixed(0)}%;background:${color}"></i></span>`
        + `<span class="pts">${((it.w * it.score) / 100).toFixed(1)}<small>/${it.w}</small></span></li>`;
    }).join('');
    const weak = items.filter(it => it.score < 80).sort((a, b) => a.score - b.score).slice(0, 3);
    $('tips').innerHTML = (weak.length ? weak.map(it => TIPS[it.key]) : ['거의 완벽한 추출이에요! 바리스타 해도 되겠어요.'])
      .map(t => `<li>${t}</li>`).join('');

    const hc = $('resultHeat');
    const hctx = hc.getContext('2d');
    paintBed(true);
    const R = (hc.width / 2) / CFG.bedR;
    hctx.clearRect(0, 0, hc.width, hc.height);
    hctx.save();
    hctx.beginPath();
    hctx.arc(hc.width / 2, hc.height / 2, hc.width / 2 - 1, 0, Math.PI * 2);
    hctx.clip();
    hctx.imageSmoothingEnabled = true;
    hctx.drawImage(bedCanvas, hc.width / 2 - R, hc.height / 2 - R, 2 * R, 2 * R);
    hctx.restore();

    ui.result.hidden = false;
  }

  // ---------------------------------------------------------------------------
  // 그리기
  // ---------------------------------------------------------------------------
  const lerp = (a, b, t) => a + (b - a) * t;
  const DRY = [190, 140, 96];
  const WET = [62, 38, 24];
  const FOAM = [200, 152, 104];
  const HEAT = [[0, [40, 70, 150]], [0.5, [80, 150, 210]], [1, [238, 234, 218]], [1.5, [235, 150, 75]], [2.2, [185, 40, 40]]];

  function heatColor(r) {
    for (let i = 1; i < HEAT.length; i++) {
      const [x1, c1] = HEAT[i];
      if (r <= x1 || i === HEAT.length - 1) {
        const [x0, c0] = HEAT[i - 1];
        const t = Math.max(0, Math.min(1, (r - x0) / (x1 - x0)));
        return [lerp(c0[0], c1[0], t), lerp(c0[1], c1[1], t), lerp(c0[2], c1[2], t)];
      }
    }
    return HEAT[HEAT.length - 1][1];
  }

  function paintBed(heat) {
    const px = bedImg.data;
    let mean = 0;
    if (heat) {
      for (let k = 0; k < CELLS; k++) if (inEval[k]) mean += G.dep[k];
      mean /= nEval;
    }
    for (let k = 0; k < CELLS; k++) {
      let c;
      if (heat) {
        c = mean > 0 ? heatColor(G.dep[k] / mean) : HEAT[2][1];
      } else {
        const w = inBed[k] ? wetness(k) : 0;
        const f = inBed[k] ? G.gas[k] * w * 0.55 : 0;
        const dark = inBed[k] ? Math.min(1, G.fresh[k] * 4) * 0.25 : 0;
        c = [0, 1, 2].map(ch => lerp(lerp(DRY[ch], WET[ch], w), FOAM[ch], f) * (1 - dark));
      }
      const p = k * 4;
      px[p] = c[0];
      px[p + 1] = c[1];
      px[p + 2] = c[2];
      px[p + 3] = 255;
    }
    bedCtx.putImageData(bedImg, 0, 0);
  }

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.round(canvas.getBoundingClientRect().width * dpr);
    if (canvas.width !== w) { canvas.width = w; canvas.height = w; }
  }

  function draw() {
    const W = canvas.width;
    const { cx, cy, R } = layout(W);
    const X = x => cx + x * R;
    const Y = y => cy + y * R;
    const bedPx = CFG.bedR * R;

    // 테이블
    const bg = ctx.createRadialGradient(cx, cy, R * 0.3, cx, cy, W * 0.75);
    bg.addColorStop(0, '#6b4a33');
    bg.addColorStop(1, '#3a271b');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, W);

    // 드리퍼 바깥 테두리
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.45)';
    ctx.shadowBlur = R * 0.12;
    ctx.shadowOffsetY = R * 0.04;
    ctx.beginPath();
    ctx.arc(cx, cy, R * 1.14, 0, Math.PI * 2);
    const rim = ctx.createRadialGradient(cx - R * 0.3, cy - R * 0.4, R * 0.2, cx, cy, R * 1.14);
    rim.addColorStop(0, '#ffffff');
    rim.addColorStop(1, '#ddd3c6');
    ctx.fillStyle = rim;
    ctx.fill();
    ctx.restore();

    // 필터 종이
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.fillStyle = '#f2e8d6';
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.06)';
    ctx.lineWidth = Math.max(1, R * 0.006);
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * bedPx, cy + Math.sin(a) * bedPx);
      ctx.lineTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R);
      ctx.stroke();
    }
    for (let i = 0; i < PAPER_BINS; i++) {
      const w = G.paperWet[i];
      if (w <= 0.01) continue;
      const a0 = -Math.PI + (i / PAPER_BINS) * Math.PI * 2;
      const a1 = a0 + (Math.PI * 2) / PAPER_BINS + 0.01;
      ctx.beginPath();
      ctx.arc(cx, cy, R, a0, a1);
      ctx.arc(cx, cy, bedPx, a1, a0, true);
      ctx.closePath();
      ctx.fillStyle = `rgba(140,98,62,${Math.min(0.55, w / 3)})`;
      ctx.fill();
    }

    // 커피 베드
    paintBed(G.heat);
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, bedPx, 0, Math.PI * 2);
    ctx.clip();
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(bedCanvas, cx - R, cy - R, 2 * R, 2 * R);

    if (!G.heat) {
      // 고인 물
      if (G.free > 1) {
        const a = Math.min(0.5, G.free / 220);
        ctx.fillStyle = `rgba(45,25,12,${a})`;
        ctx.fillRect(cx - bedPx, cy - bedPx, bedPx * 2, bedPx * 2);
        const sheen = ctx.createRadialGradient(cx - bedPx * 0.35, cy - bedPx * 0.4, 0, cx - bedPx * 0.35, cy - bedPx * 0.4, bedPx);
        sheen.addColorStop(0, `rgba(255,240,220,${a * 0.35})`);
        sheen.addColorStop(1, 'rgba(255,240,220,0)');
        ctx.fillStyle = sheen;
        ctx.fillRect(cx - bedPx, cy - bedPx, bedPx * 2, bedPx * 2);
      }
      // 뜸 거품
      for (const b of G.bubbles) {
        const t = b.age / b.life;
        const fade = t < 0.2 ? t / 0.2 : 1 - (t - 0.2) / 0.8;
        ctx.beginPath();
        ctx.arc(X(b.x), Y(b.y), (b.r * (0.7 + t * 0.5)) * R, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(232,200,160,${0.3 * fade})`;
        ctx.fill();
        ctx.strokeStyle = `rgba(255,240,220,${0.6 * fade})`;
        ctx.lineWidth = Math.max(1, R * 0.003);
        ctx.stroke();
      }
    }
    // 베드 가장자리 그림자
    const edge = ctx.createRadialGradient(cx, cy, bedPx * 0.75, cx, cy, bedPx);
    edge.addColorStop(0, 'rgba(0,0,0,0)');
    edge.addColorStop(1, 'rgba(0,0,0,0.28)');
    ctx.fillStyle = edge;
    ctx.fillRect(cx - bedPx, cy - bedPx, bedPx * 2, bedPx * 2);
    ctx.restore();

    // 물결
    for (const r of G.ripples) {
      const t = r.age / 0.9;
      ctx.beginPath();
      ctx.arc(X(r.x), Y(r.y), (0.03 + t * 0.18) * R, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(255,248,235,${(1 - t) * 0.45})`;
      ctx.lineWidth = Math.max(1, R * 0.006);
      ctx.stroke();
    }

    // 물줄기
    const sx = X(G.sx), sy = Y(G.sy);
    if (G.pouring) {
      const wob = Math.sin(performance.now() / 60) * R * 0.004;
      const glow = ctx.createRadialGradient(sx, sy, 0, sx, sy, R * 0.1);
      glow.addColorStop(0, 'rgba(255,255,255,0.75)');
      glow.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(sx, sy, R * 0.1, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(sx + wob, sy, R * (isGentle() ? 0.016 : 0.026), 0, Math.PI * 2);
      ctx.fillStyle = '#eef8ff';
      ctx.fill();
    } else {
      const active = G.state === 'play' && G.sub !== 'drawdown';
      ctx.save();
      ctx.setLineDash([R * 0.025, R * 0.02]);
      ctx.lineWidth = Math.max(1.5, R * 0.007);
      ctx.strokeStyle = active ? 'rgba(255,255,255,0.85)' : 'rgba(255,255,255,0.35)';
      ctx.beginPath();
      ctx.arc(sx, sy, CFG.sigma * 1.5 * R, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
      ctx.fillStyle = ctx.strokeStyle;
      ctx.beginPath();
      ctx.arc(sx, sy, R * 0.012, 0, Math.PI * 2);
      ctx.fill();
    }

    drawBanner(W);
    if (G.heat) drawHeatLegend(W);
  }

  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function drawBanner(W) {
    const msg = message();
    if (!msg) return;
    const [main, sub, tone] = msg;
    const fs = W * 0.034;
    ctx.font = `700 ${fs}px "Pretendard", "Malgun Gothic", sans-serif`;
    const w1 = ctx.measureText(main).width;
    ctx.font = `500 ${fs * 0.62}px "Pretendard", "Malgun Gothic", sans-serif`;
    const w2 = ctx.measureText(sub).width;
    const bw = Math.max(w1, w2) + fs * 1.4;
    const bh = fs * 2.5;
    const bx = (W - bw) / 2, by = W * 0.025;
    roundRect(bx, by, bw, bh, fs * 0.5);
    ctx.fillStyle = tone === 'go' ? 'rgba(46,92,50,0.88)' : tone === 'warn' ? 'rgba(120,44,28,0.88)' : 'rgba(30,20,14,0.82)';
    ctx.fill();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#fff6ea';
    ctx.font = `700 ${fs}px "Pretendard", "Malgun Gothic", sans-serif`;
    ctx.fillText(main, W / 2, by + bh * 0.36);
    ctx.fillStyle = 'rgba(255,240,225,0.8)';
    ctx.font = `500 ${fs * 0.62}px "Pretendard", "Malgun Gothic", sans-serif`;
    ctx.fillText(sub, W / 2, by + bh * 0.74);
  }

  function drawHeatLegend(W) {
    const fs = W * 0.022;
    ctx.font = `600 ${fs}px "Pretendard", "Malgun Gothic", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const text = '물 분포 보기 (H) · 파랑 적음 · 흰색 적정 · 빨강 많음';
    const w = ctx.measureText(text).width + fs * 1.6;
    roundRect((W - w) / 2, W - fs * 3, w, fs * 2, fs * 0.5);
    ctx.fillStyle = 'rgba(30,20,14,0.8)';
    ctx.fill();
    ctx.fillStyle = '#fff6ea';
    ctx.fillText(text, W / 2, W - fs * 2);
  }

  function message() {
    if (G.state !== 'play') return null;
    const s = G.stage;
    const ml = v => `${Math.round(v)}ml`;
    if (!G.started) return ['클릭한 채로 움직여 뜸 물을 부으세요', '목표 30~45ml로 가루 전체 적시기 · 오른쪽 버튼은 가늘게'];

    if (G.sub === 'pouring') {
      const gap = G.t - G.lastPour;
      const closing = !G.pouring && gap > 0.25 ? ` · ${Math.max(0, CFG.stageGap - gap).toFixed(1)}초 후 단계 종료` : '';
      if (s === 0) return [`뜸 들이기 ${ml(G.total)} / 30~45ml`, `중심에서 바깥으로 작은 원을 그리며 적셔요${closing}`];
      if (s === 1) return [`2차 붓기 ${ml(G.total)} / 150ml`, `나선형으로 고르게, 필터 벽은 피해서${closing}`];
      return [`3차 붓기 ${ml(G.total)} / 250ml`, `마지막까지 고르게${closing}`];
    }

    if (G.sub === 'waiting' && s === 1) {
      const w = G.t - G.stages[0].end;
      const [lo, hi] = CFG.bloomWait;
      if (w < lo) return [`뜸 들이는 중… ${w.toFixed(1)}초`, `${lo}~${hi}초 기다린 뒤 2차 붓기`];
      if (w <= hi) return ['지금 2차 붓기!', `뜸 ${w.toFixed(1)}초 · 누적 150ml까지`, 'go'];
      return [`뜸이 길어지고 있어요 (${w.toFixed(1)}초)`, '바로 2차 붓기를 시작하세요', 'warn'];
    }

    if (G.sub === 'waiting' && s === 2) {
      const [lo, hi] = CFG.thirdWindow;
      if (G.free > hi) return ['물이 빠지길 기다리세요', `고인 물 ${ml(G.free)} · ${hi}ml 이하에서 3차 시작`];
      if (G.free >= lo) return ['지금 3차 붓기!', `고인 물 ${ml(G.free)} · 누적 250ml까지`, 'go'];
      return ['물이 거의 다 빠졌어요!', '서둘러 3차 붓기를 시작하세요', 'warn'];
    }

    return ['추출 마무리 중…', `컵 ${ml(G.cup)}`];
  }

  // ---------------------------------------------------------------------------
  // 패널
  // ---------------------------------------------------------------------------
  function fmtTime(t) {
    return `${t.toFixed(1)}초`;
  }

  function updatePanel() {
    ui.timer.textContent = fmtTime(G.t);
    ui.total.textContent = Math.round(G.total);
    ui.cup.textContent = Math.round(G.cup);
    ui.freeVal.textContent = Math.round(G.free);
    ui.freeFill.style.width = `${Math.min(1, G.free / CFG.gaugeMax) * 100}%`;
    ui.freeBand.hidden = !(G.sub === 'waiting' && G.stage === 2);
    ui.steps.forEach((li, i) => {
      const done = i < G.stage;
      li.classList.toggle('done', done);
      li.classList.toggle('active', !done && i === G.stage && G.state === 'play');
      const res = li.querySelector('.res');
      const text = done ? `${Math.round(G.stages[i].cum)}ml` : '';
      if (res.textContent !== text) res.textContent = text;
    });
  }

  // ---------------------------------------------------------------------------
  // 루프
  // ---------------------------------------------------------------------------
  let last = performance.now();
  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    resize();
    if (G.state === 'play') {
      updateMovement(dt);
      simulate(dt);
    }
    draw();
    updatePanel();
    requestAnimationFrame(frame);
  }

  newGame('intro');
  requestAnimationFrame(frame);

  // 자동 테스트용: index.html#debug 로 열면 상태를 확인할 수 있다.
  if (location.hash === '#debug') window.__cc = { get G() { return G; } };
})();
