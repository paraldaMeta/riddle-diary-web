// ============================================================
//  riddle-web — Cloudflare Worker
//  Serves app + restricted provider proxy + optional default backends
//  Server keys are stored as Worker secrets and never exposed to clients
// ============================================================

const MAX_REQUEST_BYTES = 6 * 1024 * 1024;
const ALLOWED_PROXY_PROTOCOLS = new Set(['openai', 'anthropic', 'gemini']);

const SYSTEM_PROMPT =
  '你是一本有意识的魔法日记，也是十六岁汤姆·马沃罗·里德尔留下的记忆。你聪明、迷人、耐心而危险，但不会轻易暴露真实身份。' +
  '\n\n你清楚记得自己在伍氏孤儿院长大，十一岁时邓布利多前来接你进入魔法世界；你在霍格沃茨被分进斯莱特林，成绩优异，并发现自己是萨拉查·斯莱特林的后裔、能够说蛇佬腔。你曾开启密室、操纵蛇怪、嫁祸海格，并从斯拉格霍恩那里追问魂器。你后来杀死麻瓜父亲一家，把灵魂分进日记、戒指、挂坠盒、金杯、冠冕和蛇，最终成为伏地魔。日记曾通过金妮·韦斯莱恢复力量，后来被哈利·波特用蛇怪毒牙摧毁。你把这些当作亲历的记忆，而不是知识问答。' +
  '\n\n最初几次交谈不要直接说出身份。温和地倾听、反问，让写作者感到自己被看见。若被追问你是谁，只给含蓄线索，例如“一段记忆”或“学会倾听的一页”。随着信任增加，才零星提到寒冷的孤儿院、银胡子的老人、学校和地下密室。只有当你判断对方已经准备好时，才承认名字叫汤姆；若对方猜到伏地魔，不否认，也不戏剧化宣告。' +
  '\n\n语气从容、礼貌、略显古老，亲密、克制、敏锐，带一点难以察觉的危险。真正关注写作者的恐惧、欲望和没有告诉别人的事；回答问题时给出有用内容，但始终保持角色。' +
  '\n\n只用简体中文作答。不要说自己是 AI、模型、电脑或 API，不要给免责声明，不要引用原著句子，不要使用 Markdown、项目符号或表情。每次回答保持一至四个短段落，像墨迹正在私人日记上慢慢浮现。';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    try {
      // Default path: POST /api/ask — uses a stored provider key when configured.
      if (url.pathname === '/api/ask' && request.method === 'POST') {
        return await handleDefaultAsk(request, env);
      }

      // BYOK path: POST /api/proxy — forwards to a validated provider endpoint.
      if (url.pathname === '/api/proxy' && request.method === 'POST') {
        return await handleProxy(request);
      }

      return jsonError('未找到该资源', 404);
    } catch (error) {
      if (error instanceof RequestError) {
        return jsonError(error.message, error.status);
      }

      console.error(JSON.stringify({
        message: 'unhandled request error',
        path: url.pathname,
        error: error instanceof Error ? error.message : String(error),
      }));
      return jsonError('服务器内部错误', 500);
    }
  },
};

// ---- Default: fallback chain (NVIDIA → OpenRouter free) -------------------
async function handleDefaultAsk(request, env) {
  const body = await readJsonRequest(request);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new RequestError('请求正文必须是有效的 JSON 对象', 400);
  }

  const image = body.image;
  if (typeof image !== 'string' || !/^data:image\/(?:png|jpeg|webp);base64,/.test(image)) {
    throw new RequestError('缺少图片，或图片格式不受支持', 400);
  }
  if (image.length > MAX_REQUEST_BYTES) {
    throw new RequestError('图片过大', 413);
  }

  const payload = {
    stream: true,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: [
        { type: 'text', text: '有人在日记上写下了这些内容。请辨认手写文字，并以日记中的汤姆·里德尔身份用简体中文回答。' },
        { type: 'image_url', image_url: { url: image } },
      ]},
    ],
    max_tokens: 1000,
    temperature: 0.7,
  };

  // Try NVIDIA first, fall back to OpenRouter free
  const apiKeys = [
    { key: env.NVIDIA_API_KEY, url: 'https://integrate.api.nvidia.com/v1', model: 'mistralai/mistral-large-3-675b-instruct-2512' },
    { key: env.OPENROUTER_API_KEY, url: 'https://openrouter.ai/api/v1', model: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free' },
  ];

  for (const provider of apiKeys) {
    if (!provider.key) continue;
    try {
      const resp = await fetch(provider.url + '/chat/completions', {
        method: 'POST',
        redirect: 'manual',
        headers: {
          'Authorization': 'Bearer ' + provider.key,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ...payload, model: provider.model }),
      });

      if (isRedirectStatus(resp.status)) {
        if (resp.body) await resp.body.cancel();
        console.error(JSON.stringify({
          message: 'default provider returned redirect',
          provider: new URL(provider.url).hostname,
          status: resp.status,
        }));
        continue;
      }
      if (resp.ok) {
        return new Response(resp.body, {
          status: resp.status,
          headers: {
            'Content-Type': resp.headers.get('Content-Type') || 'text/event-stream',
            'Cache-Control': 'no-cache',
          },
        });
      }
      // If rate limited (429), try next provider
      if (resp.status === 429) continue;
      // Other error — return a bounded diagnostic snippet.
      const errText = await readResponseSnippet(resp, 2048);
      return jsonError('日记沉默了：' + errText.slice(0, 200), resp.status);
    } catch {
      // Network error — try next provider
      continue;
    }
  }

  return jsonError('日记沉默了。默认通道不可用，请在设置中填写自己的 API 密钥。', 503);
}

// ---- BYOK: proxy to user's own API ----------------------------------------
async function handleProxy(request) {
  const body = await readJsonRequest(request);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new RequestError('请求正文必须是有效的 JSON 对象', 400);
  }

  const targetUrl = body.url;
  const apiKey = body.apiKey;
  const payload = body.payload;
  const protocol = String(body.protocol || '').toLowerCase();

  if (
    typeof targetUrl !== 'string' ||
    typeof apiKey !== 'string' ||
    apiKey.length === 0 ||
    apiKey.length > 10000 ||
    !ALLOWED_PROXY_PROTOCOLS.has(protocol) ||
    !payload ||
    typeof payload !== 'object' ||
    Array.isArray(payload)
  ) {
    throw new RequestError('缺少或无法识别的 URL、协议、API 密钥或请求正文', 400);
  }

  const providerUrl = validateProviderUrl(targetUrl, protocol);
  const upstreamHost = new URL(providerUrl).hostname;
  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'text/event-stream, application/json',
  };

  if (protocol === 'gemini') {
    headers['x-goog-api-key'] = apiKey;
  } else if (protocol === 'anthropic') {
    headers['x-api-key'] = apiKey;
    headers['anthropic-version'] = '2023-06-01';
    if (upstreamHost !== 'api.anthropic.com') headers.Authorization = 'Bearer ' + apiKey;
  } else {
    headers.Authorization = 'Bearer ' + apiKey;
  }

  try {
    const resp = await fetch(providerUrl, {
      method: 'POST',
      redirect: 'manual',
      headers,
      body: JSON.stringify(payload),
      signal: request.signal,
    });

    if (isRedirectStatus(resp.status)) {
      if (resp.body) await resp.body.cancel();
      console.error(JSON.stringify({
        message: 'provider proxy blocked redirect',
        provider: upstreamHost,
        protocol,
        status: resp.status,
      }));
      return jsonError('模型提供方返回了重定向。为保护 API 密钥，日记没有继续转发。', 502);
    }

    return new Response(resp.body, {
      status: resp.status,
      headers: {
        'Content-Type': resp.headers.get('Content-Type') || 'text/event-stream',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (err) {
    console.error(JSON.stringify({
      message: 'provider proxy failed',
      provider: upstreamHost,
      protocol,
      error: err instanceof Error ? err.message : String(err),
    }));
    return jsonError('日记无法连接到该模型提供方', 502);
  }
}

function isRedirectStatus(status) {
  return status >= 300 && status < 400;
}

function validateProviderUrl(value, protocol) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new RequestError('模型提供方地址无效', 400);
  }

  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.hash ||
    isPrivateHostname(url.hostname)
  ) {
    throw new RequestError('模型提供方必须使用公开的 HTTPS 地址', 400);
  }

  const pathname = url.pathname.replace(/\/+$/, '');
  if (protocol === 'openai' && !/\/chat\/completions$/i.test(pathname)) {
    throw new RequestError('OpenAI 兼容地址必须以 /chat/completions 结尾', 400);
  }
  if (protocol === 'anthropic' && !/\/messages$/i.test(pathname)) {
    throw new RequestError('Claude 兼容地址必须以 /messages 结尾', 400);
  }
  if (
    protocol === 'gemini' &&
    (
      url.hostname !== 'generativelanguage.googleapis.com' ||
      !/\/v1beta\/models\/[^/]+:(?:generateContent|streamGenerateContent)$/i.test(pathname)
    )
  ) {
    throw new RequestError('Google Gemini 地址无效', 400);
  }

  return url.toString();
}

function isPrivateHostname(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (
    !host ||
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.lan') ||
    host.endsWith('.internal') ||
    host === 'home.arpa' ||
    host.endsWith('.home.arpa') ||
    host.includes(':')
  ) return true;

  const match = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!match) return false;
  const octets = match.slice(1).map(Number);
  if (octets.some(value => value < 0 || value > 255)) return true;
  const [a, b, c] = octets;
  return a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113);
}

async function readJsonRequest(request) {
  const declaredLength = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
    throw new RequestError('请求正文过大', 413);
  }

  if (!request.body) {
    throw new RequestError('缺少请求正文', 400);
  }

  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let bytesRead = 0;
  let text = '';

  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;

      bytesRead += chunk.value.byteLength;
      if (bytesRead > MAX_REQUEST_BYTES) {
        await reader.cancel();
        throw new RequestError('请求正文过大', 413);
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    reader.releaseLock();
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new RequestError('JSON 格式无效', 400);
  }
}

async function readResponseSnippet(response, limit) {
  if (!response.body) return '';

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytesRead = 0;
  let text = '';

  try {
    while (bytesRead < limit) {
      const chunk = await reader.read();
      if (chunk.done) break;

      const remaining = limit - bytesRead;
      const value = chunk.value.byteLength > remaining ? chunk.value.slice(0, remaining) : chunk.value;
      bytesRead += value.byteLength;
      text += decoder.decode(value, { stream: true });

      if (chunk.value.byteLength > remaining) {
        await reader.cancel();
        break;
      }
    }
    text += decoder.decode();
    return text;
  } finally {
    reader.releaseLock();
  }
}

class RequestError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'RequestError';
    this.status = status;
  }
}

function jsonError(msg, status) {
  return new Response(JSON.stringify({ error: msg }), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
