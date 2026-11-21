# Full tax invoice and e-Tax Invoice (owner order 7.2)

## What is built (migration `20261119035000_tax_invoice.sql`)
- A paid bill of a **VAT-registered** shop can get a **full tax invoice** (ใบกำกับภาษีเต็มรูป) on the receipt page: the buyer's name, 13-digit tax ID, 5-digit branch (00000 = head office) and address are added to the SAME sale. Numbers `TI-000001…` per shop. The seller's name, tax ID, branch, VAT and the lines come from the frozen receipt; the seller's address is set by the owner at **Settings → Accounting** (`save_tax_profile`).
- One live invoice per receipt; an issued invoice cannot be edited or deleted. A wrong one is **cancelled** (`refund.create`, with a reason, critical audit) and a new one issued.
- A4 print from the receipt page, labelled with the abbreviated receipt number it replaces.
- The data holds `etax_status` (`none` / `sent` / `failed`) already, so submission can be added without a rewrite.

## What is NOT built
- **Sending to the Revenue Department (e-Tax Invoice).** That needs an accredited service provider (a "e-Tax Invoice by Email" or "by a service provider" route), a digital certificate and a signed XML / PDF-A3 file. None of that can be done from the build environment. When the owner picks a provider, one adapter (like the payment gateway) takes an issued `tax_invoices` row and sets `etax_status`.
- Credit notes (the return slip is not one).

## Must be confirmed before go-live (accountant)
1. That the printed form carries every field the Revenue Department requires for a full tax invoice.
2. That issuing a full invoice in place of the abbreviated receipt (same sale, one document counted) is the shop's accepted practice, and how the abbreviated receipt is marked.
3. Whether a deposit invoice (`DP-…`) must be netted off the final one (docs/ACCOUNTANT-BRIEF.md).
