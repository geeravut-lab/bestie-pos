# Legal drafts for the lawyer's review

Status: **DRAFT written by the build team to common international practice (owner order 2026-11-21); not legal advice.**
The lawyer reads this BEFORE go-live. Everything here is already built behind a gate (a consent tick, a module switch, a membership), so the lawyer's changes become wording or data, not a rewrite.
Reference frame: Thailand's Personal Data Protection Act B.E. 2562 (PDPA) as the primary law, with the common GDPR principles (lawfulness, purpose limitation, data minimisation, storage limitation, security, data-subject rights) because guests are international. **The lawyer must confirm the Thai-law points marked ⚖.**

## 1. What personal data the system holds

| Data | Who | Sensitive? | Where | Why |
|---|---|---|---|---|
| Name, phone, member code | member / Tourist Pass holder | no | `customers`, `network_passes` | loyalty, pass |
| Health form answers (pregnancy, blood pressure, heart, diabetes, skin, allergies, injuries, medicines) | spa guest | **yes (health data, PDPA s.26 ⚖)** | `health_intakes` | safe treatment |
| Hair photo | salon guest | biometric-adjacent: treated as sensitive | `hair_photos` | choose a style for ONE booking |
| Before / after photo | client | treated as sensitive | `client_photos` | client history |
| Booking contact (LINE id, e-mail) | online guest | no | `appointments` | one reminder |
| Colour formula / notes | client | no | `client_notes` | service quality |
| Crypto KYC (passport data, wallet) | Credit top-up payer | yes ⚖ | KYC tables (module off by default) | AML duty |

Nothing is sent to an AI provider: the hair advisor is a fixed rule in code, photos and health forms are never given to a model.

## 2. Consent wording used by the screens (Thai is the source; English / ru / he / de / zh follow it)

Principles: explicit and separate (a tick, never pre-ticked), says WHAT, WHY, FOR HOW LONG, and that it can be withdrawn at any time; refusing never blocks the booking or the sale (the health form only matters for treatments where the therapist needs it ⚖).

| Screen | Dictionary key | English text |
|---|---|---|
| Health form (guest's phone and front desk) | `hfConsent`, `crConsent` | I confirm this is correct, and I give my explicit consent for the shop to keep this health information (sensitive data) only to keep my service safe. It is kept for 24 months and then erased automatically. I may withdraw my consent or ask the shop to erase it at any time. |
| Hair photo | `hairConsent` + note `hairPhotoNote` | I agree that the shop keeps my hair photo for this booking only and that it is deleted automatically after the appointment. I may remove it at any time. No automatic system or outside party analyses it. |
| Before / after photo (front desk) | `crPhotoConsent` | The client agrees that this photo is kept in their record for 12 months. |
| Tourist Pass sign-up | `njConsent` | I agree that my name and phone number are stored for this pass and shown to shops in the network when I show my pass. They are erased if the pass is unused for 36 months, and I may ask any shop in the network to erase them or withdraw my consent at any time. |
| Booking reminder | `bkRemindNote` | Used only for this reminder, and deleted after the appointment or if you cancel. |

The controller is the SHOP (or its company). For the Tourist Pass the network members are joint controllers of the pass data ⚖ (see §5).

## 3. Retention (what the code really does)

| Data | Kept | Then | Code |
|---|---|---|---|
| Health form | 24 months from signing | erased automatically (earlier on request, by a manager with `staff.manage`) | `health_intakes_cleanup()` (migration 64), hourly tidy |
| Hair photo | until 23 h after the booking ends; at once if cancelled / no-show; the guest may remove it any time | erased | `hair_photos_cleanup()` |
| Before / after photo | 12 months | erased; a manager may erase any time | `client_photos_cleanup()` |
| Booking e-mail / LINE id | until the booking is done / cancelled or a day past | erased | `guest_contacts_cleanup()` |
| Tourist Pass (name, phone) | while used; erased after 36 months without points activity | erased; each shop's own member record stays under that shop's rules | `network_passes_cleanup()` (migration 64) |
| Client notes / colour formulas | until the client asks, or the shop erases them | erased on request | `delete_client_record` |
| Receipts, bills, payments | 5 years (Thai accounting-record practice ⚖; owner confirmed 2026-11-21) | not deleted by the app | — |
| Audit log | 5 years (owner confirmed 2026-11-21; never below 4) | purged | `audit_purge()` |
| Crypto KYC / AML records | as the AML rules require ⚖ (module off by default) | — | — |

## 4. Rights of the person

Access, correction, erasure, withdrawal of consent, objection, portability, complaint. In the system today: erasure / withdrawal = ask any shop; the manager erases a health form, a note or a photo (`delete_client_record`, `delete_client_photo`), the guest removes her own hair photo, and a pass holder asks any network shop (a manager removes the member record; the pass itself is erased by the platform administrator). **Open (⚖):** a self-service "delete my pass" button and a printable data-subject request form. A breach is notified within 72 hours of knowledge (PDPA s.37 ⚖): the platform administrator keeps the contact list.

## 5. Island network: points coalition and clearing — participation agreement outline

Parties: each business (a legal entity) that joins a network ("Member") and the operator of the platform ("Operator"). Joining is the owner's action in the app (`join_network`, audited); leaving stops new points at once and hides the listing.

1. **Nature of points.** Points are loyalty rewards earned only from THB spend; not purchasable, not transferable between people, not redeemable for cash, no monetary guarantee; each Member's own rule sets how many it gives (default 1 point per THB 25) and the redemption cap (default 50 % of a bill). A point is worth THB 1 when redeemed (default; the Member's rule).
2. **Issue and redemption.** A Member credits points to ITS OWN ledger for purchases at its shops. A pass holder may spend the total of her points at ANY Member as a bill discount at that Member's ordinary cap. The discount is the redeeming Member's bill discount (VAT base reduced as for any discount ⚖).
3. **Who bears the cost.** The redeeming Member gives the discount to its customer and is owed the discount value by the Member(s) whose points were used. The statement (`network_clearing`) allocates by **FIFO** (the oldest points are used first) per pass and period, and shows each Member only the lines it is party to.
4. **Settlement.** The system produces a statement only; it moves no money. Members settle the net amounts between themselves (suggested: monthly, by bank transfer, within 15 days of the statement, no interest; disputes about a line are raised within 15 days; the ledgers are the evidence). **⚖ Whether the settlement is a payment for goods or a service fee, its VAT / withholding treatment, and whether a clearing role by the Operator would need any licence.** Credit (prepaid value) is NOT part of the coalition and never crosses companies.
5. **Data sharing.** Members see a pass holder's name and phone number only when she shows her pass at that Member (joint-controller arrangement ⚖); they do not see her purchases at other Members, only her point balance.
6. **Expiry.** The platform has no expiry of points today (a deliberate choice; expiring points need notice ⚖).
7. **Changes and exit.** A Member may leave at any time; points already earned there stay valid for the holder at the other Members until used; the Operator may remove a Member that breaks the rules; a statement for the last period is still produced.
8. **No commission** is taken on the marketplace listing or on points.
9. **Governing law and disputes:** Thai law; courts / arbitration as the lawyer advises ⚖.

## 6. Tourist Pass terms for the guest (short form shown under the sign-up form)

The pass is free; it records your name and phone number; points follow the rules in §5 (1–2); you can stop at any time by asking any shop; keep the link private because anyone who has it sees your points. (Wording to be settled by the lawyer ⚖.)

## 7. Bestie Credit — customer terms (see also docs/PRODUCT_SPEC §2)

Owner/lawyer decision 2026-11-21: Credit used inside ONE legal entity may be used as built. Terms shown at top-up and kept with the top-up: value is THB 1 : 1; usable only at the shops of the company that sold it (named on the screen); no cash-out, no transfer, no interest; a top-up bonus (e.g. 1,000 → 1,050) is a discount, not cash value; limits THB 100–50,000 per top-up and 200,000 balance; refunds follow the shop's policy and only for unused value by the same route it came in ⚖; a closed shop refunds the unused balance ⚖. Direct crypto top-up stays behind `legalSignOff.cryptoTopup` (owner order: build and demonstrate; the lawyer reads the design before it is switched on).

## 8. Questions for the lawyer (all ⚖ above, in one list)

1. Health data and photos: is the consent text enough, are the 24-month / 12-month / 23-hour periods acceptable, do we need a DPO, a Record of Processing and a data-processing agreement with the platform (Vercel / Supabase servers are outside Thailand: cross-border transfer s.28)?
2. Joint-controller arrangement between Members for the Tourist Pass: wording and who answers a request.
3. Points: any registration or consumer-protection rule for a multi-company loyalty scheme; expiry; how the discount is shown on the abbreviated tax invoice.
4. Settlement between Members: tax nature, documents, any licence question for the Operator.
5. Credit: terms in §7, unused-balance refund on closure, whether a notification to the Bank of Thailand is needed for single-entity prepaid value.
6. Crypto top-up: AML duties and the KYC limits in docs/CRYPTO_TRANSFER_KNOWLEDGE.md before the sign-off flag is set.
