# The Book of Geomancy Answers

一本可以手写提问的地占答案之书。使用手写笔、手指或鼠标写下问题，停笔片刻后，页面会读取墨迹并让视觉模型辨认文字。预测性问题会随机抽取一组地占卦象，从对应主题中选择最接近的内容生成回答；普通问题则直接回答，不显示卦象。

**在线体验：** [https://riddle-diary-web.cotalk.workers.dev](https://riddle-diary-web.cotalk.workers.dev)

本仓库保留了 [farhan-beg/riddle-web](https://github.com/farhan-beg/riddle-web) 的历史；该项目是 [MaximeRivest/riddle](https://github.com/MaximeRivest/riddle) 在 reMarkable Paper Pro 上的概念所衍生出的浏览器版本。

> 本项目由早期的非官方粉丝技术实验演变而来，与上游作品权利人、模型提供方或 Cloudflare 均无隶属或背书关系。地占结果仅供文化娱乐与自我反思，不构成医疗、法律、财务或人身安全建议。

## 当前功能

- 基于 Pointer Events 的压感手写
- 停笔 2.8 秒后吸收墨迹
- 视觉模型辨认手写内容
- Web Crypto 随机抽取 128 组地占组合之一
- 预测问题按最接近主题生成回答，并显示“左卦＋右卦＝结果卦”
- 非预测问题自动跳过卦象
- 中文流式回复与逐字墨迹动画
- OLED 纯黑和羊皮纸主题
- 可安装 PWA 与离线应用外壳
- 最多保存 30 套 API 连接，并可新增、复制、删除和切换
- 支持 Anthropic Claude、OpenAI、Google Gemini、自定义 OpenAI 兼容协议和自定义 Claude 协议
- Cloudflare Worker 负责请求大小限制、公开 HTTPS 地址校验、内网目标拦截及错误日志

公开部署目前以用户自备 API 密钥为主。密钥与连接配置只保存在当前浏览器的 `localStorage`，请求经本站 Worker 临时转发；建议使用设置了额度上限的受限密钥。所选模型必须支持图片输入。

可以从浏览器的应用菜单安装。在支持安装事件的 Chromium 浏览器中，页面左上角也会出现“安装”按钮。首次成功打开后，界面可以离线启动，但 AI 回复仍需联网。

## 本地运行

```bash
npm ci
npm run dev
```

打开 `http://localhost:8787`。

常用检查：

```bash
npm test
npm run types
npm run check
```

## 部署到 Cloudflare

```bash
npm ci
npm run check
npm run deploy
```

Wrangler 会从 `wrangler.jsonc` 读取 Worker 名称、静态资源目录和兼容性设置。

如需为访客提供无需自备密钥的默认通道，可选择设置服务端密钥：

```bash
npx wrangler secret put NVIDIA_API_KEY
npx wrangler secret put OPENROUTER_API_KEY
```

密钥是可选项，绝不能提交到 Git。未设置时，`/api/ask` 返回 `503`，界面会提示访客在设置中填写自己的 API 密钥。

## 工作流程

```text
手写内容
  → 停笔 2.8 秒
  → 墨迹淡出
  → 画布导出为 PNG
  → Worker 用安全随机数固定一组地占组合
  → 视觉模型辨认文字并判断是否属于预测问题
      ├─ 预测问题：匹配该组合中最接近的主题
      │             → 显示三组卦象与主题答案
      └─ 普通问题：忽略抽取结果，直接回答
  → SVG 墨迹逐字浮现
```

Worker 暴露两个同源接口：

| 接口 | 用途 |
|---|---|
| `POST /api/ask` | 使用可选的服务端 NVIDIA 或 OpenRouter 密钥 |
| `POST /api/proxy` | 按当前连接的协议临时转发用户自备密钥请求 |

Cloudflare 从 `src/` 直接提供 PWA 静态资源。`src/.assetsignore` 防止服务端 `worker.js` 和完整地占内容库进入公开资源包；每次只会把当前抽中的一组内容发送给模型。`src/_headers` 负责 CSP、安全响应头和 PWA 缓存策略。

## API 连接

| 配置项 | 行为 |
|---|---|
| Anthropic Claude | 自动使用官方 `/v1/messages` 协议 |
| OpenAI | 自动使用官方 `/v1/chat/completions` 协议 |
| Google Gemini | 自动使用官方 `streamGenerateContent` 协议 |
| 自定义（OpenAI 兼容） | Base URL 可填写兼容服务的 `/v1` 地址或完整 `/chat/completions` 地址 |
| 自定义（Claude 协议） | Base URL 支持裸域名、`/v1` 或完整 `/v1/messages` 地址 |

自定义目标必须是公开 HTTPS 地址；本机、内网、私有 IP 和不符合所选协议路径的目标会在 Worker 层被拒绝。

## 操作

| 动作 | 结果 |
|---|---|
| 写完后停笔 | 答案之书读取墨迹并回答 |
| 翻转手写笔或右键 | 擦除 |
| 画一个较小的 `?` | 重新显示内置提示 |
| 按 `Escape` | 清空页面 |
| 点击 `⚙` | 打开连接和主题设置 |

## 项目结构

```text
riddle-diary-web/
├── src/
│   ├── icons/                  # SVG 源图与 32/180/192/512 PNG 图标
│   ├── geomancy.js             # 抽卦、组合校验、模型协议与响应解析
│   ├── geomancy-library.json   # 128 组卦象及主题内容，仅打包进 Worker
│   ├── index.html              # 中文界面、连接档案、手写与回复动画
│   ├── manifest.webmanifest    # PWA 身份和安装信息
│   ├── sw.js                   # 离线应用外壳与缓存生命周期
│   ├── _headers                # 静态资源安全头和缓存规则
│   ├── .assetsignore           # 防止 Worker 源码和内容库作为静态资源公开
│   └── worker.js               # 默认后端与受限 BYOK 转发
├── tools/test-geomancy.mjs     # 数据、随机数、协议和安全边界测试
├── worker-configuration.d.ts   # 自动生成的 Cloudflare 运行时类型
├── wrangler.jsonc              # Worker 配置
├── package.json
└── LICENSE                     # MIT；保留上游版权声明
```

## 致谢

- reMarkable 概念与最初实现：[MaximeRivest/riddle](https://github.com/MaximeRivest/riddle)
- 浏览器版本：[farhan-beg/riddle-web](https://github.com/farhan-beg/riddle-web)
- 英文标题字体：[Dancing Script](https://github.com/googlefonts/DancingScript)，SIL Open Font License 1.1
- 中文提示字体：[霞鹜文楷](https://github.com/lxgw/LxgwWenKai)，SIL Open Font License 1.1
- 代码许可证：MIT
