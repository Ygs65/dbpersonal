// admin.js
// 終端機管理工具：列出 / 查看 / 刪除房間 ＋ 清除該房間題庫
// 使用 ioredis, 本機 Redis

import readline from 'readline';
import Redis from 'ioredis';

const redis = new Redis({
  host: '127.0.0.1',
  port: 6379
});

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
    const parts = k.split(':'); // room:{roomId}:settings
    const roomId = parts[1] || '(未知)';
    console.log(`  ${idx + 1}. 房間 ID = ${roomId} （key: ${k}）`);
  });
  console.log('');
}

async function showRoomDetail() {
  const roomId = await ask('請輸入要查看的房間 ID：');
  if (!roomId) {
    console.log('房間 ID 不可為空。\n');
    return;
  }

  const settingsKey = `room:${roomId}:settings`;
  const examKey = `room:${roomId}:exam`;
  const banksPattern = `bank:${roomId}:*`;

  const exists = await redis.exists(settingsKey);
  if (!exists) {
    console.log(`\n找不到房間 ${roomId} 的設定（${settingsKey} 不存在）。\n`);
    return;
  }

  console.log(`\n===== 房間 ${roomId} 設定 =====`);
  const settingsJson = await redis.get(settingsKey);
  if (settingsJson) {
    try {
      const obj = JSON.parse(settingsJson);
      console.log('room:settings =', JSON.stringify(obj, null, 2));
    } catch {
      console.log('room:settings (非 JSON)：', settingsJson);
    }
  } else {
    console.log('(room:settings 內容為空)');
  }

  console.log('\n----- 最新考試資訊 (room:exam) -----');
  const examJson = await redis.get(examKey);
  if (examJson) {
    try {
      const obj = JSON.parse(examJson);
      console.log('room:exam =', JSON.stringify(obj, null, 2));
    } catch {
      console.log('room:exam (非 JSON)：', examJson);
    }
  } else {
    console.log('(尚無考試資訊或 key 不存在)');
  }

  console.log('\n----- 題庫（bank）相關 key -----');
  const bankKeys = await redis.keys(banksPattern);
  if (bankKeys.length === 0) {
    console.log('(此房間沒有任何題庫)');
  } else {
    bankKeys.forEach((k) => console.log(' ', k));
  }
  console.log('');
}

async function deleteRoom() {
  const roomId = await ask('請輸入要刪除的房間 ID：');
  if (!roomId) {
    console.log('房間 ID 不可為空。\n');
    return;
  }

  const settingsKey = `room:${roomId}:settings`;
  const exists = await redis.exists(settingsKey);
  if (!exists) {
    console.log(`\n找不到房間 ${roomId}，不需刪除（${settingsKey} 不存在）。\n`);
    return;
  }

  console.log(`\n警告：這會刪除房間 ${roomId} 的所有相關資料：`);
  console.log(`  - room:${roomId}:*`);
  console.log(`  - bank:${roomId}:*`);
  console.log('  （包含此房間的題庫、最新考試設定等等）\n');

  const confirm = await ask('確定要刪除嗎？輸入 "YES" 確認：');
  if (confirm !== 'YES') {
    console.log('已取消刪除操作。\n');
    return;
  }

  const patterns = [`room:${roomId}:*`, `bank:${roomId}:*`];
  let allKeys = [];
  for (const p of patterns) {
    const ks = await redis.keys(p);
    allKeys = allKeys.concat(ks);
  }

  if (allKeys.length === 0) {
    console.log('沒有找到任何相關 key，可能已被清除。\n');
    return;
  }

  const delCount = await redis.del(allKeys);
  console.log(`\n已刪除房間 ${roomId} 相關 key 共 ${delCount} 筆：`);
  allKeys.forEach((k) => console.log('  -', k));
  console.log('');
}

async function mainMenu() {
  while (true) {
    console.log('============================');
    console.log(' Redis 管理工具（房間管理）');
    console.log('============================');
    console.log('1) 列出所有房間');
    console.log('2) 查看單一房間詳細資料');
    console.log('3) 刪除房間（同時清除此房間題庫）');
    console.log('4) 離開');
    console.log('----------------------------');

    const choice = await ask('請選擇功能 (1-4)：');
    switch (choice) {
      case '1':
        await listRooms();
        break;
      case '2':
        await showRoomDetail();
        break;
      case '3':
        await deleteRoom();
        break;
      case '4':
        console.log('Bye!');
        rl.close();
        await redis.quit();
        process.exit(0);
        return;
      default:
        console.log('無效選擇，請重新輸入。\n');
    }
  }
}

(async () => {
  console.log('已連線到 Redis (127.0.0.1:6379)。\n');
  await mainMenu();
})();
