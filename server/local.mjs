/* 本地联机服务器（开发 / 测试用）
 *
 *   npm install ws
 *   node server/local.mjs            # 默认 8787 端口
 *   PORT=9000 node server/local.mjs
 *
 * 然后用 ws://localhost:8787 当服务器地址打开游戏：
 *   index.html?server=ws://localhost:8787&room=test
 *
 * 线上请用 worker/（Cloudflare），这份只是让房间逻辑能在本机跑起来测。
 */
import { WebSocketServer } from "ws";
import { Room } from "./room.mjs";

const PORT = Number(process.env.PORT || 8787);
const TICK = 100;                                  // 房间步进间隔 ms

const rooms = new Map();                           // roomName -> {room, clients:Map}

function getRoom(name) {
  let entry = rooms.get(name);
  if (!entry) {
    const clients = new Map();                     // clientId -> ws
    const room = new Room((id, msg) => {
      const ws = clients.get(id);
      if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
    }, name);
    entry = { room, clients };
    rooms.set(name, entry);
  }
  return entry;
}

const wss = new WebSocketServer({ port: PORT });
let nextClientId = 1;

wss.on("connection", (ws, req) => {
  const url    = new URL(req.url, "http://x");
  const rname  = (url.searchParams.get("room") || "lobby").slice(0, 24).toUpperCase();
  const pname  = url.searchParams.get("name") || "船长";
  const id     = nextClientId++;
  const entry  = getRoom(rname);

  entry.clients.set(id, ws);
  entry.room.join(id, pname);
  console.log(`+ ${pname}#${id} → 房间 ${rname}（${entry.room.players.size} 人）`);

  ws.on("message", data => {
    let msg; try { msg = JSON.parse(data); } catch (_) { return; }
    entry.room.message(id, msg);
  });

  ws.on("close", () => {
    entry.clients.delete(id);
    entry.room.leave(id);
    console.log(`- #${id} 离开 ${rname}（剩 ${entry.room.players.size} 人）`);
    if (entry.room.empty) rooms.delete(rname);
  });

  ws.on("error", () => {});
});

setInterval(() => {
  for (const { room } of rooms.values()) room.update(TICK / 1000);
}, TICK);

console.log(`宝藏海湾联机服务器 ws://localhost:${PORT} 已启动`);
