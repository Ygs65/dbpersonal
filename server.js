// server.js
// FlashBattle Pro Final
// - 房間競賽 + Redis 題庫
// - JWT 帳號系統（使用 userId + 密碼）
// - 排行榜多模式：最後一次 / 最高分 / 平均分
// 使用：node server.js

import express from 'express';
import http from 'http';
import { Server as SocketIOServer } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';
import Redis from 'ioredis';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ===== 設定區 =====
const redisUrl = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const JWT_EXPIRES_IN = '7d';

// 排行榜 key
const LEADERBOARD_KEYS = {
  last: 'leaderboard:last',
  best: 'leaderboard:best',
  avg: 'leaderboard:avg'
};

// 使用者相關 key
const USER_AUTH_KEY = (userId) => `user:${userId}:auth`;       // 帳號密碼
const USER_STATS_KEY = (userId) => `user:${userId}:stats`;     // 彙總成績
const USER_WRONG_KEY = (userId) => `user:${userId}:wrongbook`; // 錯題本
const USER_HISTORY_KEY = (userId) => `user:${userId}:history`; // 歷史成績 list

// 房間 / 題庫 key
const ROOM_SETTINGS_KEY = (roomId) => `room:${roomId}:settings`;
const ROOM_EXAM_KEY = (roomId) => `room:${roomId}:exam`;
const BANK_KEY = (roomId, bankId) => `bank:${roomId}:${bankId}`;

// ===== Redis 連線 =====
const redis = new Redis(redisUrl);

redis.on('connect', () => {
  console.log('[Redis] connected to', redisUrl);
});

redis.on('error', (err) => {
  console.error('[Redis] error:', err);
});

// ===== Express / Socket.IO =====
const app = express();
const server = http.createServer(app);
const io = new SocketIOServer(server, {
  cors: {
    origin: '*'
  }
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 靜態檔案：直接把整個專案資料夾當靜態目錄
app.use(express.static(__dirname));

// 預設首頁
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ===== 共用工具函式 =====
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

// 從 Redis 讀題庫 (R1: 整包 JSON 字串)
async function loadBankQuestions(roomId, bankId) {
  const key = BANK_KEY(roomId, bankId);
  const json = await redis.get(key);
  if (!json) return [];
  try {
    const obj = JSON.parse(json);
    if (Array.isArray(obj)) return obj;
    if (Array.isArray(obj.questions)) return obj.questions;
    return [];
  } catch (e) {
    console.error('[loadBankQuestions] JSON parse error:', e);
    return [];
  }
}

// 存題庫，格式：{ id, name, questions: [...] }
async function saveBank(roomId, bankId, name, questions) {
  const key = BANK_KEY(roomId, bankId);
  const payload = {
    id: bankId,
    name: name || bankId,
    questions
  };
  await redis.set(key, JSON.stringify(payload));
}

// 列出房間所有題庫（只看 bank:{roomId}:*）
async function listBanksForRoom(roomId) {
  const pattern = BANK_KEY(roomId, '*');
  const keys = await redis.keys(pattern);
  const result = [];
  for (const k of keys) {
    const json = await redis.get(k);
    if (!json) continue;
    try {
      const obj = JSON.parse(json);
      const id = obj.id || k.split(':')[2];
      const name = obj.name || id;
      const count = Array.isArray(obj.questions)
        ? obj.questions.length
        : (Array.isArray(obj) ? obj.length : 0);
      result.push({ id, name, count });
    } catch {
      const parts = k.split(':');
      const id = parts[2] || k;
      result.push({ id, name: id, count: 0 });
    }
  }
  return result;
}

// 解析 CSV (簡易版)
function parseSimpleCSV(text) {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (lines.length < 2) return [];
  const header = lines[0].split(',');
  const idxTopic = header.indexOf('topic');
  const idxText = header.indexOf('text');
  const idxA = header.indexOf('optionA');
  const idxB = header.indexOf('optionB');
  const idxC = header.indexOf('optionC');
  const idxD = header.indexOf('optionD');
  const idxAns = header.indexOf('answer');
  const idxExp = header.indexOf('explanation');

  if (idxText === -1 || idxA === -1 || idxB === -1 || idxAns === -1) {
    return [];
  }

  const result = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    if (cols.length < header.length) continue;
    const topic = idxTopic >= 0 ? cols[idxTopic].trim() : '';
    const textVal = cols[idxText].trim();
    if (!textVal) continue;
    const optA = cols[idxA]?.trim() || '';
    const optB = cols[idxB]?.trim() || '';
    const optC = idxC >= 0 ? (cols[idxC]?.trim() || '') : '';
    const optD = idxD >= 0 ? (cols[idxD]?.trim() || '') : '';
    const ansStr = cols[idxAns]?.trim() || '';
    const exp = idxExp >= 0 ? (cols[idxExp]?.trim() || '') : '';
    const n = parseInt(ansStr, 10);
    if (isNaN(n) || n < 1) continue;

    const options = [optA, optB];
    if (optC) options.push(optC);
    if (optD) options.push(optD);

    const ansIdx = n - 1;
    if (ansIdx < 0 || ansIdx >= options.length) continue;

    result.push({
      topic,
      text: textVal,
      options,
      answers: [ansIdx],
      type: 'single',
      explanation: exp
    });
  }
  return result;
}

// JSON 題目標準化
function normalizeJSONQuestions(data) {
  let arr = [];
  if (Array.isArray(data)) arr = data;
  else if (Array.isArray(data.questions)) arr = data.questions;
  else return [];

  return arr.map((q) => {
    const topic = q.topic || '';
    const tag = q.tag || '';
    const text = q.text || '';
    const options = Array.isArray(q.options) ? q.options : [];
    let answers = [];
    if (Array.isArray(q.answers)) {
      answers = q.answers.map(x => Number(x)).filter(x => !isNaN(x));
    } else if (typeof q.answer === 'number') {
      answers = [q.answer];
    }
    if (answers.length === 0 && options.length >= 1) answers = [0];
    const type = q.type || (answers.length > 1 ? 'multi' : 'single');
    const explanation = q.explanation || '';
    return { topic, tag, text, options, answers, type, explanation };
  }).filter(q => q.text && q.options.length >= 2);
}

// ===== JWT / Auth 工具 =====
function signToken(userId) {
  return jwt.sign({ sub: userId }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const [scheme, token] = authHeader.split(' ');
  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ ok: false, error: 'no_token' });
  }
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.userId = payload.sub;
    next();
  } catch (e) {
    console.error('[authMiddleware] verify failed', e);
    return res.status(401).json({ ok: false, error: 'invalid_token' });
  }
}

// ===== Auth APIs =====

// 註冊：userId + password + name
app.post('/auth/register', async (req, res) => {
  try {
    const { userId, password, name } = req.body || {};
    if (!userId || !password) {
      return res.status(400).json({ ok: false, error: 'missing_fields' });
    }
    const trimmedId = String(userId).trim();
    if (!/^[a-zA-Z0-9_\-]{3,20}$/.test(trimmedId)) {
      return res.status(400).json({ ok: false, error: 'bad_userId_format' });
    }
    const key = USER_AUTH_KEY(trimmedId);
    const existed = await redis.get(key);
    if (existed) {
      return res.status(409).json({ ok: false, error: 'user_exists' });
    }
    const hash = await bcrypt.hash(String(password), 10);
    const profile = {
      userId: trimmedId,
      name: name?.trim() || trimmedId,
      passwordHash: hash,
      createdAt: new Date().toISOString()
    };
    await redis.set(key, JSON.stringify(profile));
    const token = signToken(trimmedId);
    return res.json({
      ok: true,
      token,
      user: { userId: trimmedId, name: profile.name }
    });
  } catch (e) {
    console.error('/auth/register error', e);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// 登入：userId + password
app.post('/auth/login', async (req, res) => {
  try {
    const { userId, password } = req.body || {};
    if (!userId || !password) {
      return res.status(400).json({ ok: false, error: 'missing_fields' });
    }
    const trimmedId = String(userId).trim();
    const key = USER_AUTH_KEY(trimmedId);
    const json = await redis.get(key);
    if (!json) {
      return res.status(401).json({ ok: false, error: 'user_not_found' });
    }
    let profile;
    try {
      profile = JSON.parse(json);
    } catch {
      return res.status(500).json({ ok: false, error: 'profile_broken' });
    }
    const okPass = await bcrypt.compare(String(password), profile.passwordHash || '');
    if (!okPass) {
      return res.status(401).json({ ok: false, error: 'wrong_password' });
    }
    const token = signToken(trimmedId);
    return res.json({
      ok: true,
      token,
      user: { userId: trimmedId, name: profile.name || trimmedId }
    });
  } catch (e) {
    console.error('/auth/login error', e);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// 取得目前使用者資訊
app.get('/auth/me', authMiddleware, async (req, res) => {
  try {
    const userId = req.userId;
    const [authJson, statsJson] = await redis.mget(
      USER_AUTH_KEY(userId),
      USER_STATS_KEY(userId)
    );
    let user = null;
    if (authJson) {
      try {
        const p = JSON.parse(authJson);
        user = { userId: p.userId, name: p.name };
      } catch {}
    }
    let stats = null;
    if (statsJson) {
      try {
        stats = JSON.parse(statsJson);
      } catch {}
    }
    return res.json({ ok: true, user, stats });
  } catch (e) {
    console.error('/auth/me error', e);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// ===== 成績 / 排行榜 / 錯題本 APIs =====

// 取得排行榜（多模式 + 分頁）
app.get('/api/leaderboard', async (req, res) => {
  try {
    const type = (req.query.type || 'last').toString();
    const key = LEADERBOARD_KEYS[type] || LEADERBOARD_KEYS.last;
    const page = Math.max(parseInt(req.query.page || '1', 10), 1);
    const pageSize = Math.min(Math.max(parseInt(req.query.pageSize || '10', 10), 1), 50);
    const start = (page - 1) * pageSize;
    const end = start + pageSize - 1;

    const [rawEntries, totalCount] = await Promise.all([
      redis.zrevrange(key, start, end, 'WITHSCORES'),
      redis.zcard(key)
    ]);

    const entries = [];
    for (let i = 0; i < rawEntries.length; i += 2) {
      const userId = rawEntries[i];
      const score = Number(rawEntries[i + 1]) || 0;
      entries.push({ userId, score });
    }

    // 盡量補上名稱（從 stats 取）
    if (entries.length > 0) {
      const statKeys = entries.map(e => USER_STATS_KEY(e.userId));
      const statsJsonArr = await redis.mget(statKeys);
      statsJsonArr.forEach((s, idx) => {
        if (!s) return;
        try {
          const obj = JSON.parse(s);
          entries[idx].name = obj.name || entries[idx].userId;
        } catch {}
      });
    }

    const hasNext = end < totalCount - 1;
    return res.json({
      ok: true,
      type,
      page,
      pageSize,
      total: totalCount,
      hasNext,
      entries
    });
  } catch (e) {
    console.error('/api/leaderboard error', e);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// 取得「我的歷史成績」（需登入）
app.get('/api/history/me', authMiddleware, async (req, res) => {
  try {
    const userId = req.userId;
    const list = await redis.lrange(USER_HISTORY_KEY(userId), 0, 49);
    const history = [];
    for (const item of list) {
      try {
        history.push(JSON.parse(item));
      } catch {}
    }
    return res.json({ ok: true, history });
  } catch (e) {
    console.error('/api/history/me error', e);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// 取得「我的錯題本」（可選 topic / tag 篩選）
app.get('/api/wrongbook/me', authMiddleware, async (req, res) => {
  try {
    const userId = req.userId;
    const topic = (req.query.topic || '').toString().trim();
    const tag = (req.query.tag || '').toString().trim();
    const json = await redis.get(USER_WRONG_KEY(userId));
    if (!json) return res.json({ ok: true, wrongQuestions: [] });
    let arr;
    try {
      arr = JSON.parse(json);
    } catch {
      arr = [];
    }
    if (!Array.isArray(arr)) arr = [];
    let result = arr;
    if (topic) {
      result = result.filter(q => (q.topic || '') === topic);
    }
    if (tag) {
      result = result.filter(q => (q.tag || '') === tag);
    }
    return res.json({ ok: true, wrongQuestions: result });
  } catch (e) {
    console.error('/api/wrongbook/me error', e);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// ===== 接收考試結果（單人 / 房間） =====
app.post('/api/exam_result', async (req, res) => {
  try {
    const {
      playerId,
      name,
      mode,
      roomId,
      bankId,
      score,
      total,
      correctCount,
      wrongQuestions
    } = req.body || {};

    if (!playerId) {
      return res.status(400).json({ ok: false, error: 'missing_player' });
    }

    const lastScore = Number(score) || 0;
    const totalQuestions = Number(total) || 0;
    const lastCorrect = Number(correctCount) || 0;

    // 先載入舊 stats，用來累積 best / avg
    let prevStats = {};
    const existedJson = await redis.get(USER_STATS_KEY(playerId));
    if (existedJson) {
      try {
        prevStats = JSON.parse(existedJson) || {};
      } catch {
        prevStats = {};
      }
    }

    const prevAttempts = Number(prevStats.attemptCount || 0);
    const prevBest = Number(prevStats.bestScore || 0);
    const prevSum = Number(prevStats.totalScoreSum || 0);

    const attemptCount = prevAttempts + 1;
    const bestScore = Math.max(prevBest, lastScore);
    const totalScoreSum = prevSum + lastScore;
    const avgScore = attemptCount > 0 ? Math.round(totalScoreSum / attemptCount) : lastScore;

    const stats = {
      playerId,
      name: name || playerId,
      mode: mode || 'personal',
      lastRoomId: roomId || '',
      bankId: bankId || '',
      lastScore,
      totalQuestions,
      lastCorrect,
      attemptCount,
      bestScore,
      totalScoreSum,
      avgScore,
      updatedAt: new Date().toISOString()
    };

    // 1) 存「我的成績」
    await redis.set(USER_STATS_KEY(playerId), JSON.stringify(stats));

    // 2) 累積「我的錯題本」（直接 append，保留 topic / tag / explanation 等欄位）
    if (Array.isArray(wrongQuestions) && wrongQuestions.length > 0) {
      let merged = [];
      const existedWrong = await redis.get(USER_WRONG_KEY(playerId));
      if (existedWrong) {
        try { merged = JSON.parse(existedWrong) || []; } catch (e) { merged = []; }
      }
      merged = merged.concat(wrongQuestions);
      await redis.set(USER_WRONG_KEY(playerId), JSON.stringify(merged));
    }

    // 3) 歷史成績：LPUSH + LTRIM 保留最近 50 筆
    const historyEntry = {
      playerId,
      name: name || playerId,
      mode: mode || 'personal',
      roomId: roomId || '',
      bankId: bankId || '',
      score: lastScore,
      totalQuestions,
      correctCount: lastCorrect,
      createdAt: new Date().toISOString()
    };
    await redis.lpush(USER_HISTORY_KEY(playerId), JSON.stringify(historyEntry));
    await redis.ltrim(USER_HISTORY_KEY(playerId), 0, 49);

    // 4) 更新排行榜（Sorted Set，多模式）
    await Promise.all([
      redis.zadd(LEADERBOARD_KEYS.last, lastScore, String(playerId)),
      redis.zadd(LEADERBOARD_KEYS.best, bestScore, String(playerId)),
      redis.zadd(LEADERBOARD_KEYS.avg, avgScore, String(playerId))
    ]);

    // 5) 廣播最新「最後一次成績排行榜」給首頁（只更新 last 模式第一頁）
    try {
      const top = await redis.zrevrange(LEADERBOARD_KEYS.last, 0, 9, 'WITHSCORES');
      io.emit('leaderboard_update', top || []);
    } catch (e) {
      console.error('[leaderboard] refresh failed', e);
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('/api/exam_result error', err);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// ===== Socket.IO 事件 =====
io.on('connection', (socket) => {
  console.log('client connected', socket.id);

  // ---- 登入：使用者自己填的名稱 & userId（可來自 JWT profile） ----
  socket.on('login', async ({ name, userId }) => {
    const id = (userId && userId.trim()) || (name && name.trim()) || socket.id;
    socket.data.userId = id;
    socket.data.name = name || id;

    let stats = {};
    let wrongQuestions = [];

    try {
      const [statsRaw, wrongRaw] = await redis.mget(
        USER_STATS_KEY(id),
        USER_WRONG_KEY(id)
      );
      if (statsRaw) {
        stats = JSON.parse(statsRaw);
      }
      if (wrongRaw) {
        wrongQuestions = JSON.parse(wrongRaw);
      }
    } catch (e) {
      console.error('[login] load user stats failed:', e);
    }

    socket.emit('login_ack', {
      playerId: id,
      name: socket.data.name,
      stats,
      wrongQuestions
    });

    // 初次登入時，也送一份「最後一次成績」排行榜
    try {
      const top = await redis.zrevrange(LEADERBOARD_KEYS.last, 0, 9, 'WITHSCORES');
      socket.emit('leaderboard_update', top || []);
    } catch (e) {
      console.error('[login] load leaderboard failed:', e);
    }
  });

  // ---- 建立房間 ----
  socket.on('create_room', async ({ roomId }) => {
    if (!roomId) {
      socket.emit('create_room_ack', { ok: false, error: 'bad_request' });
      return;
    }
    const settingsKey = ROOM_SETTINGS_KEY(roomId);
    const exists = await redis.exists(settingsKey);
    if (exists) {
      socket.emit('create_room_ack', { ok: false, error: 'room_exists', roomId });
      return;
    }

    const hostId = socket.data?.userId || socket.id;
    const settings = {
      roomId,
      hostId,
      createdAt: Date.now()
    };
    await redis.set(settingsKey, JSON.stringify(settings));

    socket.join(roomId);
    socket.data.currentRoom = roomId;

    socket.emit('create_room_ack', { ok: true, roomId });
  });

  // ---- 加入房間 ----
  socket.on('join_room', async ({ roomId }) => {
    if (!roomId) {
      socket.emit('join_error', { error: 'bad_request' });
      return;
    }
    const settingsKey = ROOM_SETTINGS_KEY(roomId);
    const exists = await redis.exists(settingsKey);
    if (!exists) {
      socket.emit('join_error', { error: 'room_not_found', roomId });
      return;
    }
    socket.join(roomId);
    socket.data.currentRoom = roomId;
    socket.emit('joined', { roomId });
  });

  // ---- 題庫列表 ----
  socket.on('list_banks', async () => {
    const roomId = socket.data.currentRoom;
    if (!roomId) {
      socket.emit('bank_error', { type: 'not_in_room' });
      return;
    }
    const banks = await listBanksForRoom(roomId);
    socket.emit('bank_list', banks);
  });

  // ---- 載入題庫內容 ----
  socket.on('load_bank_questions', async ({ bankId }) => {
    const roomId = socket.data.currentRoom;
    if (!roomId) {
      socket.emit('bank_error', { type: 'not_in_room' });
      return;
    }
    if (!bankId) return;
    const questions = await loadBankQuestions(roomId, bankId);
    socket.emit('bank_questions', { bankId, questions });
  });

  // ---- 刪除題庫 ----
  socket.on('delete_bank', async ({ bankId }) => {
    const roomId = socket.data.currentRoom;
    if (!roomId) {
      socket.emit('delete_bank_ack', { ok: false, error: 'not_in_room' });
      return;
    }
    if (!bankId) {
      socket.emit('delete_bank_ack', { ok: false, error: 'bad_request' });
      return;
    }
    const key = BANK_KEY(roomId, bankId);
    const delCount = await redis.del(key);
    if (delCount === 0) {
      socket.emit('delete_bank_ack', { ok: false, error: 'not_found', bankId });
    } else {
      socket.emit('delete_bank_ack', { ok: true, bankId });
    }
  });

  // ---- 從文字匯入題庫 ----
  socket.on('import_bank_text', async ({ bankId, bankName, filename, content }) => {
    const roomId = socket.data.currentRoom;
    if (!roomId) {
      socket.emit('import_bank_ack', { ok: false, error: 'not_in_room' });
      return;
    }
    if (!content || !content.trim()) {
      socket.emit('import_bank_ack', { ok: false, error: 'empty_file' });
      return;
    }

    let questions = [];
    try {
      if (filename && filename.toLowerCase().endsWith('.csv')) {
        questions = parseSimpleCSV(content);
      } else {
        const data = JSON.parse(content);
        questions = normalizeJSONQuestions(data);
      }
    } catch (e) {
      console.error('[import_bank_text] parse error:', e);
      socket.emit('import_bank_ack', { ok: false, error: 'parse_error' });
      return;
    }

    if (!Array.isArray(questions) || questions.length === 0) {
      socket.emit('import_bank_ack', { ok: false, error: 'parse_error' });
      return;
    }

    await saveBank(roomId, bankId, bankName, questions);
    socket.emit('import_bank_ack', {
      ok: true,
      roomId,
      bankId,
      count: questions.length
    });
  });

  // ---- 啟動房間多題測驗 ----
  socket.on('start_room_exam', async (payload) => {
    const { roomId, bankId, questionCount, timeLimitMinutes } = payload || {};
    if (!roomId || !bankId) {
      socket.emit('room_exam_ack', { ok: false, error: 'bad_request' });
      return;
    }

    const settingsKey = ROOM_SETTINGS_KEY(roomId);
    const settingsJson = await redis.get(settingsKey);
    let settings = {};
    if (settingsJson) {
      try { settings = JSON.parse(settingsJson); } catch {}
    }
    const currentUserId = socket.data?.userId || socket.id;
    if (settings.hostId && settings.hostId !== currentUserId) {
      socket.emit('room_exam_ack', { ok: false, error: 'not_host' });
      return;
    }

    const allQuestions = await loadBankQuestions(roomId, bankId);
    if (!Array.isArray(allQuestions) || allQuestions.length === 0) {
      socket.emit('room_exam_ack', { ok: false, error: 'empty_bank' });
      return;
    }

    const max = Math.min(questionCount || allQuestions.length, allQuestions.length);
    const indices = allQuestions.map((_, idx) => idx);
    shuffle(indices);
    const picked = indices.slice(0, max).map(i => allQuestions[i]);

    const examInfo = {
      roomId,
      bankId,
      questionCount: picked.length,
      timeLimitMinutes,
      createdAt: Date.now()
    };
    await redis.set(ROOM_EXAM_KEY(roomId), JSON.stringify(examInfo));

    io.to(roomId).emit('room_event', {
      type: 'session_start',
      roomId,
      bankId,
      questionCount: picked.length,
      timeLimitMinutes,
      questions: picked
    });

    socket.emit('room_exam_ack', { ok: true, roomId, bankId });
  });

  socket.on('disconnect', () => {
    console.log('client disconnected', socket.id);
  });
});

// ===== 啟動伺服器 =====
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on http://0.0.0.0:${PORT}`);
});
