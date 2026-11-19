import re, html
src=open('/tmp/claude-0/-home-user-bestie-pos/c8ee8571-f20c-5593-b6c8-2e75d1744734/scratchpad/info/infographic2.html',encoding='utf8').read()
fonts=''.join(re.findall(r'@font-face\{[^}]*\}\n?',src)[:3])

# status codes. Bestie: b=built(●) t=built, not tried on real services(◐) p=planned(○) x=no(✕)
# competitors: y=confirmed(✓) m=partial / extra cost(~) u=not confirmed(?)  x=not offered
SYM={'b':('●','sb'),'t':('◐','st'),'p':('○','sp'),'x':('✕','sx'),'y':('✓','sy'),'m':('~','sm'),'u':('?','su')}
def cell(code,note=''):
    s,c=SYM[code]
    n=f'<i>{html.escape(note)}</i>' if note else ''
    return f'<td class="c {c}"><b>{s}</b>{n}</td>'
STOCK='t'
SECTIONS=[
('1','ตารางเปรียบเทียบของ StoreHub (ฟีเจอร์หลักและพิเศษ)',[
 ('จัดการรายการสินค้า / เมนู','b','y','y','y','y','y','y',''),
 ('จัดการยอดขาย รายงาน','b','y','y','y','y','y','y',''),
 ('จัดการสต็อกสินค้า',STOCK,'y','y','y','y','y','y','Bestie: สต็อก v1 ทำแล้ว (รับเข้า/เสีย/นับ สูตร ต้นทุน) ยังไม่มีใบสั่งซื้อ'),
 ('ขายด้วยบาร์โค้ด','p','y','x','x','y','y','y','Bestie: ยังไม่ทำ'),
 ('จัดการหลายสาขา','t','y','y','y','y','y','y','Bestie: รายงานรวมได้ · Head Office เฟส 4'),
 ('จัดการพนักงาน','b','y','y','y','y','y','y',''),
 ('สั่งอาหารด้วย QR Code','b','y','y','x','x','y','x',''),
 ('ระบบสมาชิก (CRM)','t','y','m','x','y','y','y','Wongnai: เฉพาะ iOS (ตามตาราง)'),
 ('Customer Loyalty ขั้นสูง','t','y','x','x','x','x','x','Bestie: แต้ม + Credit มีแล้ว ระดับสมาชิกยังไม่ทำ'),
 ('เชื่อมต่อ Food Delivery','p','y','y','x','x','y','x','Bestie: เฟส 4'),
 ('เชื่อม e-Commerce','x','y','x','x','x','x','y','Bestie: ไม่อยู่ในแผน'),
]),
('2','ร้านอาหาร / คาเฟ่ และการชำระเงิน (จากหน้าเว็บอื่นของผู้ขาย)',[
 ('PromptPay QR ปิดบิลอัตโนมัติเมื่อเงินเข้า','t','u','y','u','u','u','u','Bestie: รอทดสอบ Stripe จริง · Wongnai: Order & Pay'),
 ('ลูกค้าจ่ายที่โต๊ะผ่าน PromptPay','t','m','y','u','u','u','u','StoreHub: QR Order & Pay'),
 ('รับบัตรผ่านเครื่องรูดบัตรในระบบ','t','u','u','u','u','u','u',''),
 ('แยกจ่ายบิล: ตามรายการ / ที่นั่ง / หารเท่า / หลายวิธีจ่ายในบิลเดียว','b','u','u','u','u','u','u',''),
 ('จอครัว KDS แยกสถานี','b','y','m','u','y','u','u','Wongnai: ส่งเข้าครัวจากจุดเดียว · Loyverse KDS ฟรี'),
 ('พิมพ์ใบสั่งครัว/บาร์ แยกสถานี + ออเดอร์ QR','t','u','u','u','u','u','u',''),
 ('ผังโต๊ะ ย้าย/รวมโต๊ะ','b','u','u','u','u','u','u',''),
 ('เลขคิว + จอเรียกคิวสำหรับลูกค้า (คาเฟ่)','b','u','u','u','u','u','u',''),
 ('ตัวกรองอาหารแพ้/ไม่กิน บนหน้า QR','b','u','u','u','u','u','u',''),
 ('ราคาแยกตามช่องทาง (หน้าร้าน/เดลิเวอรี/QR)','t','u','y','u','u','u','u','Bestie: โครงสร้างมี ยังไม่ใช้กับ QR'),
 ('แอปผู้จัดการดูร้านจากมือถือ','t','u','y','u','u','u','u','Bestie: เว็บแอปเดียวใช้ได้ทุกเครื่อง'),
 ('Credit เติมเงินล่วงหน้า / เติมด้วย USDT (ปิดไว้ รอทนาย)','t','u','u','u','u','u','u',''),
]),
('3','ไทย กฎหมาย อุปกรณ์ และหลังบ้าน',[
 ('ใบเสร็จอย่างย่อ พร้อม POS ID กรมสรรพากรต่อเครื่อง','b','u','u','u','u','u','u',''),
 ('ใบกำกับภาษีเต็มรูป / e-Tax Invoice','p','m','u','u','u','u','u','Bestie: เฟส 4 · StoreHub กล่าวถึง e-Invoicing'),
 ('ใช้ได้เมื่อเน็ตหลุด แล้วซิงก์ทีหลัง','b','u','u','u','u','u','u','Bestie: ออกแบบ offline-first'),
 ('เครื่องพิมพ์เพิ่มเอง พิมพ์ PDF ได้ ลิ้นชักเปิดผ่านเครื่องพิมพ์','t','u','u','u','u','u','u','Bestie: ยังไม่ทดสอบกับเครื่องจริง'),
 ('บันทึกการใช้งาน (audit) ที่ลบ/แก้ไม่ได้ + ปิดกะนับเงินสด','b','u','u','u','u','u','u',''),
 ('หน้าลูกค้าสองภาษา ไทย/อังกฤษ','b','u','u','u','u','u','u','รัสเซีย/ฮิบรู/เยอรมัน/จีน ตามหลัง'),
]),
('4','AI สำหรับลูกค้า และธุรกิจหลายแบบ',[
 ('ลูกค้าพิมพ์ถาม AI เรื่องอาหารที่กิน/แพ้ไม่ได้ แล้วระบบกรองเมนูให้ (AI คืนแค่ตัวกรอง ไม่เขียนคำตอบ)','t','u','u','u','u','u','u','Bestie: ปุ่มกรองใช้ได้โดยไม่ต้องมี AI · เมนูที่ไม่ยืนยันข้อมูลจะไม่ถูกแนะนำ'),
 ('ลูกค้าถาม AI เรื่องข้อมูลร้าน (ไวไฟ เวลาเปิด เช็กเอาต์) — แสดงข้อความของร้านเอง','t','u','u','u','u','u','u','Bestie: AI ชี้ไปที่การ์ดที่ร้านเขียน ไม่แต่งคำตอบ'),
 ('แปลชื่อเมนูไทย→อังกฤษด้วย AI (เป็นร่าง ร้านตรวจก่อนบันทึก)','t','u','u','u','u','u','u',''),
 ('ลูกค้าให้คะแนนและส่งคำติชมจากหน้า QR · คะแนนต่ำแจ้งผู้จัดการทันที','b','u','u','u','u','u','u',''),
 ('เจ้าของถาม AI เรื่องยอดขายเป็นภาษาคน (ตัวเลขจากรายงาน ตรวจซ้ำ) ทั้งร้านเดียวและทุกร้านรวม','t','u','u','u','u','u','u','Bestie: ต้องเปิดโมดูล + แผน Pro'),
 ('ลูกค้าเรียกพนักงานจากหน้า QR (ปุ่มเรียก/ขอบิล) ขึ้นที่ผังโต๊ะ','b','u','u','u','u','u','u',''),
 ('ร้านทำผม สปา นวด (นัดหมาย ห้อง/เตียง คอมมิชชัน)','p','u','u','u','u','u','u','Bestie: เฟส 2 · AI แนะนำทรงผม/สปา ต้องให้ผู้เชี่ยวชาญเซ็นกฎก่อน'),
 ('รีสอร์ต (โฟลิโอ ชาร์จเข้าห้อง เชื่อม PMS)','p','u','u','u','u','u','u','Bestie: เฟส 4'),
 ('แต้มสะสมข้ามร้านหลายเจ้าของ + Tourist Pass','p','u','u','u','u','u','u','Bestie: เฟส 3 (ต้องผ่านทนาย)'),
]),
]
PRICE=[
 ('Bestie POS','ยังไม่กำหนดแพ็กเกจ (Basic / Pro / Resort) — ต้องตัดสินใจ'),
 ('StoreHub','ต้องขอใบเสนอราคา (หน้าไทยไม่แสดงราคาที่อ่านได้)'),
 ('Wongnai POS','Order & Pay โฆษณา 20 บาท/วัน · ค่าสมาชิกรายเดือนหลังช่วงทดลอง'),
 ('Loyverse','แอปหลักฟรี · แอดออน (พนักงาน/สต็อกขั้นสูง) เสียเงินรายเดือน'),
 ('Ocha · Silom POS · POSPOS','ตารางของ StoreHub ไม่มีราคา: Ocha "ค่าบริการสบายกระเป๋า", POSPOS "ราคาไม่แพง" (คำของ StoreHub) — ต้องขอใบเสนอราคา'),
]
def table(sec):
    n,title,rs=sec
    out=f'<section class="sec"><div class="shead"><span class="num">{n}</span><h2>{title}</h2><i></i></div><table><thead><tr><th class="f">ฟีเจอร์</th><th class="bp">Bestie POS</th><th>StoreHub</th><th>Wongnai<br><small>(FoodStory)</small></th><th>Ocha</th><th>Loyverse</th><th>Silom<br>POS</th><th>POSPOS</th></tr></thead><tbody>'
    for feat,a,b_,c_,d,e_,f_,g_,note in rs:
        nt=f'<div class="nt">{html.escape(note)}</div>' if note else ''
        out+=f'<tr><td class="f">{html.escape(feat)}{nt}</td>{cell(a)}{cell(b_)}{cell(c_)}{cell(d)}{cell(e_)}{cell(f_)}{cell(g_)}</tr>'
    return out+'</tbody></table></section>'
css='''
:root{--bg:#f3fbfb;--ink:#0f2d4a;--muted:#4f6577;--primary:#00796f;--pp:#004d47;--brand:#2bd4bf;--accent:#ff7a59;--sun:#ffcb3d;--mint:#d5f7f0;--line:#cfe3e3}
*{box-sizing:border-box;margin:0}
@page{size:1414px 2000px;margin:0}
body{font-family:"BP","Noto Sans Thai",sans-serif;color:var(--ink);background:#fff}
.page{width:1414px;height:2000px;position:relative;overflow:hidden;background:var(--bg);page-break-after:always}
.top{background:linear-gradient(120deg,var(--pp),var(--primary) 60%,var(--brand) 140%);color:#fff;padding:44px 64px 74px;position:relative}
.top h1{font-size:40px;font-weight:800;line-height:1.25}
.top p{font-size:19px;opacity:.93;margin-top:8px}
.top:after{content:"";position:absolute;left:-5%;right:-5%;bottom:-50px;height:100px;background:var(--bg);border-radius:50% 50% 0 0/100% 100% 0 0}
.body{padding:8px 64px 0;position:relative;z-index:2}
.legend{display:grid;grid-template-columns:1fr 1fr;gap:10px 24px;background:#fff;border:1px solid var(--line);border-radius:20px;padding:14px 20px;font-size:16px;margin-bottom:14px}
.legend b{display:inline-grid;place-items:center;width:26px;height:26px;border-radius:50%;margin-right:8px;font-size:15px}
.legend div{display:flex;align-items:center;flex-wrap:wrap;gap:4px 14px;line-height:1.5}
.sec{margin-bottom:16px}
.shead{display:flex;align-items:center;gap:14px;margin-bottom:8px}
.num{width:44px;height:44px;border-radius:50%;background:var(--primary);color:#fff;display:grid;place-items:center;font-weight:800;font-size:22px}
.shead h2{font-size:26px;font-weight:800;white-space:nowrap}
.shead i{flex:1;height:4px;border-radius:4px;background:linear-gradient(90deg,var(--brand),transparent)}
table{width:100%;border-collapse:separate;border-spacing:0;background:#fff;border:1px solid var(--line);border-radius:18px;overflow:hidden;font-size:16px}
th{background:var(--mint);font-weight:800;padding:8px 4px;font-size:15px}
th.f{text-align:left;padding-left:16px}
th.bp{background:var(--primary);color:#fff}
th small{font-weight:600;font-size:12px}
td{border-top:1px solid #e3efef;padding:4px 6px;vertical-align:middle}
td.f{padding-left:16px;width:34%;line-height:1.35;font-weight:700}
.nt{font-weight:400;font-size:13px;color:var(--muted);margin-top:2px}
td.c{text-align:center;width:9.5%}
td.c b{display:inline-grid;place-items:center;width:28px;height:28px;border-radius:50%;font-size:16px}
td.c i{display:none}
.sb b,.legend .sb{background:var(--primary);color:#fff}
.st b,.legend .st{background:#ffe9a8;color:#0f2d4a}
.sp b,.legend .sp{background:#dff1fb;color:#0f2d4a}
.sx b,.legend .sx{background:#fde4df;color:#b3261e}
.sy b,.legend .sy{background:#d5f7f0;color:#005f58}
.sm b,.legend .sm{background:#fff3c4;color:#6b4a00}
.su b,.legend .su{background:#eceff1;color:#4f6577}
td.bp0{background:#f1fbf9}
.price{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.price div{background:#fff;border:1px solid var(--line);border-radius:16px;padding:8px 14px;font-size:15px;line-height:1.4}
.price b{display:block;font-size:19px;margin-bottom:2px}
.take{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-top:6px}
.take div{border-radius:22px;padding:12px 18px;font-size:15.5px;line-height:1.45;border:1px solid var(--line)}
.take .g{background:linear-gradient(120deg,var(--mint),#dff1fb)}
.take .a{background:#fff6dc}
.take h3{font-size:22px;margin-bottom:6px}
.take li{margin-left:18px}
.foot{position:absolute;left:64px;right:64px;bottom:22px;font-size:13.5px;line-height:1.5;color:var(--muted);border-top:2px solid var(--line);padding-top:8px}
'''
legend='''<div class="legend"><div><span><b class="sb">●</b>Bestie: ทำแล้ว</span><span><b class="st">◐</b>ทำแล้ว แต่ยังไม่ได้ทดสอบกับของจริง</span><span><b class="sp">○</b>วางแผน (ตามเฟส)</span><span><b class="sx">✕</b>ไม่มี (คู่แข่ง: ไม่ปรากฏในตารางของ StoreHub) / ไม่ทำ</span></div><div><span><b class="sy">✓</b>คู่แข่ง: มี (ตามตารางของ StoreHub หรือหน้าผู้ขาย)</span><span><b class="sm">~</b>มีบางส่วน / ต้องซื้อเพิ่ม</span><span><b class="su">?</b>ไม่พบข้อมูลยืนยัน (ไม่ได้แปลว่าไม่มี)</span></div></div>'''
p1=f'''<div class="page"><div class="top"><h1>เปรียบเทียบฟังก์ชันและฟีเจอร์: Bestie POS กับ POS ชั้นนำในไทย</h1><p>ข้อมูล ณ 19 พ.ย. 2569 · ส่วนที่ 1 ตามตารางของ StoreHub เอง (ผู้ขายเป็นผู้จัดทำ อาจเข้าข้างตัวเอง) · ส่วนอื่นจากหน้าเว็บผู้ขาย · หน้า 1 / 2</p></div><div class="body">{legend}{table(SECTIONS[0])}{table(SECTIONS[1])}</div><div class="foot">หมายเหตุ: ตารางของ StoreHub (lp.storehub.com/th/pos-comparison-storehub) ครอบคลุม 6 ระบบ แต่ไม่รวมฟีเจอร์ร้านอาหารส่วนใหญ่ จึงใส่ "?" ในส่วนที่ 2–4 · "?" คือหา<b>ข้อมูลยืนยัน</b>ไม่พบในหน้าที่อ่านได้ ไม่ได้แปลว่าคู่แข่งไม่มีฟีเจอร์นั้น · ส่วน Bestie ที่เป็น ◐ ผ่านการทดสอบอัตโนมัติแล้ว แต่ยังไม่เคยรันกับ Stripe, AI, เครื่องพิมพ์ หรือผู้ใช้จริง</div></div>'''
p2=f'''<div class="page"><div class="top"><h1>เปรียบเทียบฟังก์ชันและฟีเจอร์ (ต่อ)</h1><p>ไทยและกฎหมาย · ธุรกิจหลายแบบ · ราคา · สรุปจุดแข็งและช่องว่างของ Bestie · หน้า 2 / 2</p></div><div class="body">{table(SECTIONS[2])}{table(SECTIONS[3])}
<section class="sec"><div class="shead"><span class="num">5</span><h2>ราคา (เท่าที่พบ)</h2><i></i></div><div class="price">{''.join(f'<div><b>{n}</b>{t}</div>' for n,t in PRICE)}</div></section>
<div class="take"><div class="g"><h3>จุดที่ Bestie ต่าง / ได้เปรียบ</h3><ul><li>ธุรกิจหลายแบบในระบบเดียว และเครือข่ายเกาะ (แต้มข้ามร้าน Tourist Pass) — เป็นแผน เฟส 2–3</li><li>Credit เติมเงินแยกจากแต้ม และเติมด้วยคริปโตแบบถูกกฎหมายผ่านหนังสือทนาย</li><li>ใช้เน็ตหลุดได้ (offline-first) ตั้งแต่ต้น</li><li><b>AI ฝั่งลูกค้า</b> (กรองอาหารที่แพ้/ไม่กิน ตอบข้อมูลร้าน แปลเมนู) และ AI ถามยอดขายของเจ้าของ — ออกแบบให้ AI "อธิบาย/ชี้" ไม่ "คำนวณ/แต่งคำตอบ" ในตารางของ StoreHub ไม่มีหัวข้อ AI เลย จึงใส่ ? ให้ทุกเจ้า (ไม่ได้แปลว่าไม่มี)</li><li>บันทึกการใช้งานที่ลบไม่ได้ เครื่องพิมพ์/ฟีเจอร์เป็นข้อมูลที่ร้านตั้งเอง</li></ul></div><div class="a"><h3>ช่องว่างที่ยังต้องปิด</h3><ul><li>สต็อก v2 (ใบสั่งซื้อ ผู้ขาย โอนข้ามร้าน) และร้านค้าปลีก (บาร์โค้ด) — ยังไม่ทำ</li><li>เชื่อมเดลิเวอรี LINE MAN / Grab และ e-Tax Invoice — เฟส 4</li><li>แอป/หลายสาขาเต็มรูปแบบ (Head Office) — เฟส 4</li><li>ยังไม่เคยใช้งานจริงกับร้านนำร่อง: ต้องทดสอบ Stripe, เครื่องพิมพ์, AI และให้ร้านใช้งานก่อน</li><li>ยังไม่มีแพ็กเกจและราคา</li></ul></div></div></div>
<div class="foot">แหล่งข้อมูล: wongnai.com/pos และบทความ Wongnai POS (Order &amp; Pay, LINE MAN, Manager app) · storehub.com/th/fb และ /th/pricing · loyverse.com (llms.txt) และรีวิวของบุคคลที่สาม · klikit.io, connectpos.com (บทความเปรียบเทียบ ราคาอาจล้าสมัย) · ตารางเปรียบเทียบของ StoreHub (lp.storehub.com/th/pos-comparison-storehub, ภาพ th-compare-pos) · ควรขอใบเสนอราคาและทดลองใช้จริงก่อนอ้างอิงในการนำเสนอ</div></div>'''
open('cmp.html','w',encoding='utf8').write(f'<!doctype html><html lang="th"><meta charset="utf-8"><title>Bestie POS vs POS ไทย</title><style>{fonts}{css}</style><body>{p1}{p2}</body></html>')
