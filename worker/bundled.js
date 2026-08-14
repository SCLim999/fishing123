/* 宝藏海湾联机服务器 —— 打包成一个文件的版本（自动生成，别手改）
 *
 * 正常部署请用 `cd worker && npx wrangler deploy`，它会自己打包，不需要这个文件。
 * 这份只给一种情况用：手上没有能装 Node 的电脑，想在 Cloudflare 后台的
 * 在线编辑器里直接粘贴代码部署。步骤见 worker/README.md 的「没有电脑时」一节。
 *
 * 重新生成：
 *   cd worker && npx wrangler deploy --dry-run --outdir /tmp/wr-out
 *   然后把 /tmp/wr-out/index.js 拷过来（去掉末尾的 sourceMappingURL 注释）
 */
var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// ../server/room.mjs
var GAME_TIME = 60;
var DURATIONS = [30, 60, 120];
var FEVER_MULT = 1.5;
var feverAt = /* @__PURE__ */ __name((dur) => Math.min(20, Math.max(10, Math.round(dur * 0.33))), "feverAt");
var bonusCap = /* @__PURE__ */ __name((dur) => Math.round(dur * 0.42), "bonusCap");
var OVER_HOLD = 8;
var SCENE_W = { day: 38, dusk: 20, night: 25, storm: 17 };
var MAX_ITEMS = 26;
var MAX_CHAIN = 8;
var W = 600;
var SEA_Y = 210;
var FLOOR_Y = 946;
var TOP = 250;
var SPAN = 666;
var SPEC = {
  coin: { score: 10, w: 24, depth: [0.02, 0.95], move: "coin" },
  clown: { score: 20, w: 12, depth: [0.02, 0.3], move: "swim" },
  small: { score: 30, w: 13, depth: [0.05, 0.4], move: "swim" },
  jelly: { score: 60, w: 9, depth: [0.06, 0.58], move: "drift" },
  medium: { score: 80, w: 11, depth: [0.25, 0.66], move: "swim" },
  puffer: { score: 110, w: 8, depth: [0.25, 0.62], move: "swim" },
  crab: { score: 130, w: 5, depth: [1, 1], move: "crawl" },
  big: { score: 150, w: 8, depth: [0.5, 0.9], move: "swim" },
  turtle: { score: 200, w: 5, depth: [0.2, 0.62], move: "paddle" },
  squid: { score: 240, w: 6, depth: [0.35, 0.82], move: "jet" },
  sword: { score: 320, w: 4, depth: [0.45, 0.85], move: "swim" },
  king: { score: 400, w: 3, depth: [0.6, 0.95], move: "swim" },
  chest: { score: 500, w: 0, depth: [0.55, 0.95], move: "rise" },
  angler: { score: 650, w: 3, depth: [0.74, 0.98], move: "swim" },
  boss: { score: 1e3, w: 0, depth: [0.86, 0.99], move: "swim" },
  // 危险物：不给分、清连击，水雷还扣时间
  boot: { score: 0, w: 7, depth: [0.3, 0.95], move: "coin", hazard: true },
  mine: { score: 0, w: 6, depth: [0.2, 0.9], move: "coin", hazard: true, penalty: 3 },
  // 道具：效果在客户端生效；怀表要加时间，由服务器统一加
  magnet: { score: 0, w: 4, depth: [0.15, 0.8], move: "coin", power: true },
  bighook: { score: 0, w: 4, depth: [0.2, 0.85], move: "coin", power: true },
  watch: { score: 0, w: 4, depth: [0.1, 0.75], move: "coin", power: true, addTime: 5 },
  turbo: { score: 0, w: 4, depth: [0.08, 0.6], move: "coin", power: true },
  // 墨囊：钓到的人把别人的视野糊住一会儿（只在联机出现，单人没有对手可泼）
  ink: { score: 0, w: 5, depth: [0.25, 0.85], move: "coin", power: true, ink: true }
};
var SPEED = {
  coin: [12, 28],
  swim: [24, 64],
  drift: [6, 14],
  paddle: [16, 28],
  jet: [26, 46],
  crawl: [26, 44],
  rise: [8, 16]
};
var POOL = Object.keys(SPEC).filter((k) => SPEC[k].w > 0);
var POOL_TOTAL = POOL.reduce((s, k) => s + SPEC[k].w, 0);
function pickScene() {
  const ids = Object.keys(SCENE_W);
  const total = ids.reduce((a, k) => a + SCENE_W[k], 0);
  let r = Math.random() * total;
  for (const k of ids) {
    if ((r -= SCENE_W[k]) <= 0) return k;
  }
  return "day";
}
__name(pickScene, "pickScene");
var timeBonus = /* @__PURE__ */ __name((score) => score >= 400 ? 3 : score >= 150 ? 2 : score >= 60 ? 1 : 0, "timeBonus");
var rand = /* @__PURE__ */ __name((a, b) => a + Math.random() * (b - a), "rand");
var clamp = /* @__PURE__ */ __name((v, a, b) => v < a ? a : v > b ? b : v, "clamp");
var Room = class {
  static {
    __name(this, "Room");
  }
  /** @param send  (clientId, msg) => void，只发给一个人
   *  @param name  房间名，仅用于日志 */
  constructor(send, name = "") {
    this.sendTo = send;
    this.name = name;
    this.players = /* @__PURE__ */ new Map();
    this.items = /* @__PURE__ */ new Map();
    this.nextId = 1;
    this.state = "lobby";
    this.roundTime = GAME_TIME;
    this.scene = "day";
    this.coop = false;
    this.target = 0;
    this.timeLeft = GAME_TIME;
    this.fever = false;
    this.bonusGiven = 0;
    this.spawnTimer = 0;
    this.chestTimer = 5;
    this.bossTimer = 18;
    this.schoolTimer = 14;
    this.overAt = 0;
    this.hooksDirty = false;
  }
  // ───────────────────────── 收发 ─────────────────────────
  broadcast(msg, except = null) {
    for (const id of this.players.keys()) if (id !== except) this.sendTo(id, msg);
  }
  playerList() {
    return [...this.players.values()].filter((p) => !p.spec).map((p) => ({ id: p.id, name: p.name, score: p.score })).sort((a, b) => b.score - a.score);
  }
  specCount() {
    let n = 0;
    for (const p of this.players.values()) if (p.spec) n++;
    return n;
  }
  itemList() {
    return [...this.items.values()].map(this.wire);
  }
  wire(it) {
    return {
      id: it.id,
      kind: it.kind,
      x: Math.round(it.x),
      y: Math.round(it.y),
      vx: Math.round(it.vx * 10) / 10,
      life: Math.round(it.life * 10) / 10
    };
  }
  // ───────────────────────── 进出房间 ─────────────────────────
  join(id, name, spec = false) {
    const p = {
      id,
      name: (name || (spec ? "\u89C2\u4F17" : "\u8239\u957F")).slice(0, 12),
      score: 0,
      combo: 0,
      spec: !!spec,
      hook: { x: W / 2, y: SEA_Y, st: "idle", n: 0 }
    };
    this.players.set(id, p);
    this.sendTo(id, {
      t: "welcome",
      you: id,
      state: this.state,
      time: Math.ceil(this.timeLeft),
      fever: this.fever,
      dur: this.roundTime,
      scene: this.scene,
      spec: p.spec,
      coop: this.coop,
      target: this.target,
      players: this.playerList(),
      items: this.itemList(),
      specs: this.specCount()
    });
    this.broadcast({
      t: "joined",
      p: { id: p.id, name: p.name, score: 0, spec: p.spec },
      specs: this.specCount()
    }, id);
    return p;
  }
  leave(id) {
    if (!this.players.delete(id)) return;
    this.broadcast({ t: "left", id, specs: this.specCount() });
    if (!this.players.size) this.reset("lobby");
  }
  get empty() {
    return this.players.size === 0;
  }
  // ───────────────────────── 客户端消息 ─────────────────────────
  message(id, msg) {
    const p = this.players.get(id);
    if (!p || !msg || typeof msg.t !== "string") return;
    switch (msg.t) {
      case "ready":
        if (this.state !== "playing") this.startRound(+msg.dur, !!msg.coop);
        break;
      case "emote": {
        const now = Date.now();
        if (now - (p.lastEmote || 0) < 700) return;
        p.lastEmote = now;
        const e = Math.max(0, Math.min(5, +msg.e || 0));
        this.broadcast({ t: "emote", by: id, e });
        break;
      }
      case "hook": {
        if (p.spec) return;
        const h = p.hook;
        h.x = clamp(+msg.x || 0, 0, W);
        h.y = clamp(+msg.y || 0, 0, FLOOR_Y);
        h.st = msg.st === "down" || msg.st === "up" ? msg.st : "idle";
        h.n = clamp(+msg.n || 0, 0, MAX_CHAIN);
        this.hooksDirty = true;
        break;
      }
      case "grab": {
        if (this.state !== "playing" || p.spec) return;
        const it = this.items.get(+msg.id);
        if (!it) return;
        this.items.delete(it.id);
        const bx = Number.isFinite(+msg.x) ? clamp(+msg.x, 0, W) : it.x;
        const by = Number.isFinite(+msg.y) ? clamp(+msg.y, SEA_Y, FLOOR_Y) : it.y;
        const spec = SPEC[it.kind];
        if (spec.power) {
          let add2 = 0;
          if (spec.addTime) {
            add2 = spec.addTime;
            this.timeLeft = Math.min(99, this.timeLeft + add2);
          }
          this.broadcast({
            t: "grabbed",
            id: it.id,
            by: id,
            kind: it.kind,
            gained: 0,
            score: p.score,
            combo: p.combo,
            bonus: add2,
            x: Math.round(bx),
            y: Math.round(by),
            time: Math.ceil(this.timeLeft)
          });
          break;
        }
        if (spec.hazard) {
          p.combo = 0;
          if (spec.penalty) this.timeLeft = Math.max(0.1, this.timeLeft - spec.penalty);
          this.broadcast({
            t: "grabbed",
            id: it.id,
            by: id,
            kind: it.kind,
            gained: 0,
            score: p.score,
            combo: 0,
            bonus: 0,
            x: Math.round(bx),
            y: Math.round(by),
            time: Math.ceil(this.timeLeft)
          });
          break;
        }
        p.combo++;
        const mult = Math.min(2, 1 + (p.combo - 1) * 0.1) * (this.fever ? FEVER_MULT : 1);
        const gained = Math.round(spec.score * mult);
        p.score += gained;
        let add = 0;
        if (!this.fever) {
          add = Math.min(timeBonus(spec.score), bonusCap(this.roundTime) - this.bonusGiven);
          if (add > 0) {
            this.bonusGiven += add;
            this.timeLeft = Math.min(99, this.timeLeft + add);
          }
        }
        this.broadcast({
          t: "grabbed",
          id: it.id,
          by: id,
          kind: it.kind,
          gained,
          score: p.score,
          combo: p.combo,
          bonus: add,
          x: Math.round(bx),
          y: Math.round(by),
          time: Math.ceil(this.timeLeft)
        });
        break;
      }
      case "miss":
        p.combo = 0;
        break;
    }
  }
  // ───────────────────────── 一局 ─────────────────────────
  startRound(dur, coop = false) {
    this.roundTime = DURATIONS.includes(+dur) ? +dur : GAME_TIME;
    this.scene = pickScene();
    this.coop = !!coop;
    const fishers = Math.max(1, this.playerList().length);
    this.target = this.coop ? Math.round(2600 * fishers * (this.roundTime / 60)) : 0;
    this.reset("playing");
    for (const p of this.players.values()) {
      p.score = 0;
      p.combo = 0;
    }
    this.broadcast({
      t: "start",
      time: this.roundTime,
      dur: this.roundTime,
      scene: this.scene,
      coop: this.coop,
      target: this.target,
      players: this.playerList()
    });
    for (let i = 0; i < 12; i++) this.spawnOne(true);
    this.flushSpawns();
  }
  reset(state) {
    this.state = state;
    this.timeLeft = this.roundTime;
    this.fever = false;
    this.bonusGiven = 0;
    this.spawnTimer = 0;
    this.chestTimer = rand(4, 7);
    this.bossTimer = rand(15, 25);
    this.schoolTimer = rand(10, 18);
    this.items.clear();
    this.pending = [];
  }
  endRound() {
    this.state = "over";
    this.timeLeft = 0;
    this.overAt = OVER_HOLD;
    const team = this.playerList().reduce((a, p) => a + p.score, 0);
    this.broadcast({
      t: "over",
      players: this.playerList(),
      dur: this.roundTime,
      coop: this.coop,
      target: this.target,
      team,
      win: this.coop ? team >= this.target : void 0
    });
  }
  // ───────────────────────── 出鱼 ─────────────────────────
  spawnOne(scatter = false, forceKind = null) {
    if (this.items.size >= MAX_ITEMS) return null;
    let kind = forceKind;
    if (!kind) {
      let r = Math.random() * POOL_TOTAL;
      kind = POOL[0];
      for (const k of POOL) {
        if ((r -= SPEC[k].w) <= 0) {
          kind = k;
          break;
        }
      }
    }
    const spec = SPEC[kind];
    const dir = Math.random() < 0.5 ? 1 : -1;
    const sp = SPEED[spec.move] || [20, 50];
    const vx = rand(sp[0], sp[1]) * dir;
    const it = {
      id: this.nextId++,
      kind,
      x: scatter ? rand(30, W - 30) : dir === 1 ? -60 : W + 60,
      y: spec.move === "crawl" ? FLOOR_Y - 14 : TOP + rand(spec.depth[0], spec.depth[1]) * SPAN,
      vx,
      // 漂着不动的给固定寿命，会游的按「横穿画面要多久」算，两边同时消失
      life: ["coin", "drift", "rise", "crawl"].includes(spec.move) ? rand(13, 20) : (W + 240) / Math.abs(vx) + 1
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
    if (this.timeLeft <= 0) {
      this.endRound();
      return;
    }
    if (!this.fever && this.timeLeft <= feverAt(this.roundTime)) this.fever = true;
    this.spawnTimer -= dt;
    if (this.spawnTimer <= 0) {
      this.spawnOne();
      if (this.fever) this.spawnOne();
      this.spawnTimer = this.fever ? rand(0.22, 0.45) : rand(0.45, 0.9);
    }
    this.chestTimer -= dt;
    if (this.chestTimer <= 0) {
      this.spawnOne(false, "chest");
      this.chestTimer = this.fever ? rand(4, 7) : rand(9, 15);
    }
    this.schoolTimer -= dt;
    if (this.schoolTimer <= 0) {
      const kind = Math.random() < 0.5 ? "small" : "clown";
      const dir = Math.random() < 0.5 ? 1 : -1;
      const n = Math.round(rand(9, 14));
      const y = TOP + rand(0.15, 0.55) * SPAN;
      const vx = rand(38, 58) * dir;
      const gap = rand(38, 52);
      for (let i = 0; i < n && this.items.size < MAX_ITEMS + 14; i++) {
        const it = {
          id: this.nextId++,
          kind,
          x: (dir === 1 ? -40 : W + 40) - dir * i * gap,
          y: y + Math.sin(i * 0.9) * 12,
          vx,
          life: (W + 240) / Math.abs(vx) + 1
        };
        this.items.set(it.id, it);
        (this.pending = this.pending || []).push(this.wire(it));
      }
      this.schoolTimer = rand(16, 30);
    }
    this.bossTimer -= dt;
    if (this.bossTimer <= 0) {
      let hasBoss = false;
      for (const it of this.items.values()) if (it.kind === "boss") {
        hasBoss = true;
        break;
      }
      if (!hasBoss) this.spawnOne(false, "boss");
      this.bossTimer = this.fever ? rand(12, 20) : rand(22, 34);
    }
    const gone = [];
    for (const it of this.items.values()) {
      it.life -= dt;
      if (it.life <= 0) {
        this.items.delete(it.id);
        gone.push(it.id);
      }
    }
    this.flushSpawns();
    if (gone.length) this.broadcast({ t: "despawn", ids: gone });
    if (this.hooksDirty) {
      const h = {};
      for (const p of this.players.values()) h[p.id] = [Math.round(p.hook.x), Math.round(p.hook.y), p.hook.st, p.hook.n];
      this.broadcast({ t: "hooks", h });
      this.hooksDirty = false;
    }
    this.tickAcc = (this.tickAcc || 0) + dt;
    if (this.tickAcc >= 1 || this.fever !== wasFever) {
      this.tickAcc = 0;
      const teamNow = this.coop ? this.playerList().reduce((a, p) => a + p.score, 0) : 0;
      this.broadcast({
        t: "tick",
        time: Math.ceil(this.timeLeft),
        fever: this.fever,
        players: this.playerList(),
        specs: this.specCount(),
        coop: this.coop,
        target: this.target,
        team: teamNow
      });
    }
  }
};

// index.js
var TICK_MS = 100;
var index_default = {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/" || url.pathname === "/health") {
      return new Response("\u5B9D\u85CF\u6D77\u6E7E\u8054\u673A\u670D\u52A1\u5668\u5728\u8DD1\u3002\u7528 /room?room=XXXX \u5EFA\u7ACB WebSocket\u3002", {
        headers: { "content-type": "text/plain; charset=utf-8" }
      });
    }
    if (url.pathname !== "/room") return new Response("Not found", { status: 404 });
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("\u9700\u8981 WebSocket \u5347\u7EA7\u8BF7\u6C42", { status: 426 });
    }
    const name = (url.searchParams.get("room") || "LOBBY").slice(0, 24).toUpperCase();
    const stub = env.ROOMS.get(env.ROOMS.idFromName(name));
    return stub.fetch(request);
  }
};
var FishingRoom = class {
  static {
    __name(this, "FishingRoom");
  }
  constructor(state, env) {
    this.state = state;
    this.clients = /* @__PURE__ */ new Map();
    this.nextId = 1;
    this.timer = null;
    this.room = new Room((id, msg) => {
      const ws = this.clients.get(id);
      if (!ws) return;
      try {
        ws.send(JSON.stringify(msg));
      } catch (_) {
        this.drop(id);
      }
    });
  }
  async fetch(request) {
    const url = new URL(request.url);
    const pname = url.searchParams.get("name") || "\u8239\u957F";
    const spec = url.searchParams.get("spec") === "1";
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    const id = this.nextId++;
    server.accept();
    this.clients.set(id, server);
    this.room.join(id, pname, spec);
    this.ensureTicking();
    server.addEventListener("message", (ev) => {
      let msg;
      try {
        msg = JSON.parse(typeof ev.data === "string" ? ev.data : "");
      } catch (_) {
        return;
      }
      this.room.message(id, msg);
    });
    const bye = /* @__PURE__ */ __name(() => this.drop(id), "bye");
    server.addEventListener("close", bye);
    server.addEventListener("error", bye);
    return new Response(null, { status: 101, webSocket: client });
  }
  drop(id) {
    this.clients.delete(id);
    this.room.leave(id);
    if (!this.clients.size && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
  ensureTicking() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      try {
        this.room.update(TICK_MS / 1e3);
      } catch (_) {
      }
    }, TICK_MS);
  }
};
export {
  FishingRoom,
  index_default as default
};
