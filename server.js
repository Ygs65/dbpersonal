// server.js
// FlashBattle + 房間競賽 + Redis 題庫 (本機端 Redis)
// 使用：node server.js

import express from 'express';
import http from 'http';
import { Server as SocketIOServer } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';
import Redis from 'ioredis';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ===== Redis 連線 =====
// 優先使用環境變數 REDIS_URL（Render Key-Value Internal URL），沒有時改用本機 127.0.0.1:6379
const redisUrl = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
const redis = new Redis(redisUrl);

redis.on('connect', () => {
  console.log('[Redis] connected to', redisUrl);
});

redis.on('error', (err) => {
  console.error('[Redis] error:', err);
});

// ===== 開發者 root 設定 =====
const ROOT_USER = 'root';
// ⚠ 請在啟動前用環境變數設定 ROOT_PASSWORD，一旦設定就視為「不可更改」
// 例如：ROOT_PASSWORD=yourpass npm start
const ROOT_PASSWORD = process.env.ROOT_PASSWORD || '';

if (!ROOT_PASSWORD) {
  console.warn('[WARN] ROOT_PASSWORD 未設定，root 開發者刪除房間功能將無法使用。');
}

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

// ===== 題庫/房間工具函式 =====
const ROOM_SETTINGS_KEY = (roomId) => `room:${roomId}:settings`;
const ROOM_EXAM_KEY = (roomId) => `room:${roomId}:exam`;
const BANK_KEY = (roomId, bankId) => `bank:${roomId}:${bankId}`;

// 排行榜、個人成績、錯題本 Redis Key
const LEADER_KEY = 'leaderboard:global';
const USER_STATS_KEY = (userId) => `user:${userId}:stats`;
const USER_WRONG_KEY = (userId) => `user:${userId}:wrongbook`;

// 洗牌
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
    return { topic, text, options, answers, type, explanation };
  }).filter(q => q.text && q.options.length >= 2);
}


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

    const stats = {
      playerId,
      name: name || playerId,
      mode: mode || 'personal',
      lastRoomId: roomId || '',
      bankId: bankId || '',
      lastScore: Number(score) || 0,
      totalQuestions: Number(total) || 0,
      lastCorrect: Number(correctCount) || 0,
      updatedAt: new Date().toISOString()
    };

    // 1) 存「我的成績」
    await redis.set(USER_STATS_KEY(playerId), JSON.stringify(stats));

    // 2) 累積「我的錯題本」
    if (Array.isArray(wrongQuestions) && wrongQuestions.length > 0) {
      let merged = [];
      const existed = await redis.get(USER_WRONG_KEY(playerId));
      if (existed) {
        try { merged = JSON.parse(existed) || []; } catch (e) { merged = []; }
      }
      merged = merged.concat(wrongQuestions);
      await redis.set(USER_WRONG_KEY(playerId), JSON.stringify(merged));
    }

    // 3) 更新排行榜（Sorted Set）
    await redis.zadd(LEADER_KEY, score || 0, String(playerId));

    // 4) 廣播最新排行榜
    try {
      const top = await redis.zrevrange(LEADER_KEY, 0, 9, 'WITHSCORES');
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

  // ---- 登入：使用者自己填的名稱就是 userId ----
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

    // 初次登入時，也送一份排行榜
    try {
      const top = await redis.zrevrange(LEADER_KEY, 0, 9, 'WITHSCORES');
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

  // ---- 新增：刪除房間（只有房主或 root 開發者可以） ----
  socket.on('delete_room', async ({ roomId, devPassword }) => {
    try {
      if (!roomId) {
        socket.emit('delete_room_ack', { ok: false, error: 'bad_request' });
        return;
      }

      const settingsKey = ROOM_SETTINGS_KEY(roomId);
      const exists = await redis.exists(settingsKey);
      if (!exists) {
        socket.emit('delete_room_ack', { ok: false, error: 'not_found', roomId });
        return;
      }

      let settings = {};
      const settingsJson = await redis.get(settingsKey);
      if (settingsJson) {
        try { settings = JSON.parse(settingsJson); } catch {}
      }

      const currentUserId = socket.data?.userId || socket.id;
      const isHost = settings.hostId && settings.hostId === currentUserId;
      const isDev =
        currentUserId === ROOT_USER &&
        ROOT_PASSWORD &&
        typeof devPassword === 'string' &&
        devPassword === ROOT_PASSWORD;

      if (!isHost && !isDev) {
        socket.emit('delete_room_ack', { ok: false, error: 'no_permission', roomId });
        return;
      }

      const patterns = [`room:${roomId}:*`, `bank:${roomId}:*`];
      let allKeys = [];
      for (const p of patterns) {
        const ks = await redis.keys(p);
        allKeys = allKeys.concat(ks);
      }

      let delCount = 0;
      if (allKeys.length > 0) {
        delCount = await redis.del(allKeys);
      }

      // 對該房間所有人廣播房間已被刪除
      io.to(roomId).emit('room_event', {
        type: 'room_deleted',
        roomId
      });

      // 讓 socket 離開房間（只對目前這個連線）
      socket.leave(roomId);
      if (socket.data.currentRoom === roomId) {
        socket.data.currentRoom = null;
      }

      socket.emit('delete_room_ack', {
        ok: true,
        roomId,
        deletedKeys: delCount
      });
    } catch (e) {
      console.error('[delete_room] error:', e);
      socket.emit('delete_room_ack', { ok: false, error: 'server_error' });
    }
  });

  // ---- 排行榜（簡單 stub）----
  const LEADER_KEY = 'leaderboard:global';
  (async () => {
    const top = await redis.zrevrange(LEADER_KEY, 0, 9, 'WITHSCORES');
    socket.emit('leaderboard_update', top || []);
  })();

  socket.on('disconnect', () => {
    console.log('client disconnected', socket.id);
  });
});

// ===== 啟動伺服器 =====
const PORT = 3000;
server.listen(PORT, () => {
  console.log(`Server running on http://0.0.0.0:${PORT}`);
});
