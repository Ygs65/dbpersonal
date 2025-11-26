// admin.js
// Redis 管理工具：列出 / 刪除房間與題庫
// 本機：node admin.js
// 雲端：設定 REDIS_URL 後可連到同一個 Redis

import readline from 'readline';
import Redis from 'ioredis';

let redis;

if (process.env.REDIS_URL) {
  redis = new Redis(process.env.REDIS_URL, { tls: {} });
  console.log('[Admin] Connected to cloud Redis via REDIS_URL');
} else {
  redis = new Redis({ host: '127.0.0.1', port: 6379 });
  console.log('[Admin] Connected to local Redis (127.0.0.1:6379)');
}

redis.on('error', (err) => {
  console.error('[Redis] error:', err);
});

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function ask(q) {
  return new Promise((resolve) => {
    rl.question(q, (ans) => resolve(ans.trim()));
  });
}

async function listRooms() {
  const keys = await redis.keys('room:*:settings');
  if (keys.length === 0) {
    console.log('\n目前沒有任何房間（Redis 中沒有 room:*:settings）。\n');
    return;
  }
  console.log('\n目前房間列表：');
  keys.forEach((k, idx) => {
    const parts = k.split(':');
    const roomId = parts[1] || '(未知)';
    console.log(`  ${idx + 1}. 房間 ID = ${roomId}`);
  });
  console.log('');
}

async function deleteRoom() {
  const roomId = await ask('請輸入要刪除的房間 ID：');
  if (!roomId) return;

  console.log(`\n⚠️ 此操作將刪除 room:${roomId}:* 以及 bank:${roomId}:* 所有資料！`);
  const ok = await ask('輸入 YES 確認：');

  if (ok !== 'YES') {
    console.log('已取消。\n');
    return;
  }

  const patterns = [`room:${roomId}:*`, `bank:${roomId}:*`];
  let delKeys = [];
  for (const p of patterns) {
    delKeys.push(...await redis.keys(p));
  }
  if (delKeys.length === 0) {
    console.log('沒有任何相關資料可刪除。\n');
    return;
  }
  await redis.del(delKeys);
  console.log(`\n已刪除 ${delKeys.length} 筆資料。\n`);
}

async function menu() {
  while (true) {
    console.log('===== Redis 管理工具 =====');
    console.log('1) 列出所有房間');
    console.log('2) 刪除房間（含題庫）');
    console.log('3) 離開\n');

    const c = await ask('選擇功能：');
    if (c === '1') await listRooms();
    else if (c === '2') await deleteRoom();
    else if (c === '3') break;
  }

  rl.close();
  await redis.quit();
  process.exit(0);
}

menu();
