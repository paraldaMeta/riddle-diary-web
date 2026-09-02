# The Geomancer’s Book of Answers

一页可以手写提问的黑金地占答案之书。访客可以自由书写，提交时需要登录；首次验证身份赠送 3 次，成功回答每次消耗 1 次。预测性问题会固定抽取 128 组地占组合之一，普通问题继续保持原有魔法日记人格。

> 项目保留 [farhan-beg/riddle-web](https://github.com/farhan-beg/riddle-web) 与 [MaximeRivest/riddle](https://github.com/MaximeRivest/riddle) 的历史。地占内容仅供文化娱乐与自我反思，不构成医疗、法律、财务或安全建议。

## 功能

- Pointer Events 压感书写、笔尾/右键擦除、停笔 2.8 秒提交
- iOS PWA 使用原始 2D 画布坐标；OAuth 和支付返回后按画布比例恢复笔迹
- 保留原日记提示词；视觉模型识别手写，短英文及中英混合输入仍视为有效问题
- 预测问题随机固定一组地占组合，回答时显示卦象与对应主题
- 中文回答使用霞鹜文楷，英文回答沿用 Dancing Script，均以墨迹动画浮现
- 沉浸式帐号注册：未登录访客打开书页后，书名自动淡去，注册引导、输入和确认控件按墨迹效果出现
- 邮箱验证码、邮箱密码、密码重置、Google OAuth 2.0 + PKCE
- 中国大陆手机号验证码适配器（阿里云短信；配置与审核完成前隐藏）
- D1 会话、不可变额度流水、订单与最近 100 条问答历史；不保存手写图片
- 六档永久次数包：¥30/60/100/200/500/1000，严格 ¥1/次
- Stripe Hosted Checkout；由 Dashboard 动态提供银行卡、Apple Pay、支付宝与微信支付
- 三首 Kevin MacLeod 的 CC BY 4.0 音乐顺序循环、低音量播放、静音记忆与按需离线缓存
- 可安装 PWA；帐号、支付、历史和 AI 响应永不由 Service Worker 缓存

## 架构

```text
浏览器 / PWA
  ├─ 静态书页、画布、帐号场景、音乐
  └─ 同源 /api/*（不接收模型 URL、模型名或 API 密钥）
         │
Cloudflare Worker
  ├─ D1：帐号、身份、会话、额度、订单、问答
  ├─ Turnstile + 频率限制
  ├─ Resend / Google / 阿里云短信
  ├─ Stripe Checkout + 签名 Webhook
  └─ xfastapi.ai OpenAI 兼容视觉模型
```

模型密钥只存在 Cloudflare Secret `AI_API_KEY` 中。旧版浏览器里的 `riddle-settings-v2` 与 `riddle-settings` 会被主动删除，旧 `/api/proxy` 已不存在。

额度由 D1 触发器原子扣除：同一用户的相同 `requestId` 只能产生一条使用记录。识别失败、上游失败或返回格式异常会生成退款流水；意外中断后悬挂超过十五分钟的请求也会由清理任务自动退回。成功重试直接返回原记录。管理员邮箱通过 `ADMIN_EMAILS` 识别，保留历史但成本为 0。

## 本地运行

```bash
npm ci
npx wrangler d1 migrations apply DB --local
npm run dev
```

`.dev.vars` 可以启用本地验证模式；它已被 Git 忽略。开发模式下以 `dev-test` 作为 Turnstile token 时，验证码接口会返回 `debugCode`，不得在生产环境开启。

检查命令：

```bash
npm test
npm run check
npm run test:api           # 需要本地 8787 端口已运行
python3 tools/test-ui.py   # 需要本地 8787 端口已运行及 Playwright
```

## 生产配置

先应用 D1 迁移：

```bash
CI=1 npx wrangler d1 migrations apply DB --remote
```

必须设置的 Secret：

```bash
npx wrangler secret put AUTH_SECRET
npx wrangler secret put AI_API_KEY
npx wrangler secret put TURNSTILE_SECRET_KEY
npx wrangler secret put TURNSTILE_SITE_KEY
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put AUTH_FROM_EMAIL
npx wrangler secret put STRIPE_SECRET_KEY
npx wrangler secret put STRIPE_WEBHOOK_SECRET
npx wrangler secret put ADMIN_EMAILS
```

Google 登录启用时：

```bash
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
```

Google 回调地址为 `https://你的域名/api/auth/google/callback`。

阿里云短信资质、签名及模板审核完成后，再设置以下 Secret，并把 `ENABLE_PHONE_AUTH` 改为 `true`：

```bash
npx wrangler secret put ALIYUN_SMS_ACCESS_KEY_ID
npx wrangler secret put ALIYUN_SMS_ACCESS_KEY_SECRET
npx wrangler secret put ALIYUN_SMS_SIGN_NAME
npx wrangler secret put ALIYUN_SMS_TEMPLATE_CODE
```

Stripe Webhook 地址为 `https://你的域名/api/webhooks/stripe`。至少订阅：

- `checkout.session.completed`
- `checkout.session.async_payment_succeeded`
- `checkout.session.async_payment_failed`
- `checkout.session.expired`
- `charge.refunded`
- `charge.dispute.created`

支付方式不要由浏览器指定。在 Stripe Dashboard 中为 CNY Hosted Checkout 开启银行卡、Apple Pay、支付宝与微信支付；实际展示仍取决于 Stripe 对帐号、设备及地区的审核和支持。

配置完成并通过测试后：

```bash
npm run deploy
```

## 接口

| 范围 | 接口 |
|---|---|
| 帐号 | `POST /api/auth/register`、`login`、`otp/request`、`otp/verify`、`password/reset`、`google/start`、`logout`；`GET /api/auth/google/callback`、`me` |
| 帐号数据 | `DELETE /api/account` |
| AI | `POST /api/ask`，只接受 `requestId` 与手写图片 |
| 充值 | `GET /api/billing/packages`、`payments`；`POST /api/billing/checkout`、`confirm` |
| Stripe | `POST /api/webhooks/stripe` |
| 问答 | `GET/DELETE /api/conversations`、`GET/DELETE /api/conversations/:id` |

典型状态码：未登录 `401`、余额不足 `402`、来源或验证失败 `403`、重复处理中 `409`、无法识别 `422`、频率限制 `429`、手机号或外部服务未配置 `503`。

## 数据与隐私

- 验证码只保存 HMAC 哈希，10 分钟过期，最多尝试 5 次。
- 密码采用独立盐、带版本参数的 scrypt。
- 浏览器只保存 `HttpOnly + Secure + SameSite=Lax` 随机会话 Cookie，D1 只保存令牌哈希。
- 问答只保存识别后的文字、回答、卦象和时间；第 101 条成功记录会淘汰最旧一条。
- 注销删除身份、会话和问答，支付记录去标识化保留。
- `src/privacy.html`、`terms.html`、`refund.html` 与 `music-credits.html` 提供站内说明。

## 项目结构

```text
├── migrations/                 # D1 帐号、额度、支付与历史 schema
├── worker/                     # 不作为静态资源发布的 API Worker
│   ├── auth.js                 # 登录、验证码、OAuth、注销
│   ├── billing.js              # Stripe 与额度入账/冲销
│   ├── oracle.js               # 服务端模型调用与自动退回
│   └── index.js                # 路由入口
├── src/
│   ├── audio/                  # 三首压缩 BGM（不预缓存）
│   ├── index.html              # 书写与回答动画
│   ├── portal.js / portal.css  # 帐号、充值、记录与沉浸注册 UI
│   ├── music.js                # 顺序播放、静音与按需缓存
│   ├── geomancy.js             # 提示词、抽取与解析
│   ├── geomancy-library.json   # 128 组地占内容，仅打包进 Worker
│   └── sw.js                   # PWA 离线外壳
└── tools/                      # 单元与浏览器测试
```

## 音乐与许可

`Frost Waltz`、`Fairytale Waltz` 与 `Mysterioso March` 均由 Kevin MacLeod 创作，按 CC BY 4.0 使用；本站做了网页 MP3 压缩转换。完整链接见站内音乐署名页。代码沿用 MIT 许可及上游版权声明。

中文界面和回答使用按 Unicode 范围切分的 `LXGW WenKai Lite` WebFont，浏览器只会下载当前文字涉及的分片；字体依据 SIL Open Font License 1.1 分发，许可文本见 `src/fonts/OFL-LXGW-WenKai.txt`。英文书名与英文回答继续使用本地化的 Dancing Script 字体文件。
