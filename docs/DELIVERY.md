# Delivery (LINE MAN / Grab / own riders)

Module `delivery` (plan Pro, off by default). Migration `20261119032000_delivery.sql`.

## What is built

- **Prices by channel**: a menu item's `prices` hold `base` and an optional `delivery` price (menu editor → *Prices per channel*). A delivery bill uses the `delivery` price of every item.
- **Platforms** (`/delivery`, linked from the Menu screen): LINE MAN, Grab, own riders or other, each with the commission the platform keeps (0–50 %) and an **intake token** (shown once, only its SHA-256 is stored).
- **A delivery bill** is an ordinary bill with channel *delivery*: the till opens it with *New delivery order* (sell screen), attaches the platform, the platform's own order number and the customer (*Delivery* box on the order screen; the number is unique per platform).
- **Closing**: the platform pays the shop later, so the bill closes with the tender **Platform pays** (`close_delivery_order`): full receipt in the server `+` series, no cash in the drawer, no Points, the commission is worked out (half up) and kept on the bill.
- **Report** (`/delivery`): per platform and period — bills, sales, what the platform kept, net, and (all time) what the platform has paid out and still owes; *Record money the platform paid* writes an append-only payout.
- **Intake**: `POST /api/delivery/intake` with `Authorization: Bearer <token>` creates the bill by itself (`DL001…`, unsent lines, managers told in the app and on LINE). Every line must be a real, available item of the shop (by `item_id`, `barcode` or `sku`); an unknown item refuses the whole order (Bestie never invents a price); the same platform order number again returns the first answer; 60 orders per token per minute.

```json
{
  "ref": "LM-240101-0007",
  "name": "Somchai", "phone": "0812345678", "address": "Bungalow 4, Haad Rin",
  "note": "Please call at the gate",
  "items": [
    { "barcode": "RICE-001", "quantity": 2, "note": "extra spicy" },
    { "sku": "TEA-1", "quantity": 1 }
  ]
}
```

## What is NOT built — and why

- **No call to the real LINE MAN or Grab merchant APIs.** They need a partner agreement and credentials of the shop's own; nobody on the build side has them. Whatever holds those credentials (the platform's tablet app, a partner integrator, a small script) posts the format above. When the shop has an agreement, an adapter that turns the platform's payload into this format is a small piece of work.
- Options / modifiers on an imported line (only the item and a note come across); the platform's menu sync; accepting / rejecting the order back to the platform; rider tracking.
- Returns of a bill closed with the platform tender (the refund goes through the platform).

## Accountant

How a platform bill is shown: sale at the full price (receipt in the shop's name), the platform's commission as an expense when the platform pays out (the report gives the figures). VAT on the commission is the accountant's call.
