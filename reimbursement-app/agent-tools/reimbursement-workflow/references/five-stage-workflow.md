# Five-stage reimbursement workflow

## Financial review determines inferred completion

When valid ARP evidence explicitly maps the expense to a claim in financial review, complete stages 1–4 automatically and leave stage 5 pending. Show “财务审核中，前序自动完成”; pending review does not add approved money. When the submitted claim has passed all approvals and verified approval fully covers the expense, complete all five stages and show “财务已通过，自动完成”. Neither state needs payment screenshots, application regeneration, repeated human verification or file-handoff follow-up. An ARP reference alone, department review, unverified evidence or partial approval alone does not establish financial review.

Only full approval defaults funds received under the user's rule; do not check bank statements, cashier transfers or destination accounts. Inferred completion is a derived workflow result, not an invented original file, human signature or manual delivery event. Preserve existing raw materials and historical assertions. When the qualifying status or its mapping evidence is revoked, recalculate the workflow and reveal any remaining gaps. Shared files count as completed only when every relevant record has qualifying financial-review evidence, full approval or its own recorded handoff. Collection freshness for new expenses remains tracked separately.

The main UI is a single table ordered by invoice date, newest first. Its five workflow columns show counts above and per-expense states below. Open a state to inspect its original files; access the source library and history as secondary tools.

## 1. Collect original invoices

Read the existing records and source observations first. Retain the last actual collection time in `source.update.checkedAt`; opening or refreshing the workbench is not a collection attempt. A recent completed source with all invoice originals is green; incomplete, uncollected, or overdue collection is yellow. The UI defaults to a configurable seven-day refresh interval. Recheck due billing periods on the vendor website rather than inventing a missing monthly invoice. Preserve account and invoice identifiers and deduplicate repeated downloads.

## 2. Collect and verify payment evidence

Count existing intact `payment` materials as collected, including evidence imported in previous sessions. Request only missing payments, identifying the months, merchant, dates and original amounts. The user may supply images or PDFs. The UI preserves uploads; uploading alone does not verify payment.

If an original is absent, inspect previously supplied DOCX and PDF documents before requesting it again. Extract embedded images without alteration from DOCX when available. For a PDF, recover the embedded image or preserve an evidence page with a page locator. Keep the parent document, link the recovered file to it in the import source note, and record the page or OOXML entry. Label a rendered page as recovered document evidence, not as a separately downloaded original. Check the merchant, date, amount, settlement state and record association before `record.patch(paymentVerified: true)`. A receipt or a vendor Paid label does not replace independent card evidence.

## 3. Prepare an application package

The agent drafts the situation/purpose note; the user reviews the result. Use evidence and prior user-confirmed facts for the actual product, billing period, research/business purpose, original amounts and exchange-rate calculation. Do not copy a historical Claude label onto a GPT claim or invent a new use, amount, project code or signature.

Each package contains:

- Original invoice PDF(s).
- Payment screenshots/PDF evidence for those exact records.
- A situation/purpose and calculation note in editable DOCX and rendered PDF.
- Original BOC historical-rate screenshots for each foreign-currency invoice date, using the `中行折算价` column quoted per 100 currency units. See [the exact procedure](boc-invoice-date.md).
- A manifest mapping records to source files, hashes, original/claimed amounts and known exceptions.

Write under the workspace output directory and preserve originals. Follow applicable evidence-backed batch limits, rather than treating an old batch amount as a universal limit. A package can group related monthly invoices; each record must have its own evidence. Render and inspect the DOCX/PDF for legibility, dates, amounts and placeholders. Register with `purpose: "application"`, exact source versions, all supporting `sourceMaterialIDs`, and the generated DOCX/PDF `materialIDs`. Set `submissionPDFMaterialID` to one integrated PDF containing the authored note and all evidence pages. New foreign-currency applications require valid invoice-date FX and an exactly matching claim amount. Do not replace historical submitted amounts with the new rate. Missing payment, unconfirmed claimed CNY, unresolved purpose or unreviewed layout leaves the package as `draft`. A review report is not an application package. Historical packages may be registered after inspecting their actual content and record mapping, without marking a new handoff.

## 4. Record files handed to the finance secretary

For expenses without qualifying financial review or full approval, the user indicates which files were handed over. Use `delivery.set` for explicit feedback: `unknown`, `submitted`, or `not_submitted`, with the current delivery item's version and a stable operation ID. Retain the feedback basis in `note`. An agent recording user feedback remains attributed to the agent. Inferred completion does not create a delivery event.

Track each actual file and show submitted/total counts; a shared package PDF is one file even if it covers several records. The DOCX editing source and internal audit JSON are not mandatory handoff files. Keep invoice/payment/statement links visible. Generating files or observing an ARP number does not prove a specific file was handed to the secretary. Handoff feedback must not rewrite ARP identifiers, approvals, or human verification. Sending messages or files to the secretary is a separate external action requiring the user's specific instruction.

## 5. Financial review (财务审核)

Read `https://ihep.arp.cn`, preserve dated observations and official exported files, and match exact invoice/claim references before allocating money. Display confirmed claimed CNY, allocated approved CNY and their difference. List records with unknown claimed CNY separately; they are not zero-value claims. Explicit financial review completes the earlier four stages but leaves this final stage pending; no pending amount becomes approved. Once ARP shows the submitted claim has passed all approvals and the expense is fully covered, complete this stage, mark it reimbursed and default funds received. Do not create a bank-check stage or task. Preserve unresolved mappings and the out-of-scope share of mixed batches. A positive known difference or unknown amount remains an open financial-review gap.
