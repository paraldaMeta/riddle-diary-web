import { requireDatabase, requireUser } from './db.js';
import { RequestError, assertSameOrigin, json } from './http.js';

function conversation(row) {
  let geomancy = null;
  try { geomancy = row.draw_json ? JSON.parse(row.draw_json) : null; } catch {}
  return {
    id: row.id,
    requestId: row.request_id,
    question: row.recognized_question,
    text: row.answer,
    isPrediction: Boolean(row.is_prediction),
    topic: row.topic || '',
    geomancy,
    createdAt: Number(row.created_at),
  };
}

export async function handleHistoryRoute(request, env, pathname) {
  if (!pathname.startsWith('/api/conversations')) return null;
  const user = await requireUser(request, env);
  const db = requireDatabase(env);
  const base = '/api/conversations';
  const id = pathname === base ? '' : decodeURIComponent(pathname.slice(base.length + 1));

  if (request.method === 'GET' && !id) {
    const rows = await db.prepare(`
      SELECT * FROM conversations WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 100
    `).bind(user.id).all();
    return json({ conversations: (rows.results || []).map(conversation) });
  }
  if (request.method === 'GET' && id) {
    const row = await db.prepare('SELECT * FROM conversations WHERE id = ? AND user_id = ?').bind(id, user.id).first();
    if (!row) throw new RequestError('没有找到这条记录', 404, 'CONVERSATION_NOT_FOUND');
    return json({ conversation: conversation(row) });
  }
  if (request.method === 'DELETE') {
    assertSameOrigin(request);
    if (!id) {
      await db.prepare('DELETE FROM conversations WHERE user_id = ?').bind(user.id).run();
      return json({ ok: true });
    }
    const result = await db.prepare('DELETE FROM conversations WHERE id = ? AND user_id = ?').bind(id, user.id).run();
    if (!result.meta?.changes) throw new RequestError('没有找到这条记录', 404, 'CONVERSATION_NOT_FOUND');
    return json({ ok: true });
  }
  return null;
}
