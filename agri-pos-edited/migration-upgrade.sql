-- ============================================================
--  Migration สำหรับฐานข้อมูลเดิม (ที่ติดตั้งก่อนมีฟีเจอร์ใหม่)
--  รันไฟล์นี้ครั้งเดียวใน Supabase → SQL Editor
--  ครอบคลุม: ต้นทุนสินค้า, รอรับสินค้า/ทยอยรับ, ยกเลิกบิล
--  (ฐานข้อมูลใหม่ ใช้ schema.sql ไฟล์เดียวพอ ไม่ต้องรันไฟล์นี้)
--  ปลอดภัยถ้าเผลอรันซ้ำ (ใช้ IF NOT EXISTS / OR REPLACE)
-- ============================================================

-- 1) คอลัมน์ใหม่ -------------------------------------------------
alter table products   add column if not exists cost        numeric(12,2) not null default 0;
alter table sale_items add column if not exists cost        numeric(12,2) not null default 0;
alter table sales      add column if not exists fulfillment text not null default 'immediate';  -- immediate | deferred | complete
alter table sales      add column if not exists status      text not null default 'active';     -- active | void

-- 2) ตารางการส่งมอบสินค้า --------------------------------------
create table if not exists deliveries (
  id          uuid primary key default gen_random_uuid(),
  sale_id     uuid not null references sales(id) on delete cascade,
  note        text,
  staff_id    uuid references auth.users(id),
  created_at  timestamptz not null default now()
);
create table if not exists delivery_items (
  id           uuid primary key default gen_random_uuid(),
  delivery_id  uuid not null references deliveries(id) on delete cascade,
  sale_item_id uuid references sale_items(id) on delete set null,
  name         text,
  qty          integer not null
);
create index if not exists idx_deliveries_sale on deliveries (sale_id);

-- 3) RLS + Realtime (กันรันซ้ำ) --------------------------------
alter table deliveries     enable row level security;
alter table delivery_items enable row level security;
drop policy if exists "staff_all_deliveries"      on deliveries;
drop policy if exists "staff_all_delivery_items"  on delivery_items;
create policy "staff_all_deliveries"     on deliveries     for all to authenticated using (true) with check (true);
create policy "staff_all_delivery_items" on delivery_items for all to authenticated using (true) with check (true);
do $$ begin
  alter publication supabase_realtime add table deliveries;
exception when duplicate_object then null; end $$;

-- 4) ฟังก์ชัน (ดึงจาก schema.sql ให้ตรงกันเป๊ะ) ----------------
-- ลบ create_sale ตัวเก่า (6 พารามิเตอร์) ถ้ามี เพื่อแทนด้วยตัว 7 พารามิเตอร์
drop function if exists create_sale(jsonb, numeric, numeric, numeric, uuid, text);

create or replace function create_sale(
  p_items     jsonb,
  p_total     numeric,
  p_received  numeric,
  p_change    numeric,
  p_customer  uuid,
  p_pay_type  text,
  p_fulfillment text default 'immediate'
) returns sales
language plpgsql
as $$
declare
  v_sale   sales;
  v_bill   text;
  v_item   jsonb;
  v_pid    uuid;
  v_qty    integer;
  v_stock  integer;
begin
  v_bill := to_char(now() at time zone 'Asia/Bangkok','YYMMDD')
            || '-' || lpad(nextval('bill_seq')::text, 5, '0');

  insert into sales (bill_no, total, received, change, pay_type, fulfillment, customer_id, staff_id)
  values (v_bill, p_total, p_received, p_change, p_pay_type, p_fulfillment, p_customer, auth.uid())
  returning * into v_sale;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    v_pid := (v_item->>'product_id')::uuid;
    v_qty := (v_item->>'qty')::integer;

    -- ตรวจสต็อกแบบ lock เพื่อกัน race ระหว่างเครื่อง
    select stock into v_stock from products where id = v_pid for update;
    if v_stock is null then
      raise exception 'ไม่พบสินค้า %', v_pid;
    end if;
    if v_stock < v_qty then
      raise exception 'สต็อกไม่พอสำหรับสินค้า % (เหลือ %, ต้องการ %)', v_pid, v_stock, v_qty;
    end if;

    insert into sale_items (sale_id, product_id, name, price, cost, qty, unit)
    values (v_sale.id, v_pid, v_item->>'name', (v_item->>'price')::numeric,
            coalesce((select cost from products where id = v_pid), 0),
            v_qty, v_item->>'unit');

    update products set stock = stock - v_qty where id = v_pid;
  end loop;

  return v_sale;
end;
$$;

create or replace function record_delivery(
  p_sale_id uuid,
  p_items   jsonb,
  p_note    text default null
) returns deliveries
language plpgsql
as $$
declare
  v_del       deliveries;
  v_item      jsonb;
  v_ordered   integer;
  v_delivered integer;
begin
  insert into deliveries (sale_id, note, staff_id)
  values (p_sale_id, p_note, auth.uid())
  returning * into v_del;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    insert into delivery_items (delivery_id, sale_item_id, name, qty)
    values (
      v_del.id,
      (v_item->>'sale_item_id')::uuid,
      (select name from sale_items where id = (v_item->>'sale_item_id')::uuid),
      (v_item->>'qty')::integer
    );
  end loop;

  select coalesce(sum(qty),0) into v_ordered from sale_items where sale_id = p_sale_id;
  select coalesce(sum(di.qty),0) into v_delivered
    from delivery_items di join deliveries d on d.id = di.delivery_id
    where d.sale_id = p_sale_id;

  update sales
    set fulfillment = case when v_delivered >= v_ordered then 'complete' else 'deferred' end
    where id = p_sale_id;

  return v_del;
end;
$$;

create or replace function void_sale(p_sale_id uuid)
returns sales
language plpgsql
as $$
declare
  v_sale sales;
  v_item record;
begin
  select * into v_sale from sales where id = p_sale_id;
  if v_sale.id is null then
    raise exception 'ไม่พบบิล %', p_sale_id;
  end if;
  if v_sale.status = 'void' then
    return v_sale;  -- ยกเลิกไปแล้ว ไม่ทำซ้ำ
  end if;

  -- คืนสต็อกตามจำนวนที่ขายไป
  for v_item in select product_id, qty from sale_items where sale_id = p_sale_id
  loop
    if v_item.product_id is not null then
      update products set stock = stock + v_item.qty where id = v_item.product_id;
    end if;
  end loop;

  update sales set status = 'void' where id = p_sale_id returning * into v_sale;
  return v_sale;
end;
$$;

-- 5) สิทธิ์การเรียกใช้ -----------------------------------------
grant execute on function create_sale(jsonb, numeric, numeric, numeric, uuid, text, text) to authenticated;
grant execute on function record_delivery(uuid, jsonb, text) to authenticated;
grant execute on function void_sale(uuid) to authenticated;
