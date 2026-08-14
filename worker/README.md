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

把它填进游戏开始画面的「联机服务器」输入框 —— **直接粘贴 `https://` 那一行就行**，
游戏会自己换成 `wss://` 并补上 `/room`（裸域名也认）。填一次就记在浏览器里。

想验证服务器活着，直接用浏览器打开那个地址，应该看到一行中文提示。

> Cloudflare 网页后台（Workers & Pages 那一页）**只是用来看的** —— 请求数、日志、额度。
> 部署得靠上面这两条命令，后台的「Create application」建不出这个 Worker：
> 它需要仓库里的代码，还需要一个 Durable Object 绑定。

## 只有手机时（让 GitHub Actions 代替你的电脑部署）

想跨不同网络一起玩就必须部署这个 Worker，但部署命令要 Node。手上只有手机的话，
让 GitHub 帮你跑 —— 仓库里的 `.github/workflows/deploy-worker.yml` 就是干这个的，
**只能手动触发**，push 不会自动跑。全程在手机浏览器里点：

1. **拿 API Token**：Cloudflare 后台右上头像 → My Profile → API Tokens → Create Token
   → 选 **Edit Cloudflare Workers** 模板 → Continue → Create Token → **把那串复制下来**（只显示一次）。
2. **拿 Account ID**：Workers & Pages 页面右侧就有；或者看地址栏 `dash.cloudflare.com/<这一长串>` 里那段。
3. **存进仓库**：GitHub 仓库 → Settings → Secrets and variables → Actions → New repository secret，
   加两条（名字要一模一样）：
   - `CLOUDFLARE_API_TOKEN` = 第 1 步那串
   - `CLOUDFLARE_ACCOUNT_ID` = 第 2 步那串
4. **跑**：仓库 → Actions → 左边选 **Deploy multiplayer worker** → **Run workflow**。
5. 跑完点进日志，「部署」那一步里有一行 `https://treasure-cove-mp.<你的子域>.workers.dev`
   —— 那就是联机服务器地址。

Secret 没配好的话第一步就会明确报「缺哪个」；配好了会先空跑一遍检查配置，
有问题不会推上线。以后改了 `server/room.mjs`，再点一次 Run workflow 就是重新部署。

Token 是写权限，别贴到聊天里或截图 —— 泄漏了就到 Cloudflare 后台 Roll / Delete 掉重建。

## 没有电脑、也不想用 Actions（在后台的在线编辑器里粘贴部署）

只有手机、装不了 Node 的话，可以走这条路 —— 比命令行麻烦得多，能用电脑就别走这条。

仓库里的 `worker/bundled.js` 是**打包成单个文件**的同一份服务器（`worker/index.js` 加
`server/room.mjs` 合在一起，没有 import），就是给这种情况准备的：

1. 后台 **Workers & Pages → Create application → Create Worker**，起个名字，先部署那个默认的 Hello World。
2. 进去点 **Edit code**，把编辑器里的内容全删掉，粘贴 `worker/bundled.js` 的全部内容，保存部署。
3. 这时访问它会报错，因为还差绑定 —— 到 **Settings → Bindings → Add → Durable Object**，
   变量名填 `ROOMS`，类名选 / 填 `FishingRoom`。
4. 再打开一次 Worker 地址，看到那行中文提示就成了。

第 3 步是这条路最容易卡住的地方：Durable Object 命名空间要用**免费方案的 SQLite 后端**，
后台 UI 各版本给的入口不太一样，卡住了就换命令行 —— `npx wrangler deploy` 会把这些
（绑定 + migration）一次配好，因为 `wrangler.toml` 里已经写好了。

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
| C→S | `ready {dur,coop}` | 请求开一局，顺便定局时和是否合作模式 |
| C→S | `hook {x,y,st,n}` | 10Hz 上报自己的钩子，纯给别人看 |
| C→S | `grab {id,x,y}` | 我钩到了这条鱼 —— **先到先得，服务器仲裁**；`x,y` 是爆点 |
| C→S | `miss` | 空钩，连击清零 |
| C→S | `emote {e}` | 发快捷表情（0~3），服务器按人 700ms 限一次 |
| S→C | `welcome / joined / left` | 房间状态、谁进谁出 |
| S→C | `start / tick / over` | 开局、每秒的时间与 FEVER、结算排行 |
| S→C | `spawn {items} / despawn {ids}` | 出鱼（带 `x,y,vx,life`）、消失 |
| S→C | `grabbed {id,by,kind,gained,score,combo,bonus,x,y,time}` | 这条鱼归谁、分数与时间奖励 |
| S→C | `hooks {id:[x,y,st,n]}` | 所有人的钩子位置 |
| S→C | `emote {by,e}` | 谁发了什么表情 |

鱼的移动**不走网络**：出生时把 `x / y / vx / life` 发一次，两边各自按同样的参数推进，
所以没有每帧同步、也不会抖。真正需要仲裁的只有「这条鱼归谁」。
得分在**钩到那一刻**由服务器结算（不是拉上岸时），这样抢鱼的判定简单且不会两边都算分。

服务器只存鱼的**出生坐标**，不逐帧模拟。所以河豚 / 水雷的爆点由钓到的那个客户端在 `grab`
里上报 `x,y`，服务器原样转发 —— 这样一屋子人算出同一个爆炸范围。

**合作模式**：`welcome / start / tick` 都带 `coop` 与 `target`（目标分），`tick` 另外带
`team`（全员当前分之和），`over` 带 `team` 和 `win`。目标分 = 每人每 60 秒 2600，
按人头和局时缩放。模式和局时都由**第一个发 `ready` 的人**决定，局中不能改。

**墨囊**（`ink`）只在联机的鱼表里有权重：谁钓到它，其他客户端收到 `grabbed` 时看见
`kind === "ink"` 且 `by` 不是自己，就把自己的画面糊上墨。服务器不需要为它做任何特殊处理。
