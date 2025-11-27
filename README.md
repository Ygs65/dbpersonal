# FlashBattle 線上刷題 / 房間競賽系統（Render + Redis 版本）

這個版本已整合：

- ✅ Render Key-Value (Valkey) 作為 Redis
- ✅ 個人刷題 / 房間競賽（從 index 進入 tqcexam）
- ✅ 測驗結束按「送出」：
  - 會顯示本次成績
  - 自動呼叫 `/api/exam_result`，把成績 / 錯題列表寫入 Redis
  - 寫入：
    - `leaderboard:global`：全伺服器排行（Sorted Set）
    - `user:{userId}:stats`：玩家最近一次成績
    - `user:{userId}:wrongbook`：累積錯題本
  - 0.5 秒後自動導回首頁 `index.html`
- ✅ 回到首頁後：
  - 右側「我的成績」會顯示剛剛那次
  - 「錯題本」會顯示累積錯題
  - 「全伺服器排行」會根據 Redis 排序

---

## 一、專案結構

你實際需要部署（或放在同一資料夾）的檔案：

- `server.js`         ：主伺服器（Express + Socket.IO + Redis）
- `admin.js`          ：終端機管理工具（建題庫 / 刪題庫 / 管理房間）
- `index.html`        ：首頁 + 登入 + 房間設定 + 顯示排行榜、成績、錯題本
- `tqcexam.html`      ：多題一次作答的刷題頁
- `package.json`      ：npm 套件設定（用於 `npm install` 與 `npm start`）

> 注意：本版假設這幾個檔案都放在專案根目錄同一層。

---

## 二、在本機執行（使用本機 Redis）

1. 安裝 Redis 並啟動（預設 127.0.0.1:6379）
2. 安裝 npm 套件：

   ```bash
   npm install
   ```

3. 啟動伺服器：

   ```bash
   npm start
   ```

4. 在瀏覽器開啟：

   ```text
   http://localhost:3000/
   ```

---

## 三、在 Render 部署（使用 Render Key-Value Internal URL）

1. 在 Render 建立：
   - 一個 **Web Service**（Node.js）
   - 一個 **Key-Value Store（Valkey）**

2. 在 Key-Value Store 的畫面中，找到 **Internal Key Value URL**，例如：

   ```text
   redis://red-d4jpmfc9c44c73ega4q0:6379
   ```

3. 回到 Web Service 的 **Environment** 設定：

   新增一個環境變數：

   ```text
   REDIS_URL = redis://red-d4jpmfc9c44c73ega4q0:6379
   ```

4. Build Command、Start Command：

   - Build command：`npm install`
   - Start command：`npm start`

5. Deploy 後你可以直接在網頁上打開服務網址：

   - 首頁會是 `index.html`
   - `tqcexam.html` 由首頁按「進入多題練習 / 房間競賽」導向

---

## 四、流程說明

### 1. 登入與狀態紀錄

- 使用者在 `index.html` 輸入「登入名稱」，按下登入按鈕
- 透過 Socket.IO `login` 事件送到 `server.js`
- 伺服器會：
  - 用名稱當作 userId
  - 從 Redis 讀出：
    - `user:{userId}:stats`
    - `user:{userId}:wrongbook`
  - 把結果透過 `login_ack` 傳回前端
- 前端會：
  - 將 `playerId` / `name` 存到 `localStorage("fb_player_profile_v1")`
  - 更新右側的「我的成績」、「錯題本」顯示

### 2. 進入多題練習 / 房間競賽

- 在首頁選擇模式：
  - 個人刷題：不綁定房間
  - 房間競賽：會使用房間規則（時間限制、題數、題庫）
- 按下「進入多題練習」會導向 `tqcexam.html`
- 若是房間模式，房主設定的規則會先存到：
  - `localStorage("fb_room_exam_rules")`
- `tqcexam.html` 載入時會讀取這個規則來決定：
  - 題庫
  - 題數
  - 倒數時間

### 3. 交卷與成績寫入

- 在 `tqcexam.html` 做完題目後按「送出並批改」：
  - `gradeAll()` 會算出：
    - 總題數、答對數、分數
    - 錯題列表（含題目文字、正解、作答）
  - 透過 `fetch("/api/exam_result")` 送到 `server.js`
  - 伺服器將：
    - 寫入 `user:{userId}:stats`
    - 累積寫入 `user:{userId}:wrongbook`
    - 更新 `leaderboard:global` Sorted Set
    - 廣播最新排行榜給所有連線中的用戶
  - 前端在提示成績後，0.5 秒自動 `window.location.href = "/"`

### 4. 回到首頁後

- 首頁重新載入時：
  - 仍然有 `localStorage("fb_player_profile_v1")`，可以再次登入同一 ID
  - 伺服器從 Redis 讀出最新成績與錯題本
  - 排行榜會由 Socket.IO 推播更新

---

## 五、注意事項

- 如果你在本機開發，沒有設定 `REDIS_URL`，程式會自動改用：
  - `redis://127.0.0.1:6379`
- 若是在 Render，要務必設定 `REDIS_URL` 環境變數，且建議使用 **Internal Key Value URL**。
- 若未啟動 Redis 或網址錯誤，伺服器會在 log 中顯示 `[Redis] error: ...`。

---

## 六、檔案覆蓋方式

若你已經有舊版專案，建議做法：

1. 先備份原本的：
   - `server.js`
   - `index.html`
   - `tqcexam.html`
   - `admin.js`
2. 用這個 ZIP 內的同名檔案完全覆蓋
3. 執行：

   ```bash
   npm install
   npm start
   ```

4. 打開首頁測試：
   - 登入
   - 匯入題庫
   - 個人刷題
   - 房間競賽
   - 查看「我的成績」、「錯題本」、「排行榜」是否如預期更新

---
