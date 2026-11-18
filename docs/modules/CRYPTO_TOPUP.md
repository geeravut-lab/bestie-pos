# โมดูล `credit.topup.crypto` — เติม Bestie Credit ด้วย stablecoin (สเปกเทคนิค)

อัปเดต 18 พ.ย. 2569 · ที่มา: `docs/CRYPTO_TRANSFER_KNOWLEDGE.md` (กฎหมาย, flow, ตัวเลขที่เจ้าของตัดสินใจ) + CLAUDE.md ข้อ 2–3
**ไม่ใช่คำแนะนำทางกฎหมาย** โมดูลนี้ **ปิดอยู่เสมอ** จนกว่าเอกสารของทนายจะอัปโหลดและ `orgs.legal_sign_off.cryptoTopup = true` (ฐานข้อมูลปฏิเสธการเปิดโมดูลถ้าไม่มี และฟังก์ชันทุกตัวตรวจซ้ำที่ฝั่ง server)

## 1. ขอบเขต (ตรงกับกฎของโปรเจกต์)

| ข้อ | ในโมดูลนี้ |
|---|---|
| crypto เป็นช่องทางจ่ายบิล | **ไม่เป็น** — ใช้ **เติม Bestie Credit** เท่านั้น |
| เหรียญ | stablecoin เท่านั้น v1 = **USDT บน Tron (TRC-20)** และ **USDT บน Ethereum (ERC-20)** (USDC/BTC/ETH ภายหลัง) |
| คืนเป็นเงินสด | **ไม่มี** ledger ของ Credit ไม่มีประเภท cash-out เลย (เครดิตที่เติมด้วย crypto จึงคืนเงินสดไม่ได้) |
| ผู้ให้บริการ "รับชำระ crypto" | **ห้ามใช้ exchange ไทย** (ประกาศ ก.ล.ต. 5/2565) ใช้ได้แค่ดึงราคาสาธารณะและอ่านข้อมูลบล็อกเชน |
| private key | **ไม่มีในระบบเลย** เก็บใน hardware wallet ของบริษัท ระบบรู้แค่ address สาธารณะ |
| ทางที่แนะนำกว่า | ลูกค้าแปลงเองผ่าน TouristDigiPay แล้วเติมด้วย PromptPay (ไม่แตะ crypto) |

## 2. Flow

```
[1] พนักงาน (payment.take) เปิดสมาชิก → "เติมด้วย crypto"  ← ต้องผ่านโมดูล+กฎหมายตรวจที่ server
[2] KYC: มี KYC ที่อนุมัติแล้วไหม? ไม่มี → กรอกพาสปอร์ต/ชื่อ/สัญชาติ/ติดต่อ (+รูปเอกสารเก็บใน Storage แบบ private)
        T1 (ผู้จัดการ/เจ้าของ อนุมัติ) · T2 ต้องเจ้าของอนุมัติ + พิสูจน์เป็นเจ้าของกระเป๋า + แจ้งที่มาเงิน
[3] เลือกเครือข่าย + ยอดบาท → server เช็ก: ยอดขั้นต่ำ (Tron 500 / Ethereum 1,000), วงเงินต่อครั้ง/วัน/30 วัน ตามระดับ,
        เพดานเครดิตคงเหลือ 100,000, address ลูกค้าไม่อยู่ใน blocklist
[4] server ดึงราคา USDT/THB จาก 2 แหล่ง → ต่างกัน > 1.5% = ไม่ออกใบ (error rates_disagree)
[5] ออก "ใบเรียกเก็บ" (crypto_requests): ล็อกเรต + หมดอายุ 15 นาที + จำนวน USDT = ยอด/เรต + ตัวเลขท้ายเฉพาะใบ (1–999 หน่วยย่อย)
[6] หน้าจอแสดง: จำนวนตัวใหญ่, ชื่อเครือข่ายตัวใหญ่ ("USDT on TRON (TRC-20)"), address (อักษร 6 ตัวแรก+6 ตัวท้ายตัวใหญ่),
        QR (Ethereum = EIP-681; Tron = address เท่านั้น), นับถอยหลัง
[7] ลูกค้าโอนจากกระเป๋า/exchange ของเขา
[8] ตัวเฝ้าบล็อกเชน (cron + ปุ่ม "ตรวจตอนนี้") อ่านธุรกรรมขาเข้าของ address เรา → บันทึก crypto_transfers
[9] จับคู่: เครือข่าย + address ผู้รับ + เหรียญ + จำนวนหน่วยย่อย (คลาดได้ ≤ 0.5% หรือ 0.10 USDT แล้วแต่ค่าไหนน้อยกว่า) ภายในเวลาใบเรียกเก็บ
[10] รอ confirmation: Tron 20 บล็อก (ตรวจที่ solidity node) · Ethereum 12 บล็อก
[11] เติมเครดิตอัตโนมัติ **เฉพาะ** ถ้า: จับคู่ตรงเป๊ะ, ในเวลา, ผู้โอนไม่อยู่ใน blocklist, ยังไม่เคยเติมด้วยธุรกรรมนี้
        → credit_ledger (topup, funding=crypto, id = id ใบเรียกเก็บ ⇒ เรียกซ้ำไม่เติมซ้ำ) + audit `credit.topup`
[12] ผิดปกติทั้งหมด → คิวตรวจ (review): จ่ายขาด, จ่ายเกิน, จ่ายหลังหมดเวลา, เหรียญ/เครือข่ายไม่ตรง,
        ผู้โอนติด blocklist, ไม่มีใบที่ตรง, ธงความเสี่ยง — ไม่เติมเอง คนที่มีสิทธิ์ credit.adjust ตัดสินใจ
```

**ฝั่งรับหยุดการโอนไม่ได้** ตรวจได้หลังเงินเข้าเท่านั้น จึงป้องกันตั้งแต่ขั้น [5]–[6] (ระบุเครือข่ายเป็นคำพูด, จำนวนเฉพาะ, address ตรวจ 6+6 ตัว)

## 3. ข้อมูล (Postgres, RLS เปิดทุกตาราง, เขียนผ่านฟังก์ชัน)

| ตาราง | คอลัมน์หลัก | หมายเหตุ |
|---|---|---|
| `crypto_wallets` | org, legal_entity, network, token, address, active, label | address รับเงินของบริษัท (watch-only) หนึ่งอันที่ active ต่อ entity+network |
| `crypto_wallet_changes` | wallet/new_address, requested_by, approvals[], status | เปลี่ยน address ต้อง **2 คนอนุมัติ** (credit.adjust ต่างคน) + audit |
| `crypto_kyc` | customer, tier (T1/T2), status, full_name, nationality, passport_no, doc_path, contact, owned_addresses[] (+วิธีพิสูจน์), source_of_funds, risk_check, approved_by/at | PII: อ่านได้เฉพาะ credit.adjust, **ห้ามลบ** (เก็บ ≥ 5 ปี) |
| `crypto_requests` | store, customer, kyc, network, token, contract, receive_address, thb_amount (สตางค์), rate (สตางค์ต่อ 1 USDT), rate_sources, amount_units (หน่วยย่อย 6 หลัก), suffix, expires_at, status, tx_hash, credited_at | สถานะ open → paid_pending → credited · expired · review · cancelled; unique (network, address, amount_units) ขณะ open/pending |
| `crypto_transfers` | network, token, tx_hash, log_index, from, to, amount_units, block, block_time, confirmations, status, request, reason | unique (network, tx_hash, log_index); ธุรกรรมหนึ่งจับคู่ใบเดียว |
| `crypto_flags` | customer/request/transfer, rule, detail, status, closed_by | ธงอัตโนมัติ (3 ครั้ง/24 ชม., เฉียดวงเงินซ้ำ, address ใช้หลายคน, >3 address/30 วัน) |
| `crypto_blocklist` | network, address, reason, source | รายการของเรา + รายชื่อคว่ำบาตรที่นำเข้า |
| `credit_ledger` (เดิม) | `funding='crypto'`, `debit_account='crypto_wallet'`, `crypto_request_id` | แค่เพิ่มค่าที่อนุญาต ไม่มี cash-out |

## 4. ระดับ KYC และวงเงิน (รอทนายยืนยัน — ค่าอยู่ในโค้ดเป็นค่าตั้งต้น เจ้าของแก้ได้)
| ระดับ | ต่อครั้ง (บาท) | ต่อวัน | ต่อ 30 วัน |
|---|---|---|---|
| T1 | 500–30,000 | 30,000 | 50,000 |
| T2 | ≤100,000 | 100,000 | 500,000 |
เกิน T2 ไม่รับ · ไม่มีการเติมแบบไม่ระบุตัวตน · ยอดขั้นต่ำ Tron 500 / Ethereum 1,000 · เครดิตคงเหลือสูงสุด 100,000 ต่อคน (ใช้เครดิตรวมเป็นตัวนับแบบเข้มกว่า)

## 5. API ที่ใช้

### ภายนอก
| ใช้ทำอะไร | ผู้ให้บริการ | หมายเหตุ |
|---|---|---|
| ธุรกรรม USDT บน Tron | **TronGrid** `GET /v1/accounts/{address}/transactions/trc20?only_to=true&contract_address=…&min_timestamp=…` (คีย์ `TRONGRID_API_KEY`) · ยืนยันด้วย solidity node `POST /walletsolidity/gettransactioninfobyid` | ถ้ามีใน solidity node = ผ่านการยืนยันครบ (~20 บล็อก) ⚠️ ตรวจรูปแบบตอบกลับกับคีย์จริงก่อนเปิด |
| ธุรกรรม USDT บน Ethereum | **Etherscan** `module=account&action=tokentx&contractaddress=…&address=…` (คีย์ `ETHERSCAN_API_KEY`) หรือ Alchemy | ฟิลด์ `confirmations` ใช้ตัดสิน (≥ 12) ⚠️ ตรวจรูปแบบตอบกลับจริง |
| ราคา USDT/THB | ticker สาธารณะของ exchange ไทย + **CoinGecko** `simple/price?ids=tether&vs_currencies=thb` | ดึงราคาเท่านั้น ห้ามใช้ API เทรด/รับชำระ ⚠️ ตรวจ URL/รูปแบบจริงตอนต่อใช้งาน |

### ภายใน (Vercel Functions)
| เส้นทาง | ผู้เรียก | หน้าที่ |
|---|---|---|
| `POST /api/crypto/request` | พนักงาน (Bearer) | ตรวจสิทธิ์/KYC/วงเงิน ดึงราคา 2 แหล่ง ออกใบเรียกเก็บ |
| `POST /api/crypto/check` | พนักงาน (Bearer, จำกัดอัตรา) | ตรวจบล็อกเชนทันทีสำหรับ wallet ของใบนี้ |
| `GET/POST /api/crypto/poll` | Vercel Cron (`CRON_SECRET`) | เฝ้าทุก wallet, อัปเดต confirmation, ทำใบหมดอายุ, ตั้งธง |

### ฐานข้อมูล (RPC)
`crypto_enabled(store)` · `crypto_request_precheck(p)` · `crypto_create_request(p)` (service) · `crypto_record_transfer(p)` (service) · `crypto_expire_requests()` (service) · `crypto_kyc_submit / crypto_kyc_decide` · `crypto_resolve_review(transfer, action, note)` · `crypto_wallet_change_request / approve` · `crypto_aml_report(org, from, to)`

## 6. ความปลอดภัย (สรุป)
- ไม่มี private key; address ที่แสดงมาจาก server ทุกครั้ง; เปลี่ยน address ต้อง 2 คน
- ตัวเลขท้ายเฉพาะใบ + ไม่สนใจ dust (โดนจับคู่ไม่ได้ = ไปคิวตรวจ) ป้องกัน address poisoning; **ห้าม** คัดลอก address จากประวัติเพื่อคืนเงิน (ระบบไม่มีการคืนเงินอยู่แล้ว)
- เติมเครดิตเมื่อธุรกรรม **final เท่านั้น** (รองรับ reorg) และ idempotent
- ข้อมูล KYC เข้าถึงเฉพาะผู้มีสิทธิ์ ทุกการอ่าน/ส่งออกบันทึก audit ส่งออกรายงาน AML (`export.report`)
- ทุกการเปลี่ยนสถานะเป็น critical audit event

## 7. สิ่งที่ยังไม่ทำ / ต้องยืนยัน
1. **ทนาย:** หน้าที่แจ้ง/ขึ้นทะเบียน, AML, ภาษีของ crypto ที่รับ, ข้อความการตลาด, ระดับ KYC/วงเงิน, ระยะเก็บข้อมูล
2. คีย์ TronGrid/Etherscan และ `CRON_SECRET` ใน Vercel; ทดสอบกับ testnet (Shasta / Sepolia) ก่อนใช้จริง **ไม่เคยรันกับเครือข่ายจริงจาก sandbox**
3. BTC (xpub/BIP84), USDC, เครือข่ายอื่น = v2
4. พิสูจน์เป็นเจ้าของกระเป๋า: v1 บันทึกผลที่พนักงานตรวจ (ข้อความเซ็น/โอนยอดเล็ก) ส่วนการตรวจ signature อัตโนมัติ = v2
5. Travel Rule (มีผล 27 ก.พ. 2570) — เก็บข้อมูลผู้ส่ง/ผู้รับให้ครบตั้งแต่ตอนนี้ (ตาราง KYC + transfer)
