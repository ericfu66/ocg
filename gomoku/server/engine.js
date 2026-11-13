'use strict';
/**
 * Rapfi 引擎进程封装 + 引擎池。
 *
 * 与引擎之间使用 Piskvork（Gomocup）文本协议通信：
 *   START <size>            初始化棋盘
 *   INFO <key> <value>      设置参数（规则、时间、线程、强度……）
 *   BOARD ... DONE          给出完整局面并让引擎思考，引擎回复 "x,y"
 *   YXBOARD ... DONE        只摆局面不思考（Yixin 扩展）
 *   YXSHOWFORBID            列出黑方禁手点（连珠规则）
 *   YXSTOP                  立即停止思考并给出当前最佳着法
 *
 * 每次请求都发送完整的落子序列，所以引擎进程是"无状态"的，可以在多个
 * 用户之间复用；置换表（hash）会保留，同一盘棋连续请求时依然能受益。
 */
const { spawn } = require('child_process');
const path = require('path');
const readline = require('readline');

const RULE_ID = { freestyle: 0, standard: 1, renju: 4 };

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

/** 解析 "Depth 19-45 | Eval -235 | Time 2973ms | G7 I8 ..." 这一类输出 */
function parseMessage(text) {
  let m = /^Depth (\d+)-(\d+) \| Eval (\S+) \| Time (\d+)ms(?: \| (.*))?$/.exec(text);
  if (m) {
    return {
      kind: 'depth',
      depth: +m[1],
      selDepth: +m[2],
      eval: m[3],
      time: +m[4],
      pv: m[5] ? m[5].trim().split(/\s+/) : [],
    };
  }
  m = /^Speed (\S+) \| Depth (\d+)-(\d+) \| Eval (\S+) \| Node (\S+) \| Time (\d+)ms/.exec(text);
  if (m) {
    return {
      kind: 'final',
      speed: m[1],
      depth: +m[2],
      selDepth: +m[3],
      eval: m[4],
      nodes: m[5],
      time: +m[6],
    };
  }
  return null;
}

class RapfiEngine {
  constructor(opts) {
    this.opts = opts;
    this.id = opts.id;
    this.proc = null;
    this.size = 0;
    this.listeners = new Set();
    this.alive = false;
    this.settings = {}; // 已经发送给引擎的 INFO 参数缓存，避免重复设置
  }

  start() {
    const exe = path.join(this.opts.engineDir, this.opts.engineBin);
    this.proc = spawn(exe, [], { cwd: this.opts.engineDir, stdio: ['pipe', 'pipe', 'pipe'] });
    this.alive = true;
    this.size = 0;
    this.settings = {};
    const rl = readline.createInterface({ input: this.proc.stdout });
    rl.on('line', (line) => {
      line = line.trim();
      if (!line) return;
      for (const fn of [...this.listeners]) fn(line);
    });
    this.proc.stderr.on('data', (d) => log(`[engine ${this.id}] stderr:`, d.toString().trim()));
    this.proc.on('exit', (code, sig) => {
      this.alive = false;
      log(`[engine ${this.id}] exited code=${code} sig=${sig}`);
      for (const fn of [...this.listeners]) fn('__EXIT__');
    });
    this.proc.on('error', (err) => {
      this.alive = false;
      log(`[engine ${this.id}] spawn error:`, err.message);
      for (const fn of [...this.listeners]) fn('__EXIT__');
    });
    this.proc.stdin.on('error', () => {});
  }

  send(cmd) {
    if (!this.alive) return;
    this.proc.stdin.write(cmd + '\n');
  }

  kill() {
    try { this.proc && this.proc.kill('SIGKILL'); } catch (_) {}
    this.alive = false;
  }

  /** 等待满足 predicate 的输出行；onLine 会收到所有行 */
  waitFor(predicate, timeoutMs, onLine) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.listeners.delete(fn);
        reject(new Error('engine timeout'));
      }, timeoutMs);
      const fn = (line) => {
        if (line === '__EXIT__') {
          clearTimeout(timer);
          this.listeners.delete(fn);
          reject(new Error('engine exited'));
          return;
        }
        if (onLine) onLine(line);
        if (predicate(line)) {
          clearTimeout(timer);
          this.listeners.delete(fn);
          resolve(line);
        }
      };
      this.listeners.add(fn);
    });
  }

  setInfo(key, value) {
    if (this.settings[key] === value) return;
    this.settings[key] = value;
    this.send(`INFO ${key} ${value}`);
  }

  async ensureBoard(size, rule) {
    if (this.size !== size) {
      this.send(`START ${size}`);
      await this.waitFor((l) => l === 'OK' || l.startsWith('ERROR'), 30000);
      this.size = size;
    }
    this.setInfo('rule', RULE_ID[rule]);
  }

  /**
   * 让引擎为当前局面走一步。
   * moves: [[x,y], ...] 按落子顺序，第一手为黑。
   * level: { strength, timeMs, threads, caution }
   */
  async think({ size, rule, moves, level, onInfo, signal }) {
    await this.ensureBoard(size, rule);
    this.setInfo('max_memory', this.opts.hashMB * 1024 * 1024);
    this.setInfo('thread_num', level.threads);
    this.setInfo('strength', level.strength);
    this.setInfo('caution_factor', level.caution);
    this.setInfo('timeout_match', 0);
    this.setInfo('timeout_turn', level.timeMs);
    this.send('INFO time_left 2147483647');

    // 引擎执棋颜色 = 当前该走的一方。field 1 = 自己，2 = 对手
    const engineParity = moves.length % 2;
    const lines = ['BOARD'];
    moves.forEach(([x, y], i) => lines.push(`${x},${y},${i % 2 === engineParity ? 1 : 2}`));
    lines.push('DONE');
    this.send(lines.join('\n'));

    let stopped = false;
    const onAbort = () => {
      if (!stopped) { stopped = true; this.send('YXSTOP'); }
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    // 兜底：超过限定时间仍未返回时强制停止
    const guard = setTimeout(onAbort, level.timeMs + 5000);

    let final = null;
    try {
      const line = await this.waitFor(
        (l) => /^\d+,\d+$/.test(l) || l.startsWith('ERROR'),
        level.timeMs + 30000,
        (l) => {
          if (!l.startsWith('MESSAGE ')) return;
          const info = parseMessage(l.slice(8));
          if (!info) return;
          if (info.kind === 'final') final = info;
          if (onInfo) onInfo(info);
        }
      );
      if (line.startsWith('ERROR')) throw new Error(line);
      const [x, y] = line.split(',').map(Number);
      return { x, y, final };
    } finally {
      clearTimeout(guard);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }

  /** 连珠规则下黑方的禁手点 */
  async forbids({ size, moves }) {
    await this.ensureBoard(size, 'renju');
    const engineParity = moves.length % 2;
    const lines = ['YXBOARD'];
    moves.forEach(([x, y], i) => lines.push(`${x},${y},${i % 2 === engineParity ? 1 : 2}`));
    lines.push('DONE', 'YXSHOWFORBID');
    this.send(lines.join('\n'));
    const line = await this.waitFor((l) => l.startsWith('FORBID'), 10000);
    const digits = line.slice(6).replace(/[^0-9]/g, '');
    const pts = [];
    for (let i = 0; i + 4 <= digits.length; i += 4) {
      pts.push([+digits.slice(i, i + 2), +digits.slice(i + 2, i + 4)]);
    }
    return pts;
  }

  async about() {
    this.send('ABOUT');
    return this.waitFor((l) => /name=/.test(l), 10000);
  }
}

/**
 * 引擎池：固定数量的引擎进程 + FIFO 队列。
 */
class EnginePool {
  constructor(opts) {
    this.opts = opts;
    this.engines = [];
    this.idle = [];
    this.queue = [];
    for (let i = 0; i < opts.poolSize; i++) {
      const e = new RapfiEngine({ ...opts, id: i });
      e.start();
      this.engines.push(e);
      this.idle.push(e);
    }
    // 工具引擎：只用于计算禁手点等轻量操作，避免排在长时间搜索之后
    this.util = new RapfiEngine({ ...opts, id: 'util', hashMB: 16 });
    this.util.start();
    this.utilChain = Promise.resolve();
  }

  /** 使用工具引擎执行一个轻量任务（串行） */
  withUtil(fn) {
    const run = async () => {
      if (!this.util.alive) this.util.start();
      try {
        return await fn(this.util);
      } catch (err) {
        this.util.kill();
        this.util.start();
        throw err;
      }
    };
    const p = this.utilChain.then(run, run);
    this.utilChain = p.catch(() => {});
    return p;
  }

  /**
   * 申请一个引擎执行任务。返回 { promise, cancel }。
   * onQueued(position) 在需要排队时被调用。
   */
  acquire(task, onQueued) {
    let cancelled = false;
    let entry;
    const promise = new Promise((resolve, reject) => {
      entry = { task, resolve, reject, isCancelled: () => cancelled };
      this.queue.push(entry);
      this.pump();
      if (this.queue.includes(entry) && onQueued) onQueued(this.queue.indexOf(entry) + 1);
    });
    const cancel = () => {
      cancelled = true;
      const i = this.queue.indexOf(entry);
      if (i >= 0) {
        this.queue.splice(i, 1);
        entry.reject(new Error('cancelled'));
      }
    };
    return { promise, cancel };
  }

  queueLength() {
    return this.queue.length;
  }

  pump() {
    while (this.idle.length && this.queue.length) {
      const engine = this.idle.shift();
      const entry = this.queue.shift();
      if (entry.isCancelled()) { this.idle.push(engine); continue; }
      this.run(engine, entry);
    }
  }

  async run(engine, entry) {
    try {
      if (!engine.alive) engine.start();
      const result = await entry.task(engine);
      entry.resolve(result);
    } catch (err) {
      log(`[engine ${engine.id}] task failed:`, err.message);
      // 出错的引擎直接重启，保证池子健康
      engine.kill();
      engine.start();
      entry.reject(err);
    } finally {
      this.idle.push(engine);
      this.pump();
    }
  }

  shutdown() {
    for (const e of this.engines) { e.send('END'); e.kill(); }
    this.util.kill();
  }
}

module.exports = { EnginePool, RULE_ID };
