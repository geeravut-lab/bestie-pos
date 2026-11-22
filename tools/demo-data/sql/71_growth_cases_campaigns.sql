-- Demo: more things to click through for sets A–D (needs the 70 file's modules; safe to run again — it stops when the cases exist):
--  Island Kitchen: three guest feedbacks (two bad ones open service cases: one acknowledged, one resolved), waste with reasons, a stock lot, and the business manager's findings;
--  Breeze Café: LINE promotion campaigns as DRAFTS (inactive; nothing is sent, and no member consent or LINE contact is faked).
do $$
declare
  o text := 'owner.demo@bestiedemo.example'; v_ik uuid := demo.store('Island Kitchen'); v_bc uuid := demo.store('Breeze Café'); v_tok text;
  v_case1 uuid; v_case2 uuid; v_item uuid; v_n integer;
begin
  if demo.org() is null then raise exception 'run setup first (there is no demo organisation)'; end if;
  if exists (select 1 from public.service_cases where store_id = v_ik) then raise notice 'growth cases already there'; return; end if;

  -- guest feedback from a table page (the table's token is the guest's only key): two bad ratings open a service case each, a good one does not
  select qr_token into v_tok from public.dining_tables where store_id = v_ik and kind = 'table' and qr_token is not null order by name limit 1;
  if v_tok is not null then
    perform demo.svc(format($q$select public.guest_feedback_submit(%L, 1, 'service', 'Waited 40 minutes for the food and nobody told us')::text$q$, v_tok));
    perform demo.svc(format($q$select public.guest_feedback_submit(%L, 2, 'food', 'The basil rice was cold when it arrived')::text$q$, v_tok));
    perform demo.svc(format($q$select public.guest_feedback_submit(%L, 5, 'food', 'Best pad thai on the island')::text$q$, v_tok));
  end if;
  select id into v_case1 from public.service_cases where store_id = v_ik order by created_at limit 1;
  select id into v_case2 from public.service_cases where store_id = v_ik and id is distinct from v_case1 order by created_at limit 1;
  if v_case1 is not null then perform demo.run('manager.demo@bestiedemo.example', format($q$select public.case_ack(%L)$q$, v_case1)); end if;
  if v_case2 is not null then
    perform demo.run('manager.demo@bestiedemo.example', format($q$select public.case_ack(%L)$q$, v_case2));
    perform demo.run('manager.demo@bestiedemo.example', format($q$select public.case_resolve(%L, 'Replaced the dish and apologised to the table', true)$q$, v_case2));
  end if;

  -- waste with reasons (the report and the cost alert read these)
  for v_item in select id from public.stock_items where store_id = v_ik and deleted_at is null order by name limit 3 loop
    v_n := coalesce(v_n, 0) + 1;
    perform demo.run('stockkeeper.demo@bestiedemo.example', format($q$select public.stock_move(jsonb_build_object('item_id', %L, 'kind', 'waste', 'quantity', %s, 'reason', %L))$q$,
      v_item, 150 * v_n, case v_n when 1 then 'expired' when 2 then 'spilled' else 'damaged' end));
  end loop;

  -- the business manager's findings (rules over the shop's own figures)
  perform demo.svc(format($q$select public.generate_insights(%L)::text$q$, v_ik));

  -- LINE promotion campaigns, as drafts: the owner switches them on after members agree by sending the shop's LINE a code
  update public.stores set plan = case when plan = 'basic' then 'pro' else plan end,
         module_overrides = coalesce(module_overrides, '{}'::jsonb) || jsonb_build_object('marketing', true) where id = v_bc;
  perform demo.val(o, format($q$select public.save_marketing_campaign(jsonb_build_object('store_id', %L, 'name', 'We miss you', 'kind', 'winback', 'idle_days', 30,
      'message', '{"th":"คิดถึงนะ! แวะมาดื่มกาแฟที่ Breeze Café แล้วรับขนมฟรี 1 ชิ้น","en":"We miss you! Come by Breeze Café for a free pastry with your coffee."}'::jsonb, 'active', false))::text$q$, v_bc));
  perform demo.val(o, format($q$select public.save_marketing_campaign(jsonb_build_object('store_id', %L, 'name', 'Welcome', 'kind', 'welcome', 'idle_days', 7,
      'message', '{"th":"ยินดีต้อนรับ! ขอบคุณที่มาเป็นสมาชิก Breeze Café","en":"Welcome! Thanks for joining Breeze Café."}'::jsonb, 'active', false))::text$q$, v_bc));
  raise notice 'growth cases: 3 feedbacks (2 service cases: one acknowledged, one resolved), waste with reasons, insights, 2 draft LINE campaigns';
end $$;
