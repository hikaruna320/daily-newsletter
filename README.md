# udn Daily Newsletter 工具組

兩支互相銜接的純前端工具，放在同一個 GitHub Pages repo 下。

| 檔案 | 用途 | 網址 |
| --- | --- | --- |
| `index.html` | 新聞蒐集台（每天自動抓各來源新文章 → 勾選 → 送進工作台） | `/udn-newsletter/` |
| `newsletter.html` | 電子報產製工作台（挑選排序 → AI 生成 → 複製寄出） | `/udn-newsletter/newsletter.html` |

兩頁的頁首都有互連的按鈕，日常流程從首頁的蒐集台開始。

## 每天怎麼用

1. 打開**新聞蒐集台**，預設顯示近 3 天、S 級在最前面。
2. 看到想收的就打勾，不要的按「略過」（略過後明天不會再出現）。
3. 按底部的「加入電子報工作台」，勾選的新聞會自動帶標題、網址、媒體名稱過去。
4. 在工作台排順序、按「一鍵生成」、複製貼到信箱寄出。

## 新聞是怎麼來的

`.github/workflows/fetch-news.yml` 每天台北時間 01:00 / 07:00 / 13:00 / 19:00 自動執行，
跑 `scripts/fetch-feeds.mjs` 抓 `sources.json` 裡啟用的 RSS，
結果寫進 `news.js`，蒐集台直接讀這個檔案。

不需要伺服器、不需要付費，全部在 GitHub 上跑。

**為什麼一天要抓四次**：RSS 的機制是「給你最新的 N 篇」而不是「給你某個時段的文章」。
發稿快的來源 feed 視窗很短（實測 TechCrunch 20 篇只涵蓋 9 小時、鉅亨網 99 篇涵蓋 20 小時），
一天只抓一次的話，中間發布又被擠出視窗的文章就永遠抓不到了。

## 要增減新聞來源時

改 `sources.json` 就好：

- **停用某個來源**：把 `enabled` 改成 `false`
- **新增來源**：複製一筆，填上 `tier`（S/A/B/C）、`name`、`lang`（zh-TW / zh-CN / en）、`feed`（RSS 網址）
- **補上還沒有 feed 的來源**：把 `feed` 填上、`enabled` 改成 `true`

改完 commit，隔天早上就會生效。想立刻看到結果，到 GitHub 的 **Actions** 分頁點「每日抓取新聞」→「Run workflow」手動執行。

### 某個來源太吵的時候

有些來源只提供全站 feed，一天幾十上百篇，會把同分級的其他來源洗掉。
這種情況可以加一個 `match` 欄位，只留下標題、摘要或網址有配到關鍵字的文章：

```json
{ "name": "鉅亨網", "feed": "...", "match": "媒體|廣告|訂閱|串流|新聞業", "enabled": true }
```

沒有 `match` 欄位就是全部收錄。設定前先確認該來源真的有你要的內容——
Semafor 就是試過之後發現全站 feed 裡根本沒有媒體產業文章，怎麼篩都篩不出來。

## 目前還沒啟用的來源

`sources.json` 裡 `enabled: false` 的那些，原因寫在各自的 `note` 欄位，分四種：

- **找不到 RSS**：INMA、數位時代、虎嗅網、The Current、MediaPost、天下雜誌、36Kr、SLATE、獨立評論、經理人、品玩、The Drum、Talking Biz News、EMARKETER
- **被 Cloudflare 擋**：Press Gazette、Search Engine Land
- **有 feed 但內容不對**：Semafor（只有全站政治財經 feed，媒體版文章不在裡面）
- **付費訂閱制**：STRATECHERY（feed 綁個人會員 token，不適合放進共用工具）

## 注意事項

- **GitHub 的排程可能延遲**：免費方案的排程不保證準時，通常會晚幾分鐘到半小時。
- **排程會被自動停用**：如果 repo 連續 60 天沒有人為的操作，GitHub 會停掉排程並寄信通知，到 Actions 分頁按一下就能重新啟用。
- **抓取失敗不會弄丟資料**：某個來源臨時掛掉時，`news.js` 會保留前一次抓到的文章，蒐集台的「來源狀態」也會標示哪個來源失敗了。
- **資料只保留 14 天**：每次執行都會把超過 14 天的文章丟掉，所以 `news.js` 不會無限長大，不需要另外設清理排程。想改天數就改 `scripts/fetch-feeds.mjs` 最上面的 `KEEP_DAYS`。
- **repo 本身會慢慢變大**：`news.js` 大小固定，但每次更新都會留一筆 commit 紀錄。一年下來大約幾十到一兩百 MB，離 GitHub 的建議上限 1 GB 還很遠。真的想瘦身時，可以在 Actions 頁面手動觸發一次全新的 commit 歷史，或請人協助 `git gc`。
