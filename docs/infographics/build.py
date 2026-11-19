import base64, pathlib, html
ROOT = pathlib.Path('/home/user/bestie-pos')
FONTS = ROOT/'node_modules/.pnpm'
def b64(p): return base64.b64encode(pathlib.Path(p).read_bytes()).decode()
thai = b64(FONTS/'@fontsource-variable+noto-sans-thai@5.3.0/node_modules/@fontsource-variable/noto-sans-thai/files/noto-sans-thai-thai-wght-normal.woff2')
thai_l = b64(FONTS/'@fontsource-variable+noto-sans-thai@5.3.0/node_modules/@fontsource-variable/noto-sans-thai/files/noto-sans-thai-latin-wght-normal.woff2')
nun = b64(FONTS/'@fontsource-variable+nunito@5.3.0/node_modules/@fontsource-variable/nunito/files/nunito-latin-wght-normal.woff2')
logo = b64(ROOT/'apps/pos/public/icon-512.png')

# 24x24 stroke icons (same visual language as packages/ui/src/Icons.tsx)
IC = {
 'sell': 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 8v8M8 12h8',
 'tables': 'M3 10a9 4 0 1 0 18 0 9 4 0 0 0-18 0zM12 14v6M8 20h8',
 'order': 'M4 20h4L18 10l-4-4L4 16zM13 7l4 4',
 'kitchen': 'M5 10h14v8a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2zM3 10h18M8 6c0-2.5 4-2.5 4 0 0-2.5 4-2.5 4 0',
 'queue': 'M3 9V7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v2a2 2 0 0 0 0 4v2a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-2a2 2 0 0 0 0-4zM9 9h6M9 13h4',
 'shift': 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7v5l3 2',
 'receipt': 'M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6',
 'cash': 'M3 7h18v10H3zM12 9.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zM6 10v.01M18 14v.01',
 'qr': 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h2v2M18 14v6M14 18h2',
 'card': 'M3 6h18a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1zM2 10h20M6 15h4',
 'credit': 'M3 7h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM3 7l2-3h12M17 13.5h.01',
 'points': 'M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z',
 'split': 'M12 3v6M12 9L6 21M12 9l6 12',
 'customers': 'M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM3 20a6 6 0 0 1 12 0M17 10a2.5 2.5 0 1 0 0-5M16.5 14a5 5 0 0 1 4.5 5',
 'menu': 'M5 8h11v6a4 4 0 0 1-4 4H9a4 4 0 0 1-4-4zM16 10h2a2 2 0 0 1 0 4h-2M8 3v2M12 3v2',
 'ai': 'M11 3l1.8 5.2L18 10l-5.2 1.8L11 17l-1.8-5.2L4 10l5.2-1.8zM19 16v4M17 18h4',
 'wifi': 'M2 9a15 15 0 0 1 20 0M5 12.5a10 10 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0M12 19.5v.01',
 'sync': 'M20 7a8 8 0 0 0-14-2L4 8M4 4v4h4M4 17a8 8 0 0 0 14 2l2-3M20 20v-4h-4',
 'bell': 'M6 16v-5a6 6 0 0 1 12 0v5l2 2H4zM10 21h4',
 'chat': 'M4 5h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H10l-5 4v-4H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z',
 'chart': 'M4 20h16M7 20v-6M12 20V6M17 20v-9',
 'modules': 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
 'palette': 'M12 3a9 9 0 1 0 0 18c1.5 0 2-1 1.5-2s0-2 1.5-2h2a3 3 0 0 0 3-3C20 8 16.5 3 12 3zM8 11h.01M12 7.5h.01M16 11h.01',
 'staff': 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0',
 'shield': 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6zM9 12l2 2 4-4',
 'lock': 'M6 11h12v9H6zM8 11V8a4 4 0 0 1 8 0v3M12 15v2',
 'store': 'M4 9l1.5-5h13L20 9M4 9v11h16V9M4 9a2.7 2.7 0 0 0 5.3 0 2.7 2.7 0 0 0 5.4 0A2.7 2.7 0 0 0 20 9M10 20v-5h4v5',
 'tax': 'M6 3h12v18l-3-2-3 2-3-2-3 2zM9 9l6 6M9.5 9.5h.01M14.5 14.5h.01',
 'phone': 'M7 3h10a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM11 18h2',
 'food': 'M5 3v8a3 3 0 0 0 3 3v7M8 3v6M11 3v8a3 3 0 0 1-3 3M17 3c-2 2-3 5-3 8h3v10',
 'cal': 'M6 5h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2zM4 10h16M8 3v4M16 3v4',
 'globe': 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3 12h18M12 3c2.5 2.5 3.5 5.5 3.5 9s-1 6.5-3.5 9c-2.5-2.5-3.5-5.5-3.5-9S9.5 5.5 12 3z',
 'key': 'M8 14a4 4 0 1 1 3.9-5H21v3h-2v2h-3v-2h-4.1A4 4 0 0 1 8 14z',
 'audit': 'M6 3h9l4 4v14H6zM14 3v5h5M9 13h6M9 17h6',
 'check': 'M5 12.5l4.5 4.5L19 7.5',
}
def svg(name, size=30, color='currentColor', sw=2):
    d = ''.join(f'<path d="{p}"/>' for p in IC[name].replace('M', '|M').split('|') if p) if False else ''.join(f'<path d="M{p}"/>' for p in IC[name].split('M') if p)
    return f'<svg width="{size}" height="{size}" viewBox="0 0 24 24" fill="none" stroke="{color}" stroke-width="{sw}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">{d}</svg>'

def card(icon, title, body, tone='mint', wide=False):
    return f'<div class="card"><span class="ico {tone}">{svg(icon,30)}</span><div class="ct"><h4>{title}</h4><p>{body}</p></div></div>'
def chip(icon, text, tone='mint'):
    return f'<span class="chip"><span class="ico s {tone}">{svg(icon,18)}</span>{text}</span>'
def sec(n, title): return f'<div class="sec"><span class="num">{n}</span><h2>{title}</h2><i></i></div>'
def step(icon, title, body, tone):
    return f'<div class="step"><span class="ico l {tone}">{svg(icon,36)}</span><h4>{title}</h4><p>{body}</p></div>'

CSS = f'''
@font-face{{font-family:"BP";src:url(data:font/woff2;base64,{thai}) format("woff2");font-weight:100 900;unicode-range:U+0E01-0E5B,U+200C-200D,U+25CC}}
@font-face{{font-family:"BP";src:url(data:font/woff2;base64,{nun}) format("woff2");font-weight:200 1000;unicode-range:U+0000-00FF,U+2000-206F,U+2190-21FF,U+00D7}}
@font-face{{font-family:"BP";src:url(data:font/woff2;base64,{thai_l}) format("woff2");font-weight:100 900;unicode-range:U+0100-02AF,U+1E00-1EFF,U+20A0-20CF}}
:root{{--bg:#f3fbfb;--surface:#fff;--mint:#d5f7f0;--sky:#dff1fb;--ink:#0f2d4a;--muted:#4f6577;--primary:#00796f;--ph:#005f58;--pp:#004d47;--brand:#2bd4bf;--accent:#ff7a59;--sun:#ffcb3d;--sunl:#ffe9a8;--coral:#fde4e1;--line:#d8e8e8}}
*{{box-sizing:border-box;margin:0}}
@page{{size:1414px 2000px;margin:0}}
body{{font-family:"BP","Noto Sans Thai",sans-serif;color:var(--ink);background:#fff}}
.page{{width:1414px;height:2000px;position:relative;overflow:hidden;background:var(--bg);page-break-after:always;break-after:page}}
.page:last-child{{page-break-after:auto;break-after:auto}}
.hero{{height:600px;background:linear-gradient(120deg,var(--pp) 0%,var(--primary) 55%,var(--brand) 130%);color:#fff;position:relative;overflow:hidden}}
.hero:after{{content:"";position:absolute;left:-5%;right:-5%;bottom:-120px;height:230px;background:var(--bg);border-radius:50% 50% 0 0/100% 100% 0 0}}
.top{{height:210px;background:linear-gradient(120deg,var(--pp) 0%,var(--primary) 60%,var(--brand) 140%);color:#fff;position:relative;padding:58px 82px 0}}
.top:after{{content:"";position:absolute;left:-5%;right:-5%;bottom:-55px;height:110px;background:var(--bg);border-radius:50% 50% 0 0/100% 100% 0 0}}
.top h1{{font-size:38px;font-weight:800;line-height:1.25}}
.top p{{font-size:20px;opacity:.92;margin-top:10px}}
.brandrow{{display:flex;align-items:center;gap:20px;position:absolute;left:82px;top:60px}}
.brandrow img{{width:92px;height:92px;border-radius:24px;box-shadow:0 8px 24px rgb(0 0 0/.25)}}
.brandrow b{{font-size:40px;font-weight:800;display:block;line-height:1}}
.brandrow span{{font-size:19px;opacity:.9}}
.hero h1{{position:absolute;left:82px;top:190px;font-size:54px;line-height:1.3;font-weight:800;width:800px}}
.hero .lead{{position:absolute;left:82px;top:322px;font-size:21px;line-height:1.6;width:760px;opacity:.95}}
.pill{{position:absolute;left:82px;top:408px;background:var(--accent);color:var(--ink);font-weight:800;font-size:23px;padding:16px 30px;border-radius:999px;box-shadow:0 8px 22px rgb(0 0 0/.22);display:flex;gap:12px;align-items:center}}
.dots{{position:absolute;left:760px;top:60px;width:240px;height:240px;background-image:radial-gradient(rgb(255 255 255/.45) 3px,transparent 3.5px);background-size:40px 40px}}
.sunblob{{position:absolute;right:-70px;top:-70px;width:260px;height:260px;border-radius:50%;background:var(--sun)}}
.tablet{{position:absolute;right:68px;top:60px;width:470px;height:420px;background:var(--surface);border:12px solid var(--pp);border-radius:34px;box-shadow:0 24px 50px rgb(0 0 0/.35);transform:rotate(4deg);padding:20px;color:var(--ink)}}
.tablet .bar{{display:flex;justify-content:space-between;align-items:center;font-weight:800;font-size:18px;margin-bottom:12px}}
.tablet .bar b{{background:var(--mint);padding:4px 12px;border-radius:999px;font-size:15px;color:var(--ph)}}
.grid{{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}}
.tile{{border-radius:16px;padding:12px 8px;text-align:center;font-weight:700;font-size:14px;line-height:1.3}}
.tile small{{display:block;font-weight:600;color:var(--muted);margin-top:2px}}
.t1{{background:var(--mint)}}.t2{{background:var(--sunl)}}.t3{{background:var(--sky)}}.t4{{background:var(--coral)}}
.tablet .bill{{margin-top:12px;border-top:2px dashed var(--line);padding-top:10px;font-size:15px}}
.tablet .bill div{{display:flex;justify-content:space-between;padding:2px 0}}
.tablet .go{{margin-top:10px;background:var(--primary);color:#fff;text-align:center;font-weight:800;border-radius:14px;padding:12px;font-size:18px}}
.body{{padding:0 82px}}
.sec{{display:flex;align-items:center;gap:20px;margin:0 0 20px}}
.sec .num{{width:60px;height:60px;border-radius:50%;background:var(--primary);color:#fff;font-weight:800;font-size:28px;display:grid;place-items:center;flex:none}}
.sec h2{{font-size:32px;font-weight:800;white-space:nowrap}}
.sec i{{flex:1;height:4px;border-radius:4px;background:linear-gradient(90deg,var(--brand),transparent)}}
.cards{{display:grid;grid-template-columns:1fr 1fr;gap:16px 18px}}
.cards.c4{{grid-template-columns:repeat(4,1fr)}}
.cards.c3{{grid-template-columns:repeat(3,1fr)}}
.card{{background:var(--surface);border:1px solid var(--line);border-radius:24px;padding:16px 20px;display:flex;gap:18px;align-items:flex-start;box-shadow:0 6px 20px rgb(15 45 74/.08)}}
.card .ct h4{{font-size:23px;font-weight:800;line-height:1.3}}
.card .ct p{{font-size:16.5px;line-height:1.5;color:var(--muted);margin-top:5px}}
.cards.c4 .card,.cards.c3 .card{{flex-direction:column;align-items:center;text-align:center}}
.ico{{width:66px;height:66px;border-radius:50%;display:grid;place-items:center;flex:none;color:var(--ph)}}
.ico.s{{width:34px;height:34px}}.ico.l{{width:64px;height:64px}}
.mint{{background:var(--mint)}}.sky{{background:var(--sky);color:var(--ink)}}.sun{{background:var(--sunl);color:var(--ink)}}.coral{{background:var(--coral);color:#b3261e}}.brand{{background:var(--brand);color:var(--ink)}}
.steps{{display:grid;grid-template-columns:1fr auto 1fr auto 1fr;gap:12px;align-items:stretch}}
.step{{background:var(--surface);border:1px solid var(--line);border-radius:24px;padding:14px 18px;text-align:center;display:flex;flex-direction:column;align-items:center;box-shadow:0 6px 20px rgb(15 45 74/.08)}}
.step h4{{font-size:22px;font-weight:800;color:var(--primary);margin:6px 0 4px}}
.step p{{font-size:17px;line-height:1.5;color:var(--muted)}}
.arrow{{align-self:center;color:var(--accent);font-size:48px;font-weight:800;line-height:1}}
.chips{{display:flex;flex-wrap:wrap;gap:12px;margin-top:16px}}
.chip{{background:var(--surface);border:1px solid var(--line);border-radius:999px;padding:9px 18px 9px 10px;display:flex;gap:10px;align-items:center;font-weight:700;font-size:17px;box-shadow:0 4px 12px rgb(15 45 74/.06)}}
.note{{margin-top:16px;background:linear-gradient(120deg,var(--mint),var(--sky));border:1px solid var(--line);border-radius:26px;padding:20px 26px;display:flex;gap:20px;align-items:center}}
.note b{{font-size:21px;display:block;margin-bottom:4px}}
.note span{{font-size:17px;line-height:1.55;color:var(--muted)}}
.pay{{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}}
.pay .card{{flex-direction:row;align-items:flex-start}}
.dark{{background:linear-gradient(120deg,var(--pp),var(--primary));color:#fff;border-radius:32px;padding:24px 34px;box-shadow:0 14px 34px rgb(0 77 71/.35)}}
.dark h3{{font-size:29px;font-weight:800;margin-bottom:14px}}
.dg{{display:grid;grid-template-columns:1fr 1fr;gap:14px 30px}}
.di{{display:flex;gap:18px;align-items:flex-start}}
.di .ico{{background:rgb(255 255 255/.16);color:#fff;width:60px;height:60px}}
.di h4{{font-size:22px;font-weight:800}}
.di p{{font-size:16px;line-height:1.45;opacity:.92;margin-top:4px}}
.road{{display:grid;grid-template-columns:repeat(4,1fr);gap:14px}}
.ph{{background:var(--surface);border:1px solid var(--line);border-radius:24px;padding:16px 16px;box-shadow:0 6px 20px rgb(15 45 74/.08);position:relative;min-height:150px}}
.ph.now{{border:3px solid var(--accent);background:#fff8f6}}
.ph h4{{font-size:22px;font-weight:800;margin:10px 0 6px}}
.ph p{{font-size:16px;line-height:1.55;color:var(--muted)}}
.tag{{display:inline-block;background:var(--primary);color:#fff;font-weight:800;font-size:14px;padding:4px 12px;border-radius:999px}}
.tag.s{{background:var(--sun);color:var(--ink)}}.tag.g{{background:var(--sky);color:var(--ink)}}
.foot{{position:absolute;left:0;right:0;bottom:0;height:160px;background:linear-gradient(120deg,var(--pp),var(--primary) 60%,var(--brand) 150%);color:#fff;padding:0 82px}}
.foot:before{{content:"";position:absolute;left:-5%;right:-5%;top:-40px;height:80px;background:var(--bg);border-radius:0 0 50% 50%/0 0 100% 100%}}
.foot .in{{position:relative;display:flex;align-items:center;gap:22px;padding-top:42px}}
.foot img{{width:70px;height:70px;border-radius:24px}}
.foot h3{{font-size:30px;font-weight:800}}
.foot p{{font-size:20px;opacity:.95;margin-top:4px}}
.foot .cta{{margin-left:auto;background:var(--accent);color:var(--ink);font-weight:800;font-size:23px;padding:16px 32px;border-radius:999px;box-shadow:0 8px 22px rgb(0 0 0/.25)}}
.foot small{{position:absolute;left:82px;right:82px;bottom:12px;font-size:13.5px;opacity:.85}}
.pg{{position:absolute;right:82px;bottom:20px;font-size:17px;color:var(--muted)}}
'''

def page1():
    tiles = '''<div class="grid">
<div class="tile t1">ผัดไทยกุ้ง<small>฿180</small></div><div class="tile t2">ต้มยำกุ้ง<small>฿220</small></div><div class="tile t3">ลาเต้เย็น<small>฿85</small></div>
<div class="tile t4">ส้มตำไทย<small>฿90</small></div><div class="tile t1">ข้าวมันไก่<small>฿70</small></div><div class="tile t2">ชาเขียวปั่น<small>฿95</small></div></div>
<div class="bill"><div><span>ผัดไทยกุ้ง ×2</span><b>฿360</b></div><div><span>ลาเต้เย็น ×1</span><b>฿85</b></div><div><span>ค่าบริการ 10% + VAT</span><b>฿54</b></div></div>
<div class="go">รับเงิน ฿499</div>'''
    return f'''<section class="page">
<div class="hero"><div class="sunblob"></div><div class="dots"></div>
<div class="brandrow"><img src="data:image/png;base64,{logo}"><div><b>Bestie POS</b><span>POS เพื่อนซี้ของร้านคุณ</span></div></div>
<h1>ระบบขายหน้าร้านบนคลาวด์<br>รับเงินได้ แม้เน็ตเกาะหลุด</h1>
<p class="lead">สำหรับร้านเล็กบนเกาะพะงัน: ร้านอาหาร คาเฟ่ ซาลอน สปา รีสอร์ต ทัวร์ — เลือกโปรไฟล์ร้าน แล้วเปิด-ปิดฟีเจอร์ได้เองทีละร้าน ทีละเครื่อง ทีละบทบาท</p>
<div class="pill">{svg('cash',28,'#0f2d4a')} ทุกราคา ทุกบิล ทุกบัญชี เป็นเงินบาท (THB)</div>
<div class="tablet"><div class="bar"><span>โต๊ะ 5 · บิล A012</span><b>ออนไลน์</b></div>{tiles}</div></div>

<div class="body" style="margin-top:12px">
{sec(1,'เริ่มใช้งานใน 3 ขั้น')}
<div class="steps">{step('store','เลือกโปรไฟล์ร้าน','ร้านอาหาร หรือ คาเฟ่ (เฟส 1) ระบบเปิดฟีเจอร์ที่เหมาะให้ทันที','mint')}<div class="arrow">›</div>{step('modules','ปรับฟีเจอร์เอง','เปิด-ปิดโมดูล วิธีรับเงิน ภาษี ค่าบริการ ได้ตามร้าน','sun')}<div class="arrow">›</div>{step('sell','ขาย รับเงิน ดูรายงาน','แท็บเล็ต มือถือ จอครัว และหน้าจอลูกค้า ใช้ระบบเดียวกัน','sky')}</div>
</div>

<div class="body" style="margin-top:28px">
{sec(2,'หน้าร้าน: รับออเดอร์ได้ทุกแบบ')}
<div class="cards">
{card('tables','ผังโต๊ะ ย้ายโต๊ะ แยกบิล','เปิดบิลบนโต๊ะ ย้ายโต๊ะ รวมบิล แยกตามรายการหรือที่นั่ง จ่ายแยกพร้อมใบเสร็จของแต่ละบิล','mint')}
{card('order','รับออเดอร์เร็ว ไม่พลาด','ตัวเลือกเสริม (หวาน นม ช็อต) กำหนดขั้นต่ำ-สูงสุด โน้ต สินค้าหมด ส่งเข้าครัวหรือบาร์ในปุ่มเดียว','sun')}
{card('kitchen','จอครัว (KDS)','ตั๋วแยกตามสถานี สีเปลี่ยนเมื่อรอนาน 8 / 15 นาที กด "พร้อม" มีเสียงเตือน ใช้ได้แม้เน็ตสะดุด','sky')}
{card('queue','คิวคาเฟ่ + จอเรียกคิว','เลขคิวอัตโนมัติ A001… กระดานคิวสำหรับพนักงาน และจอเต็มสำหรับลูกค้าพร้อมเสียงเรียก','coral')}
{card('shift','กะและเงินสด','เปิด/ปิดกะ นับเงินในลิ้นชัก ระบบคำนวณยอดที่ควรมีและแสดงส่วนต่าง พร้อมบันทึกตรวจสอบ','mint')}
{card('receipt','ใบเสร็จตามกฎหมายไทย','แสดง POS ID เลขผู้เสียภาษี สาขา แยก VAT พิมพ์ 80 มม. เลือกไทยหรืออังกฤษต่อใบ พิมพ์ซ้ำได้','sun')}
</div></div>

<div class="body" style="margin-top:26px">
{sec(3,'รับเงินได้ทุกวิธี')}
<div class="pay">
{card('cash','เงินสด','มีเงินทอน ปัดเศษตามที่ร้านเลือก ใช้ได้แม้ไม่มีอินเทอร์เน็ต','mint')}
{card('qr','PromptPay QR','ยอดล็อกตามบิล บิลปิดเองทันทีที่เงินเข้า ไม่ต้องตรวจสลิป','sky')}
{card('card','บัตร (Stripe Terminal)','รูดบัตรที่เครื่องอ่าน ไม่มีข้อมูลบัตรเก็บในระบบ','sun')}
{card('credit','Bestie Credit','เงินเติมล่วงหน้าของลูกค้า ใช้ได้เฉพาะร้านในนิติบุคคลเดียวกัน','mint')}
{card('points','Bestie Points','แต้มจากการใช้จ่ายจริง ใช้เป็นส่วนลดบิล ซื้อหรือถอนเป็นเงินสดไม่ได้','coral')}
{card('customers','แยกจ่ายหลายคน','หารเท่าหรือกำหนดยอด จ่ายเงินสด + Credit ในใบเสร็จเดียว','sky')}
</div>
<div class="note">{svg('shield',44,'#005f58')}<div><b>จอแคชเชียร์ไม่ตัดสินว่า "จ่ายแล้ว"</b><span>ยอดออนไลน์ปิดบิลได้ก็ต่อเมื่อผู้ให้บริการส่ง webhook ที่ตรวจลายเซ็น ยอด สกุลเงิน และบิลตรงกันเท่านั้น ถ้าไม่ตรง ระบบพักไว้ให้ผู้จัดการตรวจ ไม่ปล่อยผ่านเงียบ ๆ</span></div></div>
</div>
<div class="pg">1 / 3</div>
</section>'''

def top(title, sub):
    return f'<div class="top"><h1>{title}</h1><p>{sub}</p></div>'

def page2():
    return f'''<section class="page">
{top('ลูกค้า ออนไลน์ และการแจ้งเตือน','สะสมแต้ม · สั่งเองผ่าน QR · ทำงานแม้เน็ตหลุด · แจ้งเตือน LINE · รายงาน')}
<div class="body" style="margin-top:68px">
{sec(4,'ลูกค้าและโปรแกรมสะสม')}
<div class="cards c3">
{card('customers','สมาชิก','ค้นหาด้วยเบอร์โทร รหัสสมาชิก หรือชื่อ เพิ่มลูกค้าที่หน้าบิลได้ทันที','mint')}
{card('points','Bestie Points','1 แต้มต่อทุก 25 บาท (ร้านปรับได้) ใช้เป็นส่วนลดสูงสุดตามเพดานที่ตั้งไว้ ไม่มีวันซื้อหรือถอนเป็นเงิน','sun')}
{card('credit','Bestie Credit','เติมด้วยเงินสด PromptPay หรือบัตร เก็บเป็นบัญชีคู่ ตรวจยอดหนี้สินแยกตามบริษัท ไม่มีการถอนเป็นเงินสด','sky')}
</div>
<div class="chips">{chip('lock','เติม Credit ด้วยคริปโต: ปิดไว้ก่อน เปิดได้เมื่อทนายลงนามเท่านั้น','coral')}{chip('check','ยอด Credit ข้ามบริษัทไม่ได้ ตรวจที่ฐานข้อมูล','mint')}</div>
</div>

<div class="body" style="margin-top:28px">
{sec(5,'ลูกค้าสแกน QR ที่โต๊ะ')}
<div class="cards">
{card('phone','เมนูไทย/อังกฤษ สั่งเองได้','ไม่ต้องสมัครหรือโหลดแอป ราคาคำนวณที่เซิร์ฟเวอร์ ไม่เชื่อราคาจากมือถือ ออเดอร์เข้าจอครัวและแคชเชียร์เอง','mint')}
{card('qr','จ่ายที่โต๊ะด้วย PromptPay','เห็นยอดบิลจริง สแกนจ่าย แล้วหน้าจอแจ้ง "จ่ายแล้ว" พร้อมเลขใบเสร็จ','sky')}
{card('food','ตัวกรองอาหาร ไม่มีหมู ไม่เผ็ด','มังสวิรัติ วีแกน ฮาลาล แพ้ถั่ว/อาหารทะเล เมนูที่ร้านยังไม่ยืนยันข้อมูลจะไม่ถูกเสนอเป็นคำตอบ แต่ให้ถามพนักงาน','sun')}
{card('ai','ผู้ช่วย AI พิมพ์เป็นคำพูด','เปิดเป็นรายร้าน AI แปลงคำพูดเป็นตัวกรองเท่านั้น ไม่เห็นเมนู ไม่เขียนราคา ปุ่มกรองใช้ได้แม้ไม่มี AI','coral')}
</div></div>

<div class="body" style="margin-top:28px">
{sec(6,'ทำงานได้แม้เน็ตหลุด และอัปเดตสดทุกเครื่อง')}
<div class="cards c4">
{card('wifi','ออฟไลน์ก่อน','รับออเดอร์ ส่งครัว รับเงินสด ต่อไปได้เมื่อไม่มีสัญญาณ','mint')}
{card('sync','ซิงก์อัตโนมัติ','คิวงานเรียงลำดับ ส่งซ้ำเมื่อกลับมาออนไลน์ ไม่ทำบิลซ้ำ','sky')}
{card('modules','อัปเดตสด','หลายเครื่องเห็นโต๊ะ ครัว คิว ตรงกัน ไม่ต้องรีเฟรช','sun')}
{card('store','ติดตั้งเป็นแอป','PWA บนแท็บเล็ตและมือถือ มีตัวบอกสถานะซิงก์มุมจอ','coral')}
</div></div>

<div class="body" style="margin-top:28px">
{sec(7,'แจ้งเตือน LINE และในแอป')}
<div class="cards">
{card('bell','แจ้งเรื่องที่สำคัญทันที','เงินเข้า · เงินเข้าแต่ต้องตรวจ (ด่วน) · ออเดอร์พร้อมเสิร์ฟ · ปิดกะเงินไม่ตรง · สรุปยอดรายวัน','mint')}
{card('chat','เลือกรับได้เอง','กระดิ่งและกล่องข้อความในแอปเสมอ ส่ง LINE เฉพาะที่เลือก มีเพดานต่อเดือนและโควตาสำรองสำหรับเรื่องด่วน','sky')}
</div></div>

<div class="body" style="margin-top:28px">
{sec(8,'รายงานที่เชื่อถือได้')}
<div class="cards">
{card('chart','ตัวเลขเดียว ใช้ทุกที่','ยอดรายวัน ตามเมนู ตามชั่วโมง ตามพนักงาน ตามวิธีชำระ นับเฉพาะบิลที่ชำระแล้ว ตามวันทำการเวลาไทย','sun')}
{card('store','หลายร้านในบัญชีเดียว','ดูทีละร้านหรือรวมทุกร้าน เลือกช่วงวันได้ ส่งออก CSV (บันทึกการส่งออกไว้ตรวจสอบ)','mint')}
</div></div>
<div class="pg">2 / 3</div>
</section>'''

def page3():
    return f'''<section class="page">
{top('เจ้าของคุมได้ทุกอย่าง ปลอดภัย ตรวจย้อนหลังได้','ปรับแต่งเอง · แบ่งสิทธิ์ · บันทึกทุกเหตุการณ์สำคัญ · พร้อมขยายหลายธุรกิจ')}
<div class="body" style="margin-top:58px">
{sec(9,'เจ้าของปรับเองได้ ไม่ต้องรอแก้โค้ด')}
<div class="cards c3">
{card('modules','เปิด-ปิดฟีเจอร์','ระดับร้าน เครื่อง และบทบาท มีคำเตือนเมื่อปิดโมดูลที่มีโมดูลอื่นพึ่งพา','mint')}
{card('cash','วิธีรับชำระต่อร้าน','เลือก PromptPay บัตร Credit Points เมนูที่ปิดจะหายจากหน้ารับเงิน และฐานข้อมูลปฏิเสธด้วย','sky')}
{card('tax','ภาษีและค่าบริการ','VAT รวม/แยก ค่าบริการ ปัดเศษ กติกาแต้ม ตัวอย่างบิลคำนวณสดก่อนบันทึก','sun')}
{card('palette','สีและแบรนด์ของร้าน','เลือก 5 สี ระบบตรวจความชัดตัวอักษร (WCAG AA) ก่อนบันทึก เปลี่ยนชื่อ โลโก้ และภาพการ์ดได้','coral')}
{card('menu','เมนูและราคา','หมวด ตัวเลือกเสริม ราคาแยกช่องทาง สถานีครัว/บาร์ ข้อมูลอาหารสำหรับผู้แพ้ เมนูตัวอย่างโหลดได้ในคลิกเดียว','mint')}
{card('staff','ทีมงานและ PIN','บทบาทเจ้าของ ผู้จัดการ แคชเชียร์ พนักงานเสิร์ฟ ครัว เชิญด้วยรหัสใช้ครั้งเดียว สลับคนด้วย PIN','sky')}
</div></div>

<div class="body" style="margin-top:28px">
{sec(10,'ปลอดภัยและตรวจสอบได้')}
<div class="cards">
{card('audit','บันทึกเหตุการณ์ (Audit trail)','35 ชนิดเหตุการณ์ 14 รายการสำคัญ (คืนเงิน ยกเลิก แก้ยอด Credit/แต้ม เปลี่ยนสิทธิ์) ปิดไม่ได้ ไม่เก็บข้อมูลส่วนตัวใน log ลบได้เฉพาะตามอายุ','mint')}
{card('key','อนุมัติด้วย PIN ผู้จัดการ','ยกเลิกรายการที่ส่งครัวแล้ว ต้องใช้ PIN ผู้จัดการ ใส่ผิด 5 ครั้งล็อก 15 นาที บันทึกว่าใครอนุมัติ','sun')}
{card('lock','ข้อมูลแยกต่อร้านและต่อบริษัท','ทุกข้อมูลผูกกับองค์กรและร้าน ป้องกันที่ฐานข้อมูล (RLS) ไม่พึ่งแค่หน้าจอ','sky')}
{card('tax','พร้อมภาษีไทย','POS ID ต่อเครื่องบนใบเสร็จ เก็บเลขผู้เสียภาษี สาขา และ VAT พร้อมต่อยอด e-Tax Invoice','coral')}
</div></div>

<div class="body" style="margin-top:28px">
<div class="dark"><h3>ทำไมไว้ใจ Bestie POS ได้</h3><div class="dg">
<div class="di"><span class="ico">{svg('cash',30)}</span><div><h4>เงินเป็นสตางค์จำนวนเต็ม</h4><p>ไม่ใช้ทศนิยม ภาษี ค่าบริการ ส่วนลด ปัดเศษ คำนวณด้วยโค้ดที่ทดสอบแล้ว ใบเสร็จตรงกับจอเสมอ</p></div></div>
<div class="di"><span class="ico">{svg('ai',30)}</span><div><h4>AI เสนอ คนและโค้ดตัดสิน</h4><p>เงิน ภาษี แต้ม สิทธิ์ คำนวณโดยโค้ด ไม่ใช่โมเดล และเมนูที่ไม่แน่ใจ ไม่ถือว่าปลอดภัย</p></div></div>
<div class="di"><span class="ico">{svg('credit',30)}</span><div><h4>Credit แยกจากแต้ม</h4><p>สองบัญชีไม่ปนกัน แต้มซื้อไม่ได้ Credit ถอนเงินสดไม่ได้ และใช้ข้ามบริษัทไม่ได้</p></div></div>
<div class="di"><span class="ico">{svg('shield',30)}</span><div><h4>ไม่ใช้คริปโตเป็นวิธีจ่ายเงิน</h4><p>ตั้งแต่ต้นระบบรับชำระเป็นเงินบาทเท่านั้น นักท่องเที่ยวแปลงเงินผ่านช่องทางที่ถูกกฎหมายแล้วจ่าย PromptPay</p></div></div>
</div></div></div>

<div class="body" style="margin-top:24px">
{sec(11,'แผนงานของระบบ')}
<div class="road">
<div class="ph now"><span class="tag">เฟส 1 · พร้อมนำร่อง</span><h4>ร้านอาหาร + คาเฟ่</h4><p>ขาย โต๊ะ ครัว คิว PromptPay บัตร Credit Points QR สั่งเอง ออฟไลน์ รายงาน</p></div>
<div class="ph"><span class="tag s">เฟส 2</span><h4>ซาลอน และสปา</h4><p>นัดหมาย ห้อง/เตียง มัดจำ คอมมิชชัน แพ็กเกจ เตือนผ่าน LINE</p></div>
<div class="ph"><span class="tag g">เฟส 3</span><h4>เครือข่ายเกาะ</h4><p>แต้มข้ามร้าน Tourist Pass หน้าจองหลายภาษา ตลาดออนไลน์ของเกาะ</p></div>
<div class="ph"><span class="tag g">เฟส 4</span><h4>รีสอร์ตและขยาย</h4><p>ผูกห้องพัก เชื่อม PMS ดีลิเวอรี คีออสก์ e-Tax Invoice หลายสาขา</p></div>
</div></div>

<div class="foot"><div class="in"><img src="data:image/png;base64,{logo}"><div><h3>เริ่มต้นกับร้านนำร่องบนเกาะพะงัน</h3><p>ทดลองใช้ที่ bestie-pos.vercel.app</p></div><div class="cta">ขอเดโมร้านของคุณ</div></div>
<small>ข้อมูล ณ 19 พ.ย. 2569 · บางฟีเจอร์ต้องตั้งค่าและทดสอบกับบริการจริงก่อนใช้ (Stripe, LINE, ผู้ให้บริการ AI) · โครงสร้าง Bestie Credit และการเก็บ audit รอทนายและนักบัญชียืนยัน · เฟส 2–4 อยู่ระหว่างวางแผน</small></div>

</section>'''

doc = f'<!doctype html><html lang="th"><meta charset="utf-8"><title>Bestie POS — ฟังก์ชันและฟีเจอร์</title><style>{CSS}</style><body>{page1()}{page2()}{page3()}</body></html>'
pathlib.Path('infographic.html').write_text(doc, encoding='utf-8')
print(len(doc)//1024, 'KB')
