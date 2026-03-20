/**
 * config.js — 所有可配置项集中在这里
 *
 * 改提示词、调阈值、换风格，只需动这一个文件
 * API Key / Token 等敏感信息仍在 GitHub Secrets，不在这里
 */

// 行为阈值

// AI 分类置信度下限（0.0-1.0）
// 低于此值时：通知不自动消失 + 显示低置信度警告 + 等待用户手动纠错
export const CONFIDENCE_THRESHOLD = 0.70;

// KV 存储预警阈值（MB）
// 超过此用量时在默认话题发一条提醒（CF KV 免费版上限 1024MB）
export const STORAGE_WARN_MB = 900;

// CF KV 免费版总容量上限（MB），用于 /storage 显示剩余空间
export const KV_FREE_LIMIT_MB = 1024;

// /clean 默认清理天数（不带参数时使用）
export const CLEAN_DEFAULT_DAYS = 30;

// 对话会话过期时间（秒），超时自动清除 KV 临时记录
export const CHAT_EXPIRE_SECONDS = 3600; // 1 小时

// 分类通知自动消失时间（毫秒），置信度正常时生效
export const NOTIFY_AUTO_DELETE_MS = 15000; // 15秒

// 置信度低时通知保留时间（毫秒），给用户时间点纠错按钮
export const NOTIFY_LOW_CONF_DELETE_MS = 60000; // 1 分钟

// 对话上下文：带入该话题最近 N 条笔记全文
export const CHAT_CONTEXT_NOTE_COUNT = 10;

// 视觉模型记忆的最大存储条数（记住图片特征）
export const MAX_MEMORY_COUNT = 30;


// ─── AI 默认模型（wrangler.toml 里可覆盖）────────────────────────────────────

export const DEFAULT_AI_BASE_URL     = 'https://api.deepseek.com/v1';
export const DEFAULT_AI_MODEL        = 'deepseek-chat';
export const DEFAULT_VISION_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3';
export const DEFAULT_VISION_MODEL_PHOTO = 'doubao-1.5-vision-lite-250315'; // 普通照片
export const DEFAULT_VISION_MODEL_DOC   = 'doubao-1.5-vision-lite-250315';             // 截图/文字图片
export const DEFAULT_SPEECH_BASE_URL = 'https://api.siliconflow.cn/v1';
export const DEFAULT_SPEECH_MODEL    = 'TeleAI/TeleSpeechASR';     // 语音转文字

// ─── 提示词 ────────────────────────────────────────────────────────────────────

/**
 * 笔记自动分类提示词
 * 触发时机：在默认话题发送新笔记时调用
 * 参数：
 *   existingHint — 已有话题列表（供 AI 优先复用）
 *   prefsHint    — 用户改名偏好记录（供 AI 参考）
 *   text         — 笔记正文
 */
export const PROMPT_CLASSIFY = (existingHint, prefsHint, text) =>
  `你是笔记分类助手。${existingHint}${prefsHint}
规则：新话题名2-6字、具体；不用"其他""杂项"。
confidence 为分类置信度（0.0-1.0），不确定时给低分。
只输出JSON：{"category":"话题名","summary":"摘要不超过20字","confidence":0.9}
内容：${text}`;

/**
 * 纠错时 AI 重新分类提示词
 * 触发时机：用户点"🤖 让 AI 重新分类"并输入提示词后调用
 * 参数：
 *   existingHint  — 已有话题列表
 *   prefsHint     — 用户偏好记录
 *   oldTopic      — 上次分错的话题名
 *   userHint      — 用户输入的提示词（描述这条内容的用途）
 *   preview       — 笔记内容摘要
 */
export const PROMPT_RECLASSIFY = (existingHint, prefsHint, oldTopic, userHint, preview) =>
  `你是笔记分类助手。${existingHint}${prefsHint}
上次将此内容分到「${oldTopic}」被用户否定，请换一个更合适的话题。
用户提示：${userHint}
规则：话题名2-6字、具体；不用"其他""杂项"。
只输出JSON：{"category":"话题名","summary":"摘要不超过20字","confidence":0.9}
内容：${preview}`;

/**
 * 图片内容描述提示词
 * 触发时机：发送图片时，先用视觉模型描述图片，再走文字分类
 * 参数：无（直接拼接到 content 数组里）
 */
export const PROMPT_IMAGE_DESCRIBE =
  '用中文简短描述这张图片的主要内容（不超过50字）';

/**
 * 笔记对话系统提示词
 * 触发时机：引用某条笔记开始对话 / 继续对话时，作为 system 消息传入
 * 参数：
 *   contextText — 该话题最近 N 条笔记全文（背景参考）
 *   noteContext — 被引用笔记的内容（对话核心）
 */
export const PROMPT_CHAT_SYSTEM = (contextText, noteContext) =>
  `你是用户的笔记助手。以下是该话题的相关笔记内容，作为背景参考：\n\n${contextText}\n\n` +
  `用户正在针对以下这条笔记和你对话：\n「${noteContext}」\n\n` +
  `请基于这些内容回答用户的问题。` +
  `风格：直接简洁，不用"当然""好的"开头，不过度解释，像朋友聊天一样自然。` +
  `不要使用 ** 加粗格式。`;

/**
 * 对话结束摘要提示词
 * 触发时机：用户发"结束对话"时调用，提炼整段对话的有用内容
 * 参数：
 *   noteContext  — 原始笔记内容
 *   historyText  — 整段对话记录（格式化后的文字）
 */
export const PROMPT_CHAT_SUMMARY = (noteContext, historyText) =>
  `以下是一段针对笔记的对话记录，请提炼其中有价值的内容，` +
  `以简洁清晰的笔记形式输出（不超过200字），去掉对话语气，只保留有用的结论、补充或洞察。` +
  `输出纯文字，不要使用 ** 加粗格式。\n\n` +
  `原始笔记：「${noteContext}」\n\n对话记录：\n${historyText}`;

