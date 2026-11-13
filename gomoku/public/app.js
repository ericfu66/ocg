'use strict';
/* 五子棋人机对弈 —— 前端逻辑
 * 坐标约定与 Rapfi 引擎一致：x 为列（A..），y 为行（1 在最下方，内部 y=0）。
 */
(() => {
  const $ = (id) => document.getElementById(id);
  const BLACK = 1, WHITE = 2;

  const RULE_DESC = {
    freestyle: '自由规则：五连或更长的连线均获胜，黑白双方无限制。',
    standard: '标准规则：必须恰好五连才算获胜，长连（六子及以上）不算赢。',
    renju: '连珠规则：黑方禁止三三、四四、长连（禁手），白方无限制。执黑时禁手点会以 × 标出。',
  };
  const FALLBACK_LEVELS = [
    { id: 1, name: '新手', desc: '' }, { id: 2, name: '入门', desc: '' }, { id: 3, name: '业余', desc: '' },
    { id: 4, name: '高手', desc: '' }, { id: 5, name: '大师', desc: '' }, { id: 6, name: '宗师', desc: '' },
  ];

  // ------------------------------------------------------------ 状态
  const load = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (_) { return d; } };
  const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) {} };

  const isTouch = matchMedia('(pointer: coarse)').matches;
  const settings = Object.assign({ rule: 'freestyle', size: 15, color: 'black', level: 3 }, load('gomoku.settings', {}));
  const opts = Object.assign({ numbers: false, sound: true, confirm: isTouch }, load('gomoku.opts', {}));
  let levels = FALLBACK_LEVELS;
  let sizes = { freestyle: [15, 19, 20], standard: [15], renju: [15] };

  const game = {
    rule: settings.rule, size: settings.size, humanColor: settings.color === 'black' ? BLACK : WHITE, level: settings.level,
    moves: [], grid: [], over: false, winLine: null, forbids: [], hint: null, pending: null,
  };
  let reqSeq = 0;
  let thinking = null; // { id, kind: 'ai' | 'hint', start, timeMs }
  let hover = null;
  let confirmPt = null;

  // ------------------------------------------------------------ 网络
  let ws = null, wsReady = false, retry = 0;
  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws`);
    setConn('wait', '连接中…');
    ws.onopen = () => {
      wsReady = true; retry = 0; setConn('ok', '已连接');
      // 断线重连后重新发出未完成的请求
      if (thinking) sendThink(thinking.kind === 'hint');
      else if (game.rule === 'renju' && isHumanTurn()) requestForbids();
      else maybeAI();
    };
    ws.onclose = () => {
      wsReady = false; setConn('bad', '已断开，重连中…');
      setTimeout(connect, Math.min(1000 * 2 ** retry++, 10000));
    };
    ws.onerror = () => {};
    ws.onmessage = (ev) => { let m; try { m = JSON.parse(ev.data); } catch (_) { return; } onMessage(m); };
  }
  function setConn(cls, text) { $('conn').className = 'conn ' + cls; $('conn').querySelector('span').textContent = text; }
  function wsSend(obj) { if (wsReady) ws.send(JSON.stringify(obj)); }

  function onMessage(m) {
    if (m.type === 'forbid') {
      if (m.id !== game.forbidReq) return;
      game.forbids = m.points; draw(); return;
    }
    if (!thinking || m.id !== thinking.id) return;
    switch (m.type) {
      case 'queued': setTurnText(`服务器繁忙，排队中（第 ${m.position} 位）…`); break;
      case 'start': thinking.start = performance.now(); setTurnText(thinking.kind === 'hint' ? '正在计算提示…' : 'AI 思考中…'); break;
      case 'info': showInfo(m, thinking.kind === 'hint' ? game.humanColor : aiColor()); break;
      case 'move': {
        const t = thinking; thinking = null; setThinking(false);
        if (m.final) showInfo(m.final, t.kind === 'hint' ? game.humanColor : aiColor());
        if (t.kind === 'hint') { game.hint = [m.x, m.y]; draw(); updateTurn(); toast(`提示：${coordName(m.x, m.y)}`); }
        else { place(m.x, m.y); }
        break;
      }
      case 'error': thinking = null; setThinking(false); updateTurn(); toast(m.message || '出错了'); break;
    }
  }

  // ------------------------------------------------------------ 对局逻辑
  const colorAt = (i) => (i % 2 === 0 ? BLACK : WHITE);
  const toMove = () => colorAt(game.moves.length);
  const aiColor = () => (game.humanColor === BLACK ? WHITE : BLACK);
  const isHumanTurn = () => !game.over && toMove() === game.humanColor;
  const coordName = (x, y) => String.fromCharCode(65 + x) + (y + 1);

  function newGame() {
    cancelThinking();
    game.rule = settings.rule; game.size = settings.size; game.level = settings.level;
    game.humanColor = settings.color === 'black' ? BLACK : WHITE;
    game.moves = []; game.over = false; game.winLine = null; game.forbids = []; game.hint = null;
    game.grid = Array.from({ length: game.size }, () => new Array(game.size).fill(0));
    game.counted = false;
    confirmPt = null;
    $('overlay').classList.add('hidden');
    $('pendingNote').classList.add('hidden');
    resetInfo();
    resize();
    renderMoves(); updateTurn();
    maybeAI();
  }

  function maybeAI() {
    if (!game.over && !thinking && toMove() === aiColor() && wsReady) {
      thinking = { id: ++reqSeq, kind: 'ai', start: performance.now(), timeMs: levelTime() };
      setThinking(true); sendThink(false);
    }
  }
  function levelTime() { const l = levels.find((v) => v.id === game.level); return l && l.timeMs ? l.timeMs : 3000; }

  function sendThink(hint) {
    wsSend({ type: 'think', id: thinking.id, rule: game.rule, size: game.size, level: game.level, hint, moves: game.moves });
  }

  function cancelThinking() {
    if (thinking) { wsSend({ type: 'cancel' }); thinking = null; setThinking(false); }
  }

  function requestForbids() {
    game.forbids = [];
    if (game.rule !== 'renju' || game.over || toMove() !== BLACK || game.humanColor !== BLACK) return;
    game.forbidReq = ++reqSeq;
    wsSend({ type: 'forbid', id: game.forbidReq, size: game.size, moves: game.moves });
  }

  function place(x, y) {
    const c = toMove();
    game.grid[y][x] = c;
    game.moves.push([x, y]);
    game.hint = null; confirmPt = null; game.forbids = [];
    playSound();
    const win = checkWin(x, y, c);
    if (win) { game.winLine = win; endGame(c === game.humanColor ? 'win' : 'lose'); }
    else if (game.moves.length >= game.size * game.size) endGame('draw');
    renderMoves(); updateTurn(); draw();
    if (!game.over) {
      if (toMove() === aiColor()) maybeAI();
      else requestForbids();
    }
  }

  function humanPlay(x, y) {
    if (!isHumanTurn() || thinking || game.grid[y][x]) return;
    if (game.forbids.some(([fx, fy]) => fx === x && fy === y)) { toast('这里是禁手点，黑方不能落子'); return; }
    if (opts.confirm && !(confirmPt && confirmPt[0] === x && confirmPt[1] === y)) { confirmPt = [x, y]; draw(); return; }
    place(x, y);
  }

  function lineCount(x, y, dx, dy, c) {
    let n = 0; x += dx; y += dy;
    while (x >= 0 && y >= 0 && x < game.size && y < game.size && game.grid[y][x] === c) { n++; x += dx; y += dy; }
    return n;
  }
  function checkWin(x, y, c) {
    for (const [dx, dy] of [[1, 0], [0, 1], [1, 1], [1, -1]]) {
      const a = lineCount(x, y, dx, dy, c), b = lineCount(x, y, -dx, -dy, c), len = a + b + 1;
      let ok;
      if (game.rule === 'freestyle') ok = len >= 5;
      else if (game.rule === 'standard') ok = len === 5;
      else ok = c === BLACK ? len === 5 : len >= 5;
      if (ok) return [[x - dx * b, y - dy * b], [x + dx * a, y + dy * a]];
    }
    return null;
  }

  function endGame(result, why) {
    game.over = true; cancelThinking(); game.forbids = [];
    const lv = levels.find((l) => l.id === game.level) || { name: '' };
    if (!game.counted) {
      game.counted = true;
      const rec = load('gomoku.record', {});
      const r = rec[game.level] || { w: 0, l: 0, d: 0 };
      r[result === 'win' ? 'w' : result === 'lose' ? 'l' : 'd']++;
      rec[game.level] = r; save('gomoku.record', rec); renderRecord();
    }
    const title = { win: '你赢了！', lose: 'AI 获胜', draw: '和棋' }[result];
    $('resultTitle').textContent = title;
    $('resultSub').textContent = why || `难度「${lv.name}」· 共 ${game.moves.length} 手`;
    setTimeout(() => $('overlay').classList.remove('hidden'), result === 'resign' ? 0 : 450);
  }

  function undo() {
    if (game.moves.length === 0) return;
    if (game.over) { game.over = false; game.winLine = null; $('overlay').classList.add('hidden'); }
    if (thinking && thinking.kind === 'ai') cancelThinking();
    else cancelThinking();
    // 退回到轮到玩家落子的位置
    do {
      const [x, y] = game.moves.pop(); game.grid[y][x] = 0;
    } while (game.moves.length && toMove() !== game.humanColor);
    game.hint = null; confirmPt = null;
    renderMoves(); updateTurn(); draw();
    if (toMove() === aiColor()) maybeAI(); // 执白且退到了开局
    else requestForbids();
  }

  function hint() {
    if (!isHumanTurn() || thinking) return;
    thinking = { id: ++reqSeq, kind: 'hint', start: performance.now(), timeMs: 3000 };
    setThinking(true); sendThink(true);
  }

  function resign() {
    if (game.over || game.moves.length === 0) return;
    if (!confirm('确定认输吗？')) return;
    endGame('lose', '你认输了');
    updateTurn();
  }

  // ------------------------------------------------------------ 信息面板
  let progressTimer = null;
  function setThinking(on) {
    $('thinkBadge').classList.toggle('hidden', !on);
    clearInterval(progressTimer);
    if (on) {
      progressTimer = setInterval(() => {
        if (!thinking) return;
        const p = Math.min(1, (performance.now() - thinking.start) / thinking.timeMs);
        $('progressBar').style.width = (p * 100).toFixed(1) + '%';
      }, 100);
    } else $('progressBar').style.width = '0';
    updateButtons();
  }

  function evalToWinrate(ev) {
    // 返回走棋方胜率
    if (typeof ev !== 'string') ev = String(ev);
    if (/^\+M/.test(ev)) return 1;
    if (/^-M/.test(ev)) return 0;
    const v = parseFloat(ev);
    if (isNaN(v)) return 0.5;
    return 1 / (1 + Math.exp(-v / 200));
  }
  function evalText(ev, side) {
    const who = side === game.humanColor ? '你' : 'AI';
    let m = /^\+M(\d+|\*)/.exec(ev);
    if (m) return `${who}必胜${m[1] !== '*' ? `（${m[1]}步）` : ''}`;
    m = /^-M(\d+|\*)/.exec(ev);
    if (m) return `${who}必败`;
    return ev;
  }
  function showInfo(info, side) {
    if (info.depth != null) $('stDepth').textContent = `${info.depth}-${info.selDepth}`;
    if (info.eval != null) {
      $('stEval').textContent = evalText(String(info.eval), side);
      $('stEval').title = String(info.eval);
      const wr = evalToWinrate(info.eval);
      const black = side === BLACK ? wr : 1 - wr;
      $('evalB').style.width = (black * 100).toFixed(1) + '%';
      $('evalBL').textContent = `黑 ${(black * 100).toFixed(0)}%`;
      $('evalWL').textContent = `白 ${((1 - black) * 100).toFixed(0)}%`;
    }
    if (info.speed) $('stSpeed').textContent = info.speed + 'N/s';
    if (info.time != null) $('stTime').textContent = (info.time / 1000).toFixed(1) + 's';
    if (info.pv && info.pv.length) $('stPV').textContent = info.pv.slice(0, 14).join(' ');
  }
  function resetInfo() {
    for (const id of ['stDepth', 'stEval', 'stSpeed', 'stTime', 'stPV']) $(id).textContent = '–';
    $('evalB').style.width = '50%'; $('evalBL').textContent = '黑 50%'; $('evalWL').textContent = '白 50%';
  }

  function setTurnText(t) { $('turnText').textContent = t; }
  function updateTurn() {
    const humanBlack = game.humanColor === BLACK;
    $('pBlack').querySelector('.pname').textContent = humanBlack ? '黑方 · 你' : '黑方 · AI';
    $('pWhite').querySelector('.pname').textContent = humanBlack ? 'AI · 白方' : '你 · 白方';
    $('pBlack').classList.toggle('active', !game.over && toMove() === BLACK);
    $('pWhite').classList.toggle('active', !game.over && toMove() === WHITE);
    if (game.over) setTurnText('对局结束');
    else if (thinking) setTurnText(thinking.kind === 'hint' ? '正在计算提示…' : 'AI 思考中…');
    else if (isHumanTurn()) setTurnText(`轮到你落子（第 ${game.moves.length + 1} 手）`);
    else setTurnText(wsReady ? '等待 AI…' : '等待连接服务器…');
    updateButtons();
  }
  function updateButtons() {
    $('btnUndo').disabled = game.moves.length === 0 || (game.humanColor === WHITE && game.moves.length <= 1 && !game.over);
    $('btnHint').disabled = !isHumanTurn() || !!thinking;
    $('btnResign').disabled = game.over || game.moves.length === 0;
  }

  function renderMoves() {
    const ol = $('moveList');
    ol.innerHTML = '';
    game.moves.forEach(([x, y], i) => {
      const li = document.createElement('li');
      li.innerHTML = `<em>${i + 1}</em><i class="${i % 2 ? 'w' : 'b'}"></i>${coordName(x, y)}`;
      ol.appendChild(li);
    });
    ol.scrollTop = ol.scrollHeight;
  }

  function renderRecord() {
    const rec = load('gomoku.record', {});
    let html = '<tr><th>难度</th><th>胜</th><th>负</th><th>和</th><th>胜率</th></tr>';
    for (const l of levels) {
      const r = rec[l.id] || { w: 0, l: 0, d: 0 };
      const tot = r.w + r.l + r.d;
      html += `<tr><td>${l.name}</td><td>${r.w}</td><td>${r.l}</td><td>${r.d}</td><td>${tot ? Math.round((r.w / tot) * 100) + '%' : '–'}</td></tr>`;
    }
    $('record').innerHTML = html;
  }

  // ------------------------------------------------------------ 设置
  function bindSeg(id, key, parse) {
    const el = $(id);
    el.addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b || b.disabled) return;
      settings[key] = parse ? parse(b.dataset.v) : b.dataset.v;
      if (key === 'rule' && !sizes[settings.rule].includes(settings.size)) settings.size = sizes[settings.rule][0];
      onSettingsChanged();
    });
  }
  function renderSettings() {
    for (const [id, key] of [['segRule', 'rule'], ['segSize', 'size'], ['segColor', 'color']]) {
      for (const b of $(id).querySelectorAll('button')) b.classList.toggle('on', String(settings[key]) === b.dataset.v);
    }
    for (const b of $('segSize').querySelectorAll('button')) b.disabled = !sizes[settings.rule].includes(+b.dataset.v);
    $('ruleDesc').textContent = RULE_DESC[settings.rule];
    const box = $('levels');
    box.innerHTML = '';
    levels.forEach((l, i) => {
      const d = document.createElement('div');
      d.className = 'level' + (l.id === settings.level ? ' on' : '') + (i === levels.length - 1 ? ' top' : '');
      d.title = l.desc;
      d.innerHTML = `<b>${l.name}</b><span class="stars">${'★'.repeat(i + 1)}</span><small>${l.desc || ''}</small>`;
      d.onclick = () => { settings.level = l.id; onSettingsChanged(); };
      box.appendChild(d);
    });
  }
  function onSettingsChanged() {
    save('gomoku.settings', settings);
    renderSettings();
    const changed = settings.rule !== game.rule || settings.size !== game.size || settings.level !== game.level ||
      (settings.color === 'black' ? BLACK : WHITE) !== game.humanColor;
    const fresh = game.moves.length === 0 || (game.humanColor === WHITE && game.moves.length === 1 && !thinking) || game.over;
    if (changed && fresh) newGame();
    else $('pendingNote').classList.toggle('hidden', !changed);
  }

  // ------------------------------------------------------------ 绘制
  const canvas = $('board');
  const ctx = canvas.getContext('2d');
  let geo = { px: 600, cell: 36, pad: 30 };

  function resize() {
    const rect = canvas.getBoundingClientRect();
    const px = Math.max(200, Math.floor(rect.width));
    const dpr = window.devicePixelRatio || 1;
    canvas.width = px * dpr; canvas.height = px * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const pad = Math.max(22, px * 0.055);
    geo = { px, pad, cell: (px - pad * 2) / (game.size - 1) };
    draw();
  }
  const sx = (x) => geo.pad + x * geo.cell;
  const sy = (y) => geo.pad + (game.size - 1 - y) * geo.cell;

  let woodPattern = null;
  function wood() {
    if (woodPattern) return woodPattern;
    const c = document.createElement('canvas'); c.width = c.height = 512;
    const g = c.getContext('2d');
    const grad = g.createLinearGradient(0, 0, 512, 512);
    grad.addColorStop(0, '#e6bf80'); grad.addColorStop(1, '#d29d58');
    g.fillStyle = grad; g.fillRect(0, 0, 512, 512);
    // 木纹
    let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 70; i++) {
      g.strokeStyle = `rgba(120,70,20,${0.03 + rnd() * 0.06})`;
      g.lineWidth = 0.6 + rnd() * 2.2;
      g.beginPath();
      const y0 = rnd() * 560 - 24;
      g.moveTo(0, y0);
      for (let x = 0; x <= 512; x += 32) g.lineTo(x, y0 + Math.sin(x / (60 + rnd() * 40) + i) * (4 + rnd() * 6));
      g.stroke();
    }
    woodPattern = ctx.createPattern(c, 'repeat');
    return woodPattern;
  }

  function draw() {
    const { px, cell } = geo, n = game.size;
    if (!game.grid.length) return;
    ctx.clearRect(0, 0, px, px);
    ctx.fillStyle = wood(); ctx.fillRect(0, 0, px, px);

    // 网格
    ctx.strokeStyle = '#5a3d1acc'; ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const p = Math.round(geo.pad + i * cell) + 0.5;
      ctx.moveTo(sx(0), p); ctx.lineTo(sx(n - 1), p);
      ctx.moveTo(p, sy(n - 1)); ctx.lineTo(p, sy(0));
    }
    ctx.stroke();
    ctx.lineWidth = 2; ctx.strokeRect(sx(0), sy(n - 1), cell * (n - 1), cell * (n - 1));

    // 星位
    const stars = n === 15 ? [3, 7, 11] : n === 19 ? [3, 9, 15] : [3, 9, 16];
    ctx.fillStyle = '#4a3214';
    for (const a of stars) for (const b of stars) {
      if (n === 15 && ((a === 7) !== (b === 7))) continue;
      ctx.beginPath(); ctx.arc(sx(a), sy(b), Math.max(2.5, cell * 0.09), 0, Math.PI * 2); ctx.fill();
    }

    // 坐标
    ctx.fillStyle = '#5a3d1a'; ctx.font = `${Math.max(9, cell * 0.3)}px ui-monospace, Menlo, monospace`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const off = geo.pad * 0.5;
    for (let i = 0; i < n; i++) {
      ctx.fillText(String.fromCharCode(65 + i), sx(i), px - off);
      ctx.fillText(String(i + 1), off, sy(i));
    }

    // 禁手点
    if (isHumanTurn()) {
      ctx.strokeStyle = '#c8443a'; ctx.lineWidth = Math.max(1.5, cell * 0.07);
      const r = cell * 0.2;
      for (const [x, y] of game.forbids) {
        ctx.beginPath();
        ctx.moveTo(sx(x) - r, sy(y) - r); ctx.lineTo(sx(x) + r, sy(y) + r);
        ctx.moveTo(sx(x) + r, sy(y) - r); ctx.lineTo(sx(x) - r, sy(y) + r);
        ctx.stroke();
      }
    }

    // 棋子
    const R = cell * 0.46;
    game.moves.forEach(([x, y], i) => drawStone(sx(x), sy(y), R, colorAt(i), 1));
    if (opts.numbers) {
      ctx.font = `600 ${Math.max(9, cell * (game.moves.length >= 100 ? 0.32 : 0.38))}px -apple-system, "Helvetica Neue", Arial, sans-serif`;
      game.moves.forEach(([x, y], i) => {
        ctx.fillStyle = colorAt(i) === BLACK ? '#f2ede3' : '#1b1b1b';
        if (i === game.moves.length - 1) ctx.fillStyle = '#e0483c';
        ctx.fillText(String(i + 1), sx(x), sy(y) + 0.5);
      });
    } else if (game.moves.length) {
      const [x, y] = game.moves[game.moves.length - 1];
      ctx.fillStyle = '#e0483c';
      ctx.beginPath(); ctx.arc(sx(x), sy(y), Math.max(3, cell * 0.12), 0, Math.PI * 2); ctx.fill();
    }

    // 获胜连线
    if (game.winLine) {
      const [[x1, y1], [x2, y2]] = game.winLine;
      ctx.strokeStyle = '#e0483cdd'; ctx.lineWidth = Math.max(3, cell * 0.12); ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(sx(x1), sy(y1)); ctx.lineTo(sx(x2), sy(y2)); ctx.stroke();
      ctx.lineCap = 'butt';
    }

    // 提示
    if (game.hint && isHumanTurn()) {
      const [x, y] = game.hint;
      drawStone(sx(x), sy(y), R, game.humanColor, 0.45);
      ctx.strokeStyle = '#2f9e6b'; ctx.lineWidth = 2.5;
      ctx.beginPath(); ctx.arc(sx(x), sy(y), R + 3, 0, Math.PI * 2); ctx.stroke();
    }
    // 落子确认 / 悬停预览
    const ghost = confirmPt || hover;
    if (ghost && isHumanTurn() && !thinking && !game.grid[ghost[1]][ghost[0]]) {
      drawStone(sx(ghost[0]), sy(ghost[1]), R, game.humanColor, confirmPt ? 0.7 : 0.35);
      if (confirmPt) {
        ctx.strokeStyle = '#e0b46c'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(sx(ghost[0]), sy(ghost[1]), R + 3, 0, Math.PI * 2); ctx.stroke();
      }
    }
  }

  function drawStone(cx, cy, r, color, alpha) {
    ctx.save();
    ctx.globalAlpha = alpha;
    if (alpha === 1) {
      ctx.shadowColor = 'rgba(0,0,0,.45)'; ctx.shadowBlur = r * 0.35; ctx.shadowOffsetX = r * 0.08; ctx.shadowOffsetY = r * 0.14;
    }
    const g = ctx.createRadialGradient(cx - r * 0.35, cy - r * 0.4, r * 0.1, cx, cy, r);
    if (color === BLACK) { g.addColorStop(0, '#6a6a6a'); g.addColorStop(0.45, '#262626'); g.addColorStop(1, '#0a0a0a'); }
    else { g.addColorStop(0, '#ffffff'); g.addColorStop(0.6, '#ece7dc'); g.addColorStop(1, '#bdb6a8'); }
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  function pointFromEvent(e) {
    const rect = canvas.getBoundingClientRect();
    const x = Math.round((e.clientX - rect.left - geo.pad) / geo.cell);
    const yScreen = Math.round((e.clientY - rect.top - geo.pad) / geo.cell);
    const y = game.size - 1 - yScreen;
    if (x < 0 || y < 0 || x >= game.size || y >= game.size) return null;
    return [x, y];
  }
  canvas.addEventListener('click', (e) => { const p = pointFromEvent(e); if (p) humanPlay(p[0], p[1]); });
  canvas.addEventListener('mousemove', (e) => {
    if (isTouch) return;
    const p = pointFromEvent(e);
    if ((p && hover && p[0] === hover[0] && p[1] === hover[1]) || (!p && !hover)) return;
    hover = p; draw();
  });
  canvas.addEventListener('mouseleave', () => { hover = null; draw(); });
  new ResizeObserver(() => resize()).observe($('boardBox'));

  // ------------------------------------------------------------ 杂项
  let audioCtx = null;
  function playSound() {
    if (!opts.sound) return;
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const t = audioCtx.currentTime;
      const buf = audioCtx.createBuffer(1, audioCtx.sampleRate * 0.08, audioCtx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, 6);
      const src = audioCtx.createBufferSource(); src.buffer = buf;
      const f = audioCtx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 1800; f.Q.value = 1.2;
      const gain = audioCtx.createGain(); gain.gain.setValueAtTime(0.9, t);
      src.connect(f).connect(gain).connect(audioCtx.destination); src.start(t);
    } catch (_) {}
  }

  let toastTimer = null;
  function toast(text) {
    const el = $('toast'); el.textContent = text; el.classList.remove('hidden');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.add('hidden'), 2200);
  }

  $('btnNew').onclick = () => newGame();
  $('btnAgain').onclick = () => newGame();
  $('btnReview').onclick = () => $('overlay').classList.add('hidden');
  $('btnUndo').onclick = undo;
  $('btnHint').onclick = hint;
  $('btnResign').onclick = resign;
  $('btnCopy').onclick = async () => {
    const ruleName = { freestyle: '自由', standard: '标准', renju: '连珠' }[game.rule];
    const text = `[${ruleName} ${game.size}路] ` + game.moves.map(([x, y]) => coordName(x, y).toLowerCase()).join(' ');
    try { await navigator.clipboard.writeText(text); toast('棋谱已复制'); } catch (_) { prompt('复制棋谱：', text); }
  };
  for (const [id, key] of [['optNumbers', 'numbers'], ['optSound', 'sound'], ['optConfirm', 'confirm']]) {
    $(id).checked = !!opts[key];
    $(id).onchange = () => { opts[key] = $(id).checked; save('gomoku.opts', opts); confirmPt = null; draw(); };
  }
  bindSeg('segRule', 'rule');
  bindSeg('segSize', 'size', Number);
  bindSeg('segColor', 'color');

  fetch('/api/info').then((r) => r.json()).then((info) => {
    if (info.levels && info.levels.length) levels = info.levels;
    if (info.sizes) sizes = info.sizes;
    if (!levels.some((l) => l.id === settings.level)) settings.level = levels[0].id;
    const m = /name="([^"]*)".*version="([^"]*)"/.exec(info.engine || '');
    $('engineInfo').textContent = m ? `引擎：${m[1]} ${m[2]} · ${info.threads} 线程` : '';
    renderSettings(); renderRecord();
  }).catch(() => {});

  renderSettings(); renderRecord();
  newGame();
  connect();
})();
