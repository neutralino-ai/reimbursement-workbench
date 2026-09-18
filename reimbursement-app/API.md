# Local API contract

Initial scope: ChatGPT records only (6 records imported from the legacy workspace). Preserve all original data; no writes in LLM-报销. Node 24 built-in SQLite. Server binds only 127.0.0.1:4317. Serve Vite middleware in dev, dist if built. Root owns HTTP server/scaffold; domain agent owns server/store.mjs and tests; frontend agent owns src/** only.

## Store module interface

`createStore({dataDir, legacyDir})` returns synchronous methods `workspace()`, `reviewRecord(id,payload)`, `allocate(payload)`, `removeAllocation(id)`, `importAppleCard(payload)`, `material(id)`, `close()`.

`legacyDir` is original `LLM-报销`; dataDir is app/data. First startup copies legacy AppData/materials into data/materials by content hash, verifies hashes, imports all accounts but only ChatGPT records into editable first-phase table; retain raw workspace JSON in data/imports and count deferred Claude records. Repeat startup/import is idempotent and preserves local reviews. Do not operate old Python canonical store. Keep transactions and append-only audit events. Throw statusCode 400/404/409 errors for user errors. Money strictly parse decimal strings to integer cents, no floating-point amount calculations.

## GET /api/workspace

```ts
type Material = {id:string;filename:string;role:string;sha256:string;legacyVerified:boolean;integrity:'ok'|'missing'|'changed';href:string};
type RecordItem = {id:string;accountID:string;accountName:string;vendor:string;plan:string;date:string;billingMonth:string;invoiceNumber:string;amount:string;currency:string;claimedCNY:string;paymentVerified:boolean;claimConfirmed:boolean;submissionReference:string;submittedOn:string;notes:string;materials:Material[];approvedCNY:string;outstandingCNY:string|null;status:'needs_review'|'ready'|'submitted'|'partial'|'completed';issues:string[]};
type ARPItem = {id:string;reimbursementNumber:string;summary:string;status:string;claimedCNY:string;approvedCNY:string;approvalVerified:boolean;availableCNY:string;sourceLabel:string;materialIds:string[]};
type Allocation = {id:string;recordID:string;arpID:string;amountCNY:string;basis:string};
type CardTransaction = {id:string;date:string;description:string;amount:string;currency:string;sourceFilename:string;candidateRecordIDs:string[]};
type Workspace = {scope:string;records:RecordItem[];arpRecords:ARPItem[];allocations:Allocation[];events:{id:string;at:string;type:string;summary:string}[];importSummary:{accounts:number;records:number;deferredRecords:number;materials:number;importedAt:string};sources:{id:string;name:string;url:string;status:string;detail:string}[];gaps:{month:string;reason:string}[];cardTransactions:CardTransaction[]};
```

Historic payment material verified flags are observations, initially paymentVerified=false; no claimedCNY in source so blank and claimConfirmed=false. ARP approvalVerified preserved only with intact supporting original material, labelled historic as of 2026-09-06, no claim allocations pre-created. Source status describes actual current capabilities, never fake connected or auto-synced. ARP URL https://ihep.arp.cn; ChatGPT https://chatgpt.com; Apple https://card.apple.com. Sources say manual login required / file import available; browser activity here is not integrated in app. Gaps from 2026-01 through current month without records mean 未核查, not unpaid/missing invoice proof.

## Local writes

- `POST /api/records/:id/review`: `{claimedCNY:string,paymentVerified:boolean,claimConfirmed:boolean,submissionReference:string,submittedOn:string,note:string}`. Require nonempty note, valid positive money for confirmed claim; confirmed payment requires intact invoice and payment evidence, not filename alone. Keep original fields. Evidence changes invalidate completion dynamically. Cannot reduce claim below existing allocation.
- `POST /api/allocations`: `{recordID:string,arpID:string,amountCNY:string,basis:string}`. Positive exact cents, nonempty basis, approval must be verified and have intact sources; forbid over-allocation against either record's confirmed claim or ARP available amount. Same source reallocation/duplicate must not exceed limits.
- `DELETE /api/allocations/:id`: reversible association removal, append event.
- `POST /api/import/apple-card`: `{filename:string,csv:string}`. Use csv-parse/sync. Support standard Apple headers Transaction Date, Clearing Date, Description, Merchant, Category, Type, Amount (USD), Purchased By. Preserve raw CSV privately. Dedup source hash and stable row identity (do not silently collapse identical legitimate rows within one source). Surface only OpenAI/ChatGPT/Codex rows with candidateRecordIDs based on date/amount; never automatically confirm payment from an approximate candidate. Credits/refunds must remain clearly distinguished and not count as paid. Reject unknown schema or invalid money without partially importing. Max 10 MB; no source absolute path needed.

Completion requires paymentVerified + confirmed positive claimedCNY + fully allocated verified approvals + intact invoice/payment/approval originals and no conflicts. Collection, submission and approval are independent dimensions. Approval alone must not invent submission date. Unknown amounts stay unknown. ARP statuses unknown/in-review cannot close records. Foreign amounts and CNY remain independent.

## Read files and export

`GET /api/materials/:id`: store.material returns `{path,filename,mime}` only for trusted known IDs, verify stored hash before serving. No arbitrary paths. `GET /api/export`: JSON export of workspace plus disclaimer coverage partial. Never expose session cookies or log credentials. Root server validates same-origin POST/DELETE and rejects foreign Host and Origin. API errors JSON `{error:string}`. GET does not mutate state apart from initial idempotent import.
