/* Cloudflare Worker + Durable Object：线上联机服务器
 *
 * 一个房间 = 一个 Durable Object 实例，房间逻辑复用 server/room.mjs，
 * 所以线上和本地跑的是同一份规则。
 *
 * 部署：见 worker/README.md
 * 连接：wss://<你的-worker>.workers.dev/room?room=ABCD&name=阿明
 */
import { Room } from "../server/room.mjs";

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
    const pair  = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    const id = this.nextId++;

    server.accept();
    this.clients.set(id, server);
    this.room.join(id, pname);
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
