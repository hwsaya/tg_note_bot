/**
 * Telegram 话题群组笔记分类 Bot — Cloudflare Worker v3
 *
 * 新特性：
 *   - AI 自由分类，无预设类别限制
 *   - /rename 旧名 新名  → 重命名话题，偏好自动记录
 *   - AI 根据改名历史学习偏好，越用越准
 *
 * Bot 权限（群管理员）：删除消息 + 管理话题
 *
 * KV 结构：
 *   topics:{chatId}  →  { "读书笔记": 123, "工作日志": 456 }
 *   prefs:{chatId}   →  [{ from, to, example, ts }, ...]
 *
 * AI 配置（wrangler.toml [vars]）：
 *   AI_BASE_URL / AI_MODEL / AI_API_KEY（secret）
 */

const TG_API = (token, method) => `https://api.telegram.org/bot${token}/${method}`;

// Telegram API 封装

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

function sendMessage(token, chatId, text, threadId = null, extra = {}) {
  return tgCall(token, 'sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    ...(threadId ? { message_thread_id: threadId } : {}),
    ...extra,
  });
}

function copyMessage(token, chatId, fromChatId, messageId, threadId, caption = null) {
  return tgCall(token, 'copyMessage', {
    chat_id: chatId,
    from_chat_id: fromChatId,
    message_id: messageId,
    ...(threadId ? { message_thread_id: threadId } : {}),
    ...(caption !== null ? { caption, parse_mode: 'HTML' } : {}),
  });
}

function deleteMessage(token, chatId, messageId) {
  return tgCall(token, 'deleteMessage', { chat_id: chatId, message_id: messageId });
}

function createForumTopic(token, chatId, name) {
  return tgCall(token, 'createForumTopic', { chat_id: chatId, name })
    .then(d => d?.result?.message_thread_id ?? null);
}

function editForumTopic(token, chatId, threadId, name) {
  return tgCall(token, 'editForumTopic', {
    chat_id: chatId,
    message_thread_id: threadId,
    name,
  });
}

// ─── KV：话题映射 ──────────────────────────────────────────────────────────────

async function getTopicMap(kv, chatId) {
  const raw = await kv.get(`topics:${chatId}`);
  return raw ? JSON.parse(raw) : {};
}

async function saveTopicMap(kv, chatId, map) {
  await kv.put(`topics:${chatId}`, JSON.stringify(map));
}

async function getOrCreateTopic(kv, token, chatId, category) {
  const map = await getTopicMap(kv, chatId);
  if (map[category]) return map[category];

  const threadId = await createForumTopic(token, chatId, category);
  if (!threadId) return null;

  map[category] = threadId;
  await saveTopicMap(kv, chatId, map);
  console.log(`Created topic "${category}" thread=${threadId}`);
  return threadId;
}

// ─── KV：偏好学习库 ───────────────────────────────────────────────────────────

async function getPrefs(kv, chatId) {
  const raw = await kv.get(`prefs:${chatId}`);
  return raw ? JSON.parse(raw) : [];
}

async function addPref(kv, chatId, from, to, example) {
  const prefs = await getPrefs(kv, chatId);
  const idx   = prefs.findIndex(p => p.from === from);
  const entry = { from, to, example: example?.slice(0, 60) || '', ts: Date.now() };
  if (idx >= 0) prefs[idx] = entry;
  else prefs.push(entry);
  if (prefs.length > 50) prefs.splice(0, prefs.length - 50);
  await kv.put(`prefs:${chatId}`, JSON.stringify(prefs));
}

function buildPrefsPrompt(prefs) {
  if (!prefs.length) return '';
  const lines = prefs.map(p => {
    const eg = p.example ? `（示例："${p.example}"）` : '';
    return `- 类似「${p.from}」这类内容，用户更喜欢叫「${p.to}」${eg}`;
  });
  return `\n用户的分类偏好（请优先参考，这是用户亲自调整过的）：\n${lines.join('\n')}\n`;
}

// ─── AI 分类（通用 OpenAI 兼容接口）─────────────────────────────────────────

async function classifyNote(text, env, chatId) {
  const baseUrl = (env.AI_BASE_URL || 'https://api.deepseek.com/v1').replace(/\/$/, '');
  const model   = env.AI_MODEL   || 'deepseek-chat';
  const apiKey  = env.AI_API_KEY;

  const topicMap     = await getTopicMap(env.KV, chatId);
  const existing     = Object.keys(topicMap);
  const existingHint = existing.length
    ? `\n已有话题（优先复用，避免碎片化）：${existing.join('、')}\n`
    : '';

  const prefs     = await getPrefs(env.KV, chatId);
  const prefsHint = buildPrefsPrompt(prefs);

  const prompt = `你是一个个人笔记分类助手，帮用户把笔记归入最合适的话题。
${existingHint}${prefsHint}
分类规则：
1. 优先复用已有话题，内容明显不符才新建
2. 新话题名必须简短（2-6字）、具体，适合作为话题名
3. 不要使用"其他""杂项"等模糊名称
4. 完全根据内容自由判断，不受固定分类限制

严格只输出 JSON，不要任何其他文字：
{"category":"话题名","tags":["标签1","标签2"],"summary":"一句话摘要不超过30字"}

笔记内容：
${text}`;

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 150,
      temperature: 0.3,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`AI API HTTP ${res.status}: ${err}`);
  }

  const data = await res.json();
  const raw  = data.choices?.[0]?.message?.content?.trim() ?? '';
  try {
    const cleaned = raw.replace(/^```json?\n?|\n?```$/g, '').trim();
    return JSON.parse(cleaned);
  } catch {
    return { category: '未分类', tags: [], summary: text.slice(0, 30) };
  }
}

// ─── 默认话题消息处理 ──────────────────────────────────────────────────────────

async function handleDefaultTopicMessage(msg, env) {
  const { chat, message_id, text, caption } = msg;
  const chatId  = String(chat.id);
  const token   = env.TELEGRAM_BOT_TOKEN;
  const content = text || caption || '';
  if (!content.trim()) return;

  let result;
  try {
    result = await classifyNote(content, env, chatId);
  } catch (e) {
    console.error('classify error:', e);
    result = { category: '未分类', tags: [], summary: content.slice(0, 30) };
  }

  const { category, tags } = result;

  const threadId = await getOrCreateTopic(env.KV, token, chatId, category);
  if (!threadId) {
    await sendMessage(token, chatId,
      `⚠️ 无法创建话题「${category}」，请确认 Bot 有管理话题权限。`
    );
    return;
  }

  const tagStr = tags?.length ? ` · ${tags.join(' · ')}` : '';
  const footer = `\n\n<i>📁 ${category}${tagStr}</i>`;

  const isPlainText = text && !msg.photo && !msg.video && !msg.document && !msg.audio && !msg.voice;
  if (isPlainText) {
    await sendMessage(token, chatId, `${text}${footer}`, threadId);
  } else {
    const newCaption = (caption || '') + footer;
    await copyMessage(token, chatId, chatId, message_id, threadId,
      newCaption.length <= 1024 ? newCaption : caption || ''
    );
  }

  await deleteMessage(token, chatId, message_id);
}

// ─── Worker 入口 ──────────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    if (request.method !== 'POST') {
      return new Response('Telegram Note Bot v3 ✓', { status: 200 });
    }
    try {
      const body = await request.json();
      const msg  = body.message;
      if (!msg) return new Response('OK');

      if (isForumGroup(msg)) {
        if (msg.text?.startsWith('/')) {
          // 命令在任意话题都响应
          await handleCommand(msg, env);
        } else if (isDefaultTopic(msg)) {
          // 普通消息只处理默认话题
          await handleDefaultTopicMessage(msg, env);
        }
      }
    } catch (e) {
      console.error('Worker error:', e);
    }
    return new Response('OK', { status: 200 });
  },
};

function isDefaultTopic(msg) {
  return !msg.message_thread_id || msg.message_thread_id === 1;
}

function isForumGroup(msg) {
  return msg.chat?.is_forum === true;
}

// ─── 命令处理 ─────────────────────────────────────────────────────────────────

async function handleCommand(msg, env) {
  const { chat, text, message_thread_id } = msg;
  const chatId   = String(chat.id);
  const token    = env.TELEGRAM_BOT_TOKEN;
  const threadId = message_thread_id || null;
  const parts    = text.trim().split(/\s+/);
  const cmd      = parts[0].split('@')[0];

  // /start /help
  if (cmd === '/start' || cmd === '/help') {
    await sendMessage(token, chatId,
      `🗂️ <b>笔记分类 Bot v3</b>\n\n` +
      `在「默认话题」发文字，AI 自由分类归档。\n\n` +
      `<b>命令</b>\n` +
      `/topics — 查看所有话题\n` +
      `/rename 旧名 新名 — 重命名话题并让 AI 记住偏好\n` +
      `/prefs — 查看 AI 已学到的偏好\n` +
      `/clear_prefs — 清空偏好记录\n` +
      `/reset_topics — 清空话题映射\n` +
      `/help — 帮助`,
      threadId
    );
    return;
  }

  // /topics
  if (cmd === '/topics') {
    const map     = await getTopicMap(env.KV, chatId);
    const entries = Object.entries(map);
    if (!entries.length) {
      await sendMessage(token, chatId, '📂 还没有话题，在默认话题发笔记会自动创建。', threadId);
      return;
    }
    const lines = entries.map(([name]) => `  📁 ${name}`);
    await sendMessage(token, chatId,
      `🗂️ <b>当前话题</b>（${entries.length} 个）\n\n${lines.join('\n')}`,
      threadId
    );
    return;
  }

  // /rename [新名]        ← 在分类话题里发，自动识别当前话题
  // /rename 旧名 新名     ← 在默认话题里发
  if (cmd === '/rename') {
    const map = await getTopicMap(env.KV, chatId);

    let oldName, newName, tid;

    if (!isDefaultTopic(msg) && threadId) {
      // 在某个分类话题里发：/rename 新名
      newName = parts.slice(1).join(' ');
      // 根据 thread_id 反查当前话题名
      oldName = Object.keys(map).find(k => map[k] === threadId);
      tid = threadId;

      if (!newName) {
        await sendMessage(token, chatId,
          '在话题内使用：<code>/rename 新话题名</code>\n例如：/rename 工作日志',
          threadId
        );
        return;
      }
      if (!oldName) {
        await sendMessage(token, chatId,
          '⚠️ 当前话题不在 Bot 的记录里，可能是手动创建的。',
          threadId
        );
        return;
      }
    } else {
      // 在默认话题里发：/rename 旧名 新名
      oldName = parts[1];
      newName = parts.slice(2).join(' ');

      if (!oldName || !newName) {
        await sendMessage(token, chatId,
          '在默认话题使用：<code>/rename 旧话题名 新话题名</code>\n' +
          '在分类话题内使用：<code>/rename 新话题名</code>',
          threadId
        );
        return;
      }
      if (!map[oldName]) {
        await sendMessage(token, chatId,
          `⚠️ 找不到话题「${oldName}」\n当前话题：${Object.keys(map).join('、') || '（无）'}`,
          threadId
        );
        return;
      }
      tid = map[oldName];
    }

    await editForumTopic(token, chatId, tid, newName);
    delete map[oldName];
    map[newName] = tid;
    await saveTopicMap(env.KV, chatId, map);
    await addPref(env.KV, chatId, oldName, newName, '');

    await sendMessage(token, chatId,
      `✅ 「${oldName}」→「${newName}」\n🧠 AI 已记录此偏好，下次遇到类似内容自动用「${newName}」`,
      threadId
    );
    return;
  }

  // /prefs
  if (cmd === '/prefs') {
    const prefs = await getPrefs(env.KV, chatId);
    if (!prefs.length) {
      await sendMessage(token, chatId,
        '🧠 还没有偏好记录。\n用 /rename 重命名话题后，AI 会自动学习。',
        threadId
      );
      return;
    }
    const lines = prefs.map(p =>
      `  <b>${p.from}</b> → <b>${p.to}</b>${p.example ? `\n  <i>"${p.example}"</i>` : ''}`
    );
    await sendMessage(token, chatId,
      `🧠 <b>AI 已学习的偏好</b>（${prefs.length} 条）\n\n${lines.join('\n\n')}`,
      threadId
    );
    return;
  }

  // /clear_prefs
  if (cmd === '/clear_prefs') {
    await env.KV.delete(`prefs:${chatId}`);
    await sendMessage(token, chatId, '🗑️ 偏好记录已清空，AI 将重新自由分类。', threadId);
    return;
  }

  // /reset_topics
  if (cmd === '/reset_topics') {
    await env.KV.delete(`topics:${chatId}`);
    await sendMessage(token, chatId, '✅ 话题映射已清空。', threadId);
    return;
  }
}

