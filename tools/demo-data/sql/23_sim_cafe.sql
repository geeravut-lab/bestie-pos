-- Breeze Café: 13 paid counter bills (queue numbers), the barista screen bumps drinks, one retail sale scanned by barcode.
do $$
declare
  c text := 'cashier.cafe.demo@bestiedemo.example'; k text := 'kds.cafe.demo@bestiedemo.example';
  n text := 'Breeze Café'; t text := 'Café counter';
begin
  if exists (select 1 from public.receipts where store_id = demo.store(n)) then raise notice 'café already simulated'; return; end if;
  perform demo.sell(c, n, t, 'takeaway', null, '[{"n":"ลาเต้","q":1,"o":["นมโอ๊ต","หวานน้อย"]},{"n":"ครัวซองต์เนยสด","q":1}]', null, 0, c, t, '[{"t":"cash"}]', k);
  perform demo.sell(c, n, t, 'takeaway', null, '[{"n":"อเมริกาโน่","q":2}]', null, 0, c, t, '[{"t":"cash"}]', k);
  perform demo.sell(c, n, t, 'takeaway', null, '[{"n":"ชาเขียวมัทฉะ","q":1,"o":["นมวัว","หวานปกติ"]},{"n":"บราวนี่","q":1}]', null, 0, c, t, '[{"t":"cash"}]', k);
  perform demo.sell(c, n, t, 'takeaway', null, '[{"n":"คาปูชิโน่","q":2,"o":["นมวัว","หวานน้อย"]},{"n":"แซนด์วิชแฮมชีส","q":1}]', null, 0, c, t, '[{"t":"cash"}]', k);
  -- a member pays with Bestie Credit
  perform demo.sell(c, n, t, 'takeaway', null, '[{"n":"ลาเต้","q":2,"o":["นมอัลมอนด์","หวานปกติ","เอสเปรสโซเพิ่ม 1 ช็อต"]},{"n":"บราวนี่","q":2}]', '66800000104', 0, c, t, '[{"t":"credit"}]', k);
  -- retail: roasted beans found by barcode at the till
  perform demo.sell(c, n, t, 'takeaway', null, '[{"n":"เมล็ดกาแฟคั่ว 250 ก.","q":2}]', null, 0, c, t, '[{"t":"cash"}]', null);
  perform demo.sell(c, n, t, 'takeaway', null, '[{"n":"ชาไทยเย็น","q":3,"o":["หวานปกติ"]}]', '66800000104', 0, c, t, '[{"t":"credit"}]', k);
  perform demo.sell(c, n, t, 'takeaway', null, '[{"n":"เอสเปรสโซ","q":4}]', null, 0, c, t, '[{"t":"cash"}]', k);
  -- Points as a discount
  perform demo.sell(c, n, t, 'takeaway', null, '[{"n":"ลาเต้","q":1,"o":["นมวัว","หวานปกติ"]},{"n":"ครัวซองต์เนยสด","q":2}]', '66800000104', 20, c, t, '[{"t":"cash"}]', k);
  perform demo.sell(c, n, t, 'takeaway', null, '[{"n":"ชาไทยเย็น","q":1,"o":["หวานน้อย"]},{"n":"น้ำส้มคั้น","q":1}]', '66800000103', 0, c, t, '[{"t":"credit"}]', k);
  perform demo.sell(c, n, t, 'takeaway', null, '[{"n":"น้ำส้มคั้น","q":3}]', null, 0, c, t, '[{"t":"cash","equal":3}]', k);
  perform demo.sell(c, n, t, 'takeaway', null, '[{"n":"แซนด์วิชแฮมชีส","q":2},{"n":"อเมริกาโน่","q":2}]', null, 0, c, t, '[{"t":"cash"}]', k);
  perform demo.sell(c, n, t, 'takeaway', null, '[{"n":"คาปูชิโน่","q":1,"o":["นมโอ๊ต","ไม่หวาน"]},{"n":"ครัวซองต์เนยสด","q":1},{"n":"เมล็ดกาแฟคั่ว 250 ก.","q":1}]', '66800000103', 0, c, t, '[{"t":"credit","a":10000},{"t":"cash"}]', k);
end $$;
select 'café receipts=' || (select count(*) from public.receipts where store_id = demo.store('Breeze Café'));
