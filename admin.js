// admin.js
// 簡易管理腳本：可在終端機操作 Redis 題庫與房間設定
// 使用方式示例：
//   node admin.js create-room room1
//   node admin.js import-json room1 iot ./iot_bank.json
//   node admin.js list-banks room1

import fs from 'fs';
import Redis from 'ioredis';

const redisUrl = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
const redis = new Redis(redisUrl);

const ROOM_SETTINGS_KEY = (roomId) => `room:${roomId}:settings`;
const BANK_KEY = (roomId, bankId) => `bank:${roomId}:${bankId}`;

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

async function createRoom(roomId) {
  const key = ROOM_SETTINGS_KEY(roomId);
  const exists = await redis.exists(key);
  if (exists) {
    console.log('房間已存在:', roomId);
    return;
  }
  const settings = {
    roomId,
    hostId: 'admin-cli',
    createdAt: Date.now()
  };
  await redis.set(key, JSON.stringify(settings));
  console.log('已建立房間:', roomId);
}

async function importJson(roomId, bankId, filePath) {
  const text = fs.readFileSync(filePath, 'utf-8');
  const data = JSON.parse(text);
  const questions = normalizeJSONQuestions(data);
  const key = BANK_KEY(roomId, bankId);
  await redis.set(key, JSON.stringify({ id: bankId, name: bankId, questions }));
  console.log(`已將 ${filePath} 匯入為房間 ${roomId} 的題庫 ${bankId}，共有 ${questions.length} 題。`);
}

async function listBanks(roomId) {
  const pattern = BANK_KEY(roomId, '*');
  const keys = await redis.keys(pattern);
  console.log('房間', roomId, '題庫列表：');
  for (const k of keys) {
    const json = await redis.get(k);
    try {
      const obj = JSON.parse(json);
      const count = Array.isArray(obj.questions) ? obj.questions.length : 0;
      console.log('-', obj.id || k, '題數:', count);
    } catch {
      console.log('-', k);
    }
  }
}

async function main() {
  const [cmd, a, b, c] = process.argv.slice(2);
  if (!cmd || cmd === 'help') {
    console.log('用法:');
    console.log('  node admin.js create-room <roomId>');
    console.log('  node admin.js import-json <roomId> <bankId> <filePath>');
    console.log('  node admin.js list-banks <roomId>');
    process.exit(0);
  }
  try {
    if (cmd === 'create-room') {
      await createRoom(a);
    } else if (cmd === 'import-json') {
      await importJson(a, b, c);
    } else if (cmd === 'list-banks') {
      await listBanks(a);
    } else {
      console.log('未知指令，請使用 help');
    }
  } catch (e) {
    console.error('執行失敗:', e);
  } finally {
    redis.disconnect();
  }
}

main();
