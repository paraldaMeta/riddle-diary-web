# Riddle Diary Web

An enchanted, handwritten AI diary for the browser. Write with a stylus, finger, or mouse; after a short pause the page absorbs your ink and streams a handwritten reply.

**Live site:** [https://riddle-diary-web.cotalk.workers.dev](https://riddle-diary-web.cotalk.workers.dev)

This repository preserves the history of [farhan-beg/riddle-web](https://github.com/farhan-beg/riddle-web), a browser adaptation of [MaximeRivest/riddle](https://github.com/MaximeRivest/riddle) for the reMarkable Paper Pro. It is the starting point for our own product experiments.

> This is an unofficial fan-made technical experiment. It is not affiliated with or endorsed by J. K. Rowling, Warner Bros., Wizarding World, Anthropic, or Cloudflare.

## Current baseline

- Pressure-sensitive drawing through Pointer Events
- Ink fade after 2.8 seconds of inactivity
- Vision-model handwriting recognition
- Streaming, word-by-word handwritten replies
- Dark OLED and parchment themes
- BYOK support for OpenAI, OpenRouter, Groq, and NVIDIA NIM
- Cloudflare Worker proxy with provider allowlisting, bounded request bodies, security headers, and structured error logging

The public deployment is currently **BYOK-only**. Open the settings panel and supply a restricted API key for a vision-capable model. The key is stored in your browser's `localStorage` and relayed through this Worker; use a key with a spending limit.

## Run locally

```bash
npm ci
npm run dev
```

Open `http://localhost:8787`.

Useful checks:

```bash
npm run types
npm run check
```

## Deploy to Cloudflare

```bash
npm ci
npm run check
npm run deploy
```

Wrangler reads the Worker name and compatibility settings from `wrangler.jsonc`.

Optionally configure a server-side default provider so visitors do not need their own key:

```bash
npx wrangler secret put NVIDIA_API_KEY
npx wrangler secret put OPENROUTER_API_KEY
```

Secrets are optional and must never be committed. Without them, `/api/ask` returns `503` and the UI asks the visitor to use BYOK.

## How it works

```text
Canvas handwriting
  → 2.8 seconds idle
  → ink fades
  → canvas exported as PNG
  → vision LLM reads the page
  → reply streams back
  → SVG handwriting appears word by word
```

The Worker exposes two same-origin endpoints:

| Endpoint | Purpose |
|---|---|
| `POST /api/ask` | Uses an optional server-side NVIDIA or OpenRouter secret |
| `POST /api/proxy` | Relays a visitor's BYOK request to an allowlisted provider |

## Compatible providers

The selected model must accept image input.

| Provider | Base URL |
|---|---|
| OpenAI | `https://api.openai.com/v1` |
| OpenRouter | `https://openrouter.ai/api/v1` |
| Groq | `https://api.groq.com/openai/v1` |
| NVIDIA NIM | `https://integrate.api.nvidia.com/v1` |

Local Ollama and arbitrary OpenAI-compatible hosts are intentionally disabled in this baseline because a public unrestricted proxy can be abused. We can add a safe local-direct path later.

## Gestures

| Action | Result |
|---|---|
| Write, then rest the pen | The diary absorbs the ink and answers |
| Flip the pen or right-click | Erase |
| Draw a small `?` | Show the built-in guide |
| Press `Escape` | Clear the page |
| Tap `⚙` | Open provider and theme settings |

## Project layout

```text
riddle-diary-web/
├── src/
│   ├── index.html              # Canvas UI, drawing, fade, stream parser, reply animation
│   └── worker.js               # HTML server, default backend, restricted BYOK proxy
├── worker-configuration.d.ts # Generated Cloudflare runtime types
├── wrangler.jsonc           # Worker configuration
├── package.json
└── LICENSE                  # MIT; retains the upstream copyright notice
```

## Credits

- reMarkable concept and original implementation: [MaximeRivest/riddle](https://github.com/MaximeRivest/riddle)
- Browser adaptation: [farhan-beg/riddle-web](https://github.com/farhan-beg/riddle-web)
- Reply font: [Dancing Script](https://github.com/googlefonts/DancingScript), SIL Open Font License 1.1
- Code license: MIT
