/**
 * Telegram 笔记分类 Bot v4
 *
 * 新增功能：
 *   - 三模型：文字→DeepSeek / 图片→Qwen-VL / 文字图片→PaddleOCR-VL
 *   - 分类后可内联纠错，AI 自动记录偏好
 *   - /search 搜索话题
 *   - /stats 今日统计
 *   - /merge 合并话题
 *   - /subscribe_daily 每日摘要推送（每天晚8点）
 *
 * Secrets: TELEGRAM_BOT_TOKEN / AI_API_KEY / VISION_API_KEY
 * Vars:    AI_BASE_URL / AI_MODEL / VISION_BASE_URL / VISION_MODEL_PHOTO / VISION_MODEL_DOC
 */

const TG_API = (token, method) => `https://api.telegram.org/bot${token}/${method}`;

// ─── Telegram API ─────────────────────────────────────────────────────────────

async function tgCall(token, method, body = {}) {
  const res = await fetch(TG_API(token, method), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!data.ok) console.error(`TG ${method} failed:`, JSON.stringify(data));
  return data;
}

const sendMessage = (token, chatId, text, threadId = null, extra = {}) =>
  tgCall(token, 'sendMessage', {
    chat_id: chatId, text, parse_mode: 'HTML',
    ...(threadId ? { message_thread_id: threadId } : {}), ...extra,
  });

const copyMessage = (token, chatId, fromChatId, msgId, threadId) =>
  tgCall(token, 'copyMessage', {
    chat_id: chatId, from_chat_id: fromChatId, message_id: msgId,
    ...(threadId ? { message_thread_id: threadId } : {}),
  });

const deleteMessage = (token, chatId, msgId) =>
  tgCall(token, 'deleteMessage', { chat_id: chatId, message_id: msgId });

const editMessageText = (token, chatId, msgId, text, replyMarkup = null) =>
  tgCall(token, 'editMessageText', {
    chat_id: chatId, message_id: msgId, text, parse_mode: 'HTML',
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  });

const answerCallbackQuery = (token, id, text = '') =>
  tgCall(token, 'answerCallbackQuery', { callback_query_id: id, text });

const createForumTopic = (token, chatId, name) =>
  tgCall(token, 'createForumTopic', { chat_id: chatId, name })
    .then(d => d?.result?.message_thread_id ?? null);

const editForumTopic = (token, chatId, threadId, name) =>
  tgCall(token, 'editForumTopic', { chat_id: chatId, message_thread_id: threadId, name });

const closeForumTopic = (token, chatId, threadId) =>
  tgCall(token, 'closeForumTopic', { chat_id: chatId, message_thread_id: threadId });

// ─── KV：话题映射 ──────────────────────────────────────────────────────────────

const getTopicMap = async (kv, chatId) => {
  const r = await kv.get(`topics:${chatId}`); return r ? JSON.parse(r) : {};
};
const saveTopicMap = (kv, chatId, map) =>
  kv.put(`topics:${chatId}`, JSON.stringify(map));

async function getOrCreateTopic(kv, token, chatId, category) {
  const map = await getTopicMap(kv, chatId);
  if (map[category]) return map[category];
  const tid = await createForumTopic(token, chatId, category);
  if (!tid) return null;
  map[category] = tid;
  await saveTopicMap(kv, chatId, map);
  return tid;
}

// ─── KV：偏好 ─────────────────────────────────────────────────────────────────

const getPrefs = async (kv, chatId) => {
  const r = await kv.get(`prefs:${chatId}`); return r ? JSON.parse(r) : [];
};

async function addPref(kv, chatId, from, to) {
  const prefs = await getPrefs(kv, chatId);
  const idx = prefs.findIndex(p => p.from === from);
  const entry = { from, to, ts: Date.now() };
  if (idx >= 0) prefs[idx] = entry; else prefs.push(entry);
  if (prefs.length > 50) prefs.splice(0, prefs.length - 50);
  await kv.put(`prefs:${chatId}`, JSON.stringify(prefs));
}

const buildPrefsPrompt = (prefs) => prefs.length
  ? `\n用户分类偏好（优先参考）：\n${prefs.map(p => `- 「${p.from}」→「${p.to}」`).join('\n')}\n`
  : '';

// ─── KV：每日统计 ─────────────────────────────────────────────────────────────

const todayKey = (chatId) => `stats:${chatId}:${new Date().toISOString().slice(0, 10)}`;

async function incrementStats(kv, chatId, topicName) {
  const key = todayKey(chatId);
  const r = await kv.get(key);
  const s = r ? JSON.parse(r) : {};
  s[topicName] = (s[topicName] || 0) + 1;
  await kv.put(key, JSON.stringify(s), { expirationTtl: 86400 * 8 });
}

const getDailyStats = async (kv, chatId) => {
  const r = await kv.get(todayKey(chatId)); return r ? JSON.parse(r) : {};
};

// ─── KV：每日摘要订阅 ─────────────────────────────────────────────────────────

const getSubscribers = async (kv) => {
  const r = await kv.get('subscribers'); return r ? JSON.parse(r) : [];
};

async function addSubscriber(kv, chatId, threadId) {
  const subs = await getSubscribers(kv);
  if (!subs.find(s => s.chatId === chatId)) {
    subs.push({ chatId, threadId: threadId || null });
    await kv.put('subscribers', JSON.stringify(subs));
  }
}

async function removeSubscriber(kv, chatId) {
  const subs = await getSubscribers(kv);
  await kv.put('subscribers', JSON.stringify(subs.filter(s => s.chatId !== chatId)));
}

// ─── KV：待纠错记录 ───────────────────────────────────────────────────────────

const saveCorrection = (kv, chatId, notifMsgId, data) =>
  kv.put(`corr:${chatId}:${notifMsgId}`, JSON.stringify(data), { expirationTtl: 3600 });

const getCorrection = async (kv, chatId, notifMsgId) => {
  const r = await kv.get(`corr:${chatId}:${notifMsgId}`); return r ? JSON.parse(r) : null;
};

const deleteCorrection = (kv, chatId, notifMsgId) =>
  kv.delete(`corr:${chatId}:${notifMsgId}`);

// ─── 图片下载转 base64 ────────────────────────────────────────────────────────

async function getFileAsBase64(token, fileId) {
  const fd = await tgCall(token, 'getFile', { file_id: fileId });
  const path = fd?.result?.file_path;
  if (!path) return null;
  const res = await fetch(`https://api.telegram.org/file/bot${token}/${path}`);
  if (!res.ok) return null;
  const buf = await res.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

// ─── AI 调用通用封装 ──────────────────────────────────────────────────────────

async function callAI(baseUrl, apiKey, model, messages, maxTokens = 150) {
  const res = await fetch(`${(baseUrl || '').replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature: 0.3 }),
  });
  if (!res.ok) throw new Error(`AI HTTP ${res.status}`);
  return (await res.json()).choices?.[0]?.message?.content?.trim() ?? '';
}

const parseJSON = (raw) => {
  try { return JSON.parse(raw.replace(/^```json?\n?|\n?```$/g, '').trim()); }
  catch { return null; }
};

// ─── 文字分类（DeepSeek）─────────────────────────────────────────────────────

async function classifyText(text, env, chatId) {
  const topicMap = await getTopicMap(env.KV, chatId);
  const existing = Object.keys(topicMap);
  const existingHint = existing.length ? `\n已有话题（优先复用）：${existing.join('、')}\n` : '';
  const prefs = await getPrefs(env.KV, chatId);
  const prefsHint = buildPrefsPrompt(prefs);

  const prompt = `你是笔记分类助手。${existingHint}${prefsHint}
规则：优先复用已有话题；新话题名2-6字、具体；不用"其他""杂项"。
只输出JSON，不要其他文字：{"category":"话题名","summary":"摘要不超过20字"}
内容：${text}`;

  const raw = await callAI(
    env.AI_BASE_URL || 'https://api.deepseek.com/v1',
    env.AI_API_KEY,
    env.AI_MODEL || 'deepseek-chat',
    [{ role: 'user', content: prompt }],
    100
  );
  return parseJSON(raw) || { category: '未分类', summary: text.slice(0, 20) };
}

// ─── 图片分类（视觉模型 → DeepSeek）─────────────────────────────────────────

async function classifyImage(fileId, isDocImage, token, env, chatId) {
  const base64 = await getFileAsBase64(token, fileId);
  if (!base64) return { category: '图片', summary: '图片内容' };

  const model = isDocImage
    ? (env.VISION_MODEL_DOC   || 'PaddleOCR-VL-1.5')
    : (env.VISION_MODEL_PHOTO || 'Qwen/Qwen2.5-VL-7B-Instruct');

  // Step 1：视觉模型描述图片
  const desc = await callAI(
    env.VISION_BASE_URL || 'https://api.siliconflow.cn/v1',
    env.VISION_API_KEY,
    model,
    [{
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64}` } },
        { type: 'text', text: '用中文简短描述这张图片的主要内容（不超过50字）' },
      ],
    }],
    100
  );

  // Step 2：用描述文字走文字分类流程
  return classifyText(desc, env, chatId);
}

// ─── 默认话题消息处理 ──────────────────────────────────────────────────────────

async function handleDefaultTopicMessage(msg, env) {
  const { chat, message_id, text, caption, photo, document } = msg;
  const chatId = String(chat.id);
  const token = env.TELEGRAM_BOT_TOKEN;
  const isPlainText = !!text && !photo && !document && !msg.video && !msg.audio && !msg.voice;

  const hasVisionKey = !!env.VISION_API_KEY;

  let result;
  try {
    if (photo) {
      const fileId = photo[photo.length - 1].file_id;
      result = hasVisionKey
        ? await classifyImage(fileId, false, token, env, chatId)
        : await classifyText(caption || '图片', env, chatId);
    } else if (document?.mime_type?.startsWith('image/')) {
      result = hasVisionKey
        ? await classifyImage(document.file_id, true, token, env, chatId)
        : await classifyText(caption || '图片', env, chatId);
    } else if ((text || caption || '').trim()) {
      result = await classifyText(text || caption, env, chatId);
    } else {
      return;
    }
  } catch (e) {
    console.error('classify error:', e);
    result = { category: '未分类', summary: (text || caption || '').slice(0, 20) || '媒体' };
  }

  const { category, summary } = result;

  const threadId = await getOrCreateTopic(env.KV, token, chatId, category);
  if (!threadId) {
    await sendMessage(token, chatId, `⚠️ 无法创建话题「${category}」，检查 Bot 管理话题权限`);
    return;
  }

  // 复制到目标话题
  let movedMsgId;
  if (isPlainText) {
    const r = await sendMessage(token, chatId, text, threadId);
    movedMsgId = r?.result?.message_id;
  } else {
    const r = await copyMessage(token, chatId, chatId, message_id, threadId);
    movedMsgId = r?.result?.message_id;
  }

  // 删除默认话题原消息
  await deleteMessage(token, chatId, message_id);

  // 更新今日统计
  await incrementStats(env.KV, chatId, category);

  // 发分类通知 + 纠错按钮（发到默认话题）
  const preview = summary || (text || caption || '').slice(0, 20) || '媒体内容';
  const notifRes = await sendMessage(
    token, chatId,
    `✅ <b>${category}</b>  <i>${preview}</i>`,
    null,
    { reply_markup: { inline_keyboard: [[{ text: '🔄 分类错了', callback_data: 'corr_show' }]] } }
  );
  const notifMsgId = notifRes?.result?.message_id;

  if (notifMsgId && movedMsgId) {
    await saveCorrection(env.KV, chatId, notifMsgId, {
      movedMsgId, movedThreadId: threadId, topicName: category, preview,
    });
  }
}

// ─── Callback Query（纠错按钮）────────────────────────────────────────────────

async function handleCallbackQuery(query, env) {
  const token = env.TELEGRAM_BOT_TOKEN;
  const chatId = String(query.message.chat.id);
  const notifMsgId = query.message.message_id;
  const data = query.data;

  await answerCallbackQuery(token, query.id);

  // 显示话题选择
  if (data === 'corr_show') {
    const corr = await getCorrection(env.KV, chatId, notifMsgId);
    if (!corr) {
      await editMessageText(token, chatId, notifMsgId, '⚠️ 纠错已过期（超过1小时）');
      return;
    }
    const map = await getTopicMap(env.KV, chatId);
    const entries = Object.entries(map).filter(([, tid]) => tid !== corr.movedThreadId);
    if (!entries.length) {
      await editMessageText(token, chatId, notifMsgId, '⚠️ 没有其他话题可选');
      return;
    }
    // 每行2个按钮
    const rows = [];
    for (let i = 0; i < entries.length; i += 2) {
      rows.push(entries.slice(i, i + 2).map(([name, tid]) => ({
        text: `📁 ${name}`,
        callback_data: `cm:${tid}`,  // cm = corr_move
      })));
    }
    rows.push([{ text: '❌ 取消', callback_data: 'corr_cancel' }]);
    await editMessageText(token, chatId, notifMsgId,
      `当前：<b>${corr.topicName}</b>\n选择新话题：`,
      { inline_keyboard: rows }
    );
    return;
  }

  // 移动到新话题
  if (data.startsWith('cm:')) {
    const newThreadId = Number(data.slice(3));
    const corr = await getCorrection(env.KV, chatId, notifMsgId);
    if (!corr) {
      await editMessageText(token, chatId, notifMsgId, '⚠️ 纠错已过期');
      return;
    }
    // 找新话题名
    const map = await getTopicMap(env.KV, chatId);
    const newTopicName = Object.keys(map).find(k => map[k] === newThreadId) || '未知';
    // 复制到新话题，删除旧话题消息
    await copyMessage(token, chatId, chatId, corr.movedMsgId, newThreadId);
    await deleteMessage(token, chatId, corr.movedMsgId);
    // 记录偏好、更新统计
    await addPref(env.KV, chatId, corr.topicName, newTopicName);
    await incrementStats(env.KV, chatId, newTopicName);
    await deleteCorrection(env.KV, chatId, notifMsgId);
    await editMessageText(token, chatId, notifMsgId,
      `✅ <b>${newTopicName}</b>  <i>${corr.preview}</i>\n<i>已纠正，AI 记录偏好</i>`
    );
    return;
  }

  // 取消纠错
  if (data === 'corr_cancel') {
    const corr = await getCorrection(env.KV, chatId, notifMsgId);
    await deleteCorrection(env.KV, chatId, notifMsgId);
    await editMessageText(token, chatId, notifMsgId,
      `✅ <b>${corr?.topicName || '已归档'}</b>  <i>${corr?.preview || ''}</i>`
    );
  }
}

// ─── 工具函数 ─────────────────────────────────────────────────────────────────

const isDefaultTopic = (msg) => !msg.message_thread_id || msg.message_thread_id === 1;
const isForumGroup   = (msg) => msg.chat?.is_forum === true;

// ─── Worker 入口 ──────────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    if (request.method !== 'POST') return new Response('Telegram Note Bot v4 ✓');
    try {
      const body = await request.json();
      if (body.callback_query) {
        await handleCallbackQuery(body.callback_query, env);
        return new Response('OK');
      }
      const msg = body.message;
      if (!msg) return new Response('OK');
      if (isForumGroup(msg)) {
        if (msg.text?.startsWith('/')) {
          await handleCommand(msg, env);
        } else if (isDefaultTopic(msg)) {
          await handleDefaultTopicMessage(msg, env);
        }
      }
    } catch (e) {
      console.error('Worker error:', e);
    }
    return new Response('OK');
  },

  // 每日摘要定时任务（UTC 12:00 = 北京 20:00）
  async scheduled(event, env) {
    try {
      const subs = await getSubscribers(env.KV);
      for (const { chatId, threadId } of subs) {
        const stats = await getDailyStats(env.KV, chatId);
        const entries = Object.entries(stats).sort(([, a], [, b]) => b - a);
        if (!entries.length) continue;
        const total = entries.reduce((s, [, c]) => s + c, 0);
        const lines = entries.map(([n, c]) => `  📁 ${n}  ${c} 条`);
        await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId,
          `📊 <b>今日笔记摘要</b>（共 ${total} 条）\n\n${lines.join('\n')}`,
          threadId
        );
      }
    } catch (e) {
      console.error('Scheduled error:', e);
    }
  },
};

// ─── 命令处理 ─────────────────────────────────────────────────────────────────

async function handleCommand(msg, env) {
  const { chat, text, message_thread_id } = msg;
  const chatId   = String(chat.id);
  const token    = env.TELEGRAM_BOT_TOKEN;
  const threadId = message_thread_id || null;
  const parts    = text.trim().split(/\s+/);
  const cmd      = parts[0].split('@')[0];

  if (cmd === '/start' || cmd === '/help') {
    await sendMessage(token, chatId,
      `🗂️ <b>笔记分类 Bot v4</b>\n\n` +
      `在「默认话题」发文字或图片，AI 自动分类。\n\n` +
      `<b>命令</b>\n` +
      `/topics — 查看所有话题\n` +
      `/rename 新名 — 在话题内重命名当前话题\n` +
      `/rename 旧名 新名 — 在默认话题重命名\n` +
      `/merge 话题A 话题B — 将 A 合并到 B\n` +
      `/search 关键词 — 搜索话题\n` +
      `/stats — 今日统计\n` +
      `/prefs — AI 偏好记录\n` +
      `/clear_prefs — 清空偏好\n` +
      `/subscribe_daily — 开启每日摘要（晚8点）\n` +
      `/unsubscribe_daily — 关闭每日摘要\n` +
      `/reset_topics — 清空话题映射`,
      threadId
    );
    return;
  }

  if (cmd === '/topics') {
    const map = await getTopicMap(env.KV, chatId);
    const entries = Object.entries(map);
    if (!entries.length) {
      await sendMessage(token, chatId, '📂 还没有话题，发笔记自动创建。', threadId);
      return;
    }
    await sendMessage(token, chatId,
      `🗂️ <b>当前话题</b>（${entries.length} 个）\n\n${entries.map(([n]) => `  📁 ${n}`).join('\n')}`,
      threadId
    );
    return;
  }

  if (cmd === '/rename') {
    const map = await getTopicMap(env.KV, chatId);
    let oldName, newName, tid;
    if (!isDefaultTopic(msg) && threadId) {
      newName = parts.slice(1).join(' ');
      oldName = Object.keys(map).find(k => map[k] === threadId);
      tid = threadId;
      if (!newName) { await sendMessage(token, chatId, '用法：<code>/rename 新话题名</code>', threadId); return; }
      if (!oldName) { await sendMessage(token, chatId, '⚠️ 当前话题不在 Bot 记录里。', threadId); return; }
    } else {
      oldName = parts[1]; newName = parts.slice(2).join(' ');
      if (!oldName || !newName) { await sendMessage(token, chatId, '用法：<code>/rename 旧话题名 新话题名</code>', threadId); return; }
      if (!map[oldName]) { await sendMessage(token, chatId, `⚠️ 找不到「${oldName}」，当前：${Object.keys(map).join('、') || '（无）'}`, threadId); return; }
      tid = map[oldName];
    }
    await editForumTopic(token, chatId, tid, newName);
    delete map[oldName]; map[newName] = tid;
    await saveTopicMap(env.KV, chatId, map);
    await addPref(env.KV, chatId, oldName, newName);
    await sendMessage(token, chatId, `✅ 「${oldName}」→「${newName}」\n🧠 AI 已记录偏好`, threadId);
    return;
  }

  if (cmd === '/merge') {
    const topicA = parts[1];
    const topicB = parts.slice(2).join(' ');
    if (!topicA || !topicB) {
      await sendMessage(token, chatId, '用法：<code>/merge 话题A 话题B</code>\n将 A 合并到 B，后续 A 的内容归入 B', threadId);
      return;
    }
    const map = await getTopicMap(env.KV, chatId);
    if (!map[topicA]) { await sendMessage(token, chatId, `⚠️ 找不到话题「${topicA}」`, threadId); return; }
    if (!map[topicB]) { await sendMessage(token, chatId, `⚠️ 找不到话题「${topicB}」`, threadId); return; }
    await closeForumTopic(token, chatId, map[topicA]);
    delete map[topicA];
    await saveTopicMap(env.KV, chatId, map);
    await addPref(env.KV, chatId, topicA, topicB);
    await sendMessage(token, chatId,
      `✅ 已合并：「${topicA}」→「${topicB}」\n话题「${topicA}」已关闭，后续内容自动归入「${topicB}」`, threadId);
    return;
  }

  if (cmd === '/search') {
    const kw = parts.slice(1).join(' ');
    if (!kw) { await sendMessage(token, chatId, '用法：<code>/search 关键词</code>', threadId); return; }
    const map = await getTopicMap(env.KV, chatId);
    const prefs = await getPrefs(env.KV, chatId);
    const matchTopics = Object.keys(map).filter(n => n.includes(kw));
    const matchPrefs  = prefs.filter(p => p.from.includes(kw) || p.to.includes(kw));
    if (!matchTopics.length && !matchPrefs.length) {
      await sendMessage(token, chatId, `🔍 未找到含「${kw}」的话题`, threadId);
      return;
    }
    let reply = `🔍 <b>搜索「${kw}」</b>\n\n`;
    if (matchTopics.length) reply += `<b>话题：</b>\n${matchTopics.map(n => `  📁 ${n}`).join('\n')}\n\n`;
    if (matchPrefs.length)  reply += `<b>偏好记录：</b>\n${matchPrefs.map(p => `  ${p.from} → ${p.to}`).join('\n')}`;
    await sendMessage(token, chatId, reply.trim(), threadId);
    return;
  }

  if (cmd === '/stats') {
    const stats   = await getDailyStats(env.KV, chatId);
    const map     = await getTopicMap(env.KV, chatId);
    const entries = Object.entries(stats).sort(([, a], [, b]) => b - a);
    const total   = entries.reduce((s, [, c]) => s + c, 0);
    let reply = `📊 <b>统计</b>\n\n话题总数：${Object.keys(map).length} 个\n今日新增：${total} 条`;
    if (entries.length) reply += `\n\n<b>今日分布：</b>\n${entries.map(([n, c]) => `  📁 ${n}  ${c} 条`).join('\n')}`;
    await sendMessage(token, chatId, reply, threadId);
    return;
  }

  if (cmd === '/prefs') {
    const prefs = await getPrefs(env.KV, chatId);
    if (!prefs.length) { await sendMessage(token, chatId, '🧠 还没有偏好记录。', threadId); return; }
    await sendMessage(token, chatId,
      `🧠 <b>AI 偏好</b>（${prefs.length} 条）\n\n${prefs.map(p => `  <b>${p.from}</b> → <b>${p.to}</b>`).join('\n')}`,
      threadId);
    return;
  }

  if (cmd === '/clear_prefs') {
    await env.KV.delete(`prefs:${chatId}`);
    await sendMessage(token, chatId, '🗑️ 偏好已清空。', threadId);
    return;
  }

  if (cmd === '/subscribe_daily') {
    await addSubscriber(env.KV, chatId, threadId);
    await sendMessage(token, chatId, '✅ 已开启每日摘要，每天晚上 8 点推送到此处。', threadId);
    return;
  }

  if (cmd === '/unsubscribe_daily') {
    await removeSubscriber(env.KV, chatId);
    await sendMessage(token, chatId, '✅ 已关闭每日摘要。', threadId);
    return;
  }

  if (cmd === '/reset_topics') {
    await env.KV.delete(`topics:${chatId}`);
    await sendMessage(token, chatId, '✅ 话题映射已清空。', threadId);
    return;
  }
}
