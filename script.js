'use strict';

/* =========================================================
 * 設定
 * ======================================================= */
const GRID = 20;        // 20 × 20 格
const CELL = 24;        // 每格 24px，畫布 480 × 480
const TARGET = 20;      // 吃滿 20 個就過關

const DIFFICULTIES = {
  easy:   { label: '簡單', interval: 150 }, // 每走一格的毫秒數
  normal: { label: '普通', interval: 100 },
  hard:   { label: '困難', interval: 70 },
};

const STORAGE_KEYS = {
  records: 'swp05-snake.records',
  settings: 'swp05-snake.settings',
};

const DIRS = {
  up:    { x: 0, y: -1 },
  down:  { x: 0, y: 1 },
  left:  { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};
const OPPOSITE = { up: 'down', down: 'up', left: 'right', right: 'left' };
const KEY_TO_DIR = {
  ArrowUp: 'up', KeyW: 'up',
  ArrowDown: 'down', KeyS: 'down',
  ArrowLeft: 'left', KeyA: 'left',
  ArrowRight: 'right', KeyD: 'right',
};
const MAX_QUEUED_TURNS = 2;

/* =========================================================
 * LocalStorage（讀寫失敗時不讓遊戲壞掉）
 * ======================================================= */
const storage = {
  read(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  },
  write(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* 無痕模式或儲存空間被封鎖時忽略 */
    }
  },
};

function emptyRecord() {
  return { bestScore: 0, bestTime: null }; // bestTime：毫秒，尚未過關為 null
}

function loadRecords() {
  const saved = storage.read(STORAGE_KEYS.records, {}) || {};
  const records = {};
  for (const key of Object.keys(DIFFICULTIES)) {
    const r = saved[key] || {};
    records[key] = {
      bestScore: Number.isFinite(r.bestScore) ? r.bestScore : 0,
      bestTime: Number.isFinite(r.bestTime) ? r.bestTime : null,
    };
  }
  return records;
}

function loadSettings() {
  const saved = storage.read(STORAGE_KEYS.settings, {}) || {};
  return {
    difficulty: DIFFICULTIES[saved.difficulty] ? saved.difficulty : 'normal',
    muted: saved.muted === true,
  };
}

/* =========================================================
 * 音效（Web Audio 即時產生，不需要音檔）
 * ======================================================= */
const SOUNDS = {
  // [頻率 Hz, 開始秒數, 長度秒數]
  eat:  [[880, 0, 0.07], [1320, 0.05, 0.06]],
  win:  [[523, 0, 0.12], [659, 0.12, 0.12], [784, 0.24, 0.12], [1047, 0.36, 0.35]],
  lose: [[392, 0, 0.16], [294, 0.16, 0.16], [196, 0.32, 0.4]],
};

const sound = {
  ctx: null,
  muted: false,

  // 瀏覽器規定要在使用者操作後才能啟動音效，所以在按下開始時呼叫
  unlock() {
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      this.ctx = new AudioCtx();
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  },

  play(name) {
    if (this.muted || !this.ctx) return;
    const now = this.ctx.currentTime;
    for (const [freq, start, dur] of SOUNDS[name]) {
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'square';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.06, now + start);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + start + dur);
      osc.connect(gain).connect(this.ctx.destination);
      osc.start(now + start);
      osc.stop(now + start + dur + 0.02);
    }
  },
};

/* =========================================================
 * 遊戲狀態
 * status: 'idle'（尚未開始）| 'running' | 'paused' | 'over'
 * ======================================================= */
const settings = loadSettings();
const records = loadRecords();

const game = {
  status: 'idle',
  difficulty: settings.difficulty,
  snake: [],
  dir: 'right',
  queue: [],      // 尚未執行的轉向（最多 2 個）
  food: null,
  score: 0,
  elapsed: 0,     // 毫秒，暫停時不計
  acc: 0,         // 距離下一步累積的毫秒
  result: null,   // 結算資料
};

sound.muted = settings.muted;

function resetGame() {
  const mid = Math.floor(GRID / 2);
  game.snake = [
    { x: 7, y: mid },
    { x: 6, y: mid },
    { x: 5, y: mid },
  ];
  game.dir = 'right';
  game.queue = [];
  game.score = 0;
  game.elapsed = 0;
  game.acc = 0;
  game.result = null;
  game.food = spawnFood();
}

function spawnFood() {
  const free = [];
  for (let y = 0; y < GRID; y++) {
    for (let x = 0; x < GRID; x++) {
      if (!game.snake.some((s) => s.x === x && s.y === y)) free.push({ x, y });
    }
  }
  return free[Math.floor(Math.random() * free.length)] || null;
}

/* ---------- 狀態轉換 ---------- */
function startOrResume() {
  sound.unlock();
  if (game.status === 'over') resetGame();
  if (game.status === 'running') return;
  game.status = 'running';
  render();
}

function pause() {
  if (game.status !== 'running') return;
  game.status = 'paused';
  render();
}

function togglePause() {
  if (game.status === 'running') pause();
  else startOrResume();
}

function restart() {
  sound.unlock();
  resetGame();
  game.status = 'running';
  render();
}

function endGame(win, reason) {
  game.status = 'over';
  const rec = records[game.difficulty];
  const time = Math.round(game.elapsed);
  let newRecord = false;

  if (game.score > rec.bestScore) {
    rec.bestScore = game.score;
    newRecord = true;
  }
  if (win && (rec.bestTime === null || time < rec.bestTime)) {
    rec.bestTime = time;
    newRecord = true;
  }
  if (newRecord) storage.write(STORAGE_KEYS.records, records);

  game.result = { win, reason, score: game.score, time, newRecord };
  sound.play(win ? 'win' : 'lose');
  render();
}

/* ---------- 每一步 ---------- */
function step() {
  if (game.queue.length) game.dir = game.queue.shift();

  const d = DIRS[game.dir];
  const head = game.snake[0];
  const next = { x: head.x + d.x, y: head.y + d.y };

  if (next.x < 0 || next.x >= GRID || next.y < 0 || next.y >= GRID) {
    endGame(false, 'wall');
    return;
  }

  const eating = game.food && next.x === game.food.x && next.y === game.food.y;
  // 沒吃到東西時尾巴會移走，所以可以走進尾巴原本的位置
  const body = eating ? game.snake : game.snake.slice(0, -1);
  if (body.some((s) => s.x === next.x && s.y === next.y)) {
    endGame(false, 'self');
    return;
  }

  game.snake.unshift(next);
  if (eating) {
    game.score++;
    if (game.score >= TARGET) {
      game.food = null;
      endGame(true, 'clear');
      return;
    }
    sound.play('eat');
    game.food = spawnFood();
  } else {
    game.snake.pop();
  }
}

function queueDirection(dir) {
  const last = game.queue.length ? game.queue[game.queue.length - 1] : game.dir;
  if (dir === last || dir === OPPOSITE[last]) return; // 不能原地回頭
  if (game.queue.length >= MAX_QUEUED_TURNS) return;
  game.queue.push(dir);
}

/* =========================================================
 * 主迴圈
 * ======================================================= */
let lastFrame = performance.now();

function frame(now) {
  // 限制單幀最大時間，避免分頁切回來時一次跳很多步
  const dt = Math.min(now - lastFrame, 100);
  lastFrame = now;

  if (game.status === 'running') {
    game.elapsed += dt;
    game.acc += dt;
    const interval = DIFFICULTIES[game.difficulty].interval;
    while (game.acc >= interval && game.status === 'running') {
      game.acc -= interval;
      step();
    }
    updateHud();
  }

  draw();
  requestAnimationFrame(frame);
}

/* =========================================================
 * 繪圖
 * ======================================================= */
const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');

function setupCanvas() {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = GRID * CELL * dpr;
  canvas.height = GRID * CELL * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, r);
  else ctx.rect(x, y, w, h);
  ctx.fill();
}

function draw() {
  // 棋盤格背景
  for (let y = 0; y < GRID; y++) {
    for (let x = 0; x < GRID; x++) {
      ctx.fillStyle = (x + y) % 2 === 0 ? '#111a30' : '#0e162a';
      ctx.fillRect(x * CELL, y * CELL, CELL, CELL);
    }
  }

  // 食物
  if (game.food) {
    const cx = game.food.x * CELL + CELL / 2;
    const cy = game.food.y * CELL + CELL / 2;
    ctx.fillStyle = '#ef4444';
    ctx.beginPath();
    ctx.arc(cx, cy, CELL * 0.36, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.beginPath();
    ctx.arc(cx - 3, cy - 3, CELL * 0.1, 0, Math.PI * 2);
    ctx.fill();
  }

  // 蛇（尾巴往頭漸亮）
  const n = game.snake.length;
  for (let i = n - 1; i >= 0; i--) {
    const s = game.snake[i];
    const t = n > 1 ? i / (n - 1) : 0;
    const light = Math.round(62 - t * 22); // 頭 62% → 尾 40%
    ctx.fillStyle = `hsl(142, 70%, ${light}%)`;
    const pad = i === 0 ? 1 : 2;
    roundRect(s.x * CELL + pad, s.y * CELL + pad, CELL - pad * 2, CELL - pad * 2, 6);
  }

  // 頭（失敗時變紅）＋眼睛
  if (n) {
    const head = game.snake[0];
    if (game.result && !game.result.win) {
      ctx.fillStyle = '#ef4444';
      roundRect(head.x * CELL + 1, head.y * CELL + 1, CELL - 2, CELL - 2, 6);
    }
    drawEyes(head, game.dir);
  }
}

function drawEyes(head, dir) {
  const d = DIRS[dir];
  const cx = head.x * CELL + CELL / 2;
  const cy = head.y * CELL + CELL / 2;
  const forward = 4;
  const side = 5;
  const eyes = [
    { x: cx + d.x * forward - d.y * side, y: cy + d.y * forward + d.x * side },
    { x: cx + d.x * forward + d.y * side, y: cy + d.y * forward - d.x * side },
  ];
  for (const e of eyes) {
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(e.x, e.y, 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#0f172a';
    ctx.beginPath();
    ctx.arc(e.x + d.x, e.y + d.y, 1.5, 0, Math.PI * 2);
    ctx.fill();
  }
}

/* =========================================================
 * 介面
 * ======================================================= */
const els = {
  score: document.getElementById('score'),
  time: document.getElementById('time'),
  best: document.getElementById('best'),
  overlay: document.getElementById('overlay'),
  startBtn: document.getElementById('start-btn'),
  restartBtn: document.getElementById('restart-btn'),
  clearBtn: document.getElementById('clear-btn'),
  mute: document.getElementById('mute'),
  lockHint: document.getElementById('lock-hint'),
  recordsBody: document.getElementById('records-body'),
  difficultyInputs: document.querySelectorAll('input[name="difficulty"]'),
};

function formatTime(ms) {
  return ms === null ? '—' : `${(ms / 1000).toFixed(1)} 秒`;
}

function updateHud() {
  els.score.textContent = `${game.score} / ${TARGET}`;
  els.time.textContent = formatTime(game.elapsed);
}

function renderBest() {
  els.best.textContent = formatTime(records[game.difficulty].bestTime);
}

function renderRecords() {
  els.recordsBody.innerHTML = Object.entries(DIFFICULTIES)
    .map(([key, d]) => {
      const r = records[key];
      const cls = key === game.difficulty ? ' class="current"' : '';
      return `<tr${cls}><td>${d.label}</td><td>${r.bestScore}</td><td>${formatTime(r.bestTime)}</td></tr>`;
    })
    .join('');
}

function renderOverlay() {
  const o = els.overlay;
  if (game.status === 'running') {
    o.hidden = true;
    return;
  }
  o.hidden = false;

  if (game.status === 'idle') {
    o.innerHTML = `
      <h2>準備好了嗎？</h2>
      <p>按 <kbd>空白鍵</kbd> 或「開始」按鈕開始遊戲</p>
      <p>難度：${DIFFICULTIES[game.difficulty].label}　目標：吃滿 ${TARGET} 個食物</p>`;
    return;
  }

  if (game.status === 'paused') {
    o.innerHTML = `
      <h2>已暫停</h2>
      <p>按 <kbd>空白鍵</kbd> 或「繼續」按鈕繼續遊戲</p>`;
    return;
  }

  // over
  const r = game.result;
  const rec = records[game.difficulty];
  const reasonText = { wall: '撞到牆壁了', self: '撞到自己了', clear: `成功吃滿 ${TARGET} 個食物` }[r.reason];
  o.innerHTML = `
    <h2 class="${r.win ? 'result-win' : 'result-lose'}">${r.win ? '🎉 過關！' : '💀 失敗'}</h2>
    <p>${reasonText}</p>
    ${r.newRecord ? '<span class="new-record">新紀錄！</span>' : ''}
    <div class="stats">
      <div class="stat"><span>分數</span><span>${r.score} / ${TARGET}</span></div>
      <div class="stat"><span>時間</span><span>${formatTime(r.time)}</span></div>
    </div>
    <p>${DIFFICULTIES[game.difficulty].label}難度最佳：最高 ${rec.bestScore} 分・最快過關 ${formatTime(rec.bestTime)}</p>
    <button class="btn primary" type="button" data-action="replay">再玩一次</button>`;
}

function renderControls() {
  const inProgress = game.status === 'running' || game.status === 'paused';
  for (const input of els.difficultyInputs) {
    input.checked = input.value === game.difficulty;
    input.disabled = inProgress;
  }
  els.lockHint.hidden = !inProgress;
  els.clearBtn.disabled = inProgress;
  els.mute.checked = sound.muted;
  els.startBtn.textContent = {
    idle: '開始', running: '暫停', paused: '繼續', over: '再玩一次',
  }[game.status];
}

function render() {
  updateHud();
  renderBest();
  renderRecords();
  renderOverlay();
  renderControls();
}

function saveSettings() {
  storage.write(STORAGE_KEYS.settings, { difficulty: game.difficulty, muted: sound.muted });
}

/* =========================================================
 * 事件
 * ======================================================= */
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return; // 不攔截 Ctrl+R 等瀏覽器快捷鍵

  const dir = KEY_TO_DIR[e.code];
  if (dir) {
    e.preventDefault(); // 避免捲動頁面或切換難度選項
    if (game.status === 'running') queueDirection(dir);
    return;
  }
  if (e.code === 'Space') {
    e.preventDefault(); // 避免觸發目前聚焦的按鈕
    if (!e.repeat) togglePause();
    return;
  }
  if (e.code === 'KeyR') {
    e.preventDefault();
    if (!e.repeat) restart();
  }
});

els.startBtn.addEventListener('click', () => {
  togglePause();
  els.startBtn.blur();
});

els.restartBtn.addEventListener('click', () => {
  restart();
  els.restartBtn.blur();
});

els.overlay.addEventListener('click', (e) => {
  if (e.target.closest('[data-action="replay"]')) restart();
});

for (const input of els.difficultyInputs) {
  input.addEventListener('change', () => {
    if (game.status === 'running' || game.status === 'paused') return;
    game.difficulty = input.value;
    game.status = 'idle';
    resetGame();
    saveSettings();
    render();
    input.blur();
  });
}

els.mute.addEventListener('change', () => {
  sound.muted = els.mute.checked;
  saveSettings();
  els.mute.blur();
});

els.clearBtn.addEventListener('click', () => {
  const label = DIFFICULTIES[game.difficulty].label;
  if (!window.confirm(`確定要清除「${label}」難度的最佳紀錄嗎？`)) return;
  records[game.difficulty] = emptyRecord();
  storage.write(STORAGE_KEYS.records, records);
  render();
});

// 切換分頁或視窗時自動暫停
document.addEventListener('visibilitychange', () => {
  if (document.hidden) pause();
});
window.addEventListener('blur', pause);

/* =========================================================
 * 啟動
 * ======================================================= */
setupCanvas();
resetGame();
render();
requestAnimationFrame(frame);
