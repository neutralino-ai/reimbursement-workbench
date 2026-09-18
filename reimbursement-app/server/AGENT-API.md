# Reimbursement agent API

The application stores evidence and structured reimbursement facts. Codex supplies browser collection, image/PDF interpretation, and Word/PDF generation. These capabilities are intentionally outside the application.

`createStore({dataDir, legacyDir?})` opens a Node 24 SQLite store. `executeAgentCommand(store, command)` from `agent.mjs` is the shared dispatcher used by MCP, the command-line client and HTTP. Local direct/stdio clients need no UI process. In remote mode, the same clients call the configured HTTPS API without opening a local store. `getAgentCatalog()` returns the authoritative JSON Schemas.

## HTTP

Deploy the Node HTTP service on a server behind a TLS reverse proxy. For example, set `PORT=29376` for a loopback listener at `127.0.0.1:29376` and `REIMBURSE_PUBLIC_URL=https://api.example.com/reimbursement` for the public API base. All routes below are relative to that base. The proxy must preserve the `/reimbursement` prefix and the complete public Host, including a nonstandard port when one is used.

`REIMBURSE_PUBLIC_URL` enables cloud authentication and the public mount; local backend mode remains available when it is absent. Set `REIMBURSE_API_ONLY=1` for a separated deployment: non-API routes return 404 and no `dist` files are served. Remote clients never fall back to a local copy after an API error. Configure and verify the deployment's TLS certificate, inbound network rules, authentication, allowed frontend Origins and certificate renewal before relying on cross-device access. These interface descriptions do not certify a particular deployment's availability or end-to-end behavior.

The browser frontend is a separate `--base=/` static build, normally served from `http://127.0.0.1:4317/`. It reads the public `frontend-config.json` field `apiBaseUrl` and calls the backend directly; the local static service neither proxies API traffic nor opens SQLite. This public file contains no credentials and is unrelated to the Agent's private `client-connection.json`.

On first start the service creates `agent-access.json` inside its configured data directory with a random Bearer token; startup logs print only the path. Set `REIMBURSE_DATA_DIR` to a private server directory, for example `/var/lib/reimbursement`. Agent authentication is separate from the human UI password. Keep server data, authentication configuration and each client's private token file outside version control. Do not copy the token into a skill, prompt, command line or browser URL.

MCP/CLI remote defaults come from application-level `client-connection.json` containing `{apiUrl,tokenFile}`. The token file is private plain text containing the 64-character hexadecimal token, not the server JSON configuration. Environment variables `REIMBURSE_API_URL` / `REIMBURSE_AGENT_TOKEN_FILE` override saved settings; `--api-url` / `--token-file` override them. `--local` bypasses remote routing and selects independent local data. There is no fallback to a local ledger after a remote error and no automatic merge with a pre-migration backup. See [client setup](../AGENT-INTERFACE.md).

Authenticated routes:

- `GET /api/agent/catalog`: command schemas.
- `GET /api/agent/workspace`: records, attachments, policy authorities and references, ARP sources, generated documents and versions.
- `GET /api/agent/tasks`: incomplete facts, coverage, source blockers and pending human verification.
- `GET /api/agent/history`: up to 1,000 newest version changes; this is an audit export, not an enabled synchronization protocol.
- `POST /api/agent/commands`: one command, with `Authorization: Bearer <token>` and JSON content type.
- `GET /api/materials/:id`: original bytes, using the Agent Bearer token or an authenticated human session. Add `?download=1` to force attachment disposition. Returned `material.href` already includes the public mount; do not prefix it again.

Origins must exactly match the API's public origin or the explicit `REIMBURSE_FRONTEND_ORIGINS` allowlist. For local browser frontends, add the exact Origins used, such as `http://127.0.0.1:4317` and `http://localhost:4317`; Electron requires `reimbursement://app`. Wildcard and `null` Origins are not accepted. Unlisted origins, or cross-site fetch metadata without a permitted Origin, are rejected even when a token is present. Bearer-authenticated Agent commands do not need a browser Origin header. Agent tokens cannot invoke human UI routes, including verification, policy editing, delivery feedback or the browser export endpoint. Use the Agent commands for those business operations that support Agent identity.

An allowed browser Origin receives `Access-Control-Allow-Origin` for that exact origin, `Vary: Origin`, and exposed `Content-Disposition, Retry-After` headers. API `OPTIONS` preflight requests return 204 for `GET, POST, DELETE, HEAD` with `Authorization, Content-Type`; other methods or headers are rejected. Preflight does not authenticate a user or expose financial data. Responses do not enable credentialed cross-origin cookies; the independent frontend sends `credentials: "omit"` and an explicit session header.

Cloud browser routes under `/api/` require a valid human session, except the authentication endpoints below; this includes workspace, tasks, export and original materials. Human mutations additionally require a permitted Origin. The independent frontend uses `Authorization: Session <64-character-token>`, while `Bearer` is reserved for Agent identity. It keeps the human session in memory and in the current tab's `sessionStorage`, keyed by API address, so page refresh retains login; it does not store sessions in `localStorage` or the public configuration. If tab storage is unavailable, login lasts only in memory. Expiry or a protected-route 401 clears the local session. Server-side passwords and session identifiers are stored only as hashes. Sessions expire after seven days; successful login rotates the presented session, and successful logout revokes it server-side. A network failure during logout clears the local session but cannot confirm server revocation.

The backend also retains its same-origin cookie login mode: Secure, HttpOnly, SameSite=Strict, scoped to the application path. The independent frontend uses header mode instead. An explicit Authorization header never falls back to an ambient cookie; Agent credentials cannot become a human session. Explicit local backend mode without cloud authentication remains separate from the deployed cloud service.

- `GET /api/auth/status` exposes only `{enabled,configured,authenticated}`.
- `POST /api/auth/setup` accepts `{token,password}` with a single-use, 24-hour setup token issued by the server administrator tool. Issuance is never exposed over HTTP. `--frontend-url` or `REIMBURSE_FRONTEND_URL` selects the independent frontend for the setup link, for example `http://127.0.0.1:4317/`. The token is in the URL fragment, not a query parameter, and the UI removes it after successful setup. The desktop UI also accepts a setup code. Successful setup does not itself log the user in; follow it with a normal login.
- `POST /api/auth/login` accepts `{password,sessionMode:"header"}` for the independent frontend and returns `{authenticated:true,sessionToken,expiresAt}` without setting a cookie. Omitting `sessionMode:"header"` uses the same-origin cookie mode and returns `{authenticated:true,expiresAt}` without exposing the token. Failed or excessive attempts return 401 or 429; initialization is required before login.
- `POST /api/auth/logout` revokes the presented Session header or cookie session, clears the cookie and returns `{authenticated:false}`. The frontend then clears its memory and tab storage.

Authentication POST bodies are limited to 4096 bytes, and requests remain subject to the permitted-Origin mutation check. Agent clients use their independent token file, never these password endpoints. The remote transport requires HTTPS except for loopback connections, rejects credentials/query/fragment in the API base URL, refuses redirects and retains HTTP status codes in sanitized errors.

Browser previews, downloads and exports use the authenticated fetch helper, then temporary Blob URLs. Opening a raw cloud material link in a new tab does not supply the Session header. The helper accepts only paths under the configured API origin and mount, refuses redirects, and never places a session or Agent token in an attachment URL. Materials remain protected regardless of whether the frontend can load. Agent clients download original material bytes with their own Bearer header.

```json
{
  "type": "record.patch",
  "actor": {"type": "agent", "id": "codex"},
  "operationId": "a-new-unique-operation-id",
  "baseVersion": "version-read-from-workspace",
  "payload": {
    "recordID": "existing-record-id",
    "submissionReference": "observed-arp-reference",
    "evidenceIDs": ["existing-intact-material-id"],
    "note": "The ARP submission reference is visible in the attached original."
  }
}
```

Successful writes return `{operationId,type,replayed,data}`. Retry an uncertain attempt with exactly the same command and operation ID. A repeat returns its originally committed result even if the record has since changed; fetch current state before the next operation. Reusing an ID for different content yields 409. Stale `baseVersion` also yields 409 without mutation. Read commands omit operation ID and base version, but a direct POST command still requires `actor.type: "agent"` and a nonempty actor ID. MCP/CLI set this identity themselves and reject caller-supplied actors.

## Evidence and facts

- `material.import` accepts bytes as Base64, maximum 20 MiB, plus filename, role and provenance. Its MCP/CLI adapter accepts an absolute `localPath` on the Agent computer and reads the file before invoking the local dispatcher or uploading the bytes to the remote API. The HTTP server does not read caller-supplied filesystem paths. Re-importing the same bytes with the same role reuses the original; an already attached file does not increment the record version.
- Supported originals include PDF, raster images, DOCX, CSV, XLSX, JSON and text. Original bytes are stored under SHA-256 names and checked on every read. Import records integrity and provenance; it does not certify visual content or interpret the file.
- `invoice.upsert` creates a record with `baseVersion: "new"`, or updates an existing invoice with its current version. Duplicate account/invoice numbers are blocked. Changes to financial identity revoke dependent payment/claim assertions; existing allocations must be resolved first.
- `record.patch` changes only supplied facts. Subscription-payment confirmation still requires intact invoice and payment materials. It does not perform an ARP submission. Under the user's workflow rule below, verified full ARP approval is sufficient to assume reimbursement arrival; there is no separate bank-arrival verification step.
- `arp.upsert` records an observed source and approval evidence. Approval must have a supported status and positive amount. Duplicate ARP references and reductions below allocated amounts are blocked.
- `reservedCNY` reserves approved money for expenses outside this ledger, with a required `reserveReason` describing the supporting evidence and period. It never changes the original approved amount. Available funds equal approved minus reserved minus allocated. In a fictional example, a ¥2,400.00 approval covering an earlier year and the current year can reserve ¥1,200.00 for the earlier year and allocate the remaining ¥1,200.00 to the current year. A new source defaults to zero; omitted reservation fields preserve an existing reservation during a later refresh. Increasing a reservation beyond unallocated funds is rejected.
- `allocation.create` requires exact invoice-to-ARP evidence and enforces both invoice and ARP amount limits. Matching amount alone is not a sufficient reason.
- Mapping evidence is retained on each allocation and rechecked on reads. If mapping evidence disappears or changes, that allocation stops contributing to completed reimbursement status, but its money stays occupied until explicitly corrected or removed.
- `document.register` links externally generated DOCX/PDF files to source materials and the exact record versions read before generation. Supply `sourceRecordVersions` for every `recordID`. `purpose` is `review` (the default for existing and new documents) or an explicitly declared `application`. An existing reconciliation report never automatically becomes an application package. `ready` requires both Word and PDF, but is an agent assertion about output preparation, not human approval or proof of rendering. Later source changes expose `stale: true`.
- A ready `application` must cover at least one record. Every covered record must have `paymentVerified: true`, `claimConfirmed: true` and a positive `claimedCNY`; its intact invoice, payment and required invoice-date FX originals must be included in `sourceMaterialIDs`. `submissionPDFMaterialID` must identify one of the registered output files: the combined PDF containing the explanation, invoice originals, payment screenshots and BOC screenshots. Retain the editable explanation DOCX as well. The DOCX and combined PDF must use role `document` or `statement`; a vendor invoice cannot replace them. A separate explanation-only PDF is optional. Incomplete work may be registered as `draft`. ZIP packaging is not required. Codex prepares the document and checks page order, contents and rendering, recording the checked page list in its note; registration does not certify visual contents.
- `source.update` records collection attempts and blockers. A complete claim requires evidence and a coverage range. It never performs browser actions.

Money uses exact decimal strings with at most two decimal places. Exchange quotes use up to six decimal places, with no scientific notation or commas. No rate is guessed by the service.

## Policy originals and clause references

Import a policy PDF with `material.import`, role `policy`, and source kind `user-upload` or `browser-download`. The original is copied unchanged using the same content-addressed storage as invoices. The 20 MiB limit applies. The service requires a `.pdf` extension, PDF signature and EOF marker; generated documents and browser transcriptions cannot be policy originals. These checks are format/integrity safeguards, not a PDF renderer or a certification of the contents. Every download checks the stored SHA-256.

`policy.register` creates or updates a rule source. Use `baseVersion: "new"` for a new policy ID, otherwise its current policy version. All shown top-level payload fields are required; `printedPage` is optional in a clause:

```json
{
  "id": "example-policy",
  "title": "Synthetic policy schema example",
  "versionLabel": "example-version",
  "materialID": "registered-policy-pdf-material-id",
  "status": "reference",
  "note": "Schema example only; use the actual original and inspected clauses.",
  "clauses": [{
    "id": "example-clause",
    "topic": "Reimbursement evidence",
    "section": "Actual section heading and clause number",
    "pdfPage": 1,
    "printedPage": "Actual printed page label",
    "quote": "Exact text transcribed from the original, not an invented requirement.",
    "interpretation": "The agent's interpretation, kept separate from the quote.",
    "scope": "The transactions and conditions to which the clause actually applies."
  }]
}
```

Status is `active` (selected authority), `reference` (retained background source), or `superseded` (retained older version). Multiple active sources are allowed for different subjects. Selection does not certify a clause interpretation or rewrite reimbursement facts. Clauses may be empty while an original awaits reading. Clause IDs must be unique within the policy, and `pdfPage` is a positive 1-based physical PDF page; the service does not parse page counts or validate the maximum page. The collecting agent must verify the actual text, page and applicability against the original.

`workspace.policies` is ordered by most recent update. Each entry contains the registered fields plus `createdAt`, `updatedAt`, `actor`, `version`, `material` and `integrity`. The material exposes its ordinary `href`; `GET /api/materials/:id?download=1` forces attachment disposition and returns the exact original bytes. The default route displays PDF/image files inline. Missing or changed originals remain visible as integrity failures and are blocked from download or new registration. `history.list` accepts `entityType: "policy"`; changes preserve append-only snapshots and actor identity. Use the policy material in a generated document's `sourceMaterialIDs` when its reasoning relies on that source, with specific clause references in the note/manifest.

UI routes require a permitted Origin and a human session in cloud mode. They accept the human Session header or same-origin cookie, and reject Agent Bearer credentials:

- `POST /api/policies/upload` accepts `{filename,contentBase64,title,versionLabel,note,operationId}`. It stores the PDF and registers a `reference` policy with no clauses under a deterministic content-based ID. Re-uploading an already registered original returns the existing policy without changing its selection or metadata.
- `POST /api/policies/:id` accepts the complete metadata `{title,versionLabel,materialID,status,note,clauses,baseVersion,operationId}` for an existing policy. The URL supplies the ID. It uses the policy version, not an invoice version.

Both return `{operationId,type,replayed,data}` and preserve the actor as `human`. Exact retries reuse the same operation ID and return the original result; a different request with that ID or an outdated base version yields 409. These UI operations maintain rule sources; they are separate from human verification of an expense. Agents use `material.import` and `policy.register`, retaining agent identity. Policy storage and metadata do not change exchange-rate selections, payment assertions, claims, ARP approvals or allocations.

## Invoice-date BOC exchange rates

The user has authorized a settled precedence rule for GPT subscriptions: follow an applicable explicit institutional clause; if none specifies the choice, use successfully approved reimbursements of the same kind as precedent and retain `中行折算价`. The date is the invoice date under the user's instruction, supported by the actual BOC screenshot. Check applicable entries in `workspace.policies`, but do not require extra finance confirmation or block a new package solely because no institutional clause specifies the category/date. Identify approved precedent and user instruction separately from institutional quotations. A scoped equipment-valuation or travel clause does not establish the rule for a software subscription. Category selection alone does not establish actual payment or the final claim amount for a record. The current schema enforces the selected date/category; if an applicable explicit authority later requires another choice, update support before registering it rather than mislabeling the quote. Existing claims and approvals remain unchanged.

Use `exchangeRate.set` with the current **record version**, a stable operation ID, and this payload:

```json
{
  "recordID": "existing-record-id",
  "date": "2026-01-25",
  "currency": "USD",
  "provider": "BOC",
  "rateType": "中行折算价",
  "quotedRate": "700.0000",
  "unit": 100,
  "sourceUrl": "https://www.boc.cn/sourcedb/whpj/",
  "evidenceIDs": ["original-boc-screenshot-material-id"],
  "note": "Synthetic schema example only; replace with the invoice-date quote actually observed and checked."
}
```

The date must equal `invoice.date`, and the currency must exactly match the invoice. The fixed quote is **中行折算价 per 100 foreign currency units**. Import original screenshots with role `exchangeRate`, source kind `browser-observation` or `browser-download`, and an official BOC `source.url`. Both that URL and the quote's `sourceUrl` must use HTTP/HTTPS on `boc.cn`, `bankofchina.com`, or their subdomains, without credentials or custom ports. PNG, JPEG, WebP, GIF and HEIC screenshots require image signatures, an image extension and intact stored bytes. Renamed JSON, spreadsheets, generated tables and document files cannot substitute for a screenshot. These checks establish format, provenance metadata and integrity; the collecting agent must actually inspect the pictured date, currency and quote.

The command returns the updated record in `data`. `record.exchangeRate` is null when not recorded, otherwise it includes the submitted fields plus `recordedAt`, `actor`, `cnyAmount`, `valid` and `issues`. `cnyAmount = invoice.amount × quotedRate / 100`, rounded half up to two decimal places using exact integer arithmetic. The supported quote range is greater than zero and at most 1,000,000 per 100 foreign units. Date/currency mismatch, invalid source metadata or changed/missing screenshot bytes makes the derived rate invalid on every read.

Recording a rate attaches its evidence and increments the record version, preserving an audit snapshot and making packages built from the previous version stale. It **never changes** an already confirmed, submitted or approved amount, payment confirmation or ARP mapping. A new ready application requires its confirmed claim to equal the calculated CNY amount; a difference produces a task for explicit reconciliation instead of silently overwriting the claim. CNY invoices need no FX screenshot and their confirmed claim must equal the invoice amount.

An older application that lacks the combined submission PDF or valid FX/amount/source requirements is exposed with `needsUpdate: true`, `ready: false` and `readinessIssues`; if it was registered as ready, its current `status` becomes `draft` while `registeredStatus` retains the original declaration. Source changes also expose `stale`. Review reports remain reviews. `tasks.list` includes missing/invalid FX and claim differences for unfinished records; records in verified financial review or fully approved keep the user's automatic completion of prior steps and do not require rebuilding historical packages.

## Finance-secretary delivery and UI uploads

`workspace.deliveryItems` exposes one item per record and linked file, including files in generated documents that reference the record. Each item has `id`, `recordID`, `materialID`, `status`, `updatedAt`, `actor`, `note`, `version`, `required`, `integrity`, and `documentIDs`. An unrecorded item starts with `status: "unknown"`, `version: "new"`, and null actor/time. Status values are `unknown`, `submitted` and `not_submitted`; here `submitted` means the specified file was handed to the finance secretary, independent of ARP submission or approval.

The human-session UI endpoint is `POST /api/records/:id/delivery` with `{materialID,status,baseVersion,note?}` from a permitted Origin, and returns the updated delivery item. `baseVersion` is the **delivery item version**, not the record version. MCP/API uses `delivery.set` with a stable operation ID, that same base version, and `{recordID,materialID,status,note}`. An agent must state the explicit user feedback or evidence in `note`; its actor stays `agent`. Delivery changes retain their own append-only history (`history.list` with `entityType: "delivery"`) and never change financial facts, record versions or human verification. Files outside the record/document scope, unknown files, and missing or altered originals cannot be marked as submitted.

`required` identifies delivery candidates: invoice/payment originals, explicit situation-statement files, and the PDF of a current ready application. Editable DOCX sources, observation JSON, reconciliation reports, draft applications and stale applications are not automatically required. Shared files have independent items for each covered record. `tasks.list` includes missing/draft/stale application tasks and per-file `delivery` tasks requesting user feedback; it does not interpret absent delivery feedback as an ARP state.

The final workflow column is **财务审核**. Valid ARP evidence explicitly mapping a record to financial review produces `financeReviewPending: true` and `priorStepsComplete: true`, with `financeReviewEvidenceIDs` and `financeReviewARPId` identifying the basis. It completes only the first four stages; `approvedCNY` is unchanged. A submission reference, department review or partial approval alone does not qualify. Full approval completes all five stages when the evidence-derived `status` is `completed`, or when `claimConfirmed` is true, `claimedCNY` is positive and verified, correctly allocated `approvedCNY` covers that amount in full. `tasks.list` omits prerequisite tasks for both groups and exposes `financeReviewPendingRecordIDs`, `priorStepsCompleteRecordIDs` and the existing `completedByApprovalRecordIDs`. Independent account/source coverage tasks remain applicable.

For each qualifying record-material relationship, delivery reads expose `completedByFinance: true` and `effectiveStatus: "submitted"`, with `financeReviewPending` indicating pending review; `completedByApproval` remains true only for full approval. Otherwise `effectiveStatus` equals the original `status`. The stored delivery status, actor, time and version remain unchanged. Shared files are evaluated independently for every record. Original attachments, payment flags, ARP submission references and `humanVerification` are never fabricated or rewritten by this derived completion. Loss of qualifying status, valid source evidence or invoice-mapping evidence removes the derived completion and restores any outstanding tasks.

Verified full ARP approval also means **reimbursement is assumed to have arrived under the user's policy**. No bank/cash verification tasks, bank receipt files or synthetic bank transactions are created. This is the chosen workflow convention, while original financial-source records remain preserved.

`POST /api/records/:id/materials` accepts `{filename,role:"invoice"|"payment",contentBase64,baseVersion,note?}` from a permitted UI Origin with a human session. Here `baseVersion` is the **record version**. It supports image/PDF originals up to 20 MiB, preserves the original bytes and human upload provenance, and returns the material plus `duplicate` and `recordVersion`. Uploading does not confirm payment, a claim, an ARP submission or human verification. A duplicate already attached original returns the current record version without invalidating prepared documents. Both UI endpoints accept the human Session header but reject Agent Bearer credentials; agents use their own commands instead of presenting themselves as UI users.

## Human verification and history

`POST /api/records/:id/verify` is a human-session UI route with `{baseVersion,evidenceFingerprint,result:"accepted"|"rejected",note}` and requires a permitted Origin. Both version and the required evidence fingerprint must match the record the user actually opened. The fingerprint is exposed by workspace reads and also protects against changed files that do not increment the database version. This operation is absent from MCP, accepts the human Session header and refuses Agent Bearer credentials. Agents cannot claim `actor.type: "human"` through the dispatcher.

Human verification is independent of payment/approval facts and bound to the reviewed version plus a fingerprint of its derived evidence state. Subsequent edits or damaged originals make it stale. Verification does not fabricate missing facts. Version history and audit events are append-only, and allocation removal leaves a history tombstone.

The ledger's host filesystem remains a trust boundary: this service is not a sandbox against software that already has write access to its database. Cloud users and remote Agent clients access the same server ledger. Offline multi-device synchronization and conflict merging are not enabled; a separate local copy remains independent. The device ID, logical versions and history export are foundations for a later synchronization implementation. Keep deployment-specific access details, backups and verification records outside the source repository.
