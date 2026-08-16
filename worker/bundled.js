/* 宝藏海湾联机服务器 —— 打包成一个文件的版本（自动生成，别手改）
 *
 * 正常部署请用 `cd worker && npx wrangler deploy`，它会自己打包，不需要这个文件。
 * 这份只给一种情况用：手上没有能装 Node 的电脑，想在 Cloudflare 后台的
 * 在线编辑器里直接粘贴代码部署。步骤见 worker/README.md 的「没有电脑时」一节。
 *
 * 内容 = server/room.mjs（去掉 export 关键字）+ worker/index.js（去掉那行 import）。
 * room.mjs 一改，这个文件就过期了 —— 重新生成任选一种：
 *   cd worker && npx wrangler deploy --dry-run --outdir /tmp/wr-out   # 用 wrangler 打包
 *   或者按上面两句话手工拼一遍（这份就是这么来的）。
 */

// ── server/room.mjs ─────────────────────────────────────
/* 宝藏海湾 · 联机房间逻辑
 *
 * 只有纯逻辑，不碰任何运行时 API，所以同一份代码给两处用：
 *   - worker/index.js       Cloudflare Durable Object（线上）
 *   - server/local.mjs      Node + ws（本地开发和自动化测试）
 *
 * 分工：
 *   服务器管「世界」—— 出什么鱼、在哪、谁先钩到、分数、计时、FEVER。
 *   客户端管「手感」—— 鱼怎么游、钩子怎么动、画面怎么画。
 * 鱼的移动不走网络：出生时把 x / y / vx / life 一次发下去，两边各自按同样的
 * 参数推进，所以没有每帧同步，也就不会有抖动。真正需要仲裁的只有「这条鱼归谁」，
 * 那是一条 grab 消息，服务器先到先得。
 */

const GAME_TIME  = 60;     // 默认局时；房间会用第一个点开始的人选的时长
const DURATIONS  = [30, 60, 120];
const FEVER_MULT = 1.5;
// 局时可变，所以 FEVER 门槛和时间奖励上限都按比例算（和客户端同一套公式）
const feverAt  = dur => Math.min(20, Math.max(10, Math.round(dur * 0.33)));
const bonusCap = dur => Math.round(dur * 0.42);
const OVER_HOLD  = 8;      // 结算停留几秒后回到大厅
// 天色由服务器定，一屋子人才看到同一片天（权重要和客户端 SCENES 一致）
const SCENE_W = { day:38, dusk:20, night:25, storm:17 };

/* 地图：和客户端 index.html 里的 MAPS 一一对应（名字和画法在客户端，
   服务器只需要「挑哪张」和「出鱼权重怎么乘」）。改了记得两边一起改。
   联机时地图由服务器定，跟天色一样随 start / welcome 下发，全房间同一片海。 */
const MAP_W = { open:26, reef:22, trench:18, wreck:18, polar:16 };
const MAP_MUL = {
  open:   {},
  reef:   { clown:2.6, small:2.2, crab:1.8, jelly:1.5, puffer:1.6, angler:0.2, boss:0, shark:0.5 },
  trench: { angler:3, squid:2.2, boss:1, clown:0.2, small:0.3, coin:0.6 },
  wreck:  { coin:2.4, boot:2.2, mine:2, magnet:1.6, watch:1.6, bighook:1.6, turbo:1.6, boss:0.6 },
  polar:  { big:1.8, sword:1.4, clown:0.2, crab:0.4, jelly:0.6 },
};
const MAX_ITEMS = 26;
const MAX_CHAIN = 8;
// 撞船：客户端自己也有一份冷却（略长），这里是防改客户端的那道
const RAM_CD     = 4.5;    // 同一个人隔多久才能再撞
const RAM_IMMUNE = 2;      // 同一个人挨完撞的无敌时间，免得被围殴

// 场地常量必须和客户端一致
const W = 600, SEA_Y = 210, FLOOR_Y = 946, TOP = 250, SPAN = 666;

/* 出鱼表：必须和客户端 index.html 里的 KINDS 对得上（score / depth / w / move）。
   客户端另外还有画法、命中框等纯表现字段，服务器不需要。 */
const SPEC = {
  coin:   { score:10,   w:24, depth:[0.02,0.95], move:"coin"   },
  clown:  { score:20,   w:12, depth:[0.02,0.30], move:"swim"   },
  small:  { score:30,   w:13, depth:[0.05,0.40], move:"swim"   },
  jelly:  { score:60,   w:9,  depth:[0.06,0.58], move:"drift"  },
  medium: { score:80,   w:11, depth:[0.25,0.66], move:"swim"   },
  puffer: { score:110,  w:8,  depth:[0.25,0.62], move:"swim"   },
  crab:   { score:130,  w:5,  depth:[1,1],       move:"crawl"  },
  big:    { score:150,  w:8,  depth:[0.50,0.90], move:"swim"   },
  turtle: { score:200,  w:5,  depth:[0.20,0.62], move:"paddle" },
  squid:  { score:240,  w:6,  depth:[0.35,0.82], move:"jet"    },
  sword:  { score:320,  w:4,  depth:[0.45,0.85], move:"swim"   },
  king:   { score:400,  w:3,  depth:[0.60,0.95], move:"swim"   },
  chest:  { score:500,  w:0,  depth:[0.55,0.95], move:"rise"   },
  angler: { score:650,  w:3,  depth:[0.74,0.98], move:"swim"   },
  boss:   { score:1000, w:0,  depth:[0.86,0.99], move:"swim"   },
  // 危险物：不给分、清连击，水雷还扣时间
  boot:   { score:0,    w:7,  depth:[0.30,0.95], move:"coin", hazard:true },
  mine:   { score:0,    w:6,  depth:[0.20,0.90], move:"coin", hazard:true, penalty:3 },
  // 道具：效果在客户端生效；怀表要加时间，由服务器统一加
  magnet: { score:0,    w:4,  depth:[0.15,0.80], move:"coin", power:true },
  bighook:{ score:0,    w:4,  depth:[0.20,0.85], move:"coin", power:true },
  watch:  { score:0,    w:4,  depth:[0.10,0.75], move:"coin", power:true, addTime:5 },
  turbo:  { score:0,    w:4,  depth:[0.08,0.60], move:"coin", power:true },
  // 墨囊：钓到的人把别人的视野糊住一会儿（只在联机出现，单人没有对手可泼）
  ink:    { score:0,    w:5,  depth:[0.25,0.85], move:"coin", power:true, ink:true },
};
const SPEED = { coin:[12,28], swim:[24,64], drift:[6,14], paddle:[16,28],
                jet:[26,46], crawl:[26,44], rise:[8,16] };
const POOL = Object.keys(SPEC).filter(k => SPEC[k].w > 0);
const weightOf = (k, map) => {
  const mul = MAP_MUL[map] || MAP_MUL.open;
  return SPEC[k].w * (mul[k] != null ? mul[k] : 1);
};

function pickMap() {
  const ids = Object.keys(MAP_W);
  const total = ids.reduce((a, k) => a + MAP_W[k], 0);
  let r = Math.random() * total;
  for (const k of ids) { if ((r -= MAP_W[k]) <= 0) return k; }
  return "open";
}

function pickScene() {
  const ids = Object.keys(SCENE_W);
  const total = ids.reduce((a, k) => a + SCENE_W[k], 0);
  let r = Math.random() * total;
  for (const k of ids) { if ((r -= SCENE_W[k]) <= 0) return k; }
  return "day";
}

const timeBonus = score => score >= 400 ? 3 : score >= 150 ? 2 : score >= 60 ? 1 : 0;
const rand  = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;

class Room {
  /** @param send  (clientId, msg) => void，只发给一个人
   *  @param name  房间名，仅用于日志 */
  constructor(send, name = "") {
    this.sendTo = send;
    this.name   = name;
    this.players = new Map();      // id -> {id, name, score, combo, hook}
    this.items   = new Map();      // id -> {id, kind, x, y, vx, life, bornAt}
    this.nextId  = 1;
    this.state   = "lobby";        // lobby | playing | over
    this.roundTime = GAME_TIME;    // 本局时长（30 / 60 / 120）
    this.scene = "day";            // 本局天色
    this.map   = "open";           // 本局在哪片海
    this.coop = false;             // 合作模式：全房间共用一个目标分
    this.target = 0;
    this.timeLeft = GAME_TIME;
    this.fever = false;
    this.bonusGiven = 0;
    this.spawnTimer = 0;
    this.chestTimer = 5;
    this.bossTimer  = 18;
    this.schoolTimer = 14;
    this.overAt = 0;
    this.hooksDirty = false;
  }

  // ───────────────────────── 收发 ─────────────────────────
  broadcast(msg, except = null) {
    for (const id of this.players.keys()) if (id !== except) this.sendTo(id, msg);
  }

  playerList() {                   // 只列真正在钓的人
    return [...this.players.values()]
      .filter(p => !p.spec)
      .map(p => ({ id: p.id, name: p.name, score: p.score }))
      .sort((a, b) => b.score - a.score);
  }

  specCount() {
    let n = 0;
    for (const p of this.players.values()) if (p.spec) n++;
    return n;
  }

  itemList() { return [...this.items.values()].map(this.wire); }
  wire(it) { return { id: it.id, kind: it.kind, x: Math.round(it.x), y: Math.round(it.y),
                      vx: Math.round(it.vx * 10) / 10, life: Math.round(it.life * 10) / 10 }; }

  // ───────────────────────── 进出房间 ─────────────────────────
  join(id, name, spec = false) {
    const p = { id, name: (name || (spec ? "观众" : "船长")).slice(0, 12), score: 0, combo: 0,
                spec: !!spec, hook: { x: W / 2, y: SEA_Y, st: "idle", n: 0, s: W / 2 } };
    this.players.set(id, p);
    this.sendTo(id, { t: "welcome", you: id, state: this.state, time: Math.ceil(this.timeLeft),
                      fever: this.fever, dur: this.roundTime, scene: this.scene, map: this.map, spec: p.spec,
                      coop: this.coop, target: this.target,
                      players: this.playerList(), items: this.itemList(), specs: this.specCount() });
    this.broadcast({ t: "joined", p: { id: p.id, name: p.name, score: 0, spec: p.spec },
                     specs: this.specCount() }, id);
    return p;
  }

  leave(id) {
    if (!this.players.delete(id)) return;
    this.broadcast({ t: "left", id, specs: this.specCount() });
    if (!this.players.size) this.reset("lobby");   // 房间空了就收拾干净
  }

  get empty() { return this.players.size === 0; }

  // ───────────────────────── 客户端消息 ─────────────────────────
  message(id, msg) {
    const p = this.players.get(id);
    if (!p || !msg || typeof msg.t !== "string") return;

    switch (msg.t) {
      case "ready":                                  // 谁先点谁定这一局的时长和模式
        if (this.state !== "playing") this.startRound(+msg.dur, !!msg.coop);
        break;

      case "emote": {                                // 快捷表情：转发一下就好
        const now = Date.now();
        if (now - (p.lastEmote || 0) < 700) return;   // 简单限流，别刷屏
        p.lastEmote = now;
        const e = Math.max(0, Math.min(5, +msg.e || 0));
        this.broadcast({ t: "emote", by: id, e });
        break;
      }

      /* 撞船：效果全在客户端（拽偏钩子 + 收线变慢，不碰分数），
         服务器只做两件事 —— 确认「谁撞了谁」，以及卡住连撞。
         冷却分两头算：撞的人别刷屏，挨撞的人也别被一屋子人围着轮。 */
      case "ram": {
        if (this.state !== "playing" || p.spec) return;
        const tgt = this.players.get(+msg.id);
        if (!tgt || tgt.id === id || tgt.spec) return;
        const now = Date.now();
        if (now - (p.lastRam || 0) < RAM_CD * 1000) return;
        if (now - (tgt.lastRammed || 0) < RAM_IMMUNE * 1000) return;
        p.lastRam = now;
        tgt.lastRammed = now;
        this.broadcast({ t: "rammed", by: id, to: tgt.id });
        break;
      }

      case "hook": {                                 // 只是给别人看的，不参与判定
        if (p.spec) return;                          // 观众没有钩子
        const h = p.hook;
        h.x  = clamp(+msg.x || 0, 0, W);
        h.y  = clamp(+msg.y || 0, 0, FLOOR_Y);
        h.st = msg.st === "down" || msg.st === "up" ? msg.st : "idle";
        h.n  = clamp(+msg.n || 0, 0, MAX_CHAIN);
        // s = 船位。钩子的 x 是钓点，船另在一处，别人要两个都拿到才画得对
        h.s  = Number.isFinite(+msg.s) ? clamp(+msg.s, 0, W) : h.x;
        this.hooksDirty = true;
        break;
      }

      case "grab": {                                 // 先到先得，抢同一条鱼只能有一个赢
        if (this.state !== "playing" || p.spec) return;
        const it = this.items.get(+msg.id);
        if (!it) return;                             // 已经被别人钓走或过期了
        this.items.delete(it.id);
        /* 爆点用钓到的人上报的位置：服务器只存出生参数，不跟踪鱼游到哪了，
           it.x/it.y 是出生点（在画面外），拿它当爆点会炸空。 */
        const bx = Number.isFinite(+msg.x) ? clamp(+msg.x, 0, W) : it.x;
        const by = Number.isFinite(+msg.y) ? clamp(+msg.y, SEA_Y, FLOOR_Y) : it.y;
        const spec = SPEC[it.kind];
        if (spec.power) {                            // 道具：不计分、不算连击
          let add = 0;
          if (spec.addTime) {                        // 怀表：时间由服务器加，客户端只读结果
            add = spec.addTime;
            this.timeLeft = Math.min(99, this.timeLeft + add);
          }
          this.broadcast({ t: "grabbed", id: it.id, by: id, kind: it.kind, gained: 0,
                           score: p.score, combo: p.combo, bonus: add,
                           x: Math.round(bx), y: Math.round(by),
                           time: Math.ceil(this.timeLeft) });
          break;
        }
        if (spec.hazard) {                           // 水雷 / 破靴子
          p.combo = 0;
          if (spec.penalty) this.timeLeft = Math.max(0.1, this.timeLeft - spec.penalty);
          this.broadcast({ t: "grabbed", id: it.id, by: id, kind: it.kind, gained: 0,
                           score: p.score, combo: 0, bonus: 0,
                           x: Math.round(bx), y: Math.round(by),
                           time: Math.ceil(this.timeLeft) });
          break;
        }
        p.combo++;
        const mult   = Math.min(2, 1 + (p.combo - 1) * 0.1) * (this.fever ? FEVER_MULT : 1);
        const gained = Math.round(spec.score * mult);
        p.score += gained;
        let add = 0;
        if (!this.fever) {                           // FEVER 中不再加时，和单机同一条规则
          add = Math.min(timeBonus(spec.score), bonusCap(this.roundTime) - this.bonusGiven);
          if (add > 0) { this.bonusGiven += add; this.timeLeft = Math.min(99, this.timeLeft + add); }
        }
        this.broadcast({ t: "grabbed", id: it.id, by: id, kind: it.kind, gained,
                         score: p.score, combo: p.combo, bonus: add,
                         x: Math.round(bx), y: Math.round(by),
                         time: Math.ceil(this.timeLeft) });
        break;
      }

      case "miss":                                   // 空钩，连击清零
        p.combo = 0;
        break;
    }
  }

  // ───────────────────────── 一局 ─────────────────────────
  startRound(dur, coop = false) {
    this.roundTime = DURATIONS.includes(+dur) ? +dur : GAME_TIME;
    this.scene = pickScene();
    this.map   = pickMap();
    this.coop = !!coop;
    const fishers = Math.max(1, this.playerList().length);
    // 目标分按人头和局时缩放，人多不能白送
    this.target = this.coop ? Math.round(2600 * fishers * (this.roundTime / 60)) : 0;
    this.reset("playing");
    for (const p of this.players.values()) { p.score = 0; p.combo = 0; }
    this.broadcast({ t: "start", time: this.roundTime, dur: this.roundTime,
                     scene: this.scene, map: this.map, coop: this.coop, target: this.target,
                     players: this.playerList() });
    for (let i = 0; i < 12; i++) this.spawnOne(true);   // 开局先铺一片鱼
    this.flushSpawns();
  }

  reset(state) {
    this.state = state;
    this.timeLeft = this.roundTime;
    this.fever = false;
    this.bonusGiven = 0;
    this.spawnTimer = 0;
    this.chestTimer = rand(4, 7);
    this.bossTimer  = rand(15, 25);
    this.schoolTimer = rand(10, 18);
    this.items.clear();
    this.pending = [];
  }

  endRound() {
    this.state = "over";
    this.timeLeft = 0;
    this.overAt = OVER_HOLD;
    const team = this.playerList().reduce((a, p) => a + p.score, 0);
    this.broadcast({ t: "over", players: this.playerList(), dur: this.roundTime,
                     coop: this.coop, target: this.target, team,
                     win: this.coop ? team >= this.target : undefined });
  }

  // ───────────────────────── 出鱼 ─────────────────────────
  spawnOne(scatter = false, forceKind = null) {
    if (this.items.size >= MAX_ITEMS) return null;
    let kind = forceKind;
    if (!kind) {
      const total = POOL.reduce((a, k) => a + weightOf(k, this.map), 0);
      let r = Math.random() * total;
      kind = null;
      for (const k of POOL) { if ((r -= weightOf(k, this.map)) <= 0) { kind = k; break; } }
      if (!kind) kind = POOL.find(k => weightOf(k, this.map) > 0) || POOL[0];
    }
    const spec = SPEC[kind];
    const dir  = Math.random() < 0.5 ? 1 : -1;
    const sp   = SPEED[spec.move] || [20, 50];
    const vx   = rand(sp[0], sp[1]) * dir;
    const it = {
      id: this.nextId++,
      kind,
      x: scatter ? rand(30, W - 30) : (dir === 1 ? -60 : W + 60),
      y: spec.move === "crawl" ? FLOOR_Y - 14 : TOP + rand(spec.depth[0], spec.depth[1]) * SPAN,
      vx,
      // 漂着不动的给固定寿命，会游的按「横穿画面要多久」算，两边同时消失
      life: ["coin", "drift", "rise", "crawl"].includes(spec.move)
        ? rand(13, 20)
        : (W + 240) / Math.abs(vx) + 1,
    };
    this.items.set(it.id, it);
    (this.pending = this.pending || []).push(this.wire(it));
    return it;
  }

  flushSpawns() {
    if (this.pending && this.pending.length) {
      this.broadcast({ t: "spawn", items: this.pending });
      this.pending = [];
    }
  }

  /** 由运行时按固定间隔调用（建议 100ms） */
  update(dt) {
    if (this.state === "over") {
      this.overAt -= dt;
      if (this.overAt <= 0) this.reset("lobby");
      return;
    }
    if (this.state !== "playing") return;

    const wasFever = this.fever;
    this.timeLeft -= dt;
    if (this.timeLeft <= 0) { this.endRound(); return; }
    if (!this.fever && this.timeLeft <= feverAt(this.roundTime)) this.fever = true;

    this.spawnTimer -= dt;
    if (this.spawnTimer <= 0) {
      this.spawnOne();
      if (this.fever) this.spawnOne();               // 冲刺时鱼群翻倍
      this.spawnTimer = this.fever ? rand(0.22, 0.45) : rand(0.45, 0.9);
    }
    this.chestTimer -= dt;
    if (this.chestTimer <= 0) {
      this.spawnOne(false, "chest");
      this.chestTimer = this.fever ? rand(4, 7) : rand(9, 15);
    }
    this.schoolTimer -= dt;
    if (this.schoolTimer <= 0) {                      // 鱼阵：一队同深同速的小鱼
      const kind = Math.random() < 0.5 ? "small" : "clown";
      const dir  = Math.random() < 0.5 ? 1 : -1;
      const n    = Math.round(rand(9, 14));
      const y    = TOP + rand(0.15, 0.55) * SPAN;
      const vx   = rand(38, 58) * dir;
      const gap  = rand(38, 52);
      for (let i = 0; i < n && this.items.size < MAX_ITEMS + 14; i++) {
        const it = { id: this.nextId++, kind, x: (dir === 1 ? -40 : W + 40) - dir * i * gap,
                     y: y + Math.sin(i * 0.9) * 12, vx, life: (W + 240) / Math.abs(vx) + 1 };
        this.items.set(it.id, it);
        (this.pending = this.pending || []).push(this.wire(it));
      }
      this.schoolTimer = rand(16, 30);
    }
    this.bossTimer -= dt;
    if (this.bossTimer <= 0) {
      let hasBoss = false;
      for (const it of this.items.values()) if (it.kind === "boss") { hasBoss = true; break; }
      if (!hasBoss) this.spawnOne(false, "boss");
      this.bossTimer = this.fever ? rand(12, 20) : rand(22, 34);
    }

    const gone = [];
    for (const it of this.items.values()) {
      it.life -= dt;
      if (it.life <= 0) { this.items.delete(it.id); gone.push(it.id); }
    }
    this.flushSpawns();
    if (gone.length) this.broadcast({ t: "despawn", ids: gone });

    if (this.hooksDirty) {                           // 别人的钩子和船位，10Hz 广播
      const h = {};
      for (const p of this.players.values()) {
        if (p.spec) continue;                        // 观众没有钩子也没有船，别占广播
        h[p.id] = [Math.round(p.hook.x), Math.round(p.hook.y), p.hook.st, p.hook.n,
                   Math.round(p.hook.s != null ? p.hook.s : p.hook.x)];
      }
      this.broadcast({ t: "hooks", h });
      this.hooksDirty = false;
    }

    this.tickAcc = (this.tickAcc || 0) + dt;
    if (this.tickAcc >= 1 || this.fever !== wasFever) {
      this.tickAcc = 0;
      const teamNow = this.coop ? this.playerList().reduce((a, p) => a + p.score, 0) : 0;
      this.broadcast({ t: "tick", time: Math.ceil(this.timeLeft), fever: this.fever,
                       players: this.playerList(), specs: this.specCount(),
                       coop: this.coop, target: this.target, team: teamNow });
    }
  }
}

// ── worker/index.js ─────────────────────────────────────
/* Cloudflare Worker + Durable Object：线上联机服务器
 *
 * 一个房间 = 一个 Durable Object 实例，房间逻辑复用 server/room.mjs，
 * 所以线上和本地跑的是同一份规则。
 *
 * 部署：见 worker/README.md
 * 连接：wss://<你的-worker>.workers.dev/room?room=ABCD&name=阿明
 */

const TICK_MS = 100;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/" || url.pathname === "/health") {
      return new Response("宝藏海湾联机服务器在跑。用 /room?room=XXXX 建立 WebSocket。", {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
    if (url.pathname !== "/room") return new Response("Not found", { status: 404 });
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("需要 WebSocket 升级请求", { status: 426 });
    }

    // 房间名决定去哪个 Durable Object，同名的人自然落在同一个实例
    const name = (url.searchParams.get("room") || "LOBBY").slice(0, 24).toUpperCase();
    const stub = env.ROOMS.get(env.ROOMS.idFromName(name));
    return stub.fetch(request);
  },
};

export class FishingRoom {
  constructor(state, env) {
    this.state   = state;
    this.clients = new Map();                       // clientId -> WebSocket
    this.nextId  = 1;
    this.timer   = null;
    this.room = new Room((id, msg) => {
      const ws = this.clients.get(id);
      if (!ws) return;
      try { ws.send(JSON.stringify(msg)); } catch (_) { this.drop(id); }
    });
  }

  async fetch(request) {
    const url   = new URL(request.url);
    const pname = url.searchParams.get("name") || "船长";
    const spec  = url.searchParams.get("spec") === "1";
    const pair  = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    const id = this.nextId++;

    server.accept();
    this.clients.set(id, server);
    this.room.join(id, pname, spec);
    this.ensureTicking();

    server.addEventListener("message", ev => {
      let msg;
      try { msg = JSON.parse(typeof ev.data === "string" ? ev.data : ""); } catch (_) { return; }
      this.room.message(id, msg);
    });
    const bye = () => this.drop(id);
    server.addEventListener("close", bye);
    server.addEventListener("error", bye);

    return new Response(null, { status: 101, webSocket: client });
  }

  drop(id) {
    this.clients.delete(id);
    this.room.leave(id);
    if (!this.clients.size && this.timer) {         // 房间空了就停掉定时器，不烧额度
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  ensureTicking() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      try { this.room.update(TICK_MS / 1000); } catch (_) {}
    }, TICK_MS);
  }
}
