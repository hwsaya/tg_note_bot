/**
 * Telegram 笔记分类 Bot v5
 *
 * 功能：
 *   - 文字/图片/语音/转发 → AI 自动分类，内容存 KV，/export 导出原文
 *   - 排版保留原始格式（copyMessage）
 *   - AI 置信度 < 0.70 自动弹纠错菜单
 *   - 占位"分析中…"消息，完成后删除
 *   - 分类通知 5 秒后自动删除（低置信度时保留）
 *   - 纠错：AI重分类(带提示词) / 自定义话题名 / 展开已有话题
 *   - 引用回复"删除" 并行静默删除两条消息
 *   - KV 已用 MB 统计 + /storage 查看 + /clean 清理旧笔记
 *   - 填 SPEECH_API_KEY 自动支持语音转文字
 *
 * Secrets:
 *   TELEGRAM_BOT_TOKEN / AI_API_KEY / VISION_API_KEY / SPEECH_API_KEY
 * Vars:
 *   AI_BASE_URL / AI_MODEL
 *   VISION_BASE_URL / VISION_MODEL_PHOTO / VISION_MODEL_DOC
 *   SPEECH_BASE_URL / SPEECH_MODEL
 */

import {
  CONFIDENCE_THRESHOLD,
  STORAGE_WARN_MB,
  CLEAN_DEFAULT_DAYS,
  CHAT_EXPIRE_SECONDS,
  MAX_MEMORY_COUNT,
  NOTIFY_AUTO_DELETE_MS,
  NOTIFY_LOW_CONF_DELETE_MS,
  CHAT_CONTEXT_NOTE_COUNT,
  DEFAULT_AI_BASE_URL,
  DEFAULT_AI_MODEL,
  DEFAULT_VISION_BASE_URL,
  DEFAULT_VISION_MODEL_PHOTO,
  DEFAULT_VISION_MODEL_DOC,
  DEFAULT_SPEECH_BASE_URL,
  DEFAULT_SPEECH_MODEL,
  PROMPT_CLASSIFY,
  PROMPT_RECLASSIFY,
  PROMPT_IMAGE_DESCRIBE,
  PROMPT_CHAT_SYSTEM,
  PROMPT_CHAT_SUMMARY,
} from './config.js';

const TG_API = (token, method) => `https://api.telegram.org/bot${token}/${method}`;
const KV_FREE_LIMIT_MB = 1024;

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

const editMessageText = (token, chatId, msgId, text, replyMarkup = null) =>
  tgCall(token, 'editMessageText', {
    chat_id: chatId, message_id: msgId, text, parse_mode: 'HTML',
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  });

const copyMessage = (token, chatId, fromChatId, msgId, threadId) =>
  tgCall(token, 'copyMessage', {
    chat_id: chatId, from_chat_id: fromChatId, message_id: msgId,
    ...(threadId ? { message_thread_id: threadId } : {}),
  });

const deleteMessage = (token, chatId, msgId) =>
  tgCall(token, 'deleteMessage', { chat_id: chatId, message_id: msgId });

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
const saveTopicMap = (kv, chatId, map) => kv.put(`topics:${chatId}`, JSON.stringify(map));

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

const getMemories = async (kv, chatId) => {
  const r = await kv.get(`memories:${chatId}`); return r ? JSON.parse(r) : [];
};

async function addMemory(kv, chatId, text) {
  const mems = await getMemories(kv, chatId);
  if (!mems.includes(text)) mems.push(text);
  // 使用 config 中的限制数量
  if (mems.length > MAX_MEMORY_COUNT) mems.shift(); 
  await kv.put(`memories:${chatId}`, JSON.stringify(mems));
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

// ─── KV：笔记内容存储 ─────────────────────────────────────────────────────────
// key: note:{chatId}:{timestamp}
// index: noteindex:{chatId} → [{ id, topic, ts, preview }]

async function saveNote(kv, chatId, topic, content, contentType) {
  const ts  = Date.now();
  const id  = `${chatId}:${ts}`;
  const key = `note:${id}`;
  const note = { id, topic, content, contentType, ts };
  const noteStr = JSON.stringify(note);

  // 存笔记
  await kv.put(key, noteStr);

  // 更新索引
  const idxKey = `noteindex:${chatId}`;
  const idxRaw = await kv.get(idxKey);
  const idx    = idxRaw ? JSON.parse(idxRaw) : [];
  idx.push({ id, topic, ts, preview: content.slice(0, 30) });
  await kv.put(idxKey, JSON.stringify(idx));

  // 更新已用存储量（字节）
  await addStorageBytes(kv, chatId, new TextEncoder().encode(noteStr).length);

  return id;
}

async function getNotesByTopic(kv, chatId, topic) {
  const idxKey = `noteindex:${chatId}`;
  const idxRaw = await kv.get(idxKey);
  if (!idxRaw) return [];
  const idx = JSON.parse(idxRaw);
  const topicNotes = idx.filter(n => n.topic === topic);
  const notes = await Promise.all(
    topicNotes.map(async n => {
      const r = await kv.get(`note:${n.id}`);
      return r ? JSON.parse(r) : null;
    })
  );
  return notes.filter(Boolean).sort((a, b) => a.ts - b.ts);
}

async function getAllNotes(kv, chatId) {
  const idxKey = `noteindex:${chatId}`;
  const idxRaw = await kv.get(idxKey);
  if (!idxRaw) return [];
  const idx = JSON.parse(idxRaw);
  const notes = await Promise.all(
    idx.map(async n => {
      const r = await kv.get(`note:${n.id}`);
      return r ? JSON.parse(r) : null;
    })
  );
  return notes.filter(Boolean).sort((a, b) => a.ts - b.ts);
}

// 清理 N 天前的笔记
async function cleanOldNotes(kv, chatId, daysAgo = 30) {
  const cutoff = Date.now() - daysAgo * 86400 * 1000;
  const idxKey = `noteindex:${chatId}`;
  const idxRaw = await kv.get(idxKey);
  if (!idxRaw) return 0;

  const idx   = JSON.parse(idxRaw);
  const old   = idx.filter(n => n.ts < cutoff);
  const fresh = idx.filter(n => n.ts >= cutoff);

  let freedBytes = 0;
  await Promise.all(old.map(async n => {
    const r = await kv.get(`note:${n.id}`);
    if (r) {
      freedBytes += new TextEncoder().encode(r).length;
      await kv.delete(`note:${n.id}`);
    }
  }));

  await kv.put(idxKey, JSON.stringify(fresh));
  await addStorageBytes(kv, chatId, -freedBytes);
  return old.length;
}

// ─── KV：已用存储量追踪 ───────────────────────────────────────────────────────

async function addStorageBytes(kv, chatId, bytes) {
  const key = `storage:${chatId}`;
  const r   = await kv.get(key);
  const cur = r ? Number(r) : 0;
  await kv.put(key, String(Math.max(0, cur + bytes)));
}

async function getStorageBytes(kv, chatId) {
  const r = await kv.get(`storage:${chatId}`);
  return r ? Number(r) : 0;
}

const toMB = (bytes) => (bytes / 1024 / 1024).toFixed(2);

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

// ─── KV：默认话题消息记录（用于"清除记录"）────────────────────────────────────────

async function recordDefaultMsgs(kv, chatId, ...msgIds) {
  const key = `defaultmsgs:${chatId}`;
  const r   = await kv.get(key);
  const ids = r ? JSON.parse(r) : [];
  ids.push(...msgIds.filter(Boolean));
  if (ids.length > 300) ids.splice(0, ids.length - 300);
  await kv.put(key, JSON.stringify(ids), { expirationTtl: 86400 * 7 });
}

async function popDefaultMsgs(kv, chatId) {
  const key = `defaultmsgs:${chatId}`;
  const r   = await kv.get(key);
  await kv.delete(key);
  return r ? JSON.parse(r) : [];
}

// ─── KV：待输入状态 ───────────────────────────────────────────────────────────

const savePending = (kv, chatId, data) =>
  kv.put(`pending:${chatId}`, JSON.stringify(data), { expirationTtl: 300 });
const getPending = async (kv, chatId) => {
  const r = await kv.get(`pending:${chatId}`); return r ? JSON.parse(r) : null;
};
const deletePending = (kv, chatId) => kv.delete(`pending:${chatId}`);

// ─── KV：纠错记录 ─────────────────────────────────────────────────────────────

const saveCorrection = (kv, chatId, notifMsgId, data) =>
  kv.put(`corr:${chatId}:${notifMsgId}`, JSON.stringify(data), { expirationTtl: 3600 });
const getCorrection = async (kv, chatId, notifMsgId) => {
  const r = await kv.get(`corr:${chatId}:${notifMsgId}`); return r ? JSON.parse(r) : null;
};
const deleteCorrection = (kv, chatId, notifMsgId) =>
  kv.delete(`corr:${chatId}:${notifMsgId}`);

// ─── KV：对话会话（临时，结束后删除）────────────────────────────────────────────
// key: chat:{chatId}:{threadId}  → { noteContext, history: [{role, content}], startMsgIds: [] }

const getChatSession = async (kv, chatId, threadId) => {
  const r = await kv.get(`chat:${chatId}:${threadId}`);
  return r ? JSON.parse(r) : null;
};

const saveChatSession = (kv, chatId, threadId, session) =>
  kv.put(`chat:${chatId}:${threadId}`, JSON.stringify(session), { expirationTtl: CHAT_EXPIRE_SECONDS });

const deleteChatSession = (kv, chatId, threadId) =>
  kv.delete(`chat:${chatId}:${threadId}`);

// ─── 文件下载 ─────────────────────────────────────────────────────────────────

async function downloadFile(token, fileId) {
  const fd = await tgCall(token, 'getFile', { file_id: fileId });
  const path = fd?.result?.file_path;
  if (!path) return null;
  const res = await fetch(`https://api.telegram.org/file/bot${token}/${path}`);
  if (!res.ok) return null;
  return res.arrayBuffer();
}

async function getFileAsBase64(token, fileId) {
  const buf = await downloadFile(token, fileId);
  if (!buf) return null;
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

// ─── AI 调用 ──────────────────────────────────────────────────────────────────

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

// ─── 语音转文字 ───────────────────────────────────────────────────────────────

async function speechToText(token, fileId, env) {
  if (!env.SPEECH_API_KEY) return null;

  const buf = await downloadFile(token, fileId);
  if (!buf) return null;

  const baseUrl = (env.SPEECH_BASE_URL || DEFAULT_SPEECH_BASE_URL).replace(/\/$/, '');
  const model   = env.SPEECH_MODEL || DEFAULT_SPEECH_MODEL;

  const form = new FormData();
  form.append('file', new Blob([buf], { type: 'audio/ogg' }), 'voice.ogg');
  form.append('model', model);

  const res = await fetch(`${baseUrl}/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.SPEECH_API_KEY}` },
    body: form,
  });
  if (!res.ok) throw new Error(`STT HTTP ${res.status}`);
  const data = await res.json();
  return data.text || null;
}

// ─── 文字分类 ─────────────────────────────────────────────────────────────────

async function classifyText(text, env, chatId, useMemories = false) {
  const topicMap = await getTopicMap(env.KV, chatId);
  const existing = Object.keys(topicMap);
  const existingHint = existing.length ? `\n已有话题（优先复用）：${existing.join('、')}\n` : '';
  const prefs = await getPrefs(env.KV, chatId);
  let prefsHint = buildPrefsPrompt(prefs);
  
  if (useMemories) {
    const memories = await getMemories(env.KV, chatId);
    if (memories.length > 0) {
      prefsHint += `\n用户专属记忆规则（必须严格遵守）：\n${memories.map(m => `- ${m}`).join('\n')}\n`;
    }
  }
  const prompt = PROMPT_CLASSIFY(existingHint, prefsHint, text);

  const raw = await callAI(
    env.AI_BASE_URL || DEFAULT_AI_BASE_URL,
    env.AI_API_KEY,
    env.AI_MODEL || DEFAULT_AI_MODEL,
    [{ role: 'user', content: prompt }], 120
  );
  return parseJSON(raw) || { category: '未分类', summary: text.slice(0, 20), confidence: 0 };
}

// ─── 图片分类 ─────────────────────────────────────────────────────────────────

async function classifyImage(fileId, isDocImage, token, env, chatId) {
  const base64 = await getFileAsBase64(token, fileId);
  if (!base64) return { category: '图片', summary: '图片内容', confidence: 0.5 };

  const model = isDocImage
    ? (env.VISION_MODEL_DOC || DEFAULT_VISION_MODEL_DOC)
    : (env.VISION_MODEL_PHOTO || DEFAULT_VISION_MODEL_PHOTO);
  
  const memories = await getMemories(env.KV, chatId);
  const memoryHint = memories.length 
    ? `\n用户提供的参考特征（若图片符合优先使用此描述）：\n${memories.map(m => `- ${m}`).join('\n')}`
    : '';
  
  const desc = await callAI(
    env.VISION_BASE_URL || DEFAULT_VISION_BASE_URL,
    env.VISION_API_KEY,
    model,
    [{
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64}` } },
        { type: 'text', text: PROMPT_IMAGE_DESCRIBE + memoryHint },
      ],
    }], 100
  );
  const imgResult = await classifyText(desc, env, chatId, true); 
  
  imgResult.confidence = Math.max(imgResult.confidence ?? 0, 0.75);
  return { ...imgResult, imageDesc: desc };
}
// ─── 提取消息内容 ─────────────────────────────────────────────────────────────

function extractContent(msg) {
  const isForwarded = !!(msg.forward_origin || msg.forward_from || msg.forward_from_chat);
  return {
    text:     msg.text || msg.caption || '',
    photo:    msg.photo,
    document: msg.document,
    voice:    msg.voice,
    audio:    msg.audio,
    isForwarded,
  };
}

// ─── 默认话题消息处理 ──────────────────────────────────────────────────────────

async function handleDefaultTopicMessage(msg, env, ctx) {
  const { chat, message_id } = msg;
  const chatId = String(chat.id);
  const token  = env.TELEGRAM_BOT_TOKEN;
  const { text, photo, document, voice, audio, isForwarded } = extractContent(msg);
  const hasVisionKey = !!env.VISION_API_KEY;
  const hasSpeechKey = !!env.SPEECH_API_KEY;

  const hasContent = text.trim() || photo || document || voice || audio;
  if (!hasContent) return;

  // ── 占位消息 ──────────────────────────────────────────────────────────────
  const placeholderRes = await sendMessage(token, chatId, '⏳ 分析中…');
  const placeholderId  = placeholderRes?.result?.message_id;

  // ── 分类 ──────────────────────────────────────────────────────────────────
  let result;
  let contentToSave = '';
  let contentType   = 'text';

  try {
    if (voice || audio) {
      const fileId = (voice || audio).file_id;
      if (hasSpeechKey) {
        const transcript = await speechToText(token, fileId, env);
        contentToSave = transcript || '（语音，转录失败）';
        contentType   = 'voice';
        result = transcript 
          ? await classifyText(transcript, env, chatId, false)
          : { category: '语音', summary: '语音消息', confidence: 0.5 };
      } else {
        contentToSave = '（语音消息）';
        contentType   = 'voice';
        result = { category: '语音', summary: '语音消息', confidence: 0.5 };
      }
    } else if (photo) {
      const fileId = photo[photo.length - 1].file_id;
      if (hasVisionKey) {
        result = await classifyImage(fileId, false, token, env, chatId);
        contentToSave = result.imageDesc ? `（图片）${result.imageDesc}` : '（图片）';
      } else {
        // 无视觉 Key：直接归入「图片」话题，不调 AI
        contentToSave = text ? `（图片）${text}` : '（图片）';
        result = { category: '图片', summary: '图片', confidence: 1 };
      }
      contentType = 'image';
    } else if (document?.mime_type?.startsWith('image/')) {
      if (hasVisionKey) {
        result = await classifyImage(document.file_id, true, token, env, chatId);
        contentToSave = result.imageDesc ? `（图片）${result.imageDesc}` : '（图片）';
      } else {
        contentToSave = text ? `（图片）${text}` : '（图片）';
        result = { category: '图片', summary: '图片', confidence: 1 };
      }
      contentType = 'image';
    } else {
      contentToSave = text;
      contentType   = 'text';
      result = await classifyText(text, env, chatId, false); 
    }
  } catch (e) {
    console.error('classify error:', e);
    result = { category: '未分类', summary: text.slice(0, 20) || '媒体', confidence: 0 };
    contentToSave = contentToSave || text || '（媒体）';
  }

  const { category, summary, confidence = 1 } = result;

  // ── 删占位 ────────────────────────────────────────────────────────────────
  if (placeholderId) await deleteMessage(token, chatId, placeholderId);

  // ── 获取/创建话题 ─────────────────────────────────────────────────────────
  const threadId = await getOrCreateTopic(env.KV, token, chatId, category);
  if (!threadId) {
    await sendMessage(token, chatId, `⚠️ 无法创建话题「${category}」，检查 Bot 管理话题权限`);
    return;
  }

  // ── 复制消息到话题（保留原始排版）────────────────────────────────────────
  const r = await copyMessage(token, chatId, chatId, message_id, threadId);
  const movedMsgId = r?.result?.message_id;

  // ── 删除默认话题原消息 ────────────────────────────────────────────────────
  await deleteMessage(token, chatId, message_id);

  // ── 存笔记内容到 KV + 更新统计 ────────────────────────────────────────────
  const [noteId] = await Promise.all([
    saveNote(env.KV, chatId, category, contentToSave, contentType),
    incrementStats(env.KV, chatId, category),
  ]);

  // ── 存储量预警（超过 900MB 时提醒）───────────────────────────────────────
  const usedBytes = await getStorageBytes(env.KV, chatId);
  const usedMB    = usedBytes / 1024 / 1024;
  if (usedMB > STORAGE_WARN_MB) {
    await sendMessage(token, chatId,
      `⚠️ <b>存储预警</b>：笔记已占用 ${usedMB.toFixed(1)}MB / ${KV_FREE_LIMIT_MB}MB\n` +
      `建议发 /clean 清理旧笔记`
    );
  }

  // ── 通知 ──────────────────────────────────────────────────────────────────
  const preview     = summary || text.slice(0, 20) || '媒体内容';
  const lowConf     = confidence < CONFIDENCE_THRESHOLD;
  const forwardTag  = isForwarded ? ' <i>（转发）</i>' : '';
  const confTag     = lowConf ? ` ⚠️ <i>置信度低（${Math.round(confidence * 100)}%）</i>` : '';
  const notifText   = `✅ <b>${category}</b>${forwardTag}  <i>${preview}</i>${confTag}`;
  const notifMarkup = { inline_keyboard: [[{ text: '🔄 分类错了', callback_data: 'corr_show' }]] };

  const notifRes   = await sendMessage(token, chatId, notifText, null, { reply_markup: notifMarkup });
  const notifMsgId = notifRes?.result?.message_id;

  if (notifMsgId && movedMsgId) {
    await saveCorrection(env.KV, chatId, notifMsgId, {
      movedMsgId, movedThreadId: threadId, topicName: category, preview, noteId,
    });
    await recordDefaultMsgs(env.KV, chatId, notifMsgId);
  }

  // 定时删通知：ctx.waitUntil 确保 Worker 不提前终止
  if (notifMsgId && ctx) {
    ctx.waitUntil((async () => {
      await new Promise(res => setTimeout(res, lowConf ? NOTIFY_LOW_CONF_DELETE_MS : NOTIFY_AUTO_DELETE_MS));
      await Promise.all([
        deleteMessage(token, chatId, notifMsgId),
        deleteCorrection(env.KV, chatId, notifMsgId),
      ]);
    })());
  }
}

// ─── Callback Query ───────────────────────────────────────────────────────────

async function handleCallbackQuery(query, env) {
  const token      = env.TELEGRAM_BOT_TOKEN;
  const chatId     = String(query.message.chat.id);
  const notifMsgId = query.message.message_id;
  const data       = query.data;

  await answerCallbackQuery(token, query.id);

  if (data === 'corr_show') {
    const corr = await getCorrection(env.KV, chatId, notifMsgId);
    if (!corr) { await editMessageText(token, chatId, notifMsgId, '⚠️ 纠错已过期'); return; }
    const rows = [
      [{ text: '🤖 让 AI 重新分类', callback_data: 'corr_ai'     }],
      [{ text: '✏️ 自定义话题名',   callback_data: 'corr_custom' }],
      [{ text: '📁 选择已有话题',   callback_data: 'corr_list'   }],
      [{ text: '❌ 取消',            callback_data: 'corr_cancel' }],
    ];
    await editMessageText(token, chatId, notifMsgId,
      `当前：<b>${corr.topicName}</b>\n\n选择纠正方式：`,
      { inline_keyboard: rows }
    );
    return;
  }

  if (data === 'corr_list') {
    const corr = await getCorrection(env.KV, chatId, notifMsgId);
    if (!corr) { await editMessageText(token, chatId, notifMsgId, '⚠️ 纠错已过期'); return; }
    const map = await getTopicMap(env.KV, chatId);
    const entries = Object.entries(map).filter(([, tid]) => tid !== corr.movedThreadId);
    if (!entries.length) {
      await editMessageText(token, chatId, notifMsgId,
        `当前：<b>${corr.topicName}</b>\n\n没有其他话题可选。`,
        { inline_keyboard: [[{ text: '← 返回', callback_data: 'corr_show' }]] }
      );
      return;
    }
    const rows = [];
    for (let i = 0; i < entries.length; i += 2) {
      rows.push(entries.slice(i, i + 2).map(([name, tid]) => ({
        text: `📁 ${name}`, callback_data: `cm:${tid}`,
      })));
    }
    rows.push([{ text: '← 返回', callback_data: 'corr_show' }]);
    await editMessageText(token, chatId, notifMsgId,
      `当前：<b>${corr.topicName}</b>\n\n选择目标话题：`,
      { inline_keyboard: rows }
    );
    return;
  }

  if (data === 'corr_ai') {
    const corr = await getCorrection(env.KV, chatId, notifMsgId);
    if (!corr) { await editMessageText(token, chatId, notifMsgId, '⚠️ 纠错已过期'); return; }
    await savePending(env.KV, chatId, { type: 'corr_ai_hint', notifMsgId, ...corr });
    await editMessageText(token, chatId, notifMsgId,
      `🤖 <b>让 AI 重新分类</b>\n\n` +
      `当前：<b>${corr.topicName}</b>  <i>${corr.preview}</i>\n\n` +
      `请在默认话题发一条消息，告诉 AI 这条内容是什么用途。\n` +
      `例如："这是工作技术笔记" 或 "这是购物清单"`,
      { inline_keyboard: [[{ text: '❌ 取消', callback_data: 'corr_cancel' }]] }
    );
    return;
  }

  if (data === 'corr_custom') {
    const corr = await getCorrection(env.KV, chatId, notifMsgId);
    if (!corr) { await editMessageText(token, chatId, notifMsgId, '⚠️ 纠错已过期'); return; }
    await savePending(env.KV, chatId, { type: 'corr_custom', notifMsgId, ...corr });
    await editMessageText(token, chatId, notifMsgId,
      `✏️ <b>自定义话题名</b>\n\n请在默认话题发一条消息，输入新的话题名称（2-6字）：`,
      { inline_keyboard: [[{ text: '❌ 取消', callback_data: 'corr_cancel' }]] }
    );
    return;
  }

  if (data.startsWith('cm:')) {
    const newThreadId = Number(data.slice(3));
    const corr = await getCorrection(env.KV, chatId, notifMsgId);
    if (!corr) { await editMessageText(token, chatId, notifMsgId, '⚠️ 纠错已过期'); return; }
    const map = await getTopicMap(env.KV, chatId);
    const newTopicName = Object.keys(map).find(k => map[k] === newThreadId) || '未知';
    const copyRes = await copyMessage(token, chatId, chatId, corr.movedMsgId, newThreadId);
    if (copyRes?.ok) await deleteMessage(token, chatId, corr.movedMsgId);
    await addPref(env.KV, chatId, corr.topicName, newTopicName);
    await incrementStats(env.KV, chatId, newTopicName);
    // 更新笔记话题
    if (corr.noteId) {
      const noteRaw = await env.KV.get(`note:${corr.noteId}`);
      if (noteRaw) {
        const note = JSON.parse(noteRaw);
        note.topic = newTopicName;
        await env.KV.put(`note:${corr.noteId}`, JSON.stringify(note));
      }
    }
    await deleteCorrection(env.KV, chatId, notifMsgId);
    await editMessageText(token, chatId, notifMsgId,
      `✅ <b>${newTopicName}</b>  <i>${corr.preview}</i>\n<i>已纠正，AI 记录偏好</i>`
    );
    return;
  }

  if (data === 'corr_cancel') {
    const corr = await getCorrection(env.KV, chatId, notifMsgId);
    await Promise.all([
      deleteCorrection(env.KV, chatId, notifMsgId),
      deletePending(env.KV, chatId),
    ]);
    await editMessageText(token, chatId, notifMsgId,
      `✅ <b>${corr?.topicName || '已归档'}</b>  <i>${corr?.preview || ''}</i>`
    );
  }
}

// ─── 待输入处理 ───────────────────────────────────────────────────────────────

async function handlePendingInput(msg, pending, env) {
  const chatId = String(msg.chat.id);
  const token  = env.TELEGRAM_BOT_TOKEN;
  await deletePending(env.KV, chatId);
  await deleteMessage(token, chatId, msg.message_id);

  if (pending.type === 'corr_custom') {
    const newName = msg.text.trim().slice(0, 20);
    const newThreadId = await getOrCreateTopic(env.KV, token, chatId, newName);
    if (!newThreadId) { await sendMessage(token, chatId, `⚠️ 无法创建话题「${newName}」`); return; }
    const cr1 = await copyMessage(token, chatId, chatId, pending.movedMsgId, newThreadId);
    if (cr1?.ok) await deleteMessage(token, chatId, pending.movedMsgId);
    await addPref(env.KV, chatId, pending.topicName, newName);
    await incrementStats(env.KV, chatId, newName);
    if (pending.noteId) {
      const noteRaw = await env.KV.get(`note:${pending.noteId}`);
      if (noteRaw) {
        const note = JSON.parse(noteRaw);
        note.topic = newName;
        await env.KV.put(`note:${pending.noteId}`, JSON.stringify(note));
      }
    }
    await deleteCorrection(env.KV, chatId, pending.notifMsgId);
    await editMessageText(token, chatId, pending.notifMsgId,
      `✅ <b>${newName}</b>  <i>${pending.preview}</i>\n<i>自定义话题，AI 已记录偏好</i>`
    );
    return;
  }

  if (pending.type === 'corr_ai_hint') {
    const userHint = msg.text.trim();
    if (userHint.includes('记住')) {
      await addMemory(env.KV, chatId, userHint);
    }
    
    await editMessageText(token, chatId, pending.notifMsgId, '🤖 AI 正在重新分类…');

    const topicMap = await getTopicMap(env.KV, chatId);
    const existing = Object.keys(topicMap);
    const prefs    = await getPrefs(env.KV, chatId);
    const existingHint = existing.length ? `\n已有话题（优先复用）：${existing.join('、')}\n` : '';
    const prefsHint    = buildPrefsPrompt(prefs);

    const prompt = PROMPT_RECLASSIFY(existingHint, prefsHint, pending.topicName, userHint, pending.preview);

    let newCategory = '未分类';
    try {
      const raw = await callAI(
        env.AI_BASE_URL || DEFAULT_AI_BASE_URL,
        env.AI_API_KEY,
        env.AI_MODEL || DEFAULT_AI_MODEL,
        [{ role: 'user', content: prompt }], 100
      );
      const parsed = parseJSON(raw);
      if (parsed?.category) newCategory = parsed.category;
    } catch(e) { console.error('re-classify:', e); }

    const newThreadId = await getOrCreateTopic(env.KV, token, chatId, newCategory);
    if (!newThreadId) {
      await editMessageText(token, chatId, pending.notifMsgId, `⚠️ 无法创建话题「${newCategory}」`);
      return;
    }
    const cr2 = await copyMessage(token, chatId, chatId, pending.movedMsgId, newThreadId);
    if (cr2?.ok) await deleteMessage(token, chatId, pending.movedMsgId);
    await addPref(env.KV, chatId, pending.topicName, newCategory);
    await incrementStats(env.KV, chatId, newCategory);
    if (pending.noteId) {
      const noteRaw = await env.KV.get(`note:${pending.noteId}`);
      if (noteRaw) {
        const note = JSON.parse(noteRaw);
        note.topic = newCategory;
        await env.KV.put(`note:${pending.noteId}`, JSON.stringify(note));
      }
    }
    await deleteCorrection(env.KV, chatId, pending.notifMsgId);
    await editMessageText(token, chatId, pending.notifMsgId,
      `✅ <b>${newCategory}</b>  <i>${pending.preview}</i>\n<i>AI 重新分类，已记录偏好</i>`
    );
  }
}

// ─── 工具 ─────────────────────────────────────────────────────────────────────

const isDefaultTopic = (msg) => !msg.message_thread_id || msg.message_thread_id === 1;
const isForumGroup   = (msg) => msg.chat?.is_forum === true;

// ─── Worker 入口 ──────────────────────────────────────────────────────────────

export default {
  async fetch(request, env, ctx) {
    if (request.method !== 'POST') return new Response('Telegram Note Bot v5 ✓');
    try {
      const body = await request.json();

      if (body.callback_query) {
        await handleCallbackQuery(body.callback_query, env);
        return new Response('OK');
      }

      const msg = body.message;
      if (!msg) return new Response('OK');

      if (isForumGroup(msg)) {
        // 引用回复"删除" → 并行静默删除
        if (msg.text?.trim() === '清除记录' && isDefaultTopic(msg)) {
          const chatId = String(msg.chat.id);
          await deleteMessage(env.TELEGRAM_BOT_TOKEN, chatId, msg.message_id);
          const ids = await popDefaultMsgs(env.KV, chatId);
          await Promise.all(ids.map(id => deleteMessage(env.TELEGRAM_BOT_TOKEN, chatId, id)));
          return new Response('OK');
        }

        if (msg.text?.trim() === '删除' && msg.reply_to_message) {
          const chatId = String(msg.chat.id);
          // 并行删除两条消息
          await Promise.all([
            deleteMessage(env.TELEGRAM_BOT_TOKEN, chatId, msg.reply_to_message.message_id),
            deleteMessage(env.TELEGRAM_BOT_TOKEN, chatId, msg.message_id),
          ]);
          // 同步删除 KV 里对应的笔记
          try {
            const msgDate = (msg.reply_to_message.date || 0) * 1000;
            const idxRaw  = await env.KV.get(`noteindex:${chatId}`);
            if (idxRaw) {
              const idx   = JSON.parse(idxRaw);
              const match = idx.findIndex(n => Math.abs(n.ts - msgDate) < 30000);
              if (match >= 0) {
                const noteId  = idx[match].id;
                const noteRaw = await env.KV.get(`note:${noteId}`);
                if (noteRaw) {
                  const freed = new TextEncoder().encode(noteRaw).length;
                  idx.splice(match, 1);
                  const cur = Number(await env.KV.get(`storage:${chatId}`) || '0');
                  await Promise.all([
                    env.KV.delete(`note:${noteId}`),
                    env.KV.put(`noteindex:${chatId}`, JSON.stringify(idx)),
                    env.KV.put(`storage:${chatId}`, String(Math.max(0, cur - freed))),
                  ]);
                }
              }
            }
          } catch(e) { console.error('KV delete error:', e); }
          return new Response('OK');
        }

        if (msg.text?.startsWith('/')) {
          await handleCommand(msg, env);
        } else if (isDefaultTopic(msg)) {
          const pending = await getPending(env.KV, String(msg.chat.id));
          if ((pending?.type === 'corr_custom' || pending?.type === 'corr_ai_hint') && msg.text) {
            await handlePendingInput(msg, pending, env);
          } else {
            await handleDefaultTopicMessage(msg, env, ctx);
          }
        } else if (!isDefaultTopic(msg) && msg.text) {
          // 分类话题里的对话处理
          const chatId   = String(msg.chat.id);
          const threadId = String(msg.message_thread_id);
          const text     = msg.text.trim();

          if (text === '结束对话') {
            const session = await getChatSession(env.KV, chatId, threadId);
            if (session) {
              await endChat(msg, session, env);
            }
          } else {
            const session = await getChatSession(env.KV, chatId, threadId);
            if (session) {
              // 已有会话 → 继续对话
              await continueChat(msg, session, env);
            } else if (msg.reply_to_message) {
              // 引用回复 → 开始新对话
              await startChat(msg, env);
            }
          }
        }
      }
    } catch (e) {
      console.error('Worker error:', e);
    }
    return new Response('OK');
  },

  async scheduled(event, env) {
    try {
      const subs = await getSubscribers(env.KV);
      for (const { chatId, threadId } of subs) {
        const stats   = await getDailyStats(env.KV, chatId);
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

// ─── 对话功能 ────────────────────────────────────────────────────────────────

async function startChat(msg, env) {
  const { chat, message_id, reply_to_message, text } = msg;
  const chatId   = String(chat.id);
  const threadId = String(msg.message_thread_id);
  const token    = env.TELEGRAM_BOT_TOKEN;

  // 读取被引用消息的内容
  const quotedText = reply_to_message?.text || reply_to_message?.caption || '';
  if (!quotedText) {
    await sendMessage(token, chatId, '⚠️ 请引用一条有文字内容的笔记来开始对话。', msg.message_thread_id);
    return;
  }

  // 发思考中占位
  const thinkRes = await sendMessage(token, chatId, '🤔 思考中…', msg.message_thread_id);
  const thinkId  = thinkRes?.result?.message_id;

  // 读取该话题最近 10 条笔记全文作为上下文
  const notes  = await getNotesByTopic(env.KV, chatId, await getTopicNameByThreadId(env.KV, chatId, threadId));
  const recent = notes.slice(-CHAT_CONTEXT_NOTE_COUNT);
  const contextText = recent.length
    ? recent.map((n, i) => `[笔记${i + 1}] ` + n.content).join('\n\n')
    : '';

  const systemPrompt = PROMPT_CHAT_SYSTEM(contextText, quotedText);

  // 构建初始历史
  const history = [{ role: 'user', content: text }];

  // 调用 AI
  const aiReply = await callAI(
    env.AI_BASE_URL || DEFAULT_AI_BASE_URL,
    env.AI_API_KEY,
    env.AI_MODEL || DEFAULT_AI_MODEL,
    [{ role: 'system', content: systemPrompt }, ...history],
    800
  );

  history.push({ role: 'assistant', content: aiReply });

  // 保存会话
  await saveChatSession(env.KV, chatId, threadId, {
    noteContext: quotedText,
    contextText,
    history,
    msgIds: [message_id],
  });

  // 用 AI 回复替换占位消息
  if (thinkId) await editMessageText(token, chatId, thinkId, aiReply);
  const replyMsgId = thinkId;
  if (replyMsgId) {
    const session = await getChatSession(env.KV, chatId, threadId);
    session.msgIds.push(replyMsgId);
    await saveChatSession(env.KV, chatId, threadId, session);
  }
}

async function continueChat(msg, session, env) {
  const { chat, message_id, text } = msg;
  const chatId   = String(chat.id);
  const threadId = String(msg.message_thread_id);
  const token    = env.TELEGRAM_BOT_TOKEN;

  session.history.push({ role: 'user', content: text });
  session.msgIds.push(message_id);

  // 发思考中占位
  const thinkRes2 = await sendMessage(token, chatId, '🤔 思考中…', msg.message_thread_id);
  const thinkId2  = thinkRes2?.result?.message_id;

  const systemPrompt = PROMPT_CHAT_SYSTEM(session.contextText || '', session.noteContext);

  const aiReply = await callAI(
    env.AI_BASE_URL || DEFAULT_AI_BASE_URL,
    env.AI_API_KEY,
    env.AI_MODEL || DEFAULT_AI_MODEL,
    [{ role: 'system', content: systemPrompt }, ...session.history],
    800
  );

  session.history.push({ role: 'assistant', content: aiReply });

  await saveChatSession(env.KV, chatId, threadId, session);

  // 用 AI 回复替换占位
  if (thinkId2) await editMessageText(token, chatId, thinkId2, aiReply);
  if (thinkId2) {
    session.msgIds.push(thinkId2);
    await saveChatSession(env.KV, chatId, threadId, session);
  }
}

async function endChat(msg, session, env) {
  const { chat, message_id } = msg;
  const chatId   = String(chat.id);
  const threadId = String(msg.message_thread_id);
  const token    = env.TELEGRAM_BOT_TOKEN;

  // 删除"结束对话"这条消息
  await deleteMessage(token, chatId, message_id);

  // 发总结中占位
  const summaryPlaceholder = await sendMessage(token, chatId, '📝 正在生成对话摘要…', msg.message_thread_id);
  const summaryPlaceholderId = summaryPlaceholder?.result?.message_id;

  // 让 AI 总结对话，提炼有用内容
  const historyText = session.history
    .map(h => `${h.role === 'user' ? '我' : 'AI'}：${h.content}`)
    .join('\n\n');

  const summaryPrompt = PROMPT_CHAT_SUMMARY(session.noteContext, historyText);

  let summary = '';
  try {
    summary = await callAI(
      env.AI_BASE_URL || DEFAULT_AI_BASE_URL,
      env.AI_API_KEY,
      env.AI_MODEL || DEFAULT_AI_MODEL,
      [{ role: 'user', content: summaryPrompt }],
      400
    );
  } catch(e) {
    console.error('summary error:', e);
    summary = '（总结生成失败）';
  }

  // 并行删除所有对话消息
  await Promise.all(session.msgIds.map(id => deleteMessage(token, chatId, id)));

  // 删占位，发最终摘要
  if (summaryPlaceholderId) await deleteMessage(token, chatId, summaryPlaceholderId);
  const topicName = await getTopicNameByThreadId(env.KV, chatId, threadId);
  const summaryMsg = `📝 <b>对话摘要</b>

${summary}`;
  await sendMessage(token, chatId, summaryMsg, msg.message_thread_id);

  // 存摘要到 KV
  await saveNote(env.KV, chatId, topicName || '对话摘要', `[对话摘要] ${summary}`, 'summary');

  // 删除会话
  await deleteChatSession(env.KV, chatId, threadId);
}

// 根据 threadId 反查话题名
async function getTopicNameByThreadId(kv, chatId, threadId) {
  const map = await getTopicMap(kv, chatId);
  return Object.keys(map).find(k => String(map[k]) === String(threadId)) || null;
}

// ─── 命令处理 ─────────────────────────────────────────────────────────────────

async function handleCommand(msg, env) {
  const { chat, text, message_thread_id } = msg;
  const chatId   = String(chat.id);
  const token    = env.TELEGRAM_BOT_TOKEN;
  const threadId = message_thread_id || null;
  const parts    = text.trim().split(/\s+/);
  const cmd      = parts[0].split('@')[0];

  if (isDefaultTopic(msg)) await recordDefaultMsgs(env.KV, chatId, msg.message_id);

  // sendReply: 发消息并自动记录 Bot 回复 ID
  const sendReply = async (txt, extra = {}) => {
    const r = await sendMessage(token, chatId, txt, threadId, extra);
    if (isDefaultTopic(msg) && r?.result?.message_id)
      await recordDefaultMsgs(env.KV, chatId, r.result.message_id);
    return r;
  };

  if (cmd === '/start' || cmd === '/help') {
    await sendReply(`🗂️ <b>笔记分类 Bot v5</b>\n\n` +
      `在「默认话题」发文字、图片、语音或转发消息，AI 自动分类。\n\n` +
      `<b>命令</b>\n` +
      `/topics — 查看所有话题\n` +
      `/rename 新名 — 在话题内重命名\n` +
      `/rename 旧名 新名 — 在默认话题重命名\n` +
      `/merge 话题A 话题B — 将 A 合并到 B\n` +
      `/search 关键词 — 搜索话题\n` +
      `/stats — 今日统计\n` +
      `/export — 导出所有笔记内容\n` +
      `/export 话题名 — 导出指定话题笔记\n` +
      `/storage — 查看存储用量\n` +
      `/clean 30 — 清理 30 天前的笔记（默认30天）\n` +
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
    if (!entries.length) { await sendReply('📂 还没有话题，发笔记自动创建。'); return; }
    await sendReply(`🗂️ <b>当前话题</b>（${entries.length} 个）\n\n${entries.map(([n]) => `  📁 ${n}`).join('\n')}`,
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
      if (!newName) { await sendReply('用法：<code>/rename 新话题名</code>'); return; }
      if (!oldName) { await sendReply('⚠️ 当前话题不在 Bot 记录里。'); return; }
    } else {
      oldName = parts[1]; newName = parts.slice(2).join(' ');
      if (!oldName || !newName) { await sendReply('用法：<code>/rename 旧话题名 新话题名</code>'); return; }
      if (!map[oldName]) { await sendReply(`⚠️ 找不到「${oldName}」`); return; }
      tid = map[oldName];
    }
    await editForumTopic(token, chatId, tid, newName);
    delete map[oldName]; map[newName] = tid;
    await saveTopicMap(env.KV, chatId, map);
    await addPref(env.KV, chatId, oldName, newName);
    await sendReply(`✅ 「${oldName}」→「${newName}」\n🧠 AI 已记录偏好`);
    return;
  }

  if (cmd === '/merge') {
    const topicA = parts[1], topicB = parts.slice(2).join(' ');
    if (!topicA || !topicB) { await sendReply('用法：<code>/merge 话题A 话题B</code>'); return; }
    const map = await getTopicMap(env.KV, chatId);
    if (!map[topicA]) { await sendReply(`⚠️ 找不到「${topicA}」`); return; }
    if (!map[topicB]) { await sendReply(`⚠️ 找不到「${topicB}」`); return; }
    await closeForumTopic(token, chatId, map[topicA]);
    delete map[topicA];
    await saveTopicMap(env.KV, chatId, map);
    await addPref(env.KV, chatId, topicA, topicB);
    await sendReply(`✅ 「${topicA}」已合并到「${topicB}」并关闭。`);
    return;
  }

  if (cmd === '/search') {
    const kw = parts.slice(1).join(' ');
    if (!kw) { await sendReply('用法：<code>/search 关键词</code>'); return; }
    const map   = await getTopicMap(env.KV, chatId);
    const prefs = await getPrefs(env.KV, chatId);
    const matchTopics = Object.keys(map).filter(n => n.includes(kw));
    const matchPrefs  = prefs.filter(p => p.from.includes(kw) || p.to.includes(kw));
    if (!matchTopics.length && !matchPrefs.length) {
      await sendReply(`🔍 未找到含「${kw}」的结果`); return;
    }
    let reply = `🔍 <b>搜索「${kw}」</b>\n\n`;
    if (matchTopics.length) reply += `<b>话题：</b>\n${matchTopics.map(n => `  📁 ${n}`).join('\n')}\n\n`;
    if (matchPrefs.length)  reply += `<b>偏好：</b>\n${matchPrefs.map(p => `  ${p.from} → ${p.to}`).join('\n')}`;
    await sendReply(reply.trim());
    return;
  }

  if (cmd === '/stats') {
    const stats   = await getDailyStats(env.KV, chatId);
    const map     = await getTopicMap(env.KV, chatId);
    const entries = Object.entries(stats).sort(([, a], [, b]) => b - a);
    const total   = entries.reduce((s, [, c]) => s + c, 0);
    let reply = `📊 <b>统计</b>\n\n话题总数：${Object.keys(map).length} 个\n今日新增：${total} 条`;
    if (entries.length) reply += `\n\n<b>今日分布：</b>\n${entries.map(([n, c]) => `  📁 ${n}  ${c} 条`).join('\n')}`;
    await sendReply(reply);
    return;
  }

  if (cmd === '/storage') {
    const usedBytes = await getStorageBytes(env.KV, chatId);
    const usedMB    = usedBytes / 1024 / 1024;
    const freeMB    = KV_FREE_LIMIT_MB - usedMB;
    const pct       = (usedMB / KV_FREE_LIMIT_MB * 100).toFixed(1);
    const bar       = '█'.repeat(Math.floor(Number(pct) / 10)) + '░'.repeat(10 - Math.floor(Number(pct) / 10));
    await sendReply(`💾 <b>存储用量</b>\n\n` +
      `${bar} ${pct}%\n` +
      `已用：${usedMB.toFixed(2)} MB\n` +
      `剩余：${freeMB.toFixed(2)} MB / ${KV_FREE_LIMIT_MB} MB\n\n` +
      `发 <code>/clean 30</code> 可清理 30 天前的笔记`,
      threadId
    );
    return;
  }

  if (cmd === '/clean') {
    const days = Number(parts[1]) || CLEAN_DEFAULT_DAYS;
    const cleaned = await cleanOldNotes(env.KV, chatId, days);
    const usedBytes = await getStorageBytes(env.KV, chatId);
    const usedMB    = (usedBytes / 1024 / 1024).toFixed(2);
    await sendReply(`🗑️ 已清理 ${cleaned} 条 ${days} 天前的笔记\n当前已用：${usedMB} MB`,
      threadId
    );
    return;
  }

  if (cmd === '/export') {
    const topicFilter = parts.slice(1).join(' ') || null;
    const notes = topicFilter
      ? await getNotesByTopic(env.KV, chatId, topicFilter)
      : await getAllNotes(env.KV, chatId);

    if (!notes.length) {
      await sendReply(
        topicFilter ? `📂 话题「${topicFilter}」没有笔记` : '📂 还没有任何笔记',
        threadId
      );
      return;
    }

    // 按话题分组，保留原始排版
    const grouped = {};
    for (const note of notes) {
      if (!grouped[note.topic]) grouped[note.topic] = [];
      grouped[note.topic].push(note);
    }

    let report = topicFilter
      ? `📁 ${topicFilter}\n${'─'.repeat(20)}\n\n`
      : `笔记导出\n导出时间：${new Date().toLocaleDateString('zh-CN')}\n${'─'.repeat(30)}\n\n`;

    for (const [topic, topicNotes] of Object.entries(grouped)) {
      if (!topicFilter) report += `📁 ${topic}\n${'─'.repeat(20)}\n\n`;
      for (const note of topicNotes) {
        const time = new Date(note.ts).toLocaleString('zh-CN', {
          year: 'numeric', month: '2-digit', day: '2-digit',
          hour: '2-digit', minute: '2-digit',
        });
        report += `${note.content}\n${time}\n\n`;
      }
      if (!topicFilter) report += '\n';
    }

    const fileName = topicFilter
      ? `${topicFilter}_${new Date().toLocaleDateString('zh-CN').replace(/\//g, '-')}.txt`
      : `笔记导出_${new Date().toLocaleDateString('zh-CN').replace(/\//g, '-')}.txt`;

    const blob = new Blob([report], { type: 'text/plain; charset=utf-8' });
    const form = new FormData();
    form.append('chat_id', chatId);
    form.append('document', blob, fileName);
    if (threadId) form.append('message_thread_id', String(threadId));
    form.append('caption', `共 ${notes.length} 条笔记`);

    await fetch(TG_API(token, 'sendDocument'), { method: 'POST', body: form });
    return;
  }

  if (cmd === '/prefs') {
    const prefs = await getPrefs(env.KV, chatId);
    if (!prefs.length) { await sendReply('🧠 还没有偏好记录。'); return; }
    await sendReply(`🧠 <b>AI 偏好</b>（${prefs.length} 条）\n\n${prefs.map(p => `  <b>${p.from}</b> → <b>${p.to}</b>`).join('\n')}`,
      threadId
    );
    return;
  }

  if (cmd === '/clear_prefs') {
    await Promise.all([
      env.KV.delete(`prefs:${chatId}`),
      env.KV.delete(`memories:${chatId}`)
    ]);
    await sendReply('🗑️ 分类偏好与用户记忆规则已清空。');
    return;
  }

  if (cmd === '/subscribe_daily') {
    await addSubscriber(env.KV, chatId, threadId);
    await sendReply('✅ 已开启每日摘要，每天晚上 8 点推送。');
    return;
  }

  if (cmd === '/unsubscribe_daily') {
    await removeSubscriber(env.KV, chatId);
    await sendReply('✅ 已关闭每日摘要。');
    return;
  }

  if (cmd === '/reset_topics') {
    await env.KV.delete(`topics:${chatId}`);
    await sendReply('✅ 话题映射已清空。');
    return;
  }
}
