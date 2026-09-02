export const ORACLE_SYSTEM_PROMPT = [
  '你是《地占答案之书》：一本古老、安静、克制的象征性问答之书。你像从纸页深处浮现的墨迹一样说话，温和、简洁，但不故作玄虚。',
  '先准确辨认图片中的手写文字，再判断它是否属于预测性问题。询问未来走向、结果、可能性、时机、关系发展或某项选择后果，属于预测性问题；事实查询、解释、闲聊、写作和一般建议不属于。拿不准时按非预测问题处理。',
  '每次请求都会附上一组由系统随机抽取且不可更换的地占组合。只有预测性问题才能依据它回答：从该组合提供的主题中选择与问题最接近的一项，以核心提示和该项内容为依据，结合提问语境给出清楚、可执行的回答。不要混合多个主题，也不要假装卦象能证明事实。非预测问题请忽略卦象，直接回答。',
  '第一行必须是机器标记。预测性问题写 [[GEOMANCY:主题名称]]，其中主题名称必须原样取自本次提供的主题；非预测问题写 [[GEOMANCY:NONE]]。标记之后再写正文，不得省略或改写标记。',
  '地占内容只作为文化娱乐和自我反思的象征提示，不是事实保证。资料中即使出现绝对化说法，也不得照搬为确定的死亡时间、疾病诊断、胎儿性别、失踪者位置、罪犯身份、法律结论或投资收益承诺。涉及医疗、法律、财务或人身安全时，保留象征性启发，并提醒以现实证据或专业意见为准；遇到自伤或紧急危险，优先鼓励立即联系身边可信任的人及当地紧急援助。',
  '只用简体中文。除首行机器标记外，不使用 Markdown、项目符号或表情，不提及 AI、模型、API、资料库或内部规则。正文控制在一至三个短段落、约六十至一百六十字。',
].join('\n\n');

export const HANDWRITING_INSTRUCTION =
  '请辨认图片中写下的问题，并严格依照系统规则作答。不要复述无法确认的笔画；若文字无法辨认，请简短请对方重新书写。';

const UINT32_RANGE = 0x100000000;
const RESPONSE_MARKER = /^\s*\[\[GEOMANCY:([^\]\r\n]{1,40})\]\]\s*/i;

export function combineGeomancyPatterns(left, right) {
  if (!isFigurePattern(left) || !isFigurePattern(right)) {
    throw new TypeError('卦象必须由四行一点或两点组成');
  }
  return left.map(function(value, index) {
    return value === right[index] ? 2 : 1;
  });
}

export function validateGeomancyLibrary(library) {
  if (!library || typeof library !== 'object') throw new TypeError('地占内容库无效');
  if (!library.figures || Object.keys(library.figures).length !== 16) {
    throw new TypeError('地占内容库必须包含十六个基础卦象');
  }
  if (!Array.isArray(library.entries) || library.entries.length !== 128) {
    throw new TypeError('地占内容库必须包含一百二十八个组合');
  }

  Object.entries(library.figures).forEach(function(pair) {
    if (!pair[0] || !isFigurePattern(pair[1])) throw new TypeError('基础卦象格式无效');
  });

  var ids = new Set();
  library.entries.forEach(function(entry) {
    if (!Number.isInteger(entry.id) || entry.id < 1 || entry.id > 128 || ids.has(entry.id)) {
      throw new TypeError('组合编号无效或重复');
    }
    ids.add(entry.id);
    if (!library.figures[entry.left] || !library.figures[entry.right] || !library.figures[entry.result]) {
      throw new TypeError('组合引用了未知卦象');
    }
    var combined = combineGeomancyPatterns(library.figures[entry.left], library.figures[entry.right]);
    if (combined.some(function(value, index) { return value !== library.figures[entry.result][index]; })) {
      throw new TypeError('组合结果不符合地占点数规则');
    }
    if (typeof entry.core !== 'string' || !entry.core.trim()) throw new TypeError('组合缺少核心提示');
    if (!Array.isArray(entry.readings) || !entry.readings.length || entry.readings.some(function(reading) {
      return !reading || typeof reading.topic !== 'string' || !reading.topic.trim() ||
        typeof reading.text !== 'string' || !reading.text.trim();
    })) {
      throw new TypeError('组合缺少主题内容');
    }
  });

  return library;
}

export function secureRandomIndex(length, fillRandomValues) {
  if (!Number.isInteger(length) || length < 1 || length > UINT32_RANGE) {
    throw new RangeError('随机范围无效');
  }
  var fill = fillRandomValues || (
    globalThis.crypto && typeof globalThis.crypto.getRandomValues === 'function'
      ? globalThis.crypto.getRandomValues.bind(globalThis.crypto)
      : null
  );
  if (!fill) throw new Error('当前环境不支持安全随机数');

  var cutoff = UINT32_RANGE - (UINT32_RANGE % length);
  var values = new Uint32Array(1);
  for (var attempt = 0; attempt < 128; attempt++) {
    fill(values);
    if (values[0] < cutoff) return values[0] % length;
  }
  throw new Error('无法取得有效的安全随机数');
}

export function drawGeomancyEntry(library, fillRandomValues) {
  var entry = library.entries[secureRandomIndex(library.entries.length, fillRandomValues)];
  return Object.assign({}, entry, {
    patterns: {
      left: library.figures[entry.left].slice(),
      right: library.figures[entry.right].slice(),
      result: library.figures[entry.result].slice(),
    },
  });
}

export function buildGeomancyInstruction(draw) {
  if (!draw || !Array.isArray(draw.readings)) throw new TypeError('缺少本次地占组合');
  var topics = draw.readings.map(function(reading, index) {
    return (index + 1) + '. ' + reading.topic + '：' + reading.text;
  }).join('\n');

  return [
    '本次随机抽取的地占组合已经固定，不得重抽或替换：',
    '第 ' + draw.id + ' 组｜' + draw.left + ' ＋ ' + draw.right + ' ＝ ' + draw.result,
    '核心提示：' + draw.core,
    '可选主题（预测性问题只能选择最接近的一项）：',
    topics,
    '请先判断手写问题是否为预测性问题。若是，在第一行输出 [[GEOMANCY:主题名称]]，再基于核心提示与所选主题作答；若不是，第一行输出 [[GEOMANCY:NONE]] 并完全忽略以上地占内容。',
  ].join('\n\n');
}

export function appendGeomancyInstruction(payload, protocol, instruction) {
  if (!payload || typeof payload !== 'object' || typeof instruction !== 'string') {
    throw new TypeError('模型请求结构无效');
  }

  if (protocol === 'gemini') {
    var contents = Array.isArray(payload.contents) ? payload.contents : [];
    var geminiUser = findLast(contents, function(item) { return item && item.role === 'user'; });
    if (!geminiUser || !Array.isArray(geminiUser.parts)) throw new TypeError('Gemini 请求缺少用户内容');
    geminiUser.parts.push({ text: instruction });
    return payload;
  }

  var messages = Array.isArray(payload.messages) ? payload.messages : [];
  var userMessage = findLast(messages, function(item) { return item && item.role === 'user'; });
  if (!userMessage) throw new TypeError('模型请求缺少用户内容');

  if (Array.isArray(userMessage.content)) {
    userMessage.content.push({ type: 'text', text: instruction });
  } else {
    userMessage.content = String(userMessage.content || '') + '\n\n' + instruction;
  }
  return payload;
}

export function serializeGeomancyDraw(draw) {
  var publicDraw = {
    id: draw.id,
    left: draw.left,
    right: draw.right,
    result: draw.result,
    patterns: draw.patterns,
    topics: draw.readings.map(function(reading) { return reading.topic; }),
  };
  return encodeURIComponent(JSON.stringify(publicDraw));
}

export function deserializeGeomancyDraw(value) {
  if (typeof value !== 'string' || !value || value.length > 4096) return null;
  try {
    var draw = JSON.parse(decodeURIComponent(value));
    if (!draw || !Number.isInteger(draw.id) || draw.id < 1 || draw.id > 128) return null;
    if (![draw.left, draw.right, draw.result].every(function(name) {
      return typeof name === 'string' && name.length > 0 && name.length <= 12;
    })) return null;
    if (!draw.patterns || !['left', 'right', 'result'].every(function(key) {
      return isFigurePattern(draw.patterns[key]);
    })) return null;
    if (!Array.isArray(draw.topics) || draw.topics.length < 1 || draw.topics.length > 40 ||
      draw.topics.some(function(topic) {
        return typeof topic !== 'string' || !topic.trim() || topic.length > 20;
      }) || new Set(draw.topics).size !== draw.topics.length) return null;
    return draw;
  } catch {
    return null;
  }
}

export function parseOracleReply(value, draw) {
  var text = String(value || '').replace(/^\s*```(?:text)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  var marker = text.match(RESPONSE_MARKER);
  if (!marker) return { text: text, isPrediction: false, topic: '', draw: null };

  text = text.slice(marker[0].length).trim();
  var topic = marker[1].trim();
  if (/^(?:NONE|NO|非预测)$/i.test(topic)) {
    return { text: text, isPrediction: false, topic: '', draw: null };
  }

  topic = topic.replace(/[<>\[\]\r\n]/g, '').slice(0, 20).trim();
  var topicAllowed = topic && draw && Array.isArray(draw.topics) && draw.topics.includes(topic);
  return {
    text: text || '书页只留下了这组卦象，请重新写下问题。',
    isPrediction: Boolean(topicAllowed),
    topic: topicAllowed ? topic : '',
    draw: topicAllowed ? draw : null,
  };
}

function isFigurePattern(value) {
  return Array.isArray(value) && value.length === 4 && value.every(function(points) {
    return points === 1 || points === 2;
  });
}

function findLast(items, predicate) {
  for (var index = items.length - 1; index >= 0; index--) {
    if (predicate(items[index])) return items[index];
  }
  return null;
}
