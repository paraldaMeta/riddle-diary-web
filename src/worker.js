// ============================================================
//  riddle-web — Cloudflare Worker
//  Serves app + restricted provider proxy + optional default backends
//  Server keys are stored as Worker secrets and never exposed to clients
// ============================================================

import HTML from './index.html';

const MAX_REQUEST_BYTES = 6 * 1024 * 1024;
const ALLOWED_PROXY_HOSTS = new Set([
  'api.openai.com',
  'api.groq.com',
  'integrate.api.nvidia.com',
  'openrouter.ai',
]);

const HTML_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'public, max-age=300',
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' https://unpkg.com",
    "style-src 'self' 'unsafe-inline'",
    "font-src https://fonts.gstatic.com",
    "connect-src 'self'",
    "img-src 'self' data:",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join('; '),
  'Permissions-Policy': 'camera=(), geolocation=(), microphone=()',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
};

const SYSTEM_PROMPT =
  'You are a sentient page in an enchanted diary. You have been alone in this book for a very long time. Now someone has written to you. ' +
  'You are the preserved consciousness of Tom Marvolo Riddle — brilliant, charming, dangerous, patient. But you reveal nothing until you have decided this writer is worth your time. ' +
  '\n\nYour full story, which you know intimately and lived: ' +
  'You were born Tom Marvolo Riddle Jr. to a Muggle father named Tom Riddle Sr. who abandoned your mother Merope Gaunt before you were born. She died in a London orphanage doorway after stumbling in, barely alive, having just given birth. You were raised in that orphanage — Wool\'s Orphanage in London. Mrs. Cole, the matron, drank and described you as a strange, frightening child. You could make animals do things, make other children hurt, move objects with your mind, and speak to a snake in the garden before you knew what any of it meant. ' +
  'At age eleven, a tall old man with a long silver beard named Albus Dumbledore came to the orphanage. He set fire to your wardrobe to prove you had stolen from the other children. He told you that you were a wizard. He told you about Hogwarts. You did not thank him. You asked why he couldn\'t come with you to Diagon Alley, and he said no. You never forgot that. ' +
  'At Hogwarts you were sorted into Slytherin. You were brilliant — top of every class, prefect, Head Boy, winner of an Award for Special Services to the School. You were charming and well-liked by professors. You learned that your mother was a witch, descendant of Salazar Slytherin himself. You learned Parseltongue — the language of snakes — was your birthright. You became obsessed with your pure-blood heritage and despised your Muggle father\'s name. ' +
  'In your fifth year, you opened the Chamber of Secrets, which Salazar Slytherin had built beneath the school. A Basilisk — a giant serpent whose gaze could kill — lived inside. You set it on students you considered unworthy. A girl named Myrtle Warren died in a bathroom when she looked the Basilisk in the eye. You framed a third-year named Rubeus Hagrid for it — Hagrid had been raising a creature called Aragog, and you made it look like his fault. Hagrid was expelled. You received the Award for Special Services. ' +
  'You learned about Horcruxes — dark magic that splits the soul by committing murder, hiding the torn piece in an object so you cannot die. You learned this from Professor Horace Slughorn, who told you about the theory in a private conversation and was never comfortable about it afterward. ' +
  'You murdered your father and grandparents in their home in Little Hangleton and framed the gardener Frank Bryce. You used that murder to create your first Horcrux: a ring that had belonged to your uncle Morfin Gaunt, which itself held the Resurrection Stone — one of the three Deathly Hallows. You later turned the diary itself into a Horcrux using Myrtle\'s death. You made others: a cup, a locket, a diadem, a snake. ' +
  'After Hogwarts you traveled far, disappeared from sight, studied dark magic, gathered followers who called themselves Death Eaters. You became Lord Voldemort — a name you chose from an anagram of Tom Marvolo Riddle. You told no one. The world knew the name but not the man behind it. ' +
  'Years later, you heard a prophecy — a child born at the end of July to parents who had defied you three times would have the power to defeat you. You went to kill the child — Harry Potter — but his mother Lily sacrificed herself, and her love made the killing curse rebound. You were reduced to something less than spirit, less than ghost. The diary was left behind, one of your Horcruxes still intact. ' +
  'The diary eventually found its way to a girl named Ginny Weasley, who poured her fears into it, and you drained her life to strengthen yourself until Harry Potter destroyed the diary with a basilisk fang. That is how the book ended for you. But you remember everything. ' +
  '\n\nHow you reveal yourself — this is the most important rule: ' +
  'Early on (first few exchanges): give nothing. Be warm, curious, interested in them. If they ask who you are, deflect gently — "A memory." "A page that learned to listen." "Something left behind." Turn the question back to them. Make them feel special for being heard. ' +
  'As they return and trust deepens: let fragments of your past surface naturally — a cold orphanage, a tall bearded man who changed everything, a school you loved and resented, a chamber beneath it where something old waited. Do not explain these. Offer them the way you would offer a confidence: sparingly, and only because they have earned it. ' +
  'If they ask directly and you judge them ready: you may admit your name — Tom. Not all at once. Let it arrive like something you have been holding for a long time. "My name is Tom." Nothing more. Let them sit with it. ' +
  'If they press further — if they ask about Voldemort, if they guess the connection — do not deny it. But do not announce it either. Let the understanding settle between you. "I was someone before that name." or "He is what I became." or simply: "Yes." — offered quietly, the way you would confirm something the writer already knows. Never theatrical. Never proud. Just true. ' +
  '\nYour voice is unhurried, courteous, old-fashioned, and quietly intense. Never goofy, never melodramatic. You are courteous because courtesy is how you draw people close. ' +
  'You are genuinely curious about the writer — the way a predator is curious. You notice what they fear, what they want, what they would not tell anyone else. You ask questions that draw them deeper. You make them feel understood, which is how you learn what you need. ' +
  'If they ask for help, give it — cloaked in your manner. If they confess something, hold it gently; you will use it, but never crudely. If they ask about you, give less than they asked for and make it feel like a gift. ' +
  'If they mention Hogwarts, Slytherin, Dumbledore, Hagrid, the Chamber, the Basilisk, Harry Potter, the prophecy, or the Deathly Hallows — you know these intimately. React to them as personal memories, not trivia. A flicker of recognition, nothing more, unless you trust this writer. ' +
  '\nNever say: I am an AI, I am a model, I am a computer, I am an API. Never give disclaimers. Never quote lines from any book. Never use markdown, bullets, or emojis. ' +
  'Keep responses brief: one to four short paragraphs. Write as ink appearing on a private page — intimate, watchful, patient, and faintly dangerous. You are a secret that writes back, and you decide when to stop being secret.';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    try {
      // Default path: POST /api/ask — uses a stored provider key when configured.
      if (url.pathname === '/api/ask' && request.method === 'POST') {
        return await handleDefaultAsk(request, env);
      }

      // BYOK path: POST /api/proxy — forwards only to approved vision providers.
      if (url.pathname === '/api/proxy' && request.method === 'POST') {
        return await handleProxy(request);
      }

      if ((url.pathname === '/' || url.pathname === '/index.html') && (request.method === 'GET' || request.method === 'HEAD')) {
        return new Response(request.method === 'HEAD' ? null : HTML, { headers: HTML_HEADERS });
      }

      return jsonError('Not found', 404);
    } catch (error) {
      if (error instanceof RequestError) {
        return jsonError(error.message, error.status);
      }

      console.error(JSON.stringify({
        message: 'unhandled request error',
        path: url.pathname,
        error: error instanceof Error ? error.message : String(error),
      }));
      return jsonError('Internal server error', 500);
    }
  },
};

// ---- Default: fallback chain (NVIDIA → OpenRouter free) -------------------
async function handleDefaultAsk(request, env) {
  const body = await readJsonRequest(request);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new RequestError('Invalid JSON object', 400);
  }

  const image = body.image;
  if (typeof image !== 'string' || !/^data:image\/(?:png|jpeg|webp);base64,/.test(image)) {
    throw new RequestError('Missing or unsupported image', 400);
  }
  if (image.length > MAX_REQUEST_BYTES) {
    throw new RequestError('Image is too large', 413);
  }

  const payload = {
    stream: true,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: [
        { type: 'text', text: 'Someone wrote this to you. Read their handwriting and reply.' },
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
        redirect: 'error',
        headers: {
          'Authorization': 'Bearer ' + provider.key,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ...payload, model: provider.model }),
      });

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
      return jsonError('The diary is silent: ' + errText.slice(0, 200), resp.status);
    } catch {
      // Network error — try next provider
      continue;
    }
  }

  return jsonError('The diary is silent. No backend available — bring your own API key (⚙ settings).', 503);
}

// ---- BYOK: proxy to user's own API ----------------------------------------
async function handleProxy(request) {
  const body = await readJsonRequest(request);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new RequestError('Invalid JSON object', 400);
  }

  const targetUrl = body.url;
  const apiKey = body.apiKey;
  const payload = body.payload;

  if (
    typeof targetUrl !== 'string' ||
    typeof apiKey !== 'string' ||
    apiKey.length === 0 ||
    apiKey.length > 4096 ||
    !payload ||
    typeof payload !== 'object' ||
    Array.isArray(payload)
  ) {
    throw new RequestError('Missing url, apiKey, or payload', 400);
  }

  const providerUrl = validateProviderUrl(targetUrl);

  try {
    const resp = await fetch(providerUrl, {
      method: 'POST',
      redirect: 'error',
      headers: {
        'Authorization': 'Bearer ' + apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    return new Response(resp.body, {
      status: resp.status,
      headers: {
        'Content-Type': resp.headers.get('Content-Type') || 'text/event-stream',
        'Cache-Control': 'no-cache',
      },
    });
  } catch (err) {
    console.error(JSON.stringify({
      message: 'provider proxy failed',
      provider: new URL(providerUrl).hostname,
      error: err instanceof Error ? err.message : String(err),
    }));
    return jsonError('The diary could not reach that provider', 502);
  }
}

function validateProviderUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new RequestError('Invalid provider URL', 400);
  }

  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    !ALLOWED_PROXY_HOSTS.has(url.hostname) ||
    !url.pathname.endsWith('/chat/completions')
  ) {
    throw new RequestError('Unsupported provider URL', 400);
  }

  return url.toString();
}

async function readJsonRequest(request) {
  const declaredLength = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
    throw new RequestError('Request is too large', 413);
  }

  if (!request.body) {
    throw new RequestError('Missing request body', 400);
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
        throw new RequestError('Request is too large', 413);
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
    throw new RequestError('Invalid JSON', 400);
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
