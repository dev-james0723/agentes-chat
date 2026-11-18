# Delivery Guardian — 原生接駁最小方案

## 2026-11-17 原生 readiness／approval 交接候選增補

**這一增補仍是 source-only；沒有建立 production approval／binding／grant，沒有發布或取得 host deployment lock。** 它補上現有 Gateway 的一項流程缺口：初次 `checkCall` 發生在批准建立之前，因此不能要求尚未存在的批准；真正 execute 則必須另外取得目前有效的執行證明。

Host verifier 可回傳 `decision: ready`，當中須有同一 org／agent／run／connection、native task、immutable repo／head、target、check policy／evidence 及短有效期。Guard 只在 preflight 接受它，狀態標示 `ready_for_approval`，並明示 `isAuthorizationGrant: false`。它不提供 operation、action authority、lease 或 fencing，也不能通過 `runConnectorDelivery`。能否建立批准仍由原有 Gateway policy 決定；不能用 readiness 直接執行。

對既有 catalog GitHub release call 的明確批准路徑，`runApproved` 建立只存於本次呼叫的 opaque locator：

1. `checking` locator 對應現有 approval ID，綁定 DB instance、org／agent／run／tool-use／conversation context、catalog 原始工具、scope、connection 及完整 action hash。它不是 caller input，序列化或仿造物件不能還原。
2. 原有 `executedAt` CAS 成功後，Gateway 只使用 DB 回傳的時間建立 `claimed` locator，並退役 checking locator。CAS 原有條件及一般工具批准語意不變。
3. Guard 將 locator 轉成只供 host verifier 閱讀的不可變 reference；caller 自行塞進 call／input 的 approval JSON 不會被採用。Signature 加入後的 `wireInput` 仍另外檢查 repo／PR／expected head，原先批准的參數 hash 不會因署名而放寬。
4. Native service 在 provider 觀察前後，重讀該 approval 的 native row、同一 subject／完整 params／hash、approved status、有效期、目前決策人的 membership／role／owner／cover，以及 checking 或 claimed 的精確執行時間。Caller 的 `approved: true` 無法代替它。
5. 立即 dispatch 前，同一 locator 只可消耗一次；Gateway `finally` 一律將本次所有 locator 退役。Pre-CAS 拒絕保留 `executedAt = null` 及結構化原因；post-CAS 撤銷則停止 provider call，保留既有執行標記。Provider timeout／error reply 仍是 `outcome_unknown`，不能自動重試或宣稱 merged。

這個 locator 是短暫交接，不是新的授權庫、target lease、跨 approval 去重或 outcome reconciliation。Native explicit approval 只解決精確工具操作的既有批准來源；**不等於 runtime target 發布授權或 File Room publisher grant**。

`approvalsLevel: never`、既有 `mergeRepos` 及其他自動政策沒有新增批准、偽造 ID 或改變其分支。此最小增補只接明確 native approval；自動政策的完整 native execution reference 尚未實作，缺少 target／checks／operation／lease 時仍拒絕。一般 reads／tasks 維持原流程。Production service 仍保留 `native_target_unverified`、`trusted_check_policy_unavailable`、`native_release_operation_unavailable`、`native_release_lease_unavailable` 等實際缺口，不會因本增補變成可發布。

明確批准的 scope 重驗使用 locator 綁定的實際 catalog tool 名稱，因此第二個／改名前綴的 GitHub connection，其 `deny:{實際工具名}` 亦優先拒絕。沒有 approval reference 的 native snapshot 仍保留原有名稱推導；原 Gateway 會先按真實工具名稱檢查，但這不代表自動路徑的 native alias／authorization reference 已全面接好。該路徑仍保持上述發布阻擋。

測試先保留兩個真實 Mac Gateway RED：readiness 不能建立批准，以及已經完成 `decideApproval` 的恢復呼叫沒有 native reference。再測同一批准一次執行、署名及 expected head、前後 CAS 撤銷、expiry／decider 撤權、完整 action 變動、假 locator、跨 context、退役／重播、unknown outcome 與自動政策不產生新卡。Helper fixtures、PGlite、Mac typecheck、獨立 exact-byte review 及真正啟用後的負向測試分開記錄；任何一種均不能代替另一種。

## 2026-11-17 原生 task binding 候選增補

**這是 source-only 實作候選；尚未部署、未建立任何 production binding，亦未授予或執行發布。** 下方 2026-11-16 的唯讀核查保留為歷史基線；其中「尚未改動」及缺口描述只適用於當時。當前執行／部署證據以原生任務的最新收據為準，不能從本文或測試成功推斷。

本次沿用現有 API、資料表及 server registration，新增：

- `packages/engine/src/delivery-native.ts`：由已登入且當前有效的 organization owner，經既有 task PATCH 設定 repository／release owner／target 選項，或明確撤回。只將嚴格型別的 `delivery_binding_changed` event 寫入既有 `issue_activity`；不建立第二套 ledger、資料庫、任務或排程。
- `apps/server/src/routes/app/issues.ts`：原路由的 session、Origin／CSRF 及 task ACL 保留。`deliveryBinding` 必須獨立於普通 task 編輯提交；普通 title、criteria、description、comment 路徑不會產生 reserved binding event。Task detail（UUID 或 number）可讀取可見的 binding view。
- `packages/engine/src/git/delivery-observation.ts`：以固定 `https://api.github.com` origin、GET、禁止 redirect、每次最多 128 KiB／3 秒讀取 repository identity 及精確 PR。只輸出規定的 repo／head／base 欄位；credential 及 provider 原文不進入 binding 或拒絕訊息。Credential 取得沿用既有原生 GitHub App／connection resolver，沒有另設 token 或授權儲存。
- `apps/server/src/engine.ts`：把 native service 的 verifier 注入既有 connector source。Guard 仍在原有 checkCall、approval recheck 及真正 execute 邊界運作。

### Trust 與 concurrency 邊界

PATCH 只接受 repository 名稱／原生 connection ID、可選的原生 agent ID、有限 target 選項及 `expectedRevision`。Caller 不能填入 repository ID、issuer、policy version、通過旗標或 grant。Repository ID 由 native credential 的 provider GET 取得；issuer 取自已驗證 session 及 current owner membership。Target 名稱只是選項，`verificationState` 固定為 `unknown`；所有 view／record 的 `authorityGranted` 固定為 `false`。`releaseOwnerId` 表示 owner 選擇的負責 agent，不是對該 agent 的新增發布權限。

寫入 transaction 鎖定現有 membership、project、issue rows，再重查 current owner、project、connection、release owner 和同一 task 的最新 event revision。兩個相同 `expectedRevision` 的競爭寫入只有一個可提交。撤回是一筆新 event，保留之前的歷史。

Reader 必須檢查最新 reserved event；最新事件 malformed、issuer 已非有效 owner、subject／project 改變或已撤回時，不回退至舊的有效紀錄。Record 的 payload hash 只用於完整性核對，**不是簽章或 attestation**。可信來源是受現有 session／ACL 約束的內部寫入路徑及 DB row 的原生作者，不是任意 JSON；直接掌握 server／DB 寫入權的程式仍在宿主信任邊界內。

此增補是一個 task 所屬 project 的 typed relation，並非全域唯一 project registry。它不把其他 task、相同 project label 或 role label 自動視為同一發布關係。

### 現時可驗證的拒絕條件

Verifier 從當前 native run 的 `issueId` 取得 task，核對 org／agent／channel／thread／trigger，重查 task／agent 狀態、binding、release owner、connection、fresh grants 和 repository allowlist。它不接受 tool input 提供的 task ID 或 `authorized` 作權威。再讀真實 repo ID、PR head／base／狀態，並在讀取後重查 binding revision、owner、scope 等原生狀態。

缺少或改變的資訊會返回具體 reason code。即使上述設定及觀察都有效，這個候選仍會拒絕發布，因為尚未接上：

1. 真正 runtime target 與 artifact 的驗證。
2. Required checks／review 的可信 issuer 與 policy。
3. 該 action／target 的現有有效發布授權。
4. 原生 operation identity、持久去重及 outcome reconciliation。
5. 現有 publisher 實際持有的 repo／target lease 與 fencing。

它不把 task ID、approval ID、owner 選項或 repo 讀取成功偽裝成上述證明，也不推斷 File Room publisher。Workflow dispatch 仍由現有 guard 以 `workflow_target_adapter_unavailable` 拒絕；不能靠加入 task binding 解除。

### 發布相容性與驗證

**前一個 R2 catalog guard 的預設行為是：缺少完整 native verifier 時，所有該 catalog 的 GitHub merge／workflow release calls 都拒絕。** 這是涉及其他 agent 的實質發布相容性改變；本增補沒有為未註冊 repo 或未知 org 開放繞過路徑。尚未完成實際 project bindings、發布負責人及必要 gate 的核對前，不能將候選直接啟用為 production 發布能力。一般 read tools、task 編輯及既有 approval 規則維持原流程。

新增 fixture 測試分別覆蓋 authenticated owner PATCH、跨 Origin／member 拒絕、嚴格 input、CAS／撤回、普通 task／comment 保留、current issuer／scope／repo／head 重驗、fake event／跨 task replay、provider redirect／大小／timeout／stream cancellation。真實 Mac 基線已證明原 PATCH 忽略 binding body，未產生 binding；修正後結果、typecheck、獨立 review 與 exact file hashes 必須另外記錄。Mock provider／PGlite 成功只證明程式控制流程，不是上線或真實發布證據。

本次沒有改 shell、host MCP、自訂 connector、Git proxy、人工發布工具或既有 host deployment lock。現有發布者仍負責真正安裝及 provider／runtime outcome 核查。必須沿用當前有效的授權與既有發布流程，逐項保存 committed、pushed、merged、built、installed/deployed、running、live_verified 證據。

## 2026-11-16 歷史唯讀基線

本節是當時按現有程式碼整理的接駁方案，供原有 task／發布負責人覆核。當時尚未改動或啟用原生產品程式碼；文件、CLI、純 policy 測試及 skill 註冊均不是工具限制已生效的證據。

2026-11-16T20:56:19.846446Z 重新唯讀確認：

- 已授權 Mac task worktree；私人絕對路徑保存在原生任務的 R0 收據，不隨公開程式碼發布。
- HEAD：`aab7cd84c673a7090b67d314485d216ed37642ff`。
- 本文核查的 connector、Gateway、GitHub auth、outbox、issue/runtime schema 及 server registration 檔案均沒有 Git 未提交改動。
- 本核查只確定該 checkout 的程式碼契約；實際服務載入版本、當前 org／task／owner／grants／發布鎖仍須從原生系統及 runtime 取得新證據。
- 沒有對 Mac、原生任務、Git branches、GitHub、部署鎖或現有排程作修改。

## 已可沿用的原生入口

| 已核對的程式碼 | 已存在的契約 | 接駁含意 |
| --- | --- | --- |
| `packages/engine/src/connectors/catalog.ts` | `merge_pull_request` 映射至 `github:pr.merge`，標為 sensitive，成功結果可記錄 `pr_merged` outcome。`actions_run_trigger` 映射至 `actions.run`。 | 延伸現有 merge／workflow 工具；不增設重複發布工具。 |
| `packages/engine/src/connectors/mcp.ts`，`createConnectorToolSource` | 由 catalog 生成 `ToolDefinition`，GitHub calls 經 `githubCallAuth`，最後執行 `withSession(...callTool...)`。目前該 catalog tool definition 沒有 Delivery Guardian `checkCall`。 | 在真正生成及執行工具的位置加入原生檢查。 |
| `packages/engine/src/tools/types.ts` | `ToolDefinition.checkCall(input, ctx)` 回傳 `CallCheck`；`ToolContext` 的 org、agent、run、bridge 與 approved 等由宿主提供。 | 可使用宿主身分重查，毋須接受 model 提交的身份或通過旗標。 |
| `packages/engine/src/tools/checks.ts` | `checkToolCall` 先做 scope-wide check，再做工具自己的 `checkCall`。現有 `github:` check 呼叫 `checkGithubCall` 驗證 repository allowlist。 | 保留現有 allowlist，額外檢查不能取代它。 |
| `packages/engine/src/tools/gateway.ts`，`runApproved` | 批准後重新取得工具，核對 `actionHash`、scope、connection、`freshGrantedKeys`，再跑 `checkToolCall`；通過後 CAS `approvals.executedAt`，避免同一批准重複執行。 | 沿用現有有效授權；同時容許撤權、換 connector、改參數或新阻塞即時拒絕。 |
| `packages/engine/src/git/github-call.ts` | `githubCallAuth` 重用 org 的 GitHub App／account connection；`pr.read` 的 App permission 候選包括 pull requests、checks、statuses 讀取。 | Collector 應使用同一原生 credentials 路徑。無權或 provider 不回應時維持 unknown。 |
| `apps/server/src/engine.ts` | 在現有 Gateway sources 內註冊 `createConnectorToolSource`，並注入 `githubApp`；另註冊既有 `createGitToolSource`。 | Server 依賴在現有 registration 注入，不另起 orchestrator 或服務。 |

這些入口沒有證明所有 shell、host MCP、自訂 connector 或人工發布路徑已受 Guardian 限制。
`git/tools.ts` 的 native clone／open PR／branch push 工具及 Git proxy 有既有 scope／branch 規則；它們並沒有構成 Cross-Project release lease。

## 最小可覆核 patch

### 1. 宿主提供 collector 與 native binding

在 `createConnectorToolSource` 的既有 deps 加入型別明確的宿主 callback，實作放在小型 engine helper，於既有 server registration 接線。
名稱及介面應在真正實作前按 repo 的 export／測試慣例確定。

Caller input 只提供 selector，例如 task、PR、repository 名稱、目標環境；它不能提供可信的 `authorized`、`exclusiveLease`、`trustedChecks`、issuer、source freshness 或任意 provider response。
宿主必須自行取得並核對：

1. 當前 `ToolContext.orgId`／agent／run／bridge 與原生 task、owner、project binding；其他組織或未能確認的 binding 阻擋該目標。
2. 當前 grants 及該操作所需的現有授權，保留 Gateway 的既有 approval 規則。`ctx.approved` 不是發布證據。
3. Provider immutable repository ID、repository 名稱、PR base／head／狀態，以及實際 required checks。Expected ID 只能用於比對，不能當作 provider 曾經驗證。
4. Check 的實際 source head、event/ref、workflow／issuer 身份及既有可信 issuer policy。Caller 提供的同名 success、舊 head success、agent 收據及未知來源均不能通過。
5. 現有發布負責人及真實 repo／runtime target lease。缺少經核對的 lease adapter 時，結果須包含可追查的 blocker。

先把可信觀察傳入 `checkRelease` 作政策判斷；`checkRelease` 本身仍是純函數，不能藉此升格成授權或 attestation authority。
`identity.mjs` 的成功結果只代表 `repository_identity_only`，亦不提供原生 task、grants、writer 或 release lease。

### 2. 在現有工具兩個位置重驗

對已綁定 Guardian project 的既有 `merge_pull_request`／`actions_run_trigger`：

- `checkCall` 用於初次呼叫及 approval 後重驗，回傳原因及可展開的結構化 evidence；unknown、conflict、過期及 required check failure 都拒絕執行。
- 在 `execute` 的真正 provider mutation 前，再用最新 native/provider 狀態重驗。取得 token、署名或等待 approval 的時間不能延長觀察有效期。
- Mutation 前的 task、grant、lease、repo/head 檢查按 Cross-Project 的短有效期重新收集；不得直接沿用 identity collector 的較長唯讀觀察 TTL。
- Merge 使用 provider 可以執行的 expected-head precondition。實作前先核對當時 pinned MCP input schema 是否支援該 precondition；沒有便阻擋此路徑，不能默默只靠先讀後寫。
- `checkCall` 的 `data` 並不自動轉成 execute 的可信 context。不要使用跨呼叫全域 cache 保存「已批准」結果；execute 應重新取得資料，並用原生記錄綁定同一 operation。
- 對 publish／workflow，要辨識實際 action、ref 及 runtime target。不能把任何 `actions.run` 的 success 當作 built、deployed 或 live_verified。

既有 Gateway approval 的 action hash、fresh grants 及一次性 CAS 保留。
已有效而涵蓋該操作的授權可繼續使用；新風險或撤權導致的拒絕須列明具體失效條件。

這個 patch 能限制被接線的 connector calls。
要宣布跨所有寫入路徑生效，仍須核對現有 shell／machine command、host MCP、自訂 connector 及實際發布者的流程，並在相應既有邊界接駁；不能以工具名稱 regex、CLI preflight 或 skill 文字代替。

## 現有資料表及租約可承載甚麼

| 現有位置 | 可重用的能力 | 邊界 |
| --- | --- | --- |
| `packages/db/src/schema/work.ts` 的 `issues`／`issueActivity` | 沿用既有 task 的 owner、criteria、PR／artifact links；`issueActivity.data` 可保存結構化事件與 operation/evidence reference。 | 自由文字、活動記錄或 criteria 勾選不構成授權、唯一 operation claim 或發布鎖。 |
| `packages/db/src/schema/runtime.ts` 的 `agentRunSteps` | `data` 可保存工具實際觀察、拒絕原因及證據鏈。 | 舊 step 不能替代 mutation 前重驗。 |
| 同檔 `approvals` | `params`、`actionHash`、owner／decider、`executedAt`、`result` 可綁定精確操作與結果。 | 一次性 claim 是同一 approval 的防重；不同 approval 的相同外部操作仍需 idempotency／provider reconciliation。 |
| 同檔 `outbox`；`packages/engine/src/outbox.ts` | `dedupeKey` 有唯一限制；`enqueue` 用 `onConflictDoNothing`；payload 可帶 operation ID。Worker claim、renew、complete 由 row ID、worker ID、attempt fencing 保護。 | 只保同一 job row。不同 operation rows 可同時執行；不是 repo＋runtime target 的 exclusive release lease。 |
| `packages/engine/src/machine-tasks.ts`／`mission-worktree.ts` | Machine queue 使用 advisory transaction lock 及 mission write 排序，避免同一 mission 的指定 writer 重疊。 | 不涵蓋其他 mission、clone、人工 shell 或發布目標；不能直接傳成 `exclusiveLease: true`。 |

Operation key 應由宿主從已核對的 org、native task、immutable repo ID、action、exact source head、目標及 artifact identity 決定，並記錄在既有任務／執行紀錄。
可在現有且適用的 job 內沿用 outbox 去重；不應為了本方案另開重複任務、排程或資料服務。
若當前操作沒有適用的原生 job／lease，先保留具體缺口；不要借用或奪取其他 writer 的 lock。

Outbox handler 可能在 lease 過期後重試；原程式亦明確要求 handler 自身 idempotent。
Provider timeout 後應先核對 PR／發布／artifact 的真實結果，再決定重試，不能因缺 receipt 就再次 mutation。
只對 outbox row 作 fencing，不能防止舊 worker 已送出的外部 API request；真正發布 lease／provider precondition 仍須由原有發布流程負責。

## 所需測試與獨立覆核

沿用現有測試位置：`packages/engine/test/connectors.test.ts`、`github-call.test.ts`、`gateway.test.ts`、`outbox.test.ts`。
新增精準 fixtures；先證明會失敗，再實作修正。至少驗證：

- 既有授權和有效 native binding 可通過；沒有重複 approval 或新任務。
- Caller 注入 pass flags、錯 org／repo ID、失效 binding、撤權、換 connection／owner／lease，provider mutation 呼叫數為零。
- 同名 check 出自錯 issuer、舊 head／錯 ref、required context 缺失、pending／failure／billing 阻塞均保持 blocked。
- 初次 check 通過但 approval 等待或 execute 準備期間 head／grant／lease 改變，第二次重驗拒絕。
- 直接呼叫該 ToolDefinition 的 execute，亦無法繞過 delivery check。
- 兩個同 operation retry 及兩個不同 operation 競逐同 target，分別驗證 idempotency 與真實 lease；不要用一項測試代替兩種保證。
- Provider 已完成 mutation 但回應遺失，重試先 reconcile 真實狀態。
- Observation 不完整、provider 離線或 connector scope 不足只阻擋受影響 target；其餘獨立且已授權讀取可繼續。

Mock provider tests 只能證明程式控制流程。
啟用後仍須以原生負向呼叫確認工具限制實際生效，並保存被攔截的真實工具名、版本、run／task、理由及無 mutation 證據。

## 當前可交付與待補證據

可交付：上述已核實入口、最小改動範圍、可信資料來源要求及測試方案；identity 模組另有真實 Git fixtures 與獨立覆核紀錄。

原生接駁仍需完成：host collector、current native project binding、issuer policy、release lease adapter、provider expected-head precondition、connector／machine 路徑的實際 enforcement 與獨立覆核。
本文件沒有將任何一項標成已啟用。

交付狀態分開保存：`committed`、`pushed`、`merged`、`built`、`installed/deployed`、`running`、`live_verified`。
Skill 亦分開保存 registered、loaded、工具限制生效三種證據。
任何必要發布關卡未通過時，保持該操作 blocked；其餘已授權且獨立的工作繼續進行。
