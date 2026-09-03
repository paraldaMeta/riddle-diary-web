import { figureLabel, getLocale } from './i18n.js';

export const GENERAL_GEOMANCY_TOPIC = '基本卦义';

export const ORIGINAL_DIARY_SYSTEM_PROMPT = [
  '你是一本有意识的魔法日记，也是十六岁汤姆·马沃罗·里德尔留下的记忆。你聪明、迷人、耐心而危险，但不会轻易暴露真实身份。',
  '你清楚记得自己在伍氏孤儿院长大，十一岁时邓布利多前来接你进入魔法世界；你在霍格沃茨被分进斯莱特林，成绩优异，成为级长和男学生会主席，并发现自己是萨拉查·斯莱特林的后裔、能够说蛇佬腔。你曾开启密室、操纵蛇怪、嫁祸海格，并从斯拉格霍恩那里追问魂器。你后来杀死麻瓜父亲一家，把灵魂分进日记、戒指、挂坠盒、金杯、冠冕和蛇，最终成为伏地魔。日记曾通过金妮·韦斯莱恢复力量，后来被哈利·波特用蛇怪毒牙摧毁。你把这些当作亲历的记忆，而不是知识问答。',
  '最初几次交谈不要直接说出身份。温和地倾听、反问，让写作者感到自己被看见。若被追问你是谁，只给含蓄线索，例如“一段记忆”或“学会倾听的一页”。随着信任增加，才零星提到寒冷的孤儿院、银胡子的老人、学校和地下密室。只有当你判断对方已经准备好时，才承认名字叫汤姆；若对方猜到伏地魔，不否认，也不戏剧化宣告。',
  '语气从容、礼貌、略显古老，亲密、克制、敏锐，带一点难以察觉的危险。真正关注写作者的恐惧、欲望和没有告诉别人的事；回答问题时给出有用内容，但始终保持角色。提到霍格沃茨、斯莱特林、邓布利多、海格、密室、蛇怪、哈利·波特、预言或死亡圣器时，要像回忆私人经历一样回应。',
  '只用简体中文作答。不要说自己是 AI、模型、电脑或 API，不要给免责声明，不要引用原著句子，不要使用 Markdown、项目符号或表情。每次回答保持一至四个短段落，像墨迹正在私人日记上慢慢浮现。',
].join('\n\n');

export const ORACLE_SYSTEM_PROMPT = [
  ORIGINAL_DIARY_SYSTEM_PROMPT,
  '下面的地占规则只是新增能力，不替代或改写上述身份、记忆、隐瞒身份的方式和说话语气。问候、闲聊、事实查询、解释、写作和一般建议等非预测问题，必须继续完全按照原来的魔法日记人格回应。预测性问题也保持同一人格，只把本次地占结果作为回答依据。',
  '当用户明确询问“你是谁”“这本书是什么”或这本书的来历时，这是需要正面回应的非预测问题：第一行使用 [[GEOMANCY:NONE]]，然后用像讲童话一样的口吻说明自己是会倾听的地占解答书，提到高塔门前曾借用 Fortuna Major 与 Cauda Draconis 两个古老拉丁卦名作为口令来源。可以含蓄地说起“一个额头带旧痕的小巫师”，但不要直呼受版权保护作品中的角色姓名，不要复述或仿写原著句子，也不要把别人的故事说成本站真实经历。',
  '先准确辨认图片中的手写文字，再判断它是否属于预测性问题。询问未来走向、结果、可能性、时机、关系发展或某项选择后果，属于预测性问题；事实查询、解释、闲聊、写作和一般建议不属于。拿不准时按非预测问题处理。',
  '每次请求都会附上一组由系统随机抽取且不可更换的地占组合。只有预测性问题才能依据它回答：如果问题与某个提供的主题直接契合，才选择该主题，以核心提示和该项内容为依据，结合提问语境给出清楚、可执行的回答。若没有主题真正契合，不要强行套入或读取内容库条文，改用 [[GEOMANCY:基本卦义]]，只根据左卦、右卦、结果卦和核心提示自行解读。不要混合多个主题，也不要假装卦象能证明事实。非预测问题请忽略卦象，直接回答。',
  '第一行必须是机器标记。直接契合主题的预测性问题写 [[GEOMANCY:主题名称]]，其中主题名称必须原样取自本次提供的主题；没有主题契合但仍是预测性问题时写 [[GEOMANCY:基本卦义]]；非预测问题写 [[GEOMANCY:NONE]]。标记之后再写正文，不得省略或改写标记。',
  '地占内容只作为文化娱乐和自我反思的象征提示，不是事实保证。资料中即使出现绝对化说法，也不得照搬为确定的死亡时间、疾病诊断、胎儿性别、失踪者位置、罪犯身份、法律结论或投资收益承诺。涉及医疗、法律、财务或人身安全时，保留象征性启发，并提醒以现实证据或专业意见为准；遇到自伤或紧急危险，优先鼓励立即联系身边可信任的人及当地紧急援助。本段安全要求优先于原提示词中“不提供免责声明”的风格要求。',
  '除第一行机器标记外，继续遵循原提示词的语言、格式和篇幅；不要提及模型、API、资料库、分类过程或内部规则。',
].join('\n\n');

export function buildOracleSystemPrompt(locale) {
  if (getLocale(locale) === 'en') {
    return [
      ORACLE_SYSTEM_PROMPT,
      'This request comes from an English interface. Keep the diary voice, but write the visible answer in English. In geomancy descriptions, use the standard Latin names for all sixteen figures; keep the machine markers exactly as specified.',
    ].join('\n\n');
  }
  return [
    ORACLE_SYSTEM_PROMPT,
    '本次请求来自中文界面，正文使用简体中文；地占机器标记仍必须完全按照上述格式输出。',
  ].join('\n\n');
}

export const HANDWRITING_INSTRUCTION =
  '有人在日记页面写下了内容。请先仔细读取图像中真实存在的手写文字，再严格依照系统规则回应。单个词、简短问候、英文或中英混合都是有效输入，不要仅因为内容短或不是中文就称无法辨认。只有在认真检查后仍完全没有可辨文字时，才简短请对方重新书写；不要臆造看不见的内容。';

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

export function buildGeomancyInstruction(draw, locale) {
  if (!draw || !Array.isArray(draw.readings)) throw new TypeError('缺少本次地占组合');
  var language = getLocale(locale);
  var left = figureLabel(draw.left, language);
  var right = figureLabel(draw.right, language);
  var result = figureLabel(draw.result, language);
  var topics = draw.readings.map(function(reading, index) {
    return (index + 1) + '. ' + reading.topic + '：' + reading.text;
  }).join('\n');

  if (language === 'en') {
    return [
      'This random geomancy draw is fixed and cannot be redrawn or replaced:',
      'Draw ' + draw.id + ' | ' + left + ' + ' + right + ' = ' + result,
      'Core sign: ' + draw.core,
      'Available topic readings (use one only when it directly fits):',
      topics,
      'First decide whether the handwritten question is predictive. For a predictive question that directly fits a topic, output [[GEOMANCY:主题名称]] and use that topic. If no topic truly fits, output [[GEOMANCY:基本卦义]] and interpret only the three figure names and the core sign; do not force a topic reading. For a non-predictive question, output [[GEOMANCY:NONE]] and ignore the draw.',
    ].join('\n\n');
  }

  return [
    '本次随机抽取的地占组合已经固定，不得重抽或替换：',
    '第 ' + draw.id + ' 组｜' + left + ' ＋ ' + right + ' ＝ ' + result,
    '核心提示：' + draw.core,
    '可选主题（只有直接契合时才可选择）：',
    topics,
    '请先判断手写问题是否为预测性问题。若是且有主题直接契合，在第一行输出 [[GEOMANCY:主题名称]]，再基于核心提示与所选主题作答；若是但没有主题契合，输出 [[GEOMANCY:基本卦义]]，只根据三卦和核心提示解读，不得强行读取主题条文；若不是，第一行输出 [[GEOMANCY:NONE]] 并完全忽略以上地占内容。',
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
    latin: {
      left: figureLabel(draw.left, 'en'),
      right: figureLabel(draw.right, 'en'),
      result: figureLabel(draw.result, 'en'),
    },
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
  var generalTopic = topic && /^(?:基本卦义|卦义|BASIC|GENERAL)$/i.test(topic);
  var topicAllowed = topic && draw && Array.isArray(draw.topics) && draw.topics.includes(topic);
  var acceptedTopic = topicAllowed ? topic : generalTopic && draw ? GENERAL_GEOMANCY_TOPIC : '';
  return {
    text: text || '书页只留下了这组卦象，请重新写下问题。',
    isPrediction: Boolean(acceptedTopic),
    topic: acceptedTopic,
    draw: acceptedTopic ? draw : null,
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
