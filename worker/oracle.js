import geomancyLibrary from '../src/geomancy-library.json' with { type: 'json' };
import {
  HANDWRITING_INSTRUCTION,
  ORACLE_SYSTEM_PROMPT,
  buildGeomancyInstruction,
  deserializeGeomancyDraw,
  drawGeomancyEntry,
  parseOracleReply,
  serializeGeomancyDraw,
  validateGeomancyLibrary,
} from '../src/geomancy.js';
import { requireDatabase, requireUser, userResponse } from './db.js';
import { RequestError, assertSameOrigin, json, randomId, readJson, unixNow } from './http.js';

const MAX_REQUEST_BYTES = 7 * 1024 * 1024;
const MAX_IMAGE_LENGTH = 6 * 1024 * 1024;
const LIBRARY = validateGeomancyLibrary(geomancyLibrary);
const QUESTION_MARKER_INSTRUCTION = [
  '为了让日记保存用户真正写下的问题，你还必须在第一行地占机器标记之后，紧接着另起一行输出识别标记：[[QUESTION:你从图片中实际辨认出的完整文字]]。',
  '即使图片里只有 hello、一个单词、简短问候或中英混合，也要原样写入 QUESTION 标记并正常回答。不要把清晰的短内容判为无法辨认。',
  '仅当图片确实没有任何可辨文字时写 [[QUESTION:UNREADABLE]]，此时正文只需请对方重新书写。QUESTION 标记必须独占一行，内容不得换行；正文从第三行开始。',
].join('\n');

function publicDraw(draw) {
  return deserializeGeomancyDraw(serializeGeomancyDraw(draw));
}

function validateInput(body) {
  const requestId = String(body.requestId || '').trim();
  const image = body.image;
  if (!/^[A-Za-z0-9_-]{8,100}$/.test(requestId)) {
    throw new RequestError('请求编号无效', 400, 'INVALID_REQUEST_ID');
  }
  if (typeof image !== 'string' || !/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(image)) {
    throw new RequestError('缺少手写图片，或图片格式不受支持', 400, 'INVALID_IMAGE');
  }
  if (image.length > MAX_IMAGE_LENGTH) throw new RequestError('手写图片过大', 413, 'IMAGE_TOO_LARGE');
  return { requestId, image };
}

function modelEndpoint(env) {
  let base = String(env.AI_BASE_URL || 'https://xfastapi.ai').trim().replace(/\/+$/, '');
  if (!/^https:\/\//i.test(base)) throw new RequestError('模型服务地址配置无效', 503, 'AI_CONFIG_INVALID');
  if (!/\/chat\/completions$/i.test(base)) base += '/chat/completions';
  return base;
}

function extractModelText(payload) {
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(part => typeof part === 'string' ? part : part?.text || '').join('');
  }
  if (typeof payload?.output_text === 'string') return payload.output_text;
  return '';
}

export function parseModelReply(raw, draw) {
  const text = String(raw || '').replace(/^\s*```(?:text)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  const structure = text.match(/^\s*(\[\[GEOMANCY:([^\]\r\n]{1,40})\]\])\s*\r?\n\s*\[\[QUESTION:([^\]\r\n]{1,500})\]\]\s*/i);
  if (!structure) throw new RequestError('答案格式异常，本次不会扣除次数', 502, 'MODEL_FORMAT_ERROR');
  const question = structure[3].trim().replace(/[\u0000-\u001f\u007f]/g, ' ');
  if (/^UNREADABLE$/i.test(question)) {
    throw new RequestError('图片中的手写文字无法准确辨认。请把字写得更大、更清晰，并适当拉开字距后再提问。', 422, 'HANDWRITING_UNREADABLE');
  }
  if (!question) throw new RequestError('答案格式异常，本次不会扣除次数', 502, 'MODEL_FORMAT_ERROR');
  const withoutQuestion = `${structure[1]}\n${text.slice(structure[0].length).trim()}`;
  const parsed = parseOracleReply(withoutQuestion, publicDraw(draw));
  if (!parsed.text || (structure[2].trim().toUpperCase() !== 'NONE' && !parsed.isPrediction)) {
    throw new RequestError('答案格式异常，本次不会扣除次数', 502, 'MODEL_FORMAT_ERROR');
  }
  return { question, ...parsed };
}

async function callModel(env, image, draw, signal) {
  if (!env.AI_API_KEY) throw new RequestError('答案之书的模型服务尚未配置', 503, 'AI_UNAVAILABLE');
  const instruction = [HANDWRITING_INSTRUCTION, buildGeomancyInstruction(draw), QUESTION_MARKER_INSTRUCTION].join('\n\n');
  const response = await fetch(modelEndpoint(env), {
    method: 'POST',
    redirect: 'manual',
    signal,
    headers: {
      Authorization: `Bearer ${env.AI_API_KEY}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      model: env.AI_MODEL || 'gpt-5.6-sol',
      stream: false,
      messages: [
        { role: 'system', content: ORACLE_SYSTEM_PROMPT },
        { role: 'user', content: [
          { type: 'image_url', image_url: { url: image } },
          { type: 'text', text: instruction },
        ] },
      ],
      max_tokens: 1000,
      temperature: 0.7,
    }),
  });
  if (response.status >= 300 && response.status < 400) {
    if (response.body) await response.body.cancel();
    throw new RequestError('答案之书暂时无法连接模型', 502, 'AI_REDIRECT_BLOCKED');
  }
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    console.error('AI upstream failed', response.status, JSON.stringify(payload).slice(0, 500));
    throw new RequestError('答案之书暂时沉默了，本次不会扣除次数', 502, 'AI_UPSTREAM_FAILED');
  }
  return parseModelReply(extractModelText(payload), draw);
}

async function existingResult(db, user, requestId, env) {
  const row = await db.prepare(`
    SELECT u.status, u.error_code, c.id AS conversation_id, c.recognized_question,
           c.answer, c.is_prediction, c.topic, c.draw_json, c.created_at
    FROM usage_requests u LEFT JOIN conversations c ON c.id = u.conversation_id
    WHERE u.user_id = ? AND u.request_id = ?
  `).bind(user.id, requestId).first();
  if (!row) return null;
  if (row.status === 'succeeded' && row.conversation_id) {
    const refreshed = await userResponse(user.id, env);
    return {
      id: row.conversation_id,
      requestId,
      question: row.recognized_question,
      text: row.answer,
      isPrediction: Boolean(row.is_prediction),
      topic: row.topic || '',
      geomancy: row.draw_json ? JSON.parse(row.draw_json) : null,
      createdAt: Number(row.created_at),
      remainingCredits: refreshed?.admin ? null : refreshed?.credits,
      unlimited: Boolean(refreshed?.admin),
      duplicate: true,
    };
  }
  if (row.status === 'reserved') throw new RequestError('这个问题仍在生成答案，请稍候', 409, 'REQUEST_IN_PROGRESS');
  throw new RequestError('这个请求上次未成功，请使用新的请求编号重试', 409, row.error_code || 'REQUEST_REFUNDED');
}

export async function handleAsk(request, env) {
  assertSameOrigin(request);
  const user = await requireUser(request, env);
  const body = await readJson(request, MAX_REQUEST_BYTES);
  const { requestId, image } = validateInput(body);
  const db = requireDatabase(env);
  const previous = await existingResult(db, user, requestId, env);
  if (previous) return json(previous);

  const usageId = randomId('use_');
  const now = unixNow();
  try {
    await db.prepare(`
      INSERT INTO usage_requests (id, user_id, request_id, cost, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'reserved', ?, ?)
    `).bind(usageId, user.id, requestId, user.admin ? 0 : 1, now, now).run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('INSUFFICIENT_CREDITS')) {
      throw new RequestError('剩余次数不足，请先充值', 402, 'INSUFFICIENT_CREDITS');
    }
    if (message.includes('UNIQUE')) {
      const duplicate = await existingResult(db, user, requestId, env);
      if (duplicate) return json(duplicate);
    }
    throw error;
  }

  try {
    const draw = drawGeomancyEntry(LIBRARY);
    const reply = await callModel(env, image, draw, request.signal);
    const conversationId = randomId('cnv_');
    const createdAt = unixNow();
    const geomancy = reply.isPrediction ? publicDraw(draw) : null;
    await db.batch([
      db.prepare(`
        INSERT INTO conversations
          (id, user_id, request_id, recognized_question, answer, is_prediction, topic, draw_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        conversationId, user.id, requestId, reply.question, reply.text,
        reply.isPrediction ? 1 : 0, reply.topic || null,
        geomancy ? JSON.stringify(geomancy) : null, createdAt,
      ),
      db.prepare(`
        UPDATE usage_requests SET status = 'succeeded', conversation_id = ?, updated_at = ?
        WHERE id = ? AND status = 'reserved'
      `).bind(conversationId, createdAt, usageId),
      db.prepare(`
        DELETE FROM conversations WHERE id IN (
          SELECT id FROM conversations WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT -1 OFFSET 100
        )
      `).bind(user.id),
    ]);
    const refreshed = await userResponse(user.id, env);
    return json({
      id: conversationId,
      requestId,
      question: reply.question,
      text: reply.text,
      isPrediction: reply.isPrediction,
      topic: reply.topic || '',
      geomancy,
      createdAt,
      remainingCredits: refreshed.admin ? null : refreshed.credits,
      unlimited: refreshed.admin,
      duplicate: false,
    });
  } catch (error) {
    const code = error instanceof RequestError ? error.code : 'AI_REQUEST_FAILED';
    await db.prepare(`
      UPDATE usage_requests SET status = 'refunded', error_code = ?, updated_at = ?
      WHERE id = ? AND status = 'reserved'
    `).bind(code, unixNow(), usageId).run().catch(refundError => {
      console.error('Credit refund failed', usageId, refundError instanceof Error ? refundError.message : String(refundError));
    });
    if (error instanceof RequestError) throw error;
    console.error('Oracle request failed', error instanceof Error ? error.message : String(error));
    throw new RequestError('答案之书暂时沉默了，本次不会扣除次数', 502, 'AI_REQUEST_FAILED');
  }
}
