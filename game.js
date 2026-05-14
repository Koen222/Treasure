(() => {
  'use strict';

  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  const scoreEl = document.getElementById('score');
  const livesEl = document.getElementById('lives');
  const levelEl = document.getElementById('level');
  const overlay = document.getElementById('overlay');
  const startBtn = document.getElementById('startBtn');

  // Maze legend: # wall, . pellet, o power pellet (cherry), space empty, B bee spawn, P player spawn, - tunnel
  const MAZE = [
    '#####################',
    '#.........#.........#',
    '#o###.###.#.###.###o#',
    '#.#...............#.#',
    '#.#.###.###.###.#.#.#',
    '#.....#..B#B..#.....#',
    '#.###.###.#.###.###.#',
    '#.#.....#.#.#.....#.#',
    '-...###.#.#.#.###...-',
    '#.#.....#.#.#.....#.#',
    '#.###.###B#B###.###.#',
    '#.........#.........#',
    '#.###.###.#.###.###.#',
    '#o..#.....P.....#..o#',
    '###.#.#.#####.#.#.###',
    '#.....#...#...#.....#',
    '#.#######.#.#######.#',
    '#...................#',
    '#####################',
  ];

  const ROWS = MAZE.length;
  const COLS = MAZE[0].length;

  let CELL = 22; // computed on resize
  let grid;     // 2D char array, mutable (pellets get removed)
  let pelletsLeft = 0;

  // Entities
  let player;
  let bees;
  let score = 0;
  let lives = 3;
  let level = 1;
  let running = false;
  let powerTimer = 0; // ms, when > 0 bees are scared
  let messageTimer = 0;
  let messageText = '';

  const DIRS = {
    up:    { x:  0, y: -1 },
    down:  { x:  0, y:  1 },
    left:  { x: -1, y:  0 },
    right: { x:  1, y:  0 },
    none:  { x:  0, y:  0 },
  };

  function resize() {
    const stage = document.getElementById('stage');
    const sw = stage.clientWidth - 20;
    const sh = stage.clientHeight - 20;
    const cellW = Math.floor(sw / COLS);
    const cellH = Math.floor(sh / ROWS);
    CELL = Math.max(10, Math.min(cellW, cellH));
    canvas.width = CELL * COLS;
    canvas.height = CELL * ROWS;
    canvas.style.width = canvas.width + 'px';
    canvas.style.height = canvas.height + 'px';
  }

  function resetGrid() {
    grid = MAZE.map(row => row.split(''));
    pelletsLeft = 0;
    for (let y = 0; y < ROWS; y++) {
      for (let x = 0; x < COLS; x++) {
        if (grid[y][x] === '.' || grid[y][x] === 'o') pelletsLeft++;
      }
    }
  }

  function isWall(x, y) {
    if (y < 0 || y >= ROWS) return true;
    if (x < 0 || x >= COLS) return false; // allow tunneling off the edges where there's no row wall
    return grid[y][x] === '#';
  }

  function tunnelWrap(x, y) {
    // The row marked with '-' chars supports horizontal wrap
    if (y >= 0 && y < ROWS && grid[y] && grid[y][0] === '-') {
      if (x < 0) return { x: COLS - 1, y };
      if (x >= COLS) return { x: 0, y };
    }
    return { x, y };
  }

  function findSpawns() {
    let p = null;
    const bs = [];
    for (let y = 0; y < ROWS; y++) {
      for (let x = 0; x < COLS; x++) {
        if (grid[y][x] === 'P') { p = { x, y }; grid[y][x] = '.'; pelletsLeft++; }
        if (grid[y][x] === 'B') { bs.push({ x, y }); grid[y][x] = ' '; }
      }
    }
    return { player: p || { x: 10, y: 13 }, bees: bs };
  }

  function resetEntities() {
    resetGrid();
    const { player: ps, bees: bs } = findSpawns();
    player = {
      gx: ps.x, gy: ps.y,
      px: ps.x * CELL + CELL / 2,
      py: ps.y * CELL + CELL / 2,
      dir: 'left',
      queuedDir: 'left',
      speed: 3.2,
      mouthPhase: 0,
      tilt: 0,
    };
    const beeColors = ['#ff5252', '#ff9f43', '#54a0ff', '#ff6b9d'];
    bees = bs.length ? bs.map((b, i) => makeBee(b.x, b.y, beeColors[i % beeColors.length], i)) : [
      makeBee(10, 8, beeColors[0], 0),
      makeBee(9, 9, beeColors[1], 1),
      makeBee(11, 9, beeColors[2], 2),
      makeBee(10, 9, beeColors[3], 3),
    ];
  }

  function makeBee(gx, gy, color, idx) {
    return {
      gx, gy,
      px: gx * CELL + CELL / 2,
      py: gy * CELL + CELL / 2,
      home: { x: gx, y: gy },
      dir: ['up','down','left','right'][idx % 4],
      color,
      speed: 2.4 + Math.min(level - 1, 4) * 0.18,
      scared: false,
      eaten: false,
      wingPhase: Math.random() * Math.PI * 2,
      releaseDelay: idx * 800,
      released: false,
      releasedAt: 0,
    };
  }

  function setMessage(text, ms = 1200) {
    messageText = text;
    messageTimer = ms;
  }

  // ---- Input ----
  let queuedInput = null;

  function setDir(dir) {
    if (!player) return;
    player.queuedDir = dir;
    // If reversal, allow immediate
    if ((player.dir === 'left' && dir === 'right') ||
        (player.dir === 'right' && dir === 'left') ||
        (player.dir === 'up' && dir === 'down') ||
        (player.dir === 'down' && dir === 'up')) {
      player.dir = dir;
    }
  }

  // Swipe
  let touchStart = null;
  canvas.addEventListener('touchstart', (e) => {
    const t = e.changedTouches[0];
    touchStart = { x: t.clientX, y: t.clientY };
  }, { passive: true });
  canvas.addEventListener('touchend', (e) => {
    if (!touchStart) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - touchStart.x;
    const dy = t.clientY - touchStart.y;
    if (Math.abs(dx) < 16 && Math.abs(dy) < 16) { touchStart = null; return; }
    if (Math.abs(dx) > Math.abs(dy)) setDir(dx > 0 ? 'right' : 'left');
    else setDir(dy > 0 ? 'down' : 'up');
    touchStart = null;
  }, { passive: true });

  // D-pad
  document.querySelectorAll('.dpad').forEach(btn => {
    const dir = btn.dataset.dir;
    const press = (e) => { e.preventDefault(); setDir(dir); btn.classList.add('active'); };
    const release = () => btn.classList.remove('active');
    btn.addEventListener('touchstart', press, { passive: false });
    btn.addEventListener('touchend', release);
    btn.addEventListener('mousedown', press);
    btn.addEventListener('mouseup', release);
    btn.addEventListener('mouseleave', release);
  });

  // Keyboard
  window.addEventListener('keydown', (e) => {
    const map = { ArrowUp:'up', ArrowDown:'down', ArrowLeft:'left', ArrowRight:'right', w:'up', s:'down', a:'left', d:'right' };
    const dir = map[e.key];
    if (dir) { setDir(dir); e.preventDefault(); }
  });

  // ---- Movement helpers ----
  function isCentered(entity) {
    const cx = entity.gx * CELL + CELL / 2;
    const cy = entity.gy * CELL + CELL / 2;
    const tol = Math.max(2, entity.speed * 1.1);
    return Math.abs(entity.px - cx) < tol && Math.abs(entity.py - cy) < tol;
  }

  function snapToCenter(entity) {
    entity.px = entity.gx * CELL + CELL / 2;
    entity.py = entity.gy * CELL + CELL / 2;
  }

  function canMove(gx, gy, dir) {
    const d = DIRS[dir];
    const nx = gx + d.x;
    const ny = gy + d.y;
    const w = tunnelWrap(nx, ny);
    return !isWall(w.x, w.y);
  }

  function stepEntity(entity, dt) {
    const d = DIRS[entity.dir];
    entity.px += d.x * entity.speed * dt * 60 / 16.67;
    entity.py += d.y * entity.speed * dt * 60 / 16.67;
    // Update grid coords when crossing center
    const gx = Math.floor(entity.px / CELL);
    const gy = Math.floor(entity.py / CELL);
    // Wrap tunnels
    if (entity.px < -CELL/2) entity.px = canvas.width + CELL/2 - 1;
    if (entity.px > canvas.width + CELL/2) entity.px = -CELL/2 + 1;
    entity.gx = Math.max(0, Math.min(COLS - 1, gx));
    entity.gy = Math.max(0, Math.min(ROWS - 1, gy));
  }

  function updatePlayer(dt) {
    // At cell centers, try queued direction
    if (isCentered(player)) {
      snapToCenter(player);
      if (player.queuedDir && player.queuedDir !== player.dir && canMove(player.gx, player.gy, player.queuedDir)) {
        player.dir = player.queuedDir;
      }
      // If can't move in current dir, stop at center
      if (!canMove(player.gx, player.gy, player.dir)) {
        return;
      }
    }
    stepEntity(player, dt);

    // Eat pellets
    const c = grid[player.gy] && grid[player.gy][player.gx];
    if (c === '.') {
      grid[player.gy][player.gx] = ' ';
      pelletsLeft--;
      score += 10;
    } else if (c === 'o') {
      grid[player.gy][player.gx] = ' ';
      pelletsLeft--;
      score += 50;
      powerTimer = 6000;
      bees.forEach(b => { if (!b.eaten) b.scared = true; });
      setMessage('Power Whip!');
    }

    player.mouthPhase += dt * 0.012;
    scoreEl.textContent = score;

    if (pelletsLeft <= 0) nextLevel();
  }

  function chooseBeeDir(bee) {
    // At intersections pick a direction; greedy toward/away from player
    const options = ['up','down','left','right'].filter(d => {
      const opp = { up:'down', down:'up', left:'right', right:'left' };
      if (d === opp[bee.dir]) return false; // no reversing
      return canMove(bee.gx, bee.gy, d);
    });
    if (options.length === 0) {
      // Forced reverse
      const opp = { up:'down', down:'up', left:'right', right:'left' };
      return opp[bee.dir];
    }
    // Score each option by distance to player
    let best = options[0];
    let bestScore = bee.scared ? -Infinity : Infinity;
    for (const d of options) {
      const dv = DIRS[d];
      const nx = bee.gx + dv.x;
      const ny = bee.gy + dv.y;
      const dx = nx - player.gx;
      const dy = ny - player.gy;
      const dist = Math.hypot(dx, dy);
      if (bee.scared) {
        if (dist > bestScore) { bestScore = dist; best = d; }
      } else {
        // 80% greedy chase, 20% random for variety
        const noise = Math.random() * 1.2;
        const s = dist + noise;
        if (s < bestScore) { bestScore = s; best = d; }
      }
    }
    return best;
  }

  function updateBees(dt, now) {
    powerTimer = Math.max(0, powerTimer - dt);
    for (const bee of bees) {
      if (!bee.released) {
        if (now - bee.releasedAt >= bee.releaseDelay) {
          bee.released = true;
        } else {
          // hover in place
          bee.wingPhase += dt * 0.02;
          continue;
        }
      }
      if (powerTimer === 0) bee.scared = false;
      if (bee.eaten) {
        // return to home
        const dx = bee.home.x - bee.gx;
        const dy = bee.home.y - bee.gy;
        if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) {
          bee.eaten = false;
          bee.scared = false;
          snapToCenter(bee);
        } else {
          // simple teleport-glide to home
          bee.px += Math.sign(bee.home.x * CELL + CELL/2 - bee.px) * (bee.speed + 2) * dt * 60 / 16.67;
          bee.py += Math.sign(bee.home.y * CELL + CELL/2 - bee.py) * (bee.speed + 2) * dt * 60 / 16.67;
          bee.gx = Math.floor(bee.px / CELL);
          bee.gy = Math.floor(bee.py / CELL);
        }
        bee.wingPhase += dt * 0.04;
        continue;
      }
      if (isCentered(bee)) {
        snapToCenter(bee);
        bee.dir = chooseBeeDir(bee);
      }
      const oldSpeed = bee.speed;
      bee.speed = bee.scared ? Math.max(1.4, oldSpeed * 0.55) : oldSpeed;
      stepEntity(bee, dt);
      bee.speed = oldSpeed;
      bee.wingPhase += dt * 0.04;
    }
  }

  function checkCollisions() {
    for (const bee of bees) {
      if (bee.eaten || !bee.released) continue;
      const dx = bee.px - player.px;
      const dy = bee.py - player.py;
      if (Math.hypot(dx, dy) < CELL * 0.55) {
        if (bee.scared) {
          bee.eaten = true;
          bee.scared = false;
          score += 200;
          scoreEl.textContent = score;
          setMessage('+200');
        } else {
          loseLife();
          return;
        }
      }
    }
  }

  function loseLife() {
    lives--;
    livesEl.textContent = lives;
    if (lives <= 0) {
      gameOver();
      return;
    }
    setMessage('Ouch!');
    // Read spawn positions from the original maze so we don't depend on grid state
    let playerHome = { x: 10, y: 13 };
    const beeHomes = [];
    for (let y = 0; y < ROWS; y++) {
      for (let x = 0; x < COLS; x++) {
        if (MAZE[y][x] === 'P') playerHome = { x, y };
        if (MAZE[y][x] === 'B') beeHomes.push({ x, y });
      }
    }
    player.gx = playerHome.x; player.gy = playerHome.y;
    snapToCenter(player);
    player.dir = 'left'; player.queuedDir = 'left';
    const now = performance.now();
    for (let i = 0; i < bees.length; i++) {
      const home = beeHomes[i % Math.max(1, beeHomes.length)] || { x: 10, y: 8 };
      bees[i].gx = home.x; bees[i].gy = home.y;
      bees[i].home = { x: home.x, y: home.y };
      snapToCenter(bees[i]);
      bees[i].released = false;
      bees[i].releasedAt = now;
      bees[i].scared = false;
      bees[i].eaten = false;
    }
  }

  function nextLevel() {
    level++;
    levelEl.textContent = level;
    setMessage('Level ' + level + '!', 1600);
    resetEntities();
    // Speed up bees
    bees.forEach(b => b.speed = Math.min(3.6, b.speed + 0.15));
  }

  function gameOver() {
    running = false;
    overlay.querySelector('h1').innerHTML = 'Game Over';
    overlay.querySelector('.tag').innerHTML = 'Final score: <b>' + score + '</b><br/>You reached level ' + level + '.';
    startBtn.textContent = 'Try Again';
    overlay.classList.add('show');
  }

  // ---- Rendering ----
  function drawMaze() {
    for (let y = 0; y < ROWS; y++) {
      for (let x = 0; x < COLS; x++) {
        const c = grid[y][x];
        const px = x * CELL;
        const py = y * CELL;
        if (c === '#') {
          drawWall(px, py, x, y);
        } else if (c === '-') {
          // tunnel floor — slightly darker
          ctx.fillStyle = '#e3b87f';
          ctx.fillRect(px, py, CELL, CELL);
        } else if (c === '.') {
          drawPellet(px + CELL/2, py + CELL/2);
        } else if (c === 'o') {
          drawCherry(px + CELL/2, py + CELL/2);
        }
      }
    }
  }

  function drawWall(px, py, gx, gy) {
    const r = Math.max(3, CELL * 0.25);
    ctx.fillStyle = '#6b4226';
    // rounded tile look
    ctx.beginPath();
    roundRect(ctx, px + 2, py + 2, CELL - 4, CELL - 4, r);
    ctx.fill();
    // Wood grain
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(px + 4, py + CELL/2);
    ctx.bezierCurveTo(px + CELL/3, py + CELL/3, px + 2*CELL/3, py + 2*CELL/3, px + CELL - 4, py + CELL/2);
    ctx.stroke();
  }

  function roundRect(ctx, x, y, w, h, r) {
    r = Math.min(r, w/2, h/2);
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  // Variety of foodies as pellets
  function drawPellet(cx, cy) {
    const r = Math.max(2, CELL * 0.12);
    ctx.save();
    ctx.translate(cx, cy);
    // little sprinkle / crumb
    const hash = (Math.floor(cx) * 73856093) ^ (Math.floor(cy) * 19349663);
    const kind = Math.abs(hash) % 5;
    const colors = ['#ff6b6b', '#ffd23f', '#7fdc8e', '#f4a261', '#a78bfa'];
    ctx.fillStyle = colors[kind];
    if (kind === 0) {
      // strawberry dot
      ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI*2); ctx.fill();
    } else if (kind === 1) {
      // cheese square
      ctx.fillRect(-r, -r, r*2, r*2);
    } else if (kind === 2) {
      // pea
      ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI*2); ctx.fill();
    } else if (kind === 3) {
      // crouton
      ctx.fillRect(-r*1.1, -r*0.7, r*2.2, r*1.4);
    } else {
      // candy
      ctx.beginPath(); ctx.ellipse(0, 0, r*1.2, r*0.7, Math.PI/4, 0, Math.PI*2); ctx.fill();
    }
    ctx.restore();
  }

  function drawCherry(cx, cy) {
    const r = Math.max(4, CELL * 0.28);
    ctx.save();
    ctx.translate(cx, cy);
    // glow
    ctx.fillStyle = 'rgba(255, 107, 107, 0.35)';
    ctx.beginPath(); ctx.arc(0, 0, r * 1.7, 0, Math.PI*2); ctx.fill();
    // body
    ctx.fillStyle = '#e63946';
    ctx.beginPath(); ctx.arc(-r*0.35, r*0.2, r*0.7, 0, Math.PI*2); ctx.fill();
    ctx.beginPath(); ctx.arc(r*0.45, r*0.25, r*0.7, 0, Math.PI*2); ctx.fill();
    // stems
    ctx.strokeStyle = '#2d6a4f';
    ctx.lineWidth = Math.max(1, r*0.18);
    ctx.beginPath();
    ctx.moveTo(-r*0.35, -r*0.4); ctx.quadraticCurveTo(0, -r*1.0, r*0.45, -r*0.4);
    ctx.stroke();
    ctx.restore();
  }

  function drawKitchenAid() {
    const cx = player.px, cy = player.py;
    const s = CELL * 0.95;
    const dir = DIRS[player.dir];
    // Smooth tilt based on direction
    const targetTilt = dir.x * 0.18;
    player.tilt += (targetTilt - player.tilt) * 0.2;

    ctx.save();
    ctx.translate(cx, cy);
    if (player.dir === 'left') ctx.scale(-1, 1);
    ctx.rotate(player.tilt);

    // Shadow
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.beginPath();
    ctx.ellipse(2, s*0.45, s*0.5, s*0.1, 0, 0, Math.PI*2);
    ctx.fill();

    // Base
    ctx.fillStyle = '#d62828';
    roundedShape(-s*0.45, s*0.1, s*0.9, s*0.32, s*0.08);
    ctx.fill();
    // Base highlight
    ctx.fillStyle = 'rgba(255,255,255,0.18)';
    ctx.fillRect(-s*0.42, s*0.12, s*0.84, s*0.05);

    // Motor housing (arched top)
    ctx.fillStyle = '#e63946';
    ctx.beginPath();
    ctx.moveTo(-s*0.4, s*0.1);
    ctx.lineTo(-s*0.4, -s*0.05);
    ctx.quadraticCurveTo(-s*0.4, -s*0.42, -s*0.05, -s*0.42);
    ctx.lineTo(s*0.2, -s*0.42);
    ctx.quadraticCurveTo(s*0.45, -s*0.42, s*0.45, -s*0.18);
    ctx.lineTo(s*0.45, s*0.1);
    ctx.closePath();
    ctx.fill();

    // Logo plate
    ctx.fillStyle = '#fff';
    roundedShape(-s*0.2, -s*0.25, s*0.4, s*0.12, s*0.04);
    ctx.fill();
    ctx.fillStyle = '#d62828';
    ctx.font = `900 ${Math.floor(s*0.09)}px -apple-system, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('KitchenAid', 0, -s*0.19);

    // Mixing head (the arm extending forward/down)
    ctx.fillStyle = '#c1121f';
    ctx.beginPath();
    ctx.moveTo(s*0.2, -s*0.05);
    ctx.lineTo(s*0.5, -s*0.05);
    ctx.lineTo(s*0.5, s*0.1);
    ctx.lineTo(s*0.2, s*0.1);
    ctx.closePath();
    ctx.fill();

    // Whisk (animated rotation as it slides)
    const whiskY = s*0.18;
    const whiskX = s*0.35;
    ctx.save();
    ctx.translate(whiskX, whiskY);
    ctx.rotate(player.mouthPhase * 4);
    ctx.strokeStyle = '#cbd5e1';
    ctx.lineWidth = Math.max(1, s*0.025);
    for (let i = 0; i < 4; i++) {
      ctx.beginPath();
      ctx.ellipse(0, s*0.05, s*0.06, s*0.12, (i * Math.PI) / 4, 0, Math.PI*2);
      ctx.stroke();
    }
    // whisk shaft
    ctx.fillStyle = '#94a3b8';
    ctx.fillRect(-s*0.015, -s*0.08, s*0.03, s*0.1);
    ctx.restore();

    // Bowl
    ctx.fillStyle = '#e2e8f0';
    ctx.beginPath();
    ctx.moveTo(-s*0.3, s*0.18);
    ctx.lineTo(s*0.2, s*0.18);
    ctx.lineTo(s*0.12, s*0.42);
    ctx.lineTo(-s*0.22, s*0.42);
    ctx.closePath();
    ctx.fill();
    // Bowl rim
    ctx.fillStyle = '#cbd5e1';
    ctx.fillRect(-s*0.3, s*0.16, s*0.5, s*0.04);

    // Mouth (open/close as it slides for that Pac-Man feel)
    const mouth = (Math.sin(player.mouthPhase * 8) + 1) * 0.5;
    if (mouth > 0.4) {
      ctx.fillStyle = '#1a0900';
      ctx.beginPath();
      ctx.moveTo(s*0.45, -s*0.05);
      ctx.lineTo(s*0.55, -s*0.05 - mouth * s*0.12);
      ctx.lineTo(s*0.55, s*0.1 + mouth * s*0.12);
      ctx.lineTo(s*0.45, s*0.1);
      ctx.closePath();
      ctx.fill();
    }

    ctx.restore();
  }

  function roundedShape(x, y, w, h, r) {
    ctx.beginPath();
    roundRect(ctx, x, y, w, h, r);
  }

  function drawBee(bee) {
    const cx = bee.px, cy = bee.py;
    const s = CELL * 0.85;
    ctx.save();
    ctx.translate(cx, cy);
    // Bobbing
    const bob = Math.sin(bee.wingPhase * 2) * s * 0.06;
    ctx.translate(0, bob);

    // Shadow
    ctx.fillStyle = 'rgba(0,0,0,0.2)';
    ctx.beginPath(); ctx.ellipse(0, s*0.45 - bob, s*0.35, s*0.08, 0, 0, Math.PI*2); ctx.fill();

    if (bee.eaten) {
      // ghost eyes only
      ctx.fillStyle = '#fff';
      ctx.beginPath(); ctx.arc(-s*0.12, 0, s*0.08, 0, Math.PI*2); ctx.fill();
      ctx.beginPath(); ctx.arc(s*0.12, 0, s*0.08, 0, Math.PI*2); ctx.fill();
      ctx.fillStyle = '#000';
      ctx.beginPath(); ctx.arc(-s*0.1, 0, s*0.03, 0, Math.PI*2); ctx.fill();
      ctx.beginPath(); ctx.arc(s*0.14, 0, s*0.03, 0, Math.PI*2); ctx.fill();
      ctx.restore();
      return;
    }

    // Wings (transparent, flapping)
    const flap = Math.abs(Math.sin(bee.wingPhase * 6));
    ctx.fillStyle = 'rgba(220, 240, 255, 0.75)';
    ctx.beginPath();
    ctx.ellipse(-s*0.18, -s*0.25, s*0.18, s*0.1 + flap * s*0.05, -0.5, 0, Math.PI*2);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(s*0.18, -s*0.25, s*0.18, s*0.1 + flap * s*0.05, 0.5, 0, Math.PI*2);
    ctx.fill();

    // Body (oval)
    const bodyColor = bee.scared ? '#3a7bd5' : '#ffd23f';
    ctx.fillStyle = bodyColor;
    ctx.beginPath();
    ctx.ellipse(0, 0, s*0.32, s*0.26, 0, 0, Math.PI*2);
    ctx.fill();

    // Stripes
    if (!bee.scared) {
      ctx.fillStyle = '#1a1a1a';
      ctx.save();
      ctx.beginPath(); ctx.ellipse(0, 0, s*0.32, s*0.26, 0, 0, Math.PI*2); ctx.clip();
      ctx.fillRect(-s*0.32, -s*0.05, s*0.64, s*0.08);
      ctx.fillRect(-s*0.32, s*0.12, s*0.64, s*0.08);
      ctx.restore();
    } else {
      // scared face mouth
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = Math.max(1, s*0.03);
      ctx.beginPath();
      const wob = Math.sin(bee.wingPhase * 8);
      for (let i = 0; i < 5; i++) {
        const x = -s*0.15 + (s*0.3) * (i/4);
        const y = s*0.1 + (i % 2 === 0 ? wob*s*0.02 : -wob*s*0.02);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }

    // Eyes
    if (!bee.scared) {
      ctx.fillStyle = '#fff';
      ctx.beginPath(); ctx.arc(-s*0.1, -s*0.05, s*0.07, 0, Math.PI*2); ctx.fill();
      ctx.beginPath(); ctx.arc(s*0.12, -s*0.05, s*0.07, 0, Math.PI*2); ctx.fill();
      ctx.fillStyle = '#000';
      const ex = DIRS[bee.dir].x * s*0.02;
      const ey = DIRS[bee.dir].y * s*0.02;
      ctx.beginPath(); ctx.arc(-s*0.1 + ex, -s*0.05 + ey, s*0.03, 0, Math.PI*2); ctx.fill();
      ctx.beginPath(); ctx.arc(s*0.12 + ex, -s*0.05 + ey, s*0.03, 0, Math.PI*2); ctx.fill();
    } else {
      ctx.fillStyle = '#fff';
      ctx.beginPath(); ctx.arc(-s*0.1, -s*0.05, s*0.05, 0, Math.PI*2); ctx.fill();
      ctx.beginPath(); ctx.arc(s*0.12, -s*0.05, s*0.05, 0, Math.PI*2); ctx.fill();
    }

    // Stinger
    if (!bee.scared) {
      ctx.fillStyle = '#1a1a1a';
      ctx.beginPath();
      ctx.moveTo(s*0.3, 0);
      ctx.lineTo(s*0.42, -s*0.04);
      ctx.lineTo(s*0.42, s*0.04);
      ctx.closePath();
      ctx.fill();
    }

    ctx.restore();
  }

  function drawMessage() {
    if (messageTimer <= 0 || !messageText) return;
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const alpha = Math.min(1, messageTimer / 500);
    ctx.fillStyle = `rgba(43, 29, 18, ${0.8 * alpha})`;
    const w = canvas.width * 0.7;
    const h = CELL * 1.6;
    roundRect(ctx, (canvas.width - w)/2, canvas.height/2 - h/2, w, h, 12);
    ctx.fill();
    ctx.fillStyle = `rgba(255, 233, 198, ${alpha})`;
    ctx.font = `900 ${Math.floor(CELL * 0.9)}px -apple-system, sans-serif`;
    ctx.fillText(messageText, canvas.width/2, canvas.height/2);
    ctx.restore();
  }

  function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    // counter background pattern
    drawMaze();
    drawKitchenAid();
    for (const bee of bees) drawBee(bee);
    drawMessage();
  }

  // ---- Loop ----
  let lastTime = 0;
  function loop(t) {
    const dt = Math.min(50, t - lastTime);
    lastTime = t;
    if (running) {
      updatePlayer(dt);
      updateBees(dt, t);
      checkCollisions();
      if (messageTimer > 0) messageTimer -= dt;
    }
    draw();
    requestAnimationFrame(loop);
  }

  function startGame() {
    score = 0; lives = 3; level = 1;
    scoreEl.textContent = score;
    livesEl.textContent = lives;
    levelEl.textContent = level;
    resetEntities();
    bees.forEach(b => b.releasedAt = performance.now());
    powerTimer = 0;
    overlay.classList.remove('show');
    running = true;
  }

  startBtn.addEventListener('click', startGame);
  window.addEventListener('resize', () => {
    resize();
    if (player) {
      snapToCenter(player);
      bees.forEach(snapToCenter);
    }
  });

  resize();
  resetEntities();
  draw();
  requestAnimationFrame(loop);
})();
