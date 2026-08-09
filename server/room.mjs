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

export const GAME_TIME  = 60;
export const BONUS_CAP  = 25;     // 每局时间奖励上限（和单机一致）
export const FEVER_AT   = 20;
export const FEVER_MULT = 1.5;
export const OVER_HOLD  = 8;      // 结算停留几秒后回到大厅
const MAX_ITEMS = 26;
const MAX_CHAIN = 8;

// 场地常量必须和客户端一致
const W = 600, SEA_Y = 210, FLOOR_Y = 946, TOP = 250, SPAN = 666;

/* 出鱼表：必须和客户端 index.html 里的 KINDS 对得上（score / depth / w / move）。
   客户端另外还有画法、命中框等纯表现字段，服务器不需要。 */
export const SPEC = {
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
};
const SPEED = { coin:[12,28], swim:[24,64], drift:[6,14], paddle:[16,28],
                jet:[26,46], crawl:[26,44], rise:[8,16] };
const POOL = Object.keys(SPEC).filter(k => SPEC[k].w > 0);
const POOL_TOTAL = POOL.reduce((s, k) => s + SPEC[k].w, 0);

const timeBonus = score => score >= 400 ? 3 : score >= 150 ? 2 : score >= 60 ? 1 : 0;
const rand  = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;

export class Room {
  /** @param send  (clientId, msg) => void，只发给一个人
   *  @param name  房间名，仅用于日志 */
  constructor(send, name = "") {
    this.sendTo = send;
    this.name   = name;
    this.players = new Map();      // id -> {id, name, score, combo, hook}
    this.items   = new Map();      // id -> {id, kind, x, y, vx, life, bornAt}
    this.nextId  = 1;
    this.state   = "lobby";        // lobby | playing | over
    this.timeLeft = GAME_TIME;
    this.fever = false;
    this.bonusGiven = 0;
    this.spawnTimer = 0;
    this.chestTimer = 5;
    this.bossTimer  = 18;
    this.overAt = 0;
    this.hooksDirty = false;
  }

  // ───────────────────────── 收发 ─────────────────────────
  broadcast(msg, except = null) {
    for (const id of this.players.keys()) if (id !== except) this.sendTo(id, msg);
  }

  playerList() {
    return [...this.players.values()]
      .map(p => ({ id: p.id, name: p.name, score: p.score }))
      .sort((a, b) => b.score - a.score);
  }

  itemList() { return [...this.items.values()].map(this.wire); }
  wire(it) { return { id: it.id, kind: it.kind, x: Math.round(it.x), y: Math.round(it.y),
                      vx: Math.round(it.vx * 10) / 10, life: Math.round(it.life * 10) / 10 }; }

  // ───────────────────────── 进出房间 ─────────────────────────
  join(id, name) {
    const p = { id, name: (name || "船长").slice(0, 12), score: 0, combo: 0,
                hook: { x: W / 2, y: SEA_Y, st: "idle", n: 0 } };
    this.players.set(id, p);
    this.sendTo(id, { t: "welcome", you: id, state: this.state, time: Math.ceil(this.timeLeft),
                      fever: this.fever, players: this.playerList(), items: this.itemList() });
    this.broadcast({ t: "joined", p: { id: p.id, name: p.name, score: 0 } }, id);
    return p;
  }

  leave(id) {
    if (!this.players.delete(id)) return;
    this.broadcast({ t: "left", id });
    if (!this.players.size) this.reset("lobby");   // 房间空了就收拾干净
  }

  get empty() { return this.players.size === 0; }

  // ───────────────────────── 客户端消息 ─────────────────────────
  message(id, msg) {
    const p = this.players.get(id);
    if (!p || !msg || typeof msg.t !== "string") return;

    switch (msg.t) {
      case "ready":                                  // 任何人都能开一局
        if (this.state !== "playing") this.startRound();
        break;

      case "hook": {                                 // 只是给别人看的，不参与判定
        const h = p.hook;
        h.x  = clamp(+msg.x || 0, 0, W);
        h.y  = clamp(+msg.y || 0, 0, FLOOR_Y);
        h.st = msg.st === "down" || msg.st === "up" ? msg.st : "idle";
        h.n  = clamp(+msg.n || 0, 0, MAX_CHAIN);
        this.hooksDirty = true;
        break;
      }

      case "grab": {                                 // 先到先得，抢同一条鱼只能有一个赢
        if (this.state !== "playing") return;
        const it = this.items.get(+msg.id);
        if (!it) return;                             // 已经被别人钓走或过期了
        this.items.delete(it.id);
        const spec = SPEC[it.kind];
        if (spec.hazard) {                           // 水雷 / 破靴子
          p.combo = 0;
          if (spec.penalty) this.timeLeft = Math.max(0.1, this.timeLeft - spec.penalty);
          this.broadcast({ t: "grabbed", id: it.id, by: id, kind: it.kind, gained: 0,
                           score: p.score, combo: 0, bonus: 0,
                           time: Math.ceil(this.timeLeft) });
          break;
        }
        p.combo++;
        const mult   = Math.min(2, 1 + (p.combo - 1) * 0.1) * (this.fever ? FEVER_MULT : 1);
        const gained = Math.round(spec.score * mult);
        p.score += gained;
        let add = 0;
        if (!this.fever) {                           // FEVER 中不再加时，和单机同一条规则
          add = Math.min(timeBonus(spec.score), BONUS_CAP - this.bonusGiven);
          if (add > 0) { this.bonusGiven += add; this.timeLeft = Math.min(99, this.timeLeft + add); }
        }
        this.broadcast({ t: "grabbed", id: it.id, by: id, kind: it.kind, gained,
                         score: p.score, combo: p.combo, bonus: add,
                         time: Math.ceil(this.timeLeft) });
        break;
      }

      case "miss":                                   // 空钩，连击清零
        p.combo = 0;
        break;
    }
  }

  // ───────────────────────── 一局 ─────────────────────────
  startRound() {
    this.reset("playing");
    for (const p of this.players.values()) { p.score = 0; p.combo = 0; }
    this.broadcast({ t: "start", time: GAME_TIME, players: this.playerList() });
    for (let i = 0; i < 12; i++) this.spawnOne(true);   // 开局先铺一片鱼
    this.flushSpawns();
  }

  reset(state) {
    this.state = state;
    this.timeLeft = GAME_TIME;
    this.fever = false;
    this.bonusGiven = 0;
    this.spawnTimer = 0;
    this.chestTimer = rand(4, 7);
    this.bossTimer  = rand(15, 25);
    this.items.clear();
    this.pending = [];
  }

  endRound() {
    this.state = "over";
    this.timeLeft = 0;
    this.overAt = OVER_HOLD;
    this.broadcast({ t: "over", players: this.playerList() });
  }

  // ───────────────────────── 出鱼 ─────────────────────────
  spawnOne(scatter = false, forceKind = null) {
    if (this.items.size >= MAX_ITEMS) return null;
    let kind = forceKind;
    if (!kind) {
      let r = Math.random() * POOL_TOTAL;
      kind = POOL[0];
      for (const k of POOL) { if ((r -= SPEC[k].w) <= 0) { kind = k; break; } }
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
    if (!this.fever && this.timeLeft <= FEVER_AT) this.fever = true;

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

    if (this.hooksDirty) {                           // 别人的钩子，10Hz 广播
      const h = {};
      for (const p of this.players.values()) h[p.id] = [Math.round(p.hook.x), Math.round(p.hook.y), p.hook.st, p.hook.n];
      this.broadcast({ t: "hooks", h });
      this.hooksDirty = false;
    }

    this.tickAcc = (this.tickAcc || 0) + dt;
    if (this.tickAcc >= 1 || this.fever !== wasFever) {
      this.tickAcc = 0;
      this.broadcast({ t: "tick", time: Math.ceil(this.timeLeft), fever: this.fever,
                       players: this.playerList() });
    }
  }
}
