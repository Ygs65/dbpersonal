# FlashBattle Pro

Redis 線上測驗系統（期末 / 專題版）

## 功能總覽

- ✅ **JWT 帳號系統**
  - 以 `userId + 密碼` 註冊 / 登入。
  - 後端使用 `bcryptjs` 雜湊 + `jsonwebtoken` 發 token。
  - API：`/auth/register`, `/auth/login`, `/auth/me`。

- ✅ **多模式排行榜（Redis Sorted Set）**
  - `leaderboard:last`：最後一次考試成績。
  - `leaderboard:best`：歷史最高分。
  - `leaderboard:avg`：平均分。
  - 前端可切換模式 + 分頁查看。

- ✅ **房間競賽模式**
  - 房主建立房間、匯入題庫（JSON / CSV）。
  - 題庫鎖定在房間底下：`bank:{roomId}:{bankId}`。
  - 房主一鍵啟動多題測驗，Socket.IO 廣播規則與題目到所有玩家。
  - 玩家自動跳轉到 `tqcexam.html` 開始作答。

- ✅ **個人刷題模式**
  - 直接打開 `tqcexam.html`，匯入自己的 JSON 題庫練習。
  - 作答結果同樣會送到 Redis，更新個人成績與排行榜。

- ✅ **歷史成績 + 錯題本**
  - 成績彙總：`user:{userId}:stats`
    - `lastScore`, `bestScore`, `avgScore`, `attemptCount` 等欄位。
  - 歷史成績：`user:{userId}:history`（Redis List，保留最近 50 筆）。
  - 錯題本：`user:{userId}:wrongbook`
    - 每題保留 `topic`, `tag`, `answers`, `userAnswer`, `explanation` 等。

- ✅ **PWA**
  - `manifest.json` + `service-worker.js`，手機瀏覽器可「加到主畫面」當 App 用。


## 快速啟動

1. 安裝套件

```bash
npm install
```

2. 設定 Redis 連線（預設：`redis://127.0.0.1:6379`）

```bash
# 若需要，可在啟動前指定：
set REDIS_URL=redis://127.0.0.1:6379   # Windows (cmd)
export REDIS_URL=redis://127.0.0.1:6379 # macOS / Linux
```

3. 啟動伺服器

```bash
npm start
```

4. 瀏覽器開啟

- 首頁：`http://localhost:3000/`
- 考場頁：`http://localhost:3000/tqcexam.html`


## 管理腳本 admin.js

提供一些簡單的 CLI 管理功能（非必須，但方便測試）：

```bash
# 建立房間
node admin.js create-room room1

# 匯入 JSON 題庫到指定房間
node admin.js import-json room1 iot ./iot_bank.json

# 查看房間題庫列表
node admin.js list-banks room1
```


## 期末報告可說明重點

- 為什麼選擇 Redis：
  - 排行榜使用 Sorted Set (`ZADD`, `ZREVRANGE`, `ZCARD`)。
  - 歷史成績使用 List (`LPUSH`, `LTRIM`, `LRANGE`)。
  - 題庫用 String 存 JSON，方便更新 / 匯入。

- 系統流程：
  1. 玩家登入（JWT / 訪客）。
  2. 房主建立房間、匯入題庫。
  3. 房主啟動測驗 -> Socket.IO 廣播規則與題目。
  4. `tqcexam.html` 作答 -> `/api/exam_result` -> Redis 更新各種統計。
  5. 首頁即時更新排行榜、我的成績、錯題本。

- 延伸方向：
  - 題庫標籤 / 主題更多分類與篩選。
  - 錯題本再出題機制（只考錯題）。
  - 題目難度分級、加權計分。
