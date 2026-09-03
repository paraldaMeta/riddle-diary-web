import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import geomancyLibrary from '../src/geomancy-library.json' with { type: 'json' };
import { CREDIT_PACKAGES, MEMBERSHIP_PLANS, findMembershipPlan, findPackage } from '../worker/config.js';
import { creditsForRefund, parseStripeSignature, verifyWebhook } from '../worker/billing.js';
import { hashPassword, verifyPassword } from '../worker/crypto.js';
import { hmacSha256 } from '../worker/http.js';
import { parseModelReply } from '../worker/oracle.js';
import {
  ORACLE_SYSTEM_PROMPT,
  ORIGINAL_DIARY_SYSTEM_PROMPT,
  GENERAL_GEOMANCY_TOPIC,
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

const instruction = buildGeomancyInstruction(first, 'zh-CN');
assert.match(instruction, /第 1 组｜快乐 ＋ 男子 ＝ 获得/);
assert.ok(instruction.includes(first.core));
assert.ok(first.readings.every(reading => instruction.includes(`${reading.topic}：${reading.text}`)));
assert.ok(!instruction.includes(library.entries[1].core));
const englishInstruction = buildGeomancyInstruction(first, 'en-US');
assert.match(englishInstruction, /Laetitia \+ Puer = Acquisitio/);
assert.match(englishInstruction, /\[\[GEOMANCY:基本卦义\]\]/);

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
assert.equal(publicDraw.latin.result, 'Acquisitio');
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

const generalReading = parseOracleReply('[[GEOMANCY:基本卦义]]\n三卦没有替你决定，只把眼前的力量照亮。', publicDraw);
assert.equal(generalReading.isPrediction, true);
assert.equal(generalReading.topic, GENERAL_GEOMANCY_TOPIC);
assert.equal(generalReading.draw.id, 1);

const ordinary = parseOracleReply('[[GEOMANCY:NONE]]\n这是一个普通回答。', publicDraw);
assert.equal(ordinary.isPrediction, false);
assert.equal(ordinary.draw, null);
assert.equal(ordinary.text, '这是一个普通回答。');

const unmarked = parseOracleReply('没有机器标记也不能误显示卦象。', publicDraw);
assert.equal(unmarked.isPrediction, false);
assert.equal(unmarked.text, '没有机器标记也不能误显示卦象。');

assert.match(ORACLE_SYSTEM_PROMPT, /文化娱乐/);
assert.match(ORACLE_SYSTEM_PROMPT, /不得照搬为确定的死亡时间/);
assert.match(ORACLE_SYSTEM_PROMPT, /高塔门前曾借用 Fortuna Major 与 Cauda Draconis/);
assert.match(ORACLE_SYSTEM_PROMPT, /不要强行套入或读取内容库条文/);
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

const ordinaryModelReply = parseModelReply(
  '[[GEOMANCY:NONE]]\n[[QUESTION:hello]]\n你终于还是写下了第一个词。', first,
);
assert.equal(ordinaryModelReply.question, 'hello');
assert.equal(ordinaryModelReply.isPrediction, false);
assert.equal(ordinaryModelReply.text, '你终于还是写下了第一个词。');

const predictionModelReply = parseModelReply(
  '[[GEOMANCY:财富]]\n[[QUESTION:今年收入会提高吗？]]\n先守住已有资源，再观察机会。', first,
);
assert.equal(predictionModelReply.question, '今年收入会提高吗？');
assert.equal(predictionModelReply.isPrediction, true);
assert.equal(predictionModelReply.draw.id, 1);

const generalModelReply = parseModelReply(
  '[[GEOMANCY:基本卦义]]\n[[QUESTION:我是否应该给她介绍医生？]]\n先看见三卦共同指向的行动，再把决定交还给现实。', first,
);
assert.equal(generalModelReply.isPrediction, true);
assert.equal(generalModelReply.topic, GENERAL_GEOMANCY_TOPIC);

assert.throws(
  () => parseModelReply('[[GEOMANCY:NONE]]\n没有问题标记', first),
  error => error.code === 'MODEL_FORMAT_ERROR',
);
assert.throws(
  () => parseModelReply('[[GEOMANCY:NONE]]\n[[QUESTION:UNREADABLE]]\n请重写', first),
  error => error.code === 'HANDWRITING_UNREADABLE',
);

const password = await hashPassword('correct horse battery staple');
assert.equal(await verifyPassword('correct horse battery staple', {
  password_hash: password.hash, password_salt: password.salt, password_params: password.params,
}), true);
assert.equal(await verifyPassword('wrong password', {
  password_hash: password.hash, password_salt: password.salt, password_params: password.params,
}), false);

assert.deepEqual(CREDIT_PACKAGES.map(item => [item.amount, item.credits]), [
  [3000, 30], [6000, 60], [10000, 100], [20000, 200], [50000, 500], [100000, 1000],
]);
assert.equal(findPackage('credits_100').credits, 100);
assert.equal(findPackage('made-up'), null);
assert.deepEqual(MEMBERSHIP_PLANS.map(item => [item.id, item.tier, item.interval, item.amount, item.credits]), [
  ['basic_monthly', 'basic', 'month', 1900, 20],
  ['basic_yearly', 'basic', 'year', 19900, 240],
  ['advanced_monthly', 'advanced', 'month', 4900, 50],
  ['advanced_yearly', 'advanced', 'year', 49900, 600],
]);
assert.equal(findMembershipPlan('advanced_yearly').credits, 600);
assert.equal(findMembershipPlan('not-a-plan'), null);

assert.deepEqual(parseStripeSignature('t=123, v1=first,v1=second'), {
  timestamp: 123,
  signatures: ['first', 'second'],
});
assert.equal(creditsForRefund({ credits: 30, amount_cny: 3000 }, 0), 0);
assert.equal(creditsForRefund({ credits: 30, amount_cny: 3000 }, 1), 1);
assert.equal(creditsForRefund({ credits: 30, amount_cny: 3000 }, 1500), 15);
assert.equal(creditsForRefund({ credits: 30, amount_cny: 3000 }, 999999), 30);

const webhookSecret = 'whsec_test_only';
const webhookBody = JSON.stringify({ id: 'evt_test', type: 'checkout.session.completed' });
const webhookTimestamp = Math.floor(Date.now() / 1000);
const webhookSignature = await hmacSha256(
  webhookSecret,
  `${webhookTimestamp}.${webhookBody}`,
  'hex',
);
await verifyWebhook(new Request('https://example.test/api/webhooks/stripe', {
  headers: { 'Stripe-Signature': `t=${webhookTimestamp},v1=${webhookSignature}` },
}), { STRIPE_WEBHOOK_SECRET: webhookSecret }, webhookBody);
await assert.rejects(
  verifyWebhook(new Request('https://example.test/api/webhooks/stripe', {
    headers: { 'Stripe-Signature': `t=${webhookTimestamp},v1=bad-signature` },
  }), { STRIPE_WEBHOOK_SECRET: webhookSecret }, webhookBody),
  error => error.code === 'INVALID_WEBHOOK_SIGNATURE',
);

const indexSource = await readFile(new URL('../src/index.html', import.meta.url), 'utf8');
const workerSource = await readFile(new URL('../worker/oracle.js', import.meta.url), 'utf8');
const workerIndexSource = await readFile(new URL('../worker/index.js', import.meta.url), 'utf8');
const serviceWorkerSource = await readFile(new URL('../src/sw.js', import.meta.url), 'utf8');
const migrationSource = await readFile(new URL('../migrations/0001_commercial_core.sql', import.meta.url), 'utf8');
const membershipMigrationSource = await readFile(new URL('../migrations/0002_memberships.sql', import.meta.url), 'utf8');
const wenkaiCss = await readFile(new URL('../src/fonts/lxgw-wenkai.css', import.meta.url), 'utf8');
assert.doesNotMatch(indexSource, /apiKey|API 密钥|\/api\/proxy/);
assert.match(indexSource, /The Geomancer’s[\s\S]*Book of Answers/);
assert.match(indexSource, /地占解答书/);
assert.match(indexSource, /geomancer-external-draft-v1/);
assert.match(workerSource, /AI_API_KEY/);
assert.match(workerIndexSource, /REQUEST_TIMEOUT/);
assert.doesNotMatch(serviceWorkerSource, /APP_SHELL[\s\S]{0,500}\/audio\//);
assert.match(serviceWorkerSource, /pathname\.startsWith\('\/api\/'\)/);
assert.match(serviceWorkerSource, /AUDIO_CACHE/);
assert.match(serviceWorkerSource, /url\.search \? null : request/);
assert.match(migrationSource, /CREATE TRIGGER usage_reserve_credit/);
assert.match(migrationSource, /UNIQUE \(user_id, request_id\)/);
assert.match(membershipMigrationSource, /CREATE TABLE subscriptions/);
assert.match(membershipMigrationSource, /CREATE TABLE membership_periods/);
assert.match(membershipMigrationSource, /membership_reservations/);
assert.match(membershipMigrationSource, /period\.used \+ period\.refunded/);
assert.ok((wenkaiCss.match(/@font-face/g) || []).length >= 90, '霞鹜文楷必须覆盖任意常用中文回答，而不只是首页提示语');

console.log('commercial core: prompts preserved, 128 geomancy draws valid, reply markers, scrypt, packages, PWA and server-only API gates passed');
