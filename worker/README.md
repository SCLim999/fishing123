# 联机服务器部署（Cloudflare Workers + Durable Objects）

游戏本体是纯静态的，但**真实时联机需要一台能转发消息的服务器**。这里用 Cloudflare
Worker + Durable Object：一个房间就是一个 Durable Object 实例，同房间码的人自然落在同一个实例上。

## 部署（约 5 分钟）

```bash
npm install -g wrangler        # 或 npx wrangler
cd worker
wrangler login                 # 浏览器里授权你的 Cloudflare 账号
wrangler deploy
```

部署完会打印一个地址，例如：

```
https://treasure-cove-mp.<你的子域>.workers.dev
```

把它填进游戏开始画面的「联机服务器」输入框（**填 https:// 或 wss:// 都行，
游戏会自动补成 `wss://…/room`**），填一次就记在浏览器里。

想验证服务器活着，直接用浏览器打开那个地址，应该看到一行中文提示。

## 邀请朋友

链接里可以直接带上服务器和房间码，对方点开就进同一片海：

```
https://sclim999.github.io/fishing123/?server=wss://treasure-cove-mp.<子域>.workers.dev&room=ABCD
```

## 本地开发 / 测试

不想每次都部署到线上：

```bash
npm install ws
node server/local.mjs                     # ws://localhost:8787
# 然后打开 index.html?server=ws://localhost:8787&room=TEST
```

`server/room.mjs` 是房间逻辑，线上的 Worker 和本地的 Node 服务器**共用同一份**，
所以两边规则不会跑偏。

## 费用

Durable Objects 在 Cloudflare 免费方案上可用（`wrangler.toml` 里用的是
`new_sqlite_classes`，即免费方案要求的 SQLite 存储后端）。房间没人时会自动停掉
定时器，不会持续消耗额度。具体额度以 Cloudflare 当前的方案说明为准。

## 协议速览

服务器管「世界」，客户端管「手感」：

| 方向 | 消息 | 作用 |
|---|---|---|
| C→S | `join`（走 URL 参数）| 带房间码和昵称连上来 |
| C→S | `ready` | 请求开一局 |
| C→S | `hook {x,y,st,n}` | 10Hz 上报自己的钩子，纯给别人看 |
| C→S | `grab {id}` | 我钩到了这条鱼 —— **先到先得，服务器仲裁** |
| C→S | `miss` | 空钩，连击清零 |
| S→C | `welcome / joined / left` | 房间状态、谁进谁出 |
| S→C | `start / tick / over` | 开局、每秒的时间与 FEVER、结算排行 |
| S→C | `spawn {items} / despawn {ids}` | 出鱼（带 `x,y,vx,life`）、消失 |
| S→C | `grabbed {id,by,gained,score,combo,bonus,time}` | 这条鱼归谁、分数与时间奖励 |
| S→C | `hooks {id:[x,y,st,n]}` | 所有人的钩子位置 |

鱼的移动**不走网络**：出生时把 `x / y / vx / life` 发一次，两边各自按同样的参数推进，
所以没有每帧同步、也不会抖。真正需要仲裁的只有「这条鱼归谁」。
得分在**钩到那一刻**由服务器结算（不是拉上岸时），这样抢鱼的判定简单且不会两边都算分。
