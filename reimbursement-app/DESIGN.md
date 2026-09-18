# Interface design

This local reimbursement tool is a working ledger. Its primary question is which monthly expense still needs action, with the evidence one click away.

## Layout

A single overview table replaces the sidebar and step-specific pages. The first column identifies the expense; five workflow columns show collection, payment, application, handoff and ARP completion. Every workflow column contains a completed/total count in its header, aligned with its row states. Records sort by invoice date descending with a stable ID tie-break. The default shows all months; filters select unfinished or reimbursed records. Original files open directly and a status opens the corresponding record drawer.

```
Reimbursement workflow / GPT / year                 Refresh   More
All (8)   To handle (5)   Reimbursed (3)                  Search
Expense    8/8         6/8        3/8        3/8          3/8
           Invoice     Payment    Application Handoff      ARP
August     Saved       Missing    Missing FX  Pending      Pending
July       Saved       Missing    Missing FX  Pending      Pending
...
January    Complete    Complete   Complete    Complete     Reimbursed
Last actual collection / refresh interval
```

The prominence belongs to the table, not promotional cards. Utility views for source records, original library and audit history remain behind More. Mobile retains the five-column comparison through an internally scrolling table and sticky identity column.

## Tokens

- Page: #F4F6FA; surface: #FFFFFF; text: #182333; secondary text: #697589.
- Action blue: #2859D6; completed green: #278464; pending amber: #A16A16.
- Chinese type: Microsoft YaHei UI, PingFang SC, Noto Sans SC, then Segoe UI. Body 14px, secondary 12px, main heading 28px. Tabular numerals for money and counts.
- 6px controls, 8px main surface corners; crisp dividers, no card shadows except an open overlay.
- Spacious rows around 84px, clear keyboard focus, text labels accompany state icons.

## Evidence and completion

Invoice-day BOC conversion evidence lives in the application column and detail drawer. That drawer shows the date, rate type, quote per 100 units, exact CNY calculation, original screenshot and integrated submission PDF. The combined PDF includes the written explanation, invoice, card/payment proof and BOC screenshot. An old review report is not a completed application.

Fully verified ARP approval overrides prerequisite gaps. It does not invent files or handoff history. Completed months remain accessible at the bottom.

Design approach reviewed against the frontend-design Skill at https://github.com/anthropics/skills/blob/main/skills/frontend-design/SKILL.md. The user's explicit table-first brief determines the layout.
