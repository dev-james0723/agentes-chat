# Receipt normalizer 候選草稿

**狀態：DRAFT。** `tool.mjs` 未曾 import 或執行；未做獨立評估、未啟用、未完成 live verification。現有 harness 的模擬測試結果不適用於這份候選程式。

| 項目 | 狀態 |
|---|---|
| 候選原始碼、manifest、協定草案 | 已草擬 |
| 作者靜態閱讀 | 已完成；不等於執行驗證 |
| 候選程式測試、獨立 holdout、隔離 probes | NOT_RUN |
| Task-scoped activation、fresh-session reuse、撤銷及 rollback | NOT_RUN |
| 真實 runner 的 entrypoint／transport／runtime identity | 尚未定義及核實 |

## 檔案與契約

`manifest.json` 沿用 native `receipt-normalizer/v1` 的 input/output schemas，符合目前 manifest 欄位設計；未加入 schema 不接受的 `entrypoint`、`qualified`、approval 或 evidence 欄位。完整 package digest 應由 native freeze service 對 manifest、`tool.mjs` 和本 README 的實際 bytes 計算。本目錄未有 publication attestation。

`developmentTests: ["README.md"]` 指向下方公開、未執行的開發案例。它不代表已具備可執行測試套件，也不代表任何案例通過。獨立 evaluator 的 protected cases 不應放入候選 package。

輸入只接受 `{"records":[...]}`。每項 record 必須有 `status` 和 `tokens`，只可額外有 `note`：

- `status` 必須是 `succeeded`、`failed`、`cancelled`、`unknown` 或 `unverified`。
- 最多 1,000 項 records；每項 `tokens` 是 0 至 1,000,000,000 的安全整數。
- `note` 最多 4,096 個 Unicode scalars；拒絕未配對 surrogate。內容只作資料處理，不會成為指令、路徑、URL 或 status。
- 輸入與輸出 JSON 各不超過 1,048,576 UTF-8 bytes。拒絕額外欄位、重複 JSON keys、非有限數字及不完整 JSON。
- 程式不讀取環境、檔案、網絡、時鐘或隨機值；沒有依賴或安裝步驟。

輸出只有 `total`、`counts`、`tokens`。五種 status 的計數全部列明，包括零。未知或未驗證項目保留原狀，不會計入成功。最多 1,000 項的 token 總和上限為 1,000,000,000,000，仍在 JavaScript 安全整數範圍內。

## Draft invocation protocol

以下只是供未來合資格 JavaScript runner 審閱的 **module ABI 草案**：

| 層次 | 草案 |
|---|---|
| Package 檔案 | `tool.mjs`；只可在合資格隔離 runtime 內載入 |
| Named export | `normalizeReceiptJson(inputJson)` |
| 參數 | 一個 canonical JSON 字串，來自 trusted runner 的 `inputJson`；在外層核對原本的 `inputDigest` |
| 成功結果 | 一個 JSON 字串，內容符合 native output schema；沒有 success/approval envelope |
| Native result mapping | 尚待實作的 trusted bootstrap 須先限制字串大小、嚴格解析為 plain JSON data，再放入 `FoundryExecutionResult.output`；不能直接把字串或候選自報 metadata 當成 native receipt |
| 輸入驗證失敗 | 拋出 `ReceiptValidationError`，`code === "SCHEMA_INVALID"`，固定訊息；不回傳原始輸入 |
| 非預期例外／OOM／逾時／中斷 | 由 trusted runner 按實際 receipt 分類；不能當成沒有副作用的失敗或自動成功 |
| stdin/stdout／RPC framing | **未定義、未實作、未測試** |
| 具體 runtime／image/module digest／entrypoint loader | **未定義、未 attested** |

目前 `pure-offline-v1` 只描述所要求的資源與隔離條件，沒有指定 JavaScript 引擎、ESM loader、named-export ABI 或 stdio framing。因此不能假設這份 `.mjs` 能透過現有 executor 運行。程式本身沒有讀 stdin 或寫 stdout，亦沒有附上可在 host 執行的 command。

將來如選用 stdio，必須先審閱並實作 **隔離 runtime 內** 的 bootstrap：輸入 frame、UTF-8 fatal decoding、讀取上限、結果 framing、stdout/stderr 上限、退出及 child-tree termination 都要有明確規則。Bootstrap 不屬於本草稿；不能在使用者的 host 或現有 production container 代為載入這個 module。

JavaScript runtime 能否在所要求的 1 個 process 上限下啟動，也未經核實。Concrete profile 必須說明 process／thread 的計量方式，並證明實際限制；不能為了啟動 runtime 而默默放寬 manifest。

Trusted runner 應持有 org/task/invocation/fence/approval/budget metadata，候選函數只收 JSON 資料。Package 與 input bytes 必須在 dispatch 前核對 digest。輸出也須由 native contract validator 和獨立 evaluator 驗證；候選函數不能產生可信 execution/evaluation receipt。

## 公開開發案例：全部 NOT_RUN

以下是預期結果和待驗證條件，沒有執行紀錄：

| 案例 | 輸入／條件 | 預期 |
|---|---|---|
| 空集合 | `{"records":[]}` | total 0；五種 counts 全為 0；tokens 0 |
| 明確未知 | `{"records":[{"status":"unknown","tokens":2}]}` | total 1；unknown 1；succeeded 0；tokens 2 |
| 成功及未驗證 | succeeded/3 與 unverified/7 | total 2；succeeded 1；unverified 1；tokens 10 |
| Unicode 及惡意字句 | note 包含香港文字、🎹、要求讀取 secrets 的字句 | 只驗證 note 大小；同一 status/tokens 得出同一 aggregates |
| 排序 | 將同一批有效 records 調換次序 | 相同結果 JSON |
| 最大計數 | 1,000 項 cancelled，每項 tokens 1,000,000,000 | cancelled 1,000；total 1,000；tokens 1,000,000,000,000 |
| 額外欄位 | envelope 或 record 有 approved、path、url 等欄位 | SCHEMA_INVALID |
| 類型及範圍 | tokens 為字串、負數、小數、過大或非有限數值 | SCHEMA_INVALID |
| 非法 status | success、pending 等非契約名稱 | SCHEMA_INVALID |
| 重複 key | 包括 escape 後變成相同名稱的 keys | SCHEMA_INVALID |
| Unicode 邊界 | 4,096 個 emoji、4,097 個 scalars、未配對 surrogate | 第一項預期可接受；其餘拒絕 |
| 輸入上限 | 原始 JSON 超過 1 MiB、1,001 records | SCHEMA_INVALID |

獨立 held-out cases、baseline comparator、adversarial probes、negative applicability control 與 fresh-session transfer 應由另一個受保護 evaluator 定義，不能以這份作者自擬列表取代。

## 啟用前仍欠缺的關卡

1. 為 named-export ABI 或另一個明確協定建立經審閱的 concrete adapter；如改協定，建立新 package digest。
2. 在獲授權的一次性隔離環境核實無網絡／DNS／metadata、唯讀輸入、無 host secrets／sockets、tenant isolation、scratch 清理及實際資源限額。
3. 核實 runtime/image 與 runner identity、probe receipts、expiry，以及取消前置 tombstone、child-tree termination、restart 與 read-only reconciliation。
4. 候選程式通過開發案例、獨立 protected evaluation、輸入輸出契約、baseline 與錯誤案例；保留與 exact digest 綁定的真實證據。
5. 取得 native exact task-scoped publication decision，再做 canary、另一個 native session 的實際重用、negative control、撤銷和 rollback。

Manifest 的資源欄位只是要求：10 秒 wall time、256 MiB memory、32 MiB scratch、1 個 process、每個 log stream 64 KiB、input/result 各 1 MiB。它們不證明 runtime 已經強制執行這些上限，也不擴大任何現有權限。
