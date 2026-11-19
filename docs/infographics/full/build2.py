import pathlib
import build as B
svg, sec, chip, card, CSS, logo = B.svg, B.sec, B.chip, B.card, B.CSS, B.logo
B.IC.update({
 'hair':'M6 21V9a6 6 0 0 1 12 0v12M9 21v-6M15 21v-6M9 9h6',
 'spa':'M12 21c-4-2-7-5-7-9 3 0 5 1 7 3 2-2 4-3 7-3 0 4-3 7-7 9zM12 15c-1.5-3-1.5-6 0-10 1.5 4 1.5 7 0 10z',
 'mic':'M12 3a3 3 0 0 1 3 3v5a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3zM5 11a7 7 0 0 0 14 0M12 18v3M9 21h6',
 'bed':'M3 18V7M3 14h18v4M21 14v-2a3 3 0 0 0-3-3h-7v5M7 11.5a1.5 1.5 0 1 0 0-.01',
 'bike':'M6 17a3 3 0 1 0 0-.01M18 17a3 3 0 1 0 0-.01M6 17l4-7h5l3 7M10 10l-1-3H7M14 7h3',
 'barcode':'M4 5v14M7 5v14M11 5v14M14 5v14M18 5v14M20 5v14',
 'link':'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
 'wallet':'M3 7a2 2 0 0 1 2-2h12v4M3 7v11a2 2 0 0 0 2 2h14a1 1 0 0 0 1-1V9a1 1 0 0 0-1-1H5a2 2 0 0 1-2-2zM16 14h2',
 'coin':'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM9 9h5a2 2 0 0 1 0 4H9m0 0h5a2 2 0 0 1 0 4H9M12 7v2M12 17v2',
 'truck':'M3 6h11v10H3zM14 9h4l3 3v4h-7M7 19a2 2 0 1 0 0-.01M17 19a2 2 0 1 0 0-.01',
 'plug':'M9 3v5M15 3v5M6 8h12v3a6 6 0 0 1-12 0zM12 17v4',
 'map':'M9 4L3 6v14l6-2 6 2 6-2V4l-6 2zM9 4v14M15 6v14',
 'tag':'M3 12V4h8l10 10-8 8zM7.5 8.5h.01',
 'pass':'M5 5h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2zM9 12h.01M14 10h4M14 14h3',
 'cart':'M3 4h2l2 11h11l2-8H6M9 20a1 1 0 1 0 0-.01M17 20a1 1 0 1 0 0-.01',
 'scan':'M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3M4 12h16',
 'users':'M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM3 20a6 6 0 0 1 12 0M17 10a2.5 2.5 0 1 0 0-5M16.5 14a5 5 0 0 1 4.5 5',
 'heart':'M12 20s-7-4.5-7-10a4 4 0 0 1 7-2.5A4 4 0 0 1 19 10c0 5.5-7 10-7 10z',
 'clock':'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7v5l3 2',
})
svg = B.svg
EXTRA = '''
.legend{position:relative;z-index:3;display:flex;gap:26px;font-size:15.5px;font-weight:700;color:var(--muted);align-items:center;margin-bottom:16px}
.legend span{display:flex;gap:8px;align-items:center}
.dot{width:14px;height:14px;border-radius:50%;display:inline-block;flex:none}
.d-r{background:var(--primary)}.d-t{background:var(--sun)}.d-p{background:#fff;border:3px solid var(--brand)}.d-l{background:var(--accent)}
.mods{display:grid;grid-template-columns:1fr 1fr;gap:16px 18px}
.mods.c3{grid-template-columns:repeat(3,1fr)}
.mod{background:var(--surface);border:1px solid var(--line);border-radius:24px;padding:16px 20px 14px;box-shadow:0 6px 20px rgb(15 45 74/.08)}
.mod header{display:flex;gap:14px;align-items:center;margin-bottom:8px}
.mod header .ico{width:52px;height:52px}
.mod h4{font-size:21px;font-weight:800;line-height:1.25}
.mod h4 small{display:block;font-size:14px;font-weight:700;color:var(--muted)}
.mod ul{list-style:none;padding:0;display:grid;gap:5px}
.mod li{font-size:15.5px;line-height:1.42;color:var(--ink);padding-left:22px;position:relative}
.mod li:before{content:"";position:absolute;left:0;top:7px;width:12px;height:12px;border-radius:50%}
.mod li.r:before{background:var(--primary)}.mod li.t:before{background:var(--sun)}.mod li.p:before{background:#fff;border:3px solid var(--brand)}.mod li.l:before{background:var(--accent)}
.mod li b{font-weight:800}
.strip{display:grid;grid-template-columns:repeat(4,1fr);gap:14px}
.stat{background:rgb(255 255 255/.14);border:1px solid rgb(255 255 255/.3);border-radius:22px;padding:14px 18px;color:#fff}
.stat b{font-size:40px;font-weight:800;display:block;line-height:1.1}
.stat span{font-size:16px;opacity:.95}
.flow{display:flex;gap:10px;align-items:stretch}
.fs{flex:1;background:var(--surface);border:1px solid var(--line);border-radius:20px;padding:12px 12px;text-align:center;font-size:15px;line-height:1.4;box-shadow:0 4px 14px rgb(15 45 74/.07)}
.fs b{display:block;font-size:16.5px;font-weight:800;color:var(--primary);margin-bottom:3px}
.fa{align-self:center;color:var(--accent);font-size:34px;font-weight:800}
.rules{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}
.rule{background:linear-gradient(120deg,var(--mint),var(--sky));border:1px solid var(--line);border-radius:20px;padding:12px 14px;font-size:15px;line-height:1.4;color:var(--muted)}
.rule b{display:block;color:var(--ink);font-size:16.5px;margin-bottom:2px}
.layers{display:grid;gap:8px}
.layer{display:grid;grid-template-columns:230px 1fr;gap:16px;align-items:center;border-radius:18px;padding:8px 18px;color:var(--ink)}
.layer b{font-size:19px;font-weight:800}.layer span{font-size:16px;line-height:1.4}
.l1{background:var(--mint)}.l2{background:var(--sunl)}.l3{background:var(--sky)}.l4{background:var(--coral)}
.prof{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}
.pf{background:var(--surface);border:1px solid var(--line);border-radius:22px;padding:14px 14px;text-align:center;box-shadow:0 4px 14px rgb(15 45 74/.07)}
.pf .ico{margin:0 auto 6px;width:54px;height:54px}
.pf h4{font-size:19px;font-weight:800}.pf p{font-size:14px;line-height:1.4;color:var(--muted);margin-top:3px}
.pf .tag{margin-top:6px;font-size:12.5px;padding:3px 10px}
.warn{background:#fff8f6;border:2px solid var(--accent);border-radius:22px;padding:14px 20px;font-size:16px;line-height:1.5;color:var(--ink)}
.warn b{font-weight:800}
.tiers{display:grid;grid-template-columns:repeat(3,1fr);gap:14px}
.tier{background:var(--surface);border:1px solid var(--line);border-radius:22px;padding:16px 18px;box-shadow:0 4px 14px rgb(15 45 74/.07)}
.tier h4{font-size:22px;font-weight:800;color:var(--primary)}.tier p{font-size:15.5px;line-height:1.5;color:var(--muted);margin-top:4px}
.tl{display:grid;grid-template-columns:repeat(4,1fr);gap:0;position:relative}
.tl:before{content:"";position:absolute;left:6%;right:6%;top:22px;height:6px;border-radius:6px;background:linear-gradient(90deg,var(--primary),var(--brand),var(--sun),var(--accent))}
.tn{text-align:center;position:relative;padding:0 10px}
.tn i{display:block;margin:0 auto 10px;width:48px;height:48px;border-radius:50%;background:var(--surface);border:6px solid var(--primary);position:relative}
.tn b{font-size:18px;font-weight:800;display:block}.tn span{font-size:14.5px;line-height:1.4;color:var(--muted);display:block}
.mini{position:absolute;left:82px;right:82px;bottom:22px;font-size:13px;color:var(--muted);display:flex;justify-content:space-between}
.top.p{height:230px}
.bodystrip .stat{background:var(--primary);border:0}
.mod.wide{grid-column:1/-1}.mod.wide ul{grid-template-columns:repeat(3,1fr);gap:6px 24px}
.foot.tall{height:250px}.foot.tall .in{padding-top:52px}.foot.tall small{position:absolute;left:82px;right:82px;bottom:16px;font-size:14px;line-height:1.5}
table.mx{width:100%;border-collapse:separate;border-spacing:0;background:var(--surface);border-radius:22px;overflow:hidden;border:1px solid var(--line);box-shadow:0 6px 20px rgb(15 45 74/.08)}
.mx th{background:var(--primary);color:#fff;font-size:16px;font-weight:800;padding:11px 8px;text-align:center}
.mx th:first-child{text-align:left;padding-left:20px}
.mx td{padding:6px 8px;text-align:center;font-size:17px;border-top:1px solid var(--line)}
.mx td:first-child{text-align:left;padding-left:20px;font-size:16px;font-weight:700}
.mx tr:nth-child(even) td{background:#f6fcfb}
.on{color:var(--primary);font-weight:800;font-size:26px}.av{color:var(--brand);font-weight:800;font-size:26px}.off{color:#b6c4cc;font-size:22px}
.pl{display:inline-block;font-size:12.5px;font-weight:800;padding:2px 10px;border-radius:999px;background:var(--sky);color:var(--ink)}
.pl.b{background:var(--mint)}.pl.r{background:var(--sunl)}
.top .phase{position:absolute;right:82px;top:56px;background:var(--sun);color:var(--ink);font-weight:800;font-size:20px;padding:8px 20px;border-radius:999px}
'''
CSS2 = CSS + EXTRA
LEG = '<div class="legend"><span><i class="dot d-r"></i>พร้อมใช้ (สร้างแล้ว)</span><span><i class="dot d-t"></i>สร้างแล้ว รอทดสอบกับบริการจริง</span><span><i class="dot d-p"></i>ออกแบบ/วางแผน</span><span><i class="dot d-l"></i>รอทนาย/นักบัญชียืนยัน</span></div>'
def top(title, sub, phase=None):
    ph = f'<span class="phase">{phase}</span>' if phase else ''
    return f'<div class="top p"><h1>{title}</h1><p>{sub}</p>{ph}</div>'
def ul(items): return '<ul>' + ''.join(f'<li class="{s}">{t}</li>' for s,t in items) + '</ul>'
def mod(icon, title, items, tone='mint', sub=''):
    s = f'<small>{sub}</small>' if sub else ''
    return f'<div class="mod"><header><span class="ico {tone}">{svg(icon,28)}</span><h4>{title}{s}</h4></header>{ul(items)}</div>'
def mods(*m, c3=False): return f'<div class="mods{" c3" if c3 else ""}">' + ''.join(m) + '</div>'
def foot(n, total=8): return f'<div class="mini"><span>Bestie POS · ข้อมูล ณ 19 พ.ย. 2569 · เอกสารนำเสนอภายใน</span><span>{n} / {total}</span></div>'
def flow(steps): 
    out=[]
    for i,(t,b) in enumerate(steps):
        out.append(f'<div class="fs"><b>{t}</b>{b}</div>')
        if i<len(steps)-1: out.append('<div class="fa">›</div>')
    return '<div class="flow">'+''.join(out)+'</div>'
B_ = lambda mt: f'<div class="body" style="margin-top:{mt}px">'
B1 = lambda: f'<div class="body" style="margin-top:34px">{LEG}'

# ───────────── PAGE 1: cover + vision
def p1():
    tablet = B.page1().split('<div class="tablet">')[1].split('</div></div>\n\n<div class="body"')[0]
    return f'''<section class="page">
<div class="hero" style="height:620px"><div class="sunblob"></div><div class="dots"></div>
<div class="brandrow"><img src="data:image/png;base64,{logo}"><div><b>Bestie POS</b><span>POS เพื่อนซี้ของร้านคุณ</span></div></div>
<h1 style="top:185px;font-size:52px">ระบบเดียว ครบทุกธุรกิจบนเกาะ<br>จากร้านอาหารถึงรีสอร์ต</h1>
<p class="lead" style="top:330px;font-size:21px">ระบบขายหน้าร้านบนคลาวด์สำหรับร้านอาหาร คาเฟ่ ซาลอน สปา รีสอร์ต ร้านค้า ทัวร์ และคาราโอเกะ ใช้โค้ดเบสเดียวกัน เลือกโปรไฟล์ แล้วเปิด-ปิดฟีเจอร์ได้ต่อร้าน ต่อเครื่อง ต่อบทบาท</p>
<div class="pill" style="top:440px">{svg('cash',28,'#0f2d4a')} เอกสารนำเสนอ: ฟังก์ชันและฟีเจอร์ทุกเฟส</div>
<div class="tablet" style="top:55px;height:390px;width:430px">{tablet}</div></div>

{B_(22)}
<div class="strip bodystrip">
<div class="stat"><b>8</b><span>โปรไฟล์ธุรกิจ (รวมคาราโอเกะ)</span></div><div class="stat"><b>4</b><span>เฟสการพัฒนา</span></div><div class="stat"><b>9</b><span>โมดูลเสริมสลับเปิด-ปิดได้</span></div><div class="stat"><b>THB</b><span>ทุกบิล ทุกบัญชี เงินบาท</span></div></div><div style="height:14px"></div>{LEG}
{sec('★','สิ่งที่ทำให้ต่างจากระบบอื่น')}
<div class="cards c3">
{card('modules','หลายธุรกิจในเครื่องเดียว','คาเฟ่ที่ขายเมล็ดกาแฟ สปาที่มีร้านอาหาร ไม่ต้องสลับโหมดเหมือน POS ทั่วไป','mint')}
{card('points','แต้มข้ามร้านในเครือ','สะสมที่คาเฟ่ ใช้ที่สปา หักบัญชีรายเดือนระหว่างร้าน (เฟส 3)','sun')}
{card('globe','พร้อมนักท่องเที่ยว','หน้าลูกค้าหลายภาษา PromptPay ยืนยันเงินเข้าเอง รองรับ TouristDigiPay ทำงานแม้เน็ตเกาะหลุด','sky')}
</div></div>

{B_(26)}
{sec('◆','โครงสร้าง 4 ชั้น')}
<div class="layers">
<div class="layer l1"><b>1 · หน้าจอ</b><span>POS แคชเชียร์ · แอปพนักงานรับออเดอร์ · หน้าลูกค้า QR / จอง / สมาชิก · จอครัวและคิว · แดชบอร์ดสำนักงานใหญ่</span></div>
<div class="layer l2"><b>2 · โปรไฟล์ธุรกิจ</b><span>ชุดโมดูลตั้งต้น: ร้านอาหาร · คาเฟ่ · ซาลอน · นวด/สปา · รีสอร์ต · ร้านค้า · ทัวร์/เช่า · คาราโอเกะ</span></div>
<div class="layer l3"><b>3 · โมดูลเสริม</b><span>โต๊ะและแยกบิล · ครัวและคิว · นัดหมายและทรัพยากร · คอมมิชชันและแพ็กเกจ · ห้องพักและ Folio · สต็อกและต้นทุน · ดีลิเวอรี · คีออสก์ · จองสล็อตและเช่า</span></div>
<div class="layer l4"><b>4 · แกนกลาง (เปิดเสมอ)</b><span>เมนู/แคตตาล็อก · ออเดอร์และชำระเงิน · ลูกค้าและแต้ม · พนักงานและสิทธิ์ · รายงานหลายร้าน · ภาษีไทย · ออฟไลน์และซิงก์ · โปรโมชัน · อุปกรณ์</span></div>
</div></div>

{B_(26)}
{sec('●','โปรไฟล์ธุรกิจที่รองรับ')}
<div class="prof">
<div class="pf"><span class="ico mint">{svg('food',28)}</span><h4>ร้านอาหาร</h4><p>ผังโต๊ะ แยกบิล จอครัว QR สั่งเอง</p><span class="tag">เฟส 1</span></div>
<div class="pf"><span class="ico sun">{svg('menu',28)}</span><h4>คาเฟ่</h4><p>ตะกร้า + คิว ตัวเลือกเครื่องดื่ม สะสมแสตมป์</p><span class="tag">เฟส 1</span></div>
<div class="pf"><span class="ico sky">{svg('hair',28)}</span><h4>ซาลอน/บาร์เบอร์</h4><p>ปฏิทินตามช่าง มัดจำ คอมมิชชัน</p><span class="tag s">เฟส 2</span></div>
<div class="pf"><span class="ico coral">{svg('spa',28)}</span><h4>นวด/สปา</h4><p>ห้อง/เตียง คอร์ส แพ็กเกจ แบบฟอร์มสุขภาพ</p><span class="tag s">เฟส 2</span></div>
<div class="pf"><span class="ico mint">{svg('bed',28)}</span><h4>รีสอร์ต</h4><p>หลายจุดขาย Folio PMS</p><span class="tag g">เฟส 4</span></div>
<div class="pf"><span class="ico sun">{svg('barcode',28)}</span><h4>ร้านค้า/มินิมาร์ท</h4><p>บาร์โค้ด สต็อก สั่งซื้อ คืนสินค้า</p><span class="tag g">เฟส 4</span></div>
<div class="pf"><span class="ico sky">{svg('bike',28)}</span><h4>ทัวร์/เช่า/คลาส</h4><p>จองสล็อต เช่าตามเวลา มัดจำ เก็บเอกสาร</p><span class="tag g">เฟส 3–4</span></div>
<div class="pf"><span class="ico coral">{svg('mic',28)}</span><h4>คาราโอเกะ</h4><p>ห้อง×เวลา ค้นเพลงด้วยเสียง</p><span class="tag g">ข้อเสนอ</span></div>
</div></div>
{foot(1)}
</section>'''

# ───────────── PAGE 2: phase 1
def p2():
    return f'''<section class="page">
{top('เฟส 1 · MVP: ร้านอาหาร + คาเฟ่','แกนกลางของระบบที่สร้างเสร็จแล้ว พร้อมนำร่องกับร้านบนเกาะพะงัน','เฟส 1 · สร้างแล้ว')}
{B1()}
{mods(
 mod('tables','หน้าร้านและออเดอร์',[('r','ผังโต๊ะตามโซน เปิดบิลบนโต๊ะ ย้ายโต๊ะ รวมบิล'),('r','ตัวเลือกเสริมกำหนดขั้นต่ำ–สูงสุด โน้ต จำนวน สินค้าหมด'),('r','ส่งครัว/บาร์ · ยกเลิกรายการที่ส่งแล้วต้องมีเหตุผลและสิทธิ์'),('r','แยกบิลตามรายการ/ที่นั่ง (แบ่งบางส่วนของรายการได้)'),('r','ออเดอร์เคาน์เตอร์/ซื้อกลับ เลขคิว A001…'),('r','PIN ผู้จัดการอนุมัติ ณ จุดขาย (void ฯลฯ)')],'mint','ร้านอาหาร · คาเฟ่'),
 mod('kitchen','ครัว คิว และกะ',[('r','จอครัว KDS แยกสถานีครัว/บาร์ สีเตือนเมื่อรอ 8/15 นาที'),('r','รายการพร้อมเสิร์ฟสำหรับพนักงานเสิร์ฟ'),('r','กระดานคิวคาเฟ่ + จอเรียกคิวพร้อมเสียง'),('r','เปิด/ปิดกะ นับเงินสด ส่วนต่างบันทึก audit'),('r','เงินสดทำงานออฟไลน์ ซิงก์ภายหลัง'),('p','จอครัวรับตั๋วใหม่ขณะออฟไลน์ผ่านเครือข่ายร้าน (LAN)')],'sun','ครัวและคิว'),
 mod('qr','ลูกค้าสั่งเองผ่าน QR โต๊ะ',[('r','เมนูไทย/อังกฤษ ไม่ต้องสมัครหรือโหลดแอป'),('r','ราคาและตัวเลือกคำนวณที่เซิร์ฟเวอร์ ป้องกันการแก้ราคา'),('r','ออเดอร์เข้าเป็นรายการรอยืนยัน หรือส่งครัวอัตโนมัติ'),('t','จ่ายที่โต๊ะด้วย PromptPay (ยอดคำนวณโดยเซิร์ฟเวอร์)'),('r','ตัวกรองอาหาร: ไม่มีหมู ไม่เผ็ด แพ้ถั่ว มังสวิรัติ ฮาลาล'),('r','จำกัดออเดอร์ต่อโต๊ะ กันสแปม')],'sky','กลุ่มลูกค้า'),
 mod('receipt','ใบเสร็จและภาษีไทย',[('r','ใบเสร็จย่อ: ชื่อผู้ขาย เลขผู้เสียภาษี สาขา POS ID ต่อเครื่อง'),('r','แยก VAT รวม/แยก ค่าบริการ ปัดเศษเป็นรายการของตัวเอง'),('r','เลือกไทย/อังกฤษต่อใบ พิมพ์ซ้ำจากเครื่องไหนก็ได้ พิมพ์ 80 มม.'),('t','เลขใบเสร็จสองชุดต่อเครื่อง (ออฟไลน์ / ออนไลน์) รอนักบัญชียืนยัน'),('p','ESC/POS ผ่านเครือข่าย/บลูทูธ (รอรุ่นเครื่องพิมพ์)'),('p','ใบกำกับภาษีเต็มรูปและ e-Tax Invoice (เฟส 4)')],'coral','Thai tax')
)}
</div>
{B_(20)}
{sec('◎','ระบบหลังบ้านและงานเบื้องหลัง')}
{mods(
 mod('menu','เมนูและหลังบ้าน',[('r','หมวด รายการ ตัวเลือกเสริม ราคาแยกช่องทาง สถานีครัว/บาร์ หมดชั่วคราว'),('r','ข้อมูลอาหาร: แท็กส่วนผสม ความเผ็ด ร้านตรวจแล้ว เมนูแนะนำ'),('r','โหลดเมนูตัวอย่างร้านอาหาร/คาเฟ่ในคลิกเดียว'),('p','ช่วย AI แปลเมนู และใส่รูปอาหาร')],'mint','เมนู'),
 mod('staff','ทีมงาน เครื่อง และสิทธิ์',[('r','บทบาท: เจ้าของ ผู้จัดการ แคชเชียร์ เสิร์ฟ ครัว · เชิญด้วยรหัสครั้งเดียว'),('r','ลงทะเบียนเครื่อง ผูก POS ID สลับคนด้วย PIN ล็อกเอง 5 นาที'),('r','หลายร้านในบัญชีเดียว (นิติบุคคลเดียวกัน)'),('r','เปิด-ปิดโมดูล · วิธีรับเงิน · ภาษี/ค่าบริการ/แต้ม ต่อร้าน'),('r','ธีมสี 5 สี + แบรนด์ ชื่อ โลโก้ ภาพการ์ด')],'sun','การจัดการ'),
 mod('wifi','ออฟไลน์ ซิงก์ และสด',[('r','คิวงานในเครื่อง ส่งซ้ำตามลำดับ ไม่ทำบิลซ้ำ'),('r','ตัวบอกสถานะซิงก์ · ติดตั้งเป็นแอป (PWA)'),('r','หลายเครื่องเห็นตรงกันทันที (Realtime) พร้อมสำรองด้วยการโพลล์')],'sky','Offline-first'),
 mod('chart','รายงาน แจ้งเตือน และตรวจสอบ',[('r','รายงานรายวัน/เมนู/ชั่วโมง/พนักงาน/วิธีชำระ หลายร้าน ส่งออก CSV'),('r','แจ้งเตือนในแอปและ LINE: เงินเข้า ออเดอร์พร้อม ปิดกะไม่ตรง สรุปรายวัน'),('r','Audit trail 35 เหตุการณ์ (14 รายการสำคัญปิดไม่ได้) · ลบตามอายุ'),('p','แจ้งสต็อกต่ำ (เมื่อมีโมดูลสต็อก)')],'coral','รายงานและความปลอดภัย')
)}
</div>
<div class="body" style="margin-top:20px">
{sec(3,'เส้นทางของหนึ่งบิล: ตั้งแต่สั่งจนถึงรายงาน')}
{flow([('1 · เปิดบิล','เลือกโต๊ะหรือเคาน์เตอร์ ใส่รายการ + ตัวเลือก'),('2 · ส่งครัว/บาร์','ตั๋วเข้าจอสถานี พร้อมเสียงเตือน'),('3 · ครัวกด "พร้อม"','พนักงานเสิร์ฟเห็นรายการพร้อมเสิร์ฟ'),('4 · รับเงิน','เงินสด · PromptPay · บัตร · Credit · แต้ม · แยกจ่าย'),('5 · ใบเสร็จ','POS ID VAT ค่าบริการ · ได้แต้มลูกค้า'),('6 · รายงาน','ยอดขาย แจ้งเตือน LINE สรุปรายวัน')])}
</div>
<div class="body" style="margin-top:20px">
{sec(4,'ตัวอย่างชุดตั้งค่าร้านนำร่อง (โมดูลเดียวกัน เปิดต่างกัน)')}
{mods(
 mod('menu','คาเฟ่ริมหาด',[('r','เคาน์เตอร์ + เลขคิว + จอเรียกคิว'),('r','ตัวเลือกเครื่องดื่ม หวาน/นม/ช็อต'),('r','PromptPay ปิดบิลเอง · แต้มสะสม'),],'sun','ไม่ต้องใช้ผังโต๊ะ'),
 mod('tables','ร้านอาหารเต็มรูปแบบ',[('r','ผังโต๊ะ ย้าย/รวม/แยกบิล'),('r','จอครัวแยกครัว/บาร์ · ค่าบริการ 10%'),('r','QR สั่งเองที่โต๊ะ + จ่าย PromptPay'),],'mint','ใช้ครบแกนเฟส 1'),
 mod('qr','ร้านเล็ก ขายง่าย ๆ',[('r','เปิดเฉพาะเคาน์เตอร์ เงินสด + PromptPay'),('r','ไม่ต้องมีจอครัว ไม่ต้องมี QR'),('r','รายงานรายวัน ส่งสรุปเข้า LINE · เพิ่มโมดูลทีหลังได้โดยไม่ย้ายข้อมูล')],'sky','เริ่มเล็ก ขยายทีหลัง'),
 c3=True)}
</div>
{foot(2)}
</section>'''

# ───────────── PAGE 3: payments, credit, points, crypto
def p3():
    return f'''<section class="page">
{top('การชำระเงิน · Credit · แต้ม · คริปโต','ทุกยอดเป็นเงินบาท แยกบัญชี Credit กับ Points ไม่ปนกัน คริปโตใช้เติม Credit เท่านั้น','เฟส 1 → 3')}
{B1()}
{sec(1,'วิธีรับเงินทั้งหมด (เปิด-ปิดได้ต่อร้าน)')}
{mods(
 mod('cash','ช่องทางที่ใช้ได้',[('r','<b>เงินสด</b> มีเงินทอน ปัดเศษตามกติกา ทำงานออฟไลน์'),('t','<b>PromptPay QR</b> ยอดล็อก ปิดบิลอัตโนมัติเมื่อ Stripe ยืนยัน (webhook ตรวจลายเซ็น)'),('t','<b>บัตร</b> ผ่านเครื่องอ่าน Stripe Terminal ไม่มีข้อมูลบัตรในระบบ'),('r','<b>Bestie Credit</b> และ <b>Bestie Points</b> (ส่วนลด)'),('r','<b>แยกจ่ายหลายคน</b> หารเท่า/กำหนดยอด เงินสด + Credit ใบเสร็จเดียว'),('p','PromptPay/บัตรในการแยกจ่าย · e-wallet ผ่านผู้ให้บริการที่สลับได้')],'mint','Tenders'),
 mod('shield','หลักความปลอดภัยของเงิน',[('r','จอแคชเชียร์ไม่ตัดสินว่า "จ่ายแล้ว" มีเพียง webhook ที่ตรวจลายเซ็น'),('r','ตรวจยอด สกุลเงิน เลขอ้างอิง และสถานะบิลซ้ำทุกครั้ง'),('r','ไม่ตรง = พักไว้ให้ผู้จัดการตรวจ ไม่ปล่อยเงียบ ๆ ไม่ทิ้ง'),('r','เงินเป็นสตางค์จำนวนเต็ม ไม่ใช้ทศนิยม'),('r','เปิด-ปิดวิธีรับเงินต่อร้าน ปิดแล้วเซิร์ฟเวอร์ปฏิเสธด้วย')],'sky','Trust')
)}
</div>
{B_(20)}
{sec(2,'Bestie Credit และ Bestie Points — สองบัญชีที่แยกขาด')}
{mods(
 mod('credit','Bestie Credit (เงินเติมล่วงหน้า)',[('r','เติมด้วยเงินสด · ลูกค้าถือยอด 1:1 บาท'),('t','เติมด้วย PromptPay หรือบัตร (ผ่าน webhook)'),('r','ใช้ได้เฉพาะร้านของ<b>นิติบุคคลเดียวกัน</b> บังคับที่ฐานข้อมูล'),('r','บัญชีคู่ ไม่แก้ย้อนหลัง · รายงานหนี้สินแยกบริษัท · เติมครั้งละ 100–50,000 บาท ยอดสะสมไม่เกิน 200,000'),('r','<b>ไม่มีการถอนเป็นเงินสด</b>'),('l','ทนายยืนยันโครงสร้างตาม พ.ร.บ. ระบบการชำระเงิน 2560 ก่อนเปิดจริง')],'sky','เป็นหนี้สิน (deferred revenue)'),
 mod('points','Bestie Points (แต้มสะสม)',[('r','ได้จากยอดใช้จ่ายจริง: ค่าเริ่มต้น 1 แต้ม / 25 บาท (ร้านปรับได้)'),('r','ใช้เป็นส่วนลดบิล สูงสุด 50% (ปรับได้) · ล็อกแต้มก่อนปิดบิล'),('r','ไม่ได้แต้มจากการซื้อ Credit และจากส่วนที่จ่ายด้วยแต้ม'),('r','<b>ซื้อไม่ได้ ถอนเป็นเงินสดไม่ได้ ถูกบังคับด้วยโค้ดและทดสอบ</b>'),('p','เฟส 3: แต้มข้ามร้านในเครือ + ใบแจ้งยอดหักบัญชีรายเดือน'),('l','รอนักบัญชียืนยันว่าส่วนลดแต้มลดฐาน VAT')],'sun','รางวัลสะสม')
)}
</div>
{B_(20)}
{sec(3,'เติม Credit ด้วยคริปโต (โมดูลปิดไว้ก่อน เปิดได้เมื่อทนายลงนาม)')}
{flow([('1 · ขอเติม','พนักงานระบุยอด บาท + เครือข่าย (Tron / Ethereum)'),('2 · ล็อกเรท','ราคาต่ำสุดจาก 2 แหล่ง ที่ต่างกันไม่เกิน 1.5% · 15 นาที'),('3 · ลูกค้าโอน','USDT ยอดไม่ซ้ำ + QR + ที่อยู่กระเป๋า 6+6 ตัว'),('4 · ระบบเฝ้า','อ่านบล็อกเชน จับคู่ด้วยกระเป๋าและยอด'),('5 · ยืนยันครบ','Tron 20 / Ethereum 12 block'),('6 · เพิ่ม Credit','1:1 ตามเรทที่ล็อก เพิ่มครั้งเดียวเสมอ')])}
<div style="height:14px"></div>
{mods(
 mod('coin','กติกาและขอบเขต',[('r','<b>คริปโตไม่ใช่วิธีจ่ายบิล</b> ใช้เติม Credit เท่านั้น'),('r','Stablecoin เท่านั้น: USDT บน Tron และ Ethereum (ต่อไป: USDC)'),('r','ไม่มีการคืนเป็นเงินสด Credit ไม่มีประเภท cash-out'),('r','ไม่ใช้ exchange ไทยเป็นผู้ให้บริการรับชำระ (ก.ล.ต. 5/2565) ใช้ดึงราคาสาธารณะเท่านั้น'),('r','<b>ไม่มี private key ในระบบ</b> บริษัทเก็บใน hardware wallet'),('l','เปิดได้ก็ต่อเมื่อบริษัทบันทึกความเห็นทนาย (legal sign-off) ในระบบ')],'coral','Compliance'),
 mod('lock','KYC · AML · การควบคุม',[('r','KYC สองระดับ (พาสปอร์ต): T1 ถึง 30,000/ครั้ง · T2 ถึง 100,000/ครั้ง (รอทนายยืนยันวงเงิน)'),('r','เก็บ tx hash + เครือข่าย + เรทที่ล็อก ส่งออกรายงาน AML (CSV)'),('r','คิวตรวจ: ยอดไม่ตรง/ช้า/กำกวม/ผู้ส่งต้องห้าม ไม่เครดิตอัตโนมัติ'),('r','เปลี่ยนกระเป๋าบริษัทต้องมี 2 คนอนุมัติ'),('t','ยังไม่ได้ทดสอบกับ TronGrid/Etherscan จริง (ต้อง Shasta/Sepolia ก่อน)')],'sky','ควบคุม'),
)}
<div style="height:10px"></div>
<div class="note" style="margin-top:0;padding:14px 22px">{svg('globe',40,'#005f58')}<div><b>ทางที่แนะนำกว่า: นักท่องเที่ยวใช้ TouristDigiPay แล้วเติมด้วย PromptPay</b><span>แปลงคริปโตเป็นเงินบาทผ่านผู้ให้บริการที่ได้รับอนุญาต (วงเงินตามที่ผู้ให้บริการกำหนด ณ ปัจจุบัน 100,000 บาท/ครั้ง 500,000 บาท/เดือน) ระบบไม่ต้องแตะคริปโตเลย ส่วนช่องทางโอนตรงเป็นทางเลือกที่ต้องผ่านทนายก่อนเท่านั้น</span></div></div>
</div>
{B_(20)}
{sec(4,'ที่ออกแบบไว้เพิ่มเติม (ยังเป็นแผน)')}
{mods(
 mod('tag','โปรโมชันและโบนัสเติมเงิน',[('p','โบนัสเติม Credit เช่น เติม 1,000 ได้ 1,050 บันทึกเป็นส่วนลด ไม่ใช่มูลค่าเงินสดเพิ่ม'),('p','โค้ดโปรโมชันใช้ได้ครั้งเดียว · โปรโมชันตามระดับสมาชิก')],'sun','Promotions'),
 mod('globe','แสดงราคาหลายสกุลเงิน',[('p','แสดงราคาเป็นสกุลเงินของนักท่องเที่ยว แต่ชำระและลงบัญชีเป็นบาทเสมอ'),('p','กติกาปัดเศษแยกตามวิธีชำระ · ภาษาใบเสร็จตามลูกค้า')],'sky','Multi-currency display')
)}
</div>
{foot(3)}
</section>'''

# ───────────── PAGE 4: AI
def p4():
    return f'''<section class="page">
{top('AI ผู้ช่วย: อาหาร · สินค้า · บริการ ของทุกธุรกิจในกลุ่ม','AI อ่านและอธิบาย แต่โค้ดและคนเป็นผู้ตัดสิน ราคา ภาษี แต้ม สิทธิ์ และความปลอดภัยไม่ผ่านมือโมเดล','เฟส 1 → 3')}
{B1()}
<div class="rules">
<div class="rule"><b>AI อ่าน โค้ดคำนวณ</b>เงิน ภาษี แต้ม Credit สิทธิ์ ไม่เคยให้โมเดลคำนวณ</div>
<div class="rule"><b>"ไม่รู้" ≠ "ปลอดภัย"</b>เมนู/บริการที่ร้านยังไม่ยืนยัน ไม่ถูกเสนอเป็นคำตอบ</div>
<div class="rule"><b>AI ให้ id ไม่ใช่ราคา</b>หน้าจอวาดการ์ดจากข้อมูลจริง แต่งราคาหรือรายการเองไม่ได้</div>
<div class="rule"><b>มีทางออกเสมอ</b>ปุ่มเรียกพนักงาน · AI ล่มก็สั่ง/จองได้ · ปิดได้ต่อร้าน</div>
</div>
<div style="height:14px"></div>
{flow([('ลูกค้าพิมพ์/พูด','"ไม่มีหมู ไม่เผ็ด ไม่เกิน 250" (ไทย/อังกฤษ/รัสเซีย/ฮีบรู/เยอรมัน/จีน)'),('AI → ตัวกรอง','แปลงเป็นตัวกรองในรูปแบบที่ตรวจได้ ไม่เห็นเมนูทั้งหมด'),('โค้ด/SQL กรอง','จากข้อมูลจริงของร้าน (แท็ก สต็อก คิวว่าง กฎที่ร้านเซ็น)'),('แสดงผล','การ์ดจากข้อมูลจริง + คำเตือนมาตรฐาน + ปุ่มใส่ตะกร้า/จอง')])}
</div>
{B_(20)}
{sec(1,'ผู้ช่วยลูกค้า แยกตามธุรกิจ')}
{mods(
 mod('food','ร้านอาหารและคาเฟ่ (อาหารและเครื่องดื่ม)',[('r','กรองด้วยแท็ก: หมู เนื้อ ไก่ อาหารทะเล ไข่ นม กลูเตน ถั่ว แอลกอฮอล์ · มังสวิรัติ วีแกน ฮาลาล · ระดับเผ็ด · งบ'),('r','เมนูที่ร้านยังไม่ยืนยันอยู่กลุ่ม "ถามพนักงาน" · เมนูที่มีของต้องห้ามไม่ถูกแสดงเลย (ทดสอบแบบสุ่ม)'),('t','พิมพ์เป็นคำพูดผ่านผู้ช่วย AI (เปิดต่อร้าน ต้องมีคีย์ AI)'),('p','แนะนำจากเมนูขายดีและเมนูแนะนำของร้าน ตามโอกาส ("กินกับเบียร์")'),('p','คาเฟ่: "หวานน้อย นมโอ๊ต" → เลือกตัวเลือกให้ถูก ตรวจที่ฐานข้อมูล'),('p','ตะกร้าร่างจากแชต · ตัวเลือกเสริมมีแท็กของตัวเอง')],'mint','อาหาร'),
 mod('barcode','ร้านค้า/มินิมาร์ท (สินค้า)',[('p','ถามหาสินค้า "มีครีมกันแดดไหม ไม่มีน้ำหอม" ค้นจากแคตตาล็อกและสต็อกจริง'),('p','บอกชั้นวาง ราคา ขนาด สินค้าทดแทนเมื่อหมด (ตัวเลขจากสต็อก ไม่ใช่โมเดล)'),('p','ตัวกรองแท็กสินค้า: ส่วนผสม แพ้ง่าย ขนาดพกบิน ของฝากจากเกาะ'),('p','พนักงาน: ถาม AI "สินค้านี้เหลือกี่ชิ้น ควรสั่งเพิ่มเท่าไร" จากสถิติ'),('p','ใช้รูปแบบเดียวกับผู้ช่วยอาหาร (ข้อเสนอขยาย รอยืนยัน)')],'sun','สินค้า'),
 mod('hair','ซาลอน/บาร์เบอร์ (บริการ)',[('p','ถาม 4–6 ข้อ: ลักษณะผม ไลฟ์สไตล์ โอกาส งบ ข้อจำกัด (ผมบาง แพ้สี)'),('p','แนะนำ 3 ทรงจาก<b>แคตตาล็อกผลงานของร้านเท่านั้น</b> + ช่างที่ทำได้ + เวลา/ราคาจริง + ปุ่มจอง'),('p','ส่งรูปถ่ายได้เมื่อยินยอม (ลบภายใน 24 ชม. ไม่ใช้ฝึกโมเดล)'),('p','ภายหลัง: ลองทรงบนรูปตัวเอง ติดป้าย "ภาพจำลอง"')],'sky','ทรงผม · เฟส 2'),
 mod('spa','สปา/นวด/โยคะ (บริการด้านสุขภาพ)',[('p','คัดกรองเป็นขั้น: ต้องการอะไร ระดับปวด ผ่าตัด/ตั้งครรภ์ ความดัน ยา ผิวหนัง แพ้น้ำมัน'),('p','<b>กฎข้อห้ามที่นักบำบัดเซ็นรับรองเป็นผู้ตัดสิน</b> AI มีหน้าที่ถามและอธิบายเท่านั้น'),('p','ธงแดง (ชา ร้าว อ่อนแรง เจ็บหน้าอก ไข้) หยุดแนะนำ → ปรึกษาแพทย์/เรียกพนักงาน'),('p','ใบสรุปให้นักบำบัด ผูกกับการจอง และ e-sign แบบฟอร์ม'),('l','ข้อมูลสุขภาพอ่อนไหวตาม PDPA · ต้องให้นักบำบัดและทนายเซ็นกฎก่อนเปิดใช้')],'coral','เฟส 2 → 3')
)}
</div>
{B_(16)}
{mods(
 mod('bike','ทัวร์ เช่ารถ คลาส',[('p','แนะนำกิจกรรมตามเวลา อากาศ จำนวนคน ข้อจำกัดร่างกาย'),('p','ตอบเงื่อนไขเช่า: ใบขับขี่ หมวก มัดจำ ตามนโยบายร้าน · แนะนำรุ่น'),('p','จองสล็อตจากที่ว่างจริง')],'mint','ทัวร์/เช่า · เฟส 3–4'),
 mod('bed','รีสอร์ต (Concierge)',[('p','QR ในห้อง: สั่งอาหารเข้าห้อง จองสปา/ทัวร์ ถามเวลาเช็กเอาต์ ข้อมูลเกาะที่ร้านเตรียมไว้'),('p','เชื่อมกับ Folio: ตอบ "ยอดรวมของฉัน" จากข้อมูลจริง'),('p','แปลสดระหว่างพนักงานกับแขก')],'sun','รีสอร์ต · เฟส 4'),
 mod('mic','คาราโอเกะ',[('p','พูดชื่อเพลง/ท่อนเนื้อร้อง → ค้นเพลงจริง 5–8 รายการ'),('p','AI <b>ห้ามแต่งชื่อเพลงเอง</b> · เข้าคิวห้องตามกฎร้าน'),('p','ส่งเข้าระบบคาราโอเกะ/YouTube เดิมของร้าน')],'coral','คาราโอเกะ · ข้อเสนอ'),
 mod('map','เครือข่ายทั้งเกาะ',[('p','ผู้ช่วยกลาง: "สปาว่างพรุ่งนี้บ่าย", "อาหารมังสวิรัติใกล้หาดริน"'),('p','ค้นข้ามร้านในเครือจากข้อมูลจริง จอง/สั่งได้ในที่เดียว'),('p','ผ่านเว็บและ LINE OA ใช้ได้กับหลายภาษา')],'sky','มาร์เก็ตเพลส · เฟส 3').replace('class="mod"','class="mod wide"'),
 c3=True)}
</div>
{B_(18)}
{mods(
 mod('ai','AI ฝั่งพนักงานและเจ้าของ',[('t','ร่างแท็กอาหารจากชื่อเมนู (คนกดยืนยัน ไม่ติ๊ก "ตรวจแล้ว" ให้เอง)'),('p','"ถามร้านของฉัน": ถามตัวเลขด้วยภาษาธรรมชาติ ตัวเลขมาจาก SQL'),('p','แปลเมนูและโปรโมชันหลายภาษา (ร้านตรวจก่อนบันทึก) · เขียนคำอธิบายเมนู'),('p','สรุปกะและอธิบายสาเหตุส่วนต่างเงินสด · ร่างคำตอบรีวิว/LINE'),('p','เตือนเตรียมของจากสถิติวัน/ฤดูกาล/อากาศ')],'mint','Staff AI'),
 mod('lock','สิ่งที่ไม่ใช้ AI เด็ดขาด',[('r','คำนวณเงิน ภาษี แต้ม Credit'),('r','ตัดสินความปลอดภัยด้านอาหาร/สุขภาพโดยลำพัง'),('r','อนุมัติคืนเงิน/ยกเลิกบิล · ตัดสิน KYC/AML'),('r','จอครัว (KDS) ไม่มี AI'),('r','เลือกผู้ให้บริการ/โมเดล/กฎหลักล็อกในโค้ด ผู้ดูแลเพิ่มได้เฉพาะคำแนะนำที่ผ่านด่านตรวจ 2 ชั้น')],'sky','Guardrails')
)}
</div>
{foot(4)}
</section>'''

# ───────────── PAGE 5: phases 2 and 3
def p5():
    return f'''<section class="page">
{top('เฟส 2–3 · บริการ และเครือข่ายเกาะ','ซาลอน สปา การนัดหมาย → แต้มข้ามร้าน Tourist Pass และมาร์เก็ตเพลสของเกาะ','เฟส 2 และ 3 · วางแผน')}
{B1()}
{sec(1,'เฟส 2 · บริการ: ซาลอน/บาร์เบอร์ และนวด/สปา')}
{mods(
 mod('cal','นัดหมายและจองออนไลน์',[('p','ปฏิทินตามช่าง/ห้อง/เตียง เห็นภาพรวมวันนั้นทั้งร้าน'),('p','หน้าจองออนไลน์เลือกช่างได้ ยืนยัน/ปฏิเสธตามเวลา'),('p','คิว Walk-in แยกจากนัดหมาย'),('p','จองคู่/กลุ่ม · เตือนผ่าน LINE/WhatsApp ลดการไม่มา')],'mint','Appointments'),
 mod('bed','ทรัพยากรและคอร์ส',[('p','จัดสรรห้อง/เตียง/ผู้ให้บริการ ไม่ให้ชนกัน'),('p','จับเวลาคอร์ส 60/90/120 นาที แจ้งก่อนหมดเวลา'),('p','เวลาทำความสะอาดระหว่างคิว'),('p','บริการ (นาที) + สินค้าในบิลเดียว')],'sun','Resources'),
 mod('wallet','มัดจำ แพ็กเกจ สมาชิก',[('p','มัดจำและป้องกันการไม่มา (Credit/PromptPay)'),('p','แพ็กเกจ 10 ครั้ง คอร์สรายคลาส สมาชิกรายเดือน'),('p','บัตรของขวัญ (Gift card)'),('l','ต้องให้ทนายยืนยันโครงสร้างมัดจำ/แพ็กเกจที่เป็นเงินล่วงหน้า')],'sky','Deposits · Packages'),
 mod('staff','คอมมิชชันและทิป',[('p','คอมมิชชันตามบริการ/สินค้า อัตราต่างกันต่อช่าง'),('p','ทิปต่อพนักงาน รวมในรายงานเงินเดือน'),('p','รายงานรายได้ต่อช่างและห้อง')],'coral','Commission'),
 mod('customers','ประวัติลูกค้าและแบบฟอร์ม',[('p','ประวัติลูกค้า: สูตรสี ก่อน/หลัง รูปผลงาน'),('p','แบบฟอร์มสุขภาพ (intake) พร้อมลายเซ็นอิเล็กทรอนิกส์'),('p','ข้อมูลอ่อนไหว: ขอความยินยอม เข้ารหัส จำกัดสิทธิ์')],'mint','CRM · PDPA'),
 mod('barcode','สต็อกสินค้าหน้าร้าน',[('p','สต็อกและบาร์โค้ดสินค้า (น้ำยา ครีม ผลิตภัณฑ์)'),('p','เตือนของใกล้หมด · ตรวจนับ')],'sun','Stock'),
)}
</div>
{B_(20)}
{sec(2,'เฟส 3 · เครือข่ายเกาะ: ขายร่วมกันแบบอิสระ')}
{mods(
 mod('points','แต้มข้ามร้านและการหักบัญชี',[('p','ลูกค้าคนเดียวทั้งเครือข่าย ได้แต้มที่คาเฟ่ ใช้ที่สปา'),('p','ใบแจ้งยอดรายเดือนระหว่างร้านผู้ออกและร้านผู้รับแต้ม'),('p','กฎการได้/ใช้ต่อร้าน ระดับสมาชิก (tier) และโปรโมชันตามระดับ'),('l','ผ่านเฟส 3 ได้เมื่อทนายยืนยันโครงสร้างแต้ม/การหักบัญชี'),('r','หมายเหตุ: Bestie Credit ยังใช้ได้เฉพาะนิติบุคคลเดียวกัน ไม่ข้ามบริษัท')],'sun','Coalition loyalty'),
 mod('pass','Tourist Pass',[('p','สแกน QR ครั้งเดียว ได้บัตรสมาชิกดิจิทัล ไม่ต้องโหลดแอป'),('p','เพิ่มลง Apple Wallet / Google Wallet หรือ LINE'),('p','แสดงแต้มและสิทธิ์ที่ร้านต่าง ๆ ในเครือ')],'mint','Member pass'),
 mod('globe','หน้าลูกค้าหลายภาษา',[('r','ไทยและอังกฤษ พร้อมใช้แล้ว'),('p','รัสเซีย ฮีบรู (อ่านขวา→ซ้าย) เยอรมัน จีน (ยืนยันกับร้านนำร่อง)'),('p','แปลเมนู/บริการตอนบันทึก ร้านตรวจก่อนเผยแพร่')],'sky','Multilingual'),
 mod('store','มาร์เก็ตเพลสของเกาะ (เว็บ + LINE OA)',[('p','เลือกดูร้านในเครือ จองสปา/ซาลอน/ทัวร์ สั่งอาหาร'),('p','ค่าคอมมิชชันต่ำกว่า 20% ของ Fresha อย่างมีนัยสำคัญ'),('p','พร้อมเชื่อมรีสอร์ตพาร์ตเนอร์เมื่อ PMS พร้อม'),('p','ผู้ช่วย AI กลางสำหรับค้นหาและจอง')],'coral','Island marketplace')
)}
</div>
{B_(20)}
{sec(3,'ตัวอย่างเส้นทางของนักท่องเที่ยวในเครือข่าย')}
{flow([('สแกน QR','รับ Tourist Pass บนมือถือ ไม่ต้องโหลดแอป'),('สะสมที่คาเฟ่','จ่ายด้วย PromptPay ได้แต้มตามยอดจริง'),('ถามผู้ช่วย AI','"สปาว่างพรุ่งนี้บ่ายไหม" ตอบจากข้อมูลจริง'),('จอง + มัดจำ','เลือกนักบำบัด/ห้อง จ่ายมัดจำเป็น Credit'),('ใช้แต้มที่สปา','ส่วนลดบิล ภายในเพดานที่สปากำหนด'),('หักบัญชีสิ้นเดือน','ใบแจ้งยอดระหว่างคาเฟ่และสปา')])}
</div>
{B_(20)}
<div class="note">{svg('shield',44,'#005f58')}<div><b>เกณฑ์ผ่านเฟส</b><span>ผ่านเฟส 2: ทนายยืนยันโครงสร้างแต้ม/หักบัญชี · ผ่านเฟส 3: มีรีสอร์ตพาร์ตเนอร์พร้อมเชื่อมระบบห้องพัก (PMS) · ทุกเฟสวัดผลจากร้านนำร่องที่ขายผ่านระบบทุกวัน</span></div></div>
</div>
{foot(5)}
</section>'''

# ───────────── PAGE 6: phase 4 + other profiles + karaoke
def p6():
    return f'''<section class="page">
{top('เฟส 4 · รีสอร์ต และการขยาย','Folio ห้องพัก · PMS · ดีลิเวอรี · คีออสก์ · e-Tax · ร้านค้า · ทัวร์/เช่า · คาราโอเกะ','เฟส 4 และข้อเสนอ')}
{B1()}
{sec(1,'เฟส 4 · รีสอร์ตและการขยายระบบ')}
{mods(
 mod('bed','รีสอร์ต: Folio และหลายจุดขาย',[('p','หลายจุดขายในที่เดียว: ร้านอาหาร บาร์สระ สปา ร้านค้า'),('p','<b>เรียกเก็บเข้าห้อง (Charge to room)</b> บิลรวมตอนเช็กเอาต์'),('p','Folio ในตัวแบบเบา หรือเชื่อม <b>Cloudbeds / Mews</b> (PMS)'),('p','QR สั่งอาหาร/บริการในห้อง'),('p','มัดจำคืนได้ · เช่ามอเตอร์ไซค์/ทัวร์ผ่านห้องพัก')],'mint','Resort'),
 mod('truck','ดีลิเวอรีและคีออสก์',[('p','รับออเดอร์ LINE MAN / Grab เข้าระบบ พร้อมราคาแยกช่องทาง'),('p','ราคาตามช่องทาง (หน้าร้าน ซื้อกลับ ดีลิเวอรี QR)'),('p','คีออสก์สั่งเองและจ่ายเงินที่หน้าร้าน')],'sun','Delivery · Kiosk'),
 mod('tax','ภาษีและสำนักงานใหญ่',[('p','<b>ใบกำกับภาษีเต็มรูปและ e-Tax Invoice</b> ผ่านผู้ให้บริการ'),('p','ข้อมูลพร้อมแล้ว: เลขผู้เสียภาษีลูกค้า สาขา แยก VAT'),('p','แดชบอร์ดสำนักงานใหญ่หลายสาขา/หลายธุรกิจ รวมยอด'),('p','เปรียบเทียบสาขา เป้าหมาย และการแจ้งเตือนผิดปกติ')],'sky','Scale'),
 mod('chart','สต็อกและต้นทุน',[('p','สูตรอาหาร (BOM) คำนวณต้นทุนต่อจาน กำไรขั้นต้น'),('p','รับสินค้า ใบสั่งซื้อ ตรวจนับ สต็อกขั้นต่ำเตือน'),('p','เชื่อมต้นทุนกับรายงานยอดขาย')],'coral','Stock · Recipe cost')
)}
</div>
{B_(20)}
{sec(2,'ร้านค้า · ทัวร์ · เช่า · คลาส')}
{mods(
 mod('barcode','ร้านค้า/มินิมาร์ท',[('p','สแกนบาร์โค้ด · ตัวเลือก SKU/ขนาด'),('p','รับสินค้า/ใบสั่งซื้อ · ตรวจนับ · คืนสินค้า'),('p','ราคาขายส่ง · พิมพ์ป้ายราคา'),('p','เสนอ: ผู้ช่วย AI ค้นสินค้าจากสต็อก (ดูหน้า 4)')],'mint','Retail'),
 mod('cal','ทัวร์/คลาส/กิจกรรม',[('p','จองรอบเวลาพร้อมจำกัดที่นั่ง'),('p','แพ็กเกจคลาส คอร์สหลายครั้ง'),('p','ป้ายยืนยัน/เตือนทาง LINE')],'sun','Tours · Classes'),
 mod('bike','เช่า (มอเตอร์ไซค์ อุปกรณ์)',[('p','คิดตามชั่วโมง/วัน พร้อมมัดจำที่คืนได้'),('p','สแกน/เก็บเอกสารและพาสปอร์ตอย่างปลอดภัย'),('p','สถานะอุปกรณ์ ว่าง/ถูกเช่า/ซ่อม')],'sky','Rentals')
, c3=True)}
</div>
{B_(20)}
{sec(3,'คาราโอเกะ + ค้นเพลงด้วยเสียง (ข้อเสนอ รอเจ้าของยืนยัน)')}
{mods(
 mod('mic','โปรไฟล์คาราโอเกะใน Bestie POS',[('p','ผังห้อง สถานะ ว่าง/ใช้อยู่/ใกล้หมดเวลา'),('p','ห้อง × เวลา (ชั่วโมง/แพ็กเกจ "2 ชม. + ถังเบียร์") จับเวลาที่เซิร์ฟเวอร์'),('p','บิลต่อห้อง · สั่งอาหารผ่าน QR ห้อง · แยกบิล · Credit · แต้ม'),('p','QR ห้อง: ขอเพลง เรียกพนักงาน ดูเวลาที่เหลือ')],'coral','ใช้ของเดิมให้มากที่สุด'),
 mod('plug','Bestie Song Bridge: เชื่อมระบบเดิมของร้าน',[('p','YouTube บนสมาร์ททีวี/Chromecast (Lounge) · Android TV Remote'),('p','เครื่องคาราโอเกะรหัสเพลง: อุปกรณ์พิมพ์แทนคีย์บอร์ด (USB HID)'),('p','โปรแกรมบนพีซี/ปลั๊กอิน · หรือ <b>Bestie Karaoke Player</b> เล่นผ่าน YouTube IFrame API ทางการ'),('l','โปรโตคอล Lounge ไม่เป็นทางการ และลิขสิทธิ์เปิดเพลงในที่สาธารณะเป็นหน้าที่ของร้าน ต้องให้ทนายยืนยัน')],'sky','ต้องรู้ระบบเดิมของร้านก่อน'),
 mod('store','Bestie Karaoke: ขายเป็นเว็บแอปแยก',[('p','ร้านคาราโอเกะทั่วไทยใช้ได้ แม้ไม่ใช้ Bestie POS'),('p','ค้นเพลงหลายภาษา คิวหลายห้อง แดชบอร์ดร้าน'),('p','นำร่อง 2–3 ร้านบนเกาะ · ยังไม่ได้สำรวจคู่แข่งและกำหนดราคา')],'mint','โอกาสธุรกิจใหม่')
, c3=True)}
</div>
{B_(18)}
{sec(4,'ลำดับการเปิดตัวคาราโอเกะและอุปกรณ์หน้าร้าน')}
{flow([('สำรวจร้านนำร่อง','2–3 ร้าน ใช้ระบบเดิมอะไร'),('v0 · เว็บ + AI + Player','ไม่ต้องมีอุปกรณ์เสริม'),('v1 · Song Bridge','YouTube Lounge/Cast · USB HID'),('v2 · Bestie Karaoke','เว็บแอปแยก ขายร้านทั่วไทย')])}
<div style="height:12px"></div>
{mods(
 mod('receipt','อุปกรณ์หน้าร้าน (แกนกลาง)',[('p','เครื่องพิมพ์ใบเสร็จ ครัว สติกเกอร์แก้ว'),('p','ลิ้นชักเก็บเงิน · จอที่สองสำหรับลูกค้า'),('t','เครื่องอ่านบัตร Stripe Terminal (เฟส 1)')],'mint','Devices'),
 mod('phone','ช่องทางลูกค้า',[('p','LINE OA: จอง แจ้งเตือน ส่งเมนู'),('p','WhatsApp สำหรับนักท่องเที่ยว'),('p','Web Push และอีเมลยืนยัน')],'sky','Channels')
)}
</div>
{foot(6)}
</section>'''


def p7m():
    return f'''<section class="page">
{top('แผนที่โมดูลของแต่ละธุรกิจ','เปิดมาให้ตามโปรไฟล์ ● · เลือกเปิดได้เอง ○ · ซ่อน – · เจ้าของปรับต่อร้าน ต่อเครื่อง ต่อบทบาท','Toggle matrix')}
{B1()}
<table class="mx"><thead><tr><th>โมดูล</th><th>ร้านอาหาร</th><th>คาเฟ่</th><th>ซาลอน</th><th>สปา</th><th>รีสอร์ต</th><th>ร้านค้า</th><th>แผน</th><th>สถานะ</th></tr></thead><tbody><tr><td>ผังโต๊ะ + ย้าย/รวมโต๊ะ</td><td><span class="on">●</span></td><td><span class="av">○</span></td><td><span class="off">–</span></td><td><span class="off">–</span></td><td><span class="on">●</span></td><td><span class="off">–</span></td><td><span class="pl b">Basic</span></td><td><i class="dot d-r"></i></td></tr><tr><td>แยก/รวมบิล</td><td><span class="on">●</span></td><td><span class="av">○</span></td><td><span class="av">○</span></td><td><span class="on">●</span></td><td><span class="on">●</span></td><td><span class="off">–</span></td><td><span class="pl b">Basic</span></td><td><i class="dot d-r"></i></td></tr><tr><td>เลขคิว + จอเรียกคิว</td><td><span class="av">○</span></td><td><span class="on">●</span></td><td><span class="av">○</span></td><td><span class="off">–</span></td><td><span class="off">–</span></td><td><span class="off">–</span></td><td><span class="pl b">Basic</span></td><td><i class="dot d-r"></i></td></tr><tr><td>จอครัว / พิมพ์ครัวตามสถานี</td><td><span class="on">●</span></td><td><span class="on">●</span></td><td><span class="off">–</span></td><td><span class="off">–</span></td><td><span class="on">●</span></td><td><span class="off">–</span></td><td><span class="pl ">Pro</span></td><td><i class="dot d-r"></i></td></tr><tr><td>QR สั่งและจ่าย (โต๊ะ/ห้อง/เตียง)</td><td><span class="on">●</span></td><td><span class="av">○</span></td><td><span class="off">–</span></td><td><span class="av">○</span></td><td><span class="on">●</span></td><td><span class="off">–</span></td><td><span class="pl ">Pro</span></td><td><i class="dot d-t"></i></td></tr><tr><td>นัดหมาย + จองออนไลน์</td><td><span class="av">○</span></td><td><span class="off">–</span></td><td><span class="on">●</span></td><td><span class="on">●</span></td><td><span class="av">○</span></td><td><span class="off">–</span></td><td><span class="pl ">Pro</span></td><td><i class="dot d-p"></i></td></tr><tr><td>จัดสรรห้อง/เตียง/ทรัพยากร</td><td><span class="off">–</span></td><td><span class="off">–</span></td><td><span class="av">○</span></td><td><span class="on">●</span></td><td><span class="on">●</span></td><td><span class="off">–</span></td><td><span class="pl ">Pro</span></td><td><i class="dot d-p"></i></td></tr><tr><td>มัดจำ / ชำระล่วงหน้า</td><td><span class="av">○</span></td><td><span class="off">–</span></td><td><span class="on">●</span></td><td><span class="on">●</span></td><td><span class="on">●</span></td><td><span class="off">–</span></td><td><span class="pl ">Pro</span></td><td><i class="dot d-p"></i></td></tr><tr><td>คอมมิชชัน + ทิปต่อพนักงาน</td><td><span class="av">○</span></td><td><span class="off">–</span></td><td><span class="on">●</span></td><td><span class="on">●</span></td><td><span class="av">○</span></td><td><span class="av">○</span></td><td><span class="pl ">Pro</span></td><td><i class="dot d-p"></i></td></tr><tr><td>แพ็กเกจ / คอร์ส / สมาชิก</td><td><span class="off">–</span></td><td><span class="av">○</span></td><td><span class="on">●</span></td><td><span class="on">●</span></td><td><span class="av">○</span></td><td><span class="off">–</span></td><td><span class="pl ">Pro</span></td><td><i class="dot d-p"></i></td></tr><tr><td>เรียกเก็บเข้าห้อง / Folio</td><td><span class="av">○</span></td><td><span class="av">○</span></td><td><span class="off">–</span></td><td><span class="av">○</span></td><td><span class="on">●</span></td><td><span class="av">○</span></td><td><span class="pl r">Resort</span></td><td><i class="dot d-p"></i></td></tr><tr><td>เชื่อม PMS</td><td><span class="off">–</span></td><td><span class="off">–</span></td><td><span class="off">–</span></td><td><span class="off">–</span></td><td><span class="av">○</span></td><td><span class="off">–</span></td><td><span class="pl r">Resort</span></td><td><i class="dot d-p"></i></td></tr><tr><td>สต็อก + บาร์โค้ด</td><td><span class="av">○</span></td><td><span class="av">○</span></td><td><span class="on">●</span></td><td><span class="av">○</span></td><td><span class="av">○</span></td><td><span class="on">●</span></td><td><span class="pl b">Basic</span></td><td><i class="dot d-p"></i></td></tr><tr><td>ต้นทุนสูตรอาหาร (BOM)</td><td><span class="on">●</span></td><td><span class="on">●</span></td><td><span class="off">–</span></td><td><span class="av">○</span></td><td><span class="av">○</span></td><td><span class="off">–</span></td><td><span class="pl ">Pro</span></td><td><i class="dot d-p"></i></td></tr><tr><td>ดีลิเวอรี + ราคาตามช่องทาง</td><td><span class="av">○</span></td><td><span class="av">○</span></td><td><span class="off">–</span></td><td><span class="off">–</span></td><td><span class="off">–</span></td><td><span class="av">○</span></td><td><span class="pl ">Pro</span></td><td><i class="dot d-p"></i></td></tr><tr><td>ค่าบริการ (Service charge)</td><td><span class="on">●</span></td><td><span class="off">–</span></td><td><span class="off">–</span></td><td><span class="av">○</span></td><td><span class="on">●</span></td><td><span class="off">–</span></td><td><span class="pl b">Basic</span></td><td><i class="dot d-r"></i></td></tr><tr><td>คีออสก์สั่งเอง</td><td><span class="av">○</span></td><td><span class="av">○</span></td><td><span class="off">–</span></td><td><span class="off">–</span></td><td><span class="av">○</span></td><td><span class="av">○</span></td><td><span class="pl ">Pro</span></td><td><i class="dot d-p"></i></td></tr><tr><td>แต้มเครือข่าย + CRM</td><td><span class="on">●</span></td><td><span class="on">●</span></td><td><span class="on">●</span></td><td><span class="on">●</span></td><td><span class="on">●</span></td><td><span class="on">●</span></td><td><span class="pl b">Basic</span></td><td><i class="dot d-r"></i></td></tr></tbody></table>
</div>
{B_(24)}
{sec(1,'กฎการเปิด-ปิดโมดูล')}
{mods(
 mod('modules','สามระดับ',[('r','<b>ร้าน</b> เปิด/ปิดโมดูลทั้งร้าน'),('r','<b>เครื่อง</b> เช่น แท็บเล็ตบาร์เห็นเฉพาะเมนูบาร์'),('r','<b>บทบาท</b> เช่น แคชเชียร์ไม่เปลี่ยนราคา (เป็นสิทธิ์ ไม่ใช่โมดูล)'),('r','เปิดโมดูลหนึ่ง ระบบเปิดสิ่งที่พึ่งพาให้อัตโนมัติ'),('r','ปิดโมดูล = ซ่อนหน้าจอ แต่ <b>ข้อมูลไม่ถูกลบ</b>')],'mint','Store → Device → Role'),
 mod('shield','ล็อกด้วยแผนและกฎหมาย',[('r','โมดูลสูงกว่าแผนที่ใช้ เปิดไม่ได้ (Basic ⊂ Pro ⊂ Resort)'),('r','โมดูลคริปโตเปิดไม่ได้จนกว่าจะมีความเห็นทนายในระบบ'),('r','Bestie Credit ปิดตั้งแต่ต้นทุกโปรไฟล์ จนกว่าเจ้าของเปิดเอง'),('r','ทุกจุดตรวจทั้งหน้าจอและเซิร์ฟเวอร์ (ฐานข้อมูลปฏิเสธเอง)')],'coral','ไม่พึ่งแค่การซ่อนปุ่ม')
)}
</div>
{B_(24)}
{sec(2,'ตัวอย่างการผสมหลายธุรกิจในบัญชีเดียว')}
{mods(
 mod('bed','รีสอร์ตริมหาด',[('p','โปรไฟล์รีสอร์ต + ร้านอาหาร + บาร์สระ + สปา + ร้านค้า'),('p','บิลรวมเข้าห้อง ผู้ช่วย AI concierge ในห้อง'),('p','หนึ่งนิติบุคคล Credit ใช้ข้ามทุกจุดขายได้')],'mint','หลายจุดขาย'),
 mod('menu','คาเฟ่ + เมล็ดกาแฟ',[('r','คาเฟ่ (เฟส 1) + เปิดสต็อกและบาร์โค้ดขายเมล็ดกาแฟ'),('p','ไม่ต้องสลับโหมด บิลเดียวมีทั้งแก้วและถุงเมล็ด')],'sun','ผสมโมดูล'),
 mod('spa','สปา + ร้านอาหารสุขภาพ',[('p','สปา (เฟส 2) + ร้านอาหารในที่เดียว'),('p','แต้มและ Credit ใช้ร่วมกันในนิติบุคคลเดียว'),('p','AI แนะนำเมนูสุขภาพตามโปรแกรมที่จอง')],'sky','ข้ามธุรกิจ'),
 c3=True)}
</div>
{foot(7)}
</section>'''

# ───────────── PAGE 8: trust, plans, roadmap, needs
def p7():
    return f'''<section class="page">
{top('ความน่าเชื่อถือ แผนบริการ และสิ่งที่ต้องตัดสินใจ','สำหรับเจ้าของธุรกิจและหุ้นส่วน: ระบบพร้อมแค่ไหน ต้องใช้อะไร และต้องตัดสินใจเรื่องไหน')}
{B1()}
{sec(1,'ความปลอดภัยและการตรวจสอบ')}
<div class="chips" style="margin-top:0">{chip('audit','Audit trail 35 เหตุการณ์ · 14 รายการสำคัญปิดไม่ได้','mint')}{chip('key','PIN ผิด 5 ครั้งล็อก 15 นาที · อนุมัติด้วย PIN ผู้จัดการ','sun')}{chip('lock','ข้อมูลแยกต่อองค์กร/ร้านที่ฐานข้อมูล (RLS)','sky')}{chip('tax','POS ID · VAT · PDPA · ลบ audit ตามอายุ (5 ปี)','coral')}{chip('shield','เงินเป็นสตางค์จำนวนเต็ม ไม่ใช้ทศนิยม','mint')}</div>
</div>
{B_(20)}
{sec(2,'แผนบริการ 3 ระดับ (ราคายังไม่กำหนด)')}
<div class="tiers">
<div class="tier"><h4>Basic</h4><p>แกนกลาง ผังโต๊ะและแยกบิล คิว สต็อกและบาร์โค้ด ค่าบริการ แต้มสะสมในเครือข่าย PromptPay และเงินสด</p></div>
<div class="tier"><h4>Pro</h4><p>จอครัว QR สั่งและจ่าย นัดหมายและจองออนไลน์ ทรัพยากรห้อง/เตียง มัดจำ คอมมิชชันและทิป แพ็กเกจ สูตรต้นทุน ดีลิเวอรี คีออสก์ ผู้ช่วย AI</p></div>
<div class="tier"><h4>Resort</h4><p>ทุกอย่างใน Pro + Folio เรียกเก็บเข้าห้อง เชื่อม PMS (Cloudbeds/Mews) หลายจุดขาย สำนักงานใหญ่หลายสาขา</p></div>
</div></div>
{B_(24)}
{sec(3,'แผนงานและเกณฑ์ผ่านแต่ละเฟส')}
<div class="tl">
<div class="tn"><i></i><b>เฟส 1 · MVP</b><span>ร้านอาหาร + คาเฟ่ สร้างแล้ว<br>เกณฑ์: 3–5 ร้านนำร่องขายทุกวัน</span></div>
<div class="tn"><i style="border-color:var(--brand)"></i><b>เฟส 2 · บริการ</b><span>ซาลอน สปา นัดหมาย มัดจำ คอมมิชชัน<br>เกณฑ์: ทนายยืนยันแต้ม/หักบัญชี</span></div>
<div class="tn"><i style="border-color:var(--sun)"></i><b>เฟส 3 · เครือข่าย</b><span>แต้มข้ามร้าน Tourist Pass หลายภาษา มาร์เก็ตเพลส<br>เกณฑ์: รีสอร์ตพร้อมเชื่อม PMS</span></div>
<div class="tn"><i style="border-color:var(--accent)"></i><b>เฟส 4 · ขยาย</b><span>Folio PMS ดีลิเวอรี คีออสก์ e-Tax สำนักงานใหญ่<br>และโปรไฟล์ร้านค้า/ทัวร์/คาราโอเกะ</span></div>
</div></div>
{B_(26)}
{sec(4,'สถานะวันนี้ (19 พ.ย. 2569) โดยสรุป')}
{mods(
 mod('check','สร้างเสร็จ พร้อมนำร่อง',[('r','แกนกลางเฟส 1 ทั้งชุด: ขาย โต๊ะ ครัว คิว กะ ใบเสร็จ'),('r','Credit (เงินสด) · Points · แยกจ่าย · QR สั่งเอง · ตัวกรองอาหาร'),('r','ออฟไลน์ · Realtime · Audit · สิทธิ์และ PIN · รายงาน · แจ้งเตือนในแอป'),('r','สวิตช์โมดูล · วิธีรับเงิน · ธีมสีและแบรนด์')],'mint','พร้อมใช้'),
 mod('sync','สร้างแล้ว รอทดสอบกับบริการจริง',[('t','Stripe: PromptPay · บัตร · เติม Credit · จ่ายที่โต๊ะ'),('t','แจ้งเตือน LINE และตัวตั้งเวลา'),('t','ผู้ช่วย AI (ต้องมีคีย์) และร่างแท็กอาหาร'),('t','เติม Credit ด้วยคริปโต (ปิดไว้ รอทนาย และ Shasta/Sepolia)')],'sun','รอทดสอบ'),
 mod('cal','ยังเป็นแผน/ข้อเสนอ',[('p','เฟส 2 ซาลอน/สปา · เฟส 3 เครือข่ายเกาะ · เฟส 4 รีสอร์ตและขยาย'),('p','ผู้ช่วย AI ซาลอน สปา ทัวร์ รีสอร์ต ร้านค้า คาราโอเกะ'),('p','คาราโอเกะและ Bestie Karaoke · มาร์เก็ตเพลส · e-Tax')],'sky','แผน'),
 c3=True)}
</div>
{B_(26)}
{sec(5,'สิ่งที่ต้องการจากเจ้าของ ทนาย นักบัญชี และร้านนำร่อง')}
{mods(
 mod('key','การตัดสินใจและลงมือ',[('l','<b>ทนาย:</b> Credit ร้านเดียวนิติบุคคลเดียวต้องแจ้ง/ขึ้นทะเบียน ธปท. หรือไม่ · AML และภาษีของคริปโต · ถ้อยคำการตลาด · ลิขสิทธิ์เพลงคาราโอเกะ · กฎสปา/โยคะ'),('l','<b>นักบัญชี:</b> เลขใบเสร็จสองชุดต่อเครื่อง · ส่วนลดแต้มลดฐาน VAT · ปีที่เก็บ audit'),('p','<b>เจ้าของ/หุ้นส่วน:</b> ตั้งราคาแพ็กเกจ Basic/Pro/Resort · ใครจ่ายค่า AI ฝั่งลูกค้า (คีย์กลางหรือร้านใส่เอง)'),('p','<b>ร้านนำร่อง:</b> รายชื่อ 3–5 ร้าน โปรไฟล์ ภาษาของลูกค้า')],'coral','ต้องตัดสินใจ'),
 mod('phone','เตรียมอุปกรณ์และบริการ',[('t','ทดสอบ Stripe โหมดทดสอบ: PromptPay, บัตรผ่านเครื่องอ่าน, เติม Credit, จ่ายที่โต๊ะ'),('t','ตั้ง scheduler และ LINE OA เพื่อแจ้งเตือน · ใส่คีย์ AI ก่อนเปิดผู้ช่วย'),('p','รายการอุปกรณ์: แท็บเล็ต เครื่องพิมพ์ใบเสร็จ เครื่องอ่านบัตร Stripe Terminal (ตรวจว่าส่งมาเกาะได้)'),('p','รายการตรวจร้านนำร่องครบทั้งชุดอยู่ใน PILOT-CHECKLIST')],'sky','เตรียมความพร้อม')
)}
</div>
<div class="foot tall"><div class="in"><img src="data:image/png;base64,{logo}"><div><h3>เริ่มจากร้านนำร่องบนเกาะพะงัน</h3><p>ทดลองใช้ที่ bestie-pos.vercel.app</p></div><div class="cta">นัดหมายเดโม</div></div>
<small>เอกสารนำเสนอภายใน ข้อมูล ณ 19 พ.ย. 2569 · เฟส 2–4 คาราโอเกะ ผู้ช่วย AI ฝั่งร้านค้า และมาร์เก็ตเพลสยังเป็นแผน/ข้อเสนอ · Credit คริปโต และการเก็บ audit รอทนายและนักบัญชียืนยัน · ฟีเจอร์ที่ใช้ Stripe LINE และ AI ต้องทดสอบกับบริการจริงก่อนใช้ · 8 / 8</small></div>
</section>'''

pages = [p1(), p2(), p3(), p4(), p5(), p6(), p7m(), p7()]
doc = f'<!doctype html><html lang="th"><meta charset="utf-8"><title>Bestie POS — ฟังก์ชันและฟีเจอร์ทุกเฟส</title><style>{CSS2}</style><body>{"".join(pages)}</body></html>'
pathlib.Path('infographic2.html').write_text(doc, encoding='utf-8')
print('ok', len(doc)//1024, 'KB')
