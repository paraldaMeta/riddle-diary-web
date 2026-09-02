import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import geomancyLibrary from '../src/geomancy-library.json' with { type: 'json' };
import worker from '../src/worker.js';
import {
  ORACLE_SYSTEM_PROMPT,
  ORIGINAL_DIARY_SYSTEM_PROMPT,
  HANDWRITING_INSTRUCTION,
  appendGeomancyInstruction,
  buildGeomancyInstruction,
  combineGeomancyPatterns,
  deserializeGeomancyDraw,
  drawGeomancyEntry,
  parseOracleReply,
  secureRandomIndex,
  serializeGeomancyDraw,
  validateGeomancyLibrary,
} from '../src/geomancy.js';

const library = validateGeomancyLibrary(geomancyLibrary);
assert.equal(library.entries.length, 128);
assert.equal(Object.keys(library.figures).length, 16);
assert.equal(new Set(Object.values(library.figures).map(pattern => pattern.join(''))).size, 16);
assert.deepEqual(library.entries.map(entry => entry.id), Array.from({ length: 128 }, (_, index) => index + 1));
assert.equal(new Set(library.entries.map(entry => `${entry.left}|${entry.right}`)).size, 128);
assert.ok(library.entries.every(entry => entry.readings.length >= 28));

for (const entry of library.entries) {
  assert.deepEqual(
    combineGeomancyPatterns(library.figures[entry.left], library.figures[entry.right]),
    library.figures[entry.result],
    `第 ${entry.id} 组结果必须符合点数合成规则`,
  );
  const roundTrip = deserializeGeomancyDraw(serializeGeomancyDraw({
    ...entry,
    patterns: {
      left: library.figures[entry.left],
      right: library.figures[entry.right],
      result: library.figures[entry.result],
    },
  }));
  assert.ok(roundTrip, `第 ${entry.id} 组必须能安全写入响应头`);
  assert.deepEqual(roundTrip.topics, entry.readings.map(reading => reading.topic));
}

const first = drawGeomancyEntry(library, values => { values[0] = 0; });
const last = drawGeomancyEntry(library, values => { values[0] = 127; });
assert.equal(first.id, 1);
assert.equal(last.id, 128);
assert.equal(secureRandomIndex(128, values => { values[0] = 255; }), 127);

const rejectionValues = [0xffffffff, 9];
assert.equal(secureRandomIndex(10, values => { values[0] = rejectionValues.shift(); }), 9);

const instruction = buildGeomancyInstruction(first);
assert.match(instruction, /第 1 组｜快乐 ＋ 男子 ＝ 获得/);
assert.ok(instruction.includes(first.core));
assert.ok(first.readings.every(reading => instruction.includes(`${reading.topic}：${reading.text}`)));
assert.ok(!instruction.includes(library.entries[1].core));

const openAI = { messages: [{ role: 'user', content: [{ type: 'text', text: '问题' }] }] };
appendGeomancyInstruction(openAI, 'openai', instruction);
assert.equal(openAI.messages[0].content.at(-1).text, instruction);

const anthropic = { messages: [{ role: 'user', content: [{ type: 'image', source: {} }] }] };
appendGeomancyInstruction(anthropic, 'anthropic', instruction);
assert.equal(anthropic.messages[0].content.at(-1).text, instruction);

const gemini = { contents: [{ role: 'user', parts: [{ text: '问题' }] }] };
appendGeomancyInstruction(gemini, 'gemini', instruction);
assert.equal(gemini.contents[0].parts.at(-1).text, instruction);

const encoded = serializeGeomancyDraw(first);
const publicDraw = deserializeGeomancyDraw(encoded);
assert.equal(publicDraw.id, first.id);
assert.deepEqual(publicDraw.patterns.result, first.patterns.result);
assert.deepEqual(publicDraw.topics, first.readings.map(reading => reading.topic));
assert.ok(encoded.length < 4096);
assert.equal(deserializeGeomancyDraw('not-json'), null);

const prediction = parseOracleReply('[[GEOMANCY:财富]]\n先看清现有资源，再决定下一步。', publicDraw);
assert.equal(prediction.isPrediction, true);
assert.equal(prediction.topic, '财富');
assert.equal(prediction.draw.id, 1);
assert.equal(prediction.text, '先看清现有资源，再决定下一步。');

const inventedTopic = parseOracleReply('[[GEOMANCY:模型编造的主题]]\n不能显示未抽中的主题。', publicDraw);
assert.equal(inventedTopic.isPrediction, false);
assert.equal(inventedTopic.draw, null);

const ordinary = parseOracleReply('[[GEOMANCY:NONE]]\n这是一个普通回答。', publicDraw);
assert.equal(ordinary.isPrediction, false);
assert.equal(ordinary.draw, null);
assert.equal(ordinary.text, '这是一个普通回答。');

const unmarked = parseOracleReply('没有机器标记也不能误显示卦象。', publicDraw);
assert.equal(unmarked.isPrediction, false);
assert.equal(unmarked.text, '没有机器标记也不能误显示卦象。');

assert.match(ORACLE_SYSTEM_PROMPT, /文化娱乐/);
assert.match(ORACLE_SYSTEM_PROMPT, /不得照搬为确定的死亡时间/);
assert.match(ORIGINAL_DIARY_SYSTEM_PROMPT, /十六岁汤姆·马沃罗·里德尔留下的记忆/);
assert.match(ORIGINAL_DIARY_SYSTEM_PROMPT, /提到霍格沃茨、斯莱特林、邓布利多/);
assert.equal(
  createHash('sha256').update(ORIGINAL_DIARY_SYSTEM_PROMPT).digest('hex'),
  'f2dfb8a0a3fccf4662cd306df2c79674c0a1bb72e2e6e7b2ccdbbba99cb1d001',
  '原始日记提示词必须保持与地占功能加入前完全一致',
);
assert.match(ORACLE_SYSTEM_PROMPT, /不替代或改写上述身份、记忆/);
assert.match(ORACLE_SYSTEM_PROMPT, /非预测问题，必须继续完全按照原来的魔法日记人格回应/);
assert.match(HANDWRITING_INSTRUCTION, /单个词、简短问候、英文或中英混合都是有效输入/);
assert.doesNotMatch(HANDWRITING_INSTRUCTION, /不要复述无法确认的笔画/);

const originalFetch = globalThis.fetch;
let upstreamRequest;
let upstreamCalls = 0;
globalThis.fetch = async (url, init) => {
  upstreamCalls += 1;
  upstreamRequest = { url: String(url), init };
  return new Response(JSON.stringify({
    choices: [{ message: { content: '[[GEOMANCY:财富]]\n保持清醒，再迈出下一步。' } }],
  }), { headers: { 'Content-Type': 'application/json' } });
};

try {
  const image = 'data:image/png;base64,iVBORw0KGgo=';
  const malformedResponse = await worker.fetch(new Request('https://book.test/api/proxy', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      protocol: 'openai',
      url: 'https://api.openai.com/v1/chat/completions',
      apiKey: 'test-key',
      payload: {},
    }),
  }));
  assert.equal(malformedResponse.status, 400);
  assert.equal(upstreamCalls, 0);

  const defaultResponse = await worker.fetch(new Request('https://book.test/api/ask', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image }),
  }), { NVIDIA_API_KEY: 'test-key' });
  assert.equal(defaultResponse.status, 200);
  assert.equal(upstreamCalls, 1);
  const defaultDraw = deserializeGeomancyDraw(defaultResponse.headers.get('X-Geomancy-Draw'));
  assert.ok(defaultDraw);
  const defaultPayload = JSON.parse(upstreamRequest.init.body);
  const defaultUserContent = defaultPayload.messages.at(-1).content;
  assert.equal(defaultUserContent[0].type, 'image_url');
  const defaultInstruction = defaultUserContent.find(part => part.type === 'text').text;
  assert.match(defaultInstruction, new RegExp(`第 ${defaultDraw.id} 组`));

  const proxyResponse = await worker.fetch(new Request('https://book.test/api/proxy', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      protocol: 'openai',
      url: 'https://api.openai.com/v1/chat/completions',
      apiKey: 'test-key',
      payload: {
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: ORACLE_SYSTEM_PROMPT },
          { role: 'user', content: [
            { type: 'image_url', image_url: { url: image } },
            { type: 'text', text: HANDWRITING_INSTRUCTION },
          ]},
        ],
      },
    }),
  }));
  assert.equal(proxyResponse.status, 200);
  assert.equal(upstreamCalls, 2);
  const proxyDraw = deserializeGeomancyDraw(proxyResponse.headers.get('X-Geomancy-Draw'));
  assert.ok(proxyDraw);
  const proxyPayload = JSON.parse(upstreamRequest.init.body);
  assert.equal(proxyPayload.messages[0].content, ORACLE_SYSTEM_PROMPT);
  assert.ok(proxyPayload.messages[0].content.startsWith(ORIGINAL_DIARY_SYSTEM_PROMPT));
  assert.equal(proxyPayload.messages[1].content[0].type, 'image_url');
  assert.equal(proxyPayload.messages[1].content[1].text, HANDWRITING_INSTRUCTION);
  const injected = proxyPayload.messages[1].content.at(-1).text;
  assert.match(injected, new RegExp(`第 ${proxyDraw.id} 组`));
  assert.match(injected, /GEOMANCY:NONE/);
} finally {
  globalThis.fetch = originalFetch;
}

console.log('geomancy: 128 combinations, deterministic draw, Worker injection, response parsing, and safety gates passed');
