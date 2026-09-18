# Invoice-date Bank of China evidence

Use this procedure when preparing a new GPT foreign-currency application under the user's confirmed precedent rule. An applicable explicit institutional clause takes precedence. Where none specifies the choice, retain `中行折算价` because reimbursements of the same kind of GPT subscription succeeded with it; use the invoice date under the user's date instruction and preserve an actual official screenshot. Do not require extra finance confirmation or block the package solely because the institution did not specify the category/date. Describe this as user-authorized approved precedent, not as an institutional quotation.

Check the current intact, applicable sources in `workspace.policies`; see [policy evidence](policy-evidence.md). An applicable user-supplied institutional requirement takes precedence. Do not import equipment-valuation or overseas-travel rules into subscription reimbursement without support for that scope. Quote authenticity and policy applicability are separate conclusions. If a different date/category is required, record that requirement and adjust the workflow/API before registering the new choice; never enter a buy/sell quote under `rateType: 中行折算价`.

## Retrieve and preserve

1. Read the exact invoice date, original currency and amount from the registered original. Use the invoice issue date, not the period end, bank posting date or package generation date.
2. Open https://www.boc.cn/sourcedb/whpjSearch/index.html using Codex's browser tools. Enter that exact date and currency. If a CAPTCHA appears, follow the browser tool's confirmation requirements; record the blocker and continue independent work.
3. Check the returned date and the `中行折算价` column. The BOC table quotes CNY per 100 units of foreign currency. Keep the published timestamp; when several intraday rows exist, use the latest published row on that same date and preserve that choice in the note. Do not substitute a buy/sell quote or describe `中行折算价` as the arithmetic average of buy and sell prices.
4. Capture the actual rendered official page showing Bank of China identification, the selected date/currency, column headings and the chosen result. Preserve those screenshot bytes unaltered. Store source URL, capture time, published time and selected row in a sidecar/manifest or material source note. A hand-retyped table, generated image or HTML reconstruction is not an official screenshot.
5. If the date has no quote, stop this calculation with a precise missing-rate issue. Do not silently use an adjacent day or an old batch rate. Do not treat a query form or CAPTCHA image without a result as exchange-rate evidence.

## Register and calculate

Import the image with `material.import` role `exchangeRate` and browser source URL/time. Attach it to the relevant invoice using the current record version. Call `exchangeRate.set` with fresh baseVersion and a stable operationId:

```json
{
  "recordID": "<existing record id>",
  "date": "<invoice YYYY-MM-DD>",
  "currency": "USD",
  "provider": "BOC",
  "rateType": "中行折算价",
  "quotedRate": "<actual official quote>",
  "unit": 100,
  "sourceUrl": "https://www.boc.cn/sourcedb/whpjSearch/index.html",
  "evidenceIDs": ["<registered screenshot id>"],
  "note": "Official query date, result timestamp, selected column and screenshot were visually checked. 中行折算价 follows the user's authorized approved GPT precedent; the invoice date follows the user's instruction. This basis is separate from institutional quotations."
}
```

The service computes original amount × quotedRate ÷ 100 using exact decimal arithmetic and rounds the final CNY amount to cents. The authorized category and the observed rate are separate from proof of actual payment and confirmation of the final per-record claim amount. Preserve already confirmed, submitted or approved amounts. If a new application would differ, expose the difference and reconcile it explicitly instead of overwriting history. Claims in verified financial review or fully approved need no new FX lookup or regenerated historical application. A CNY expense needs no FX screenshot.

## Integrated submission PDF

The agent authors the situation/purpose note in Word and produces one integrated PDF in this order:

1. Situation/purpose and calculation note: invoice identity/date, relevant research/business purpose, original currency, BOC quote/date, CNY calculation, and attachments list. State the user-authorized approved precedent and date instruction, or cite an applicable explicit institutional clause where one governs; do not attribute the precedent-based choice to a clause that does not say it.
2. Original invoice PDF pages, preserved without alteration.
3. Actual payment evidence pages, keeping the text readable at print size.
4. Official invoice-date BOC screenshot and its source/date caption.

Keep the editable DOCX. A manifest should link each expense to its own invoice, payment, rate screenshot, calculation, hashes and PDF page numbers. Merge existing original PDF pages rather than recreating them from extracted text. Do not put missing evidence placeholders into a ready package. Use the documents/PDF skills to render and visually inspect every page.

Register the application with `purpose: application`, the exact `sourceRecordVersions`, all evidence in `sourceMaterialIDs`, DOCX/PDF in `materialIDs`, and the integrated PDF ID in `submissionPDFMaterialID`. A separate reconciliation report stays `purpose: review`; it never counts as the integrated submission file. An incomplete package remains a draft. Handoff is recorded from user feedback; verified financial review or full ARP approval may infer workflow completion without creating a historical delivery event.

Official references: https://www.boc.cn/sourcedb/whpj/ and https://www.boc.cn/sourcedb/whpjSearch/index.html .
