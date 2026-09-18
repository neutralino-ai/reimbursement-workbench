# ChatGPT / Stripe invoice downloads in Chrome

Use this procedure when collecting ChatGPT invoices from the Stripe billing portal in Chrome. Follow the current browser tool's documented API. The sequence below succeeded for two invoices in the local session on 2026-09-17, with the saved PDFs verified; it does not establish the cause of earlier `ERR_BLOCKED_BY_CLIENT` failures or guarantee success in other sessions.

## Download and verify

1. Use the requested account and billing period, and retain the existing ledger identifiers from `workspace.get` / `tasks.list`. On the relevant Stripe invoice page, locate the **Download invoice** control without clicking it yet. **Download receipt** is a different document.
2. Before clicking, record the download directory's existing file paths and sizes. Identify new files by the before/after path set; Chrome may add a suffix such as `(1)`. If filtering by time, compare a UTC start time with `LastWriteTimeUtc`. Do not compare PowerShell local timestamps with UTC timestamps, which can hide a successful download.
3. When the current tool supports `playwright.waitForEvent('download', { timeoutMs: 15000 })`, create the promise **before** clicking, then await it. The following uses already-obtained page/tab handles; choose the click target from a fresh UI snapshot rather than reusing old coordinates:

   ```javascript
   var invoiceDownloadPromise = page.playwright.waitForEvent('download', { timeoutMs: 15000 });
   await cuaTab.click([x, y]);
   await invoiceDownloadPromise;
   ```

4. Confirm a completed file actually exists on disk, using the directory difference. Consult browser download status only if the current tool permits it; do not retry or work around a denied internal browser page. A successful click or download event alone is insufficient. Read the PDF and verify its invoice number, issue date/billing period, account or customer, currency, and total against the selected invoice. Check that it is the invoice rather than a receipt or error page. Record the file's path, size, and hash for provenance before importing it.
5. Reconcile against existing materials and the same account/invoice number. Reuse identical stored bytes. A new filename or different PDF bytes for an already-recorded invoice is not a new expense; inspect the content and link any needed evidence to the existing record using its current version. A verification-only re-download needs no duplicate invoice or material import.

## If the attempt fails

If the event times out or the browser shows an error, inspect the before/after files and download status before retrying: the file may already have arrived. If a verified file exists, stop. If the ordinary click previously failed and no file exists, try the listener-before-click sequence once. If that attempt also produces no usable PDF, report the observed page/download state and leave the collection gap open instead of repeatedly clicking or declaring success.

Keep invoice contents and signed download URLs out of reusable instructions. Do not copy or persist browser sessions, cookies, credentials, or signed URLs as a workaround.
