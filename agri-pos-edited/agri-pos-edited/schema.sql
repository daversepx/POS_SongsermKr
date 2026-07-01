-- ============================================================
--  ระบบ POS ร้านเคมีเกษตร — Supabase Schema
--  วิธีใช้: เปิด Supabase Dashboard > SQL Editor > วางทั้งหมดนี้ > Run
-- ============================================================

create extension if not exists pgcrypto;

-- ---------- ตารางสินค้า ----------
create table if not exists products (
  id          uuid primary key default gen_random_uuid(),
  code        text,
  name        text not null,
  category    text,
  price       numeric(12,2) not null default 0,
  cost        numeric(12,2) not null default 0,
  unit        text,
  stock       integer not null default 0,
  created_at  timestamptz not null default now()
);
create index if not exists idx_products_name on products (name);
create index if not exists idx_products_code on products (code);

-- ---------- ตารางลูกค้า ----------
create table if not exists customers (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  phone       text,
  area        text,
  note        text,
  created_at  timestamptz not null default now()
);
create index if not exists idx_customers_name on customers (name);

-- ---------- ตารางการขาย (บิล) ----------
create table if not exists sales (
  id          uuid primary key default gen_random_uuid(),
  bill_no     text unique not null,
  total       numeric(12,2) not null default 0,
  received    numeric(12,2) not null default 0,
  change      numeric(12,2) not null default 0,
  pay_type    text not null default 'cash',   -- 'cash' | 'promptpay' | 'farmer_card' | 'credit'
  ref         text,                            -- เลขอ้างอิงสลิปพร้อมเพย์ / เลขอนุมัติบัตร (ถ้ามี)
  fulfillment text not null default 'immediate', -- 'immediate'=รับเลย | 'deferred'=รอรับ | 'complete'=รับครบแล้ว
  status      text not null default 'active',     -- 'active' | 'void' (ยกเลิกบิล)
  customer_id uuid references customers(id) on delete set null,
  staff_id    uuid references auth.users(id),
  created_at  timestamptz not null default now()
);
create index if not exists idx_sales_created on sales (created_at);
create index if not exists idx_sales_customer on sales (customer_id);

-- ---------- รายการสินค้าในแต่ละบิล ----------
create table if not exists sale_items (
  id          uuid primary key default gen_random_uuid(),
  sale_id     uuid not null references sales(id) on delete cascade,
  product_id  uuid references products(id) on delete set null,
  name        text not null,
  price       numeric(12,2) not null,
  cost        numeric(12,2) not null default 0,
  qty         integer not null,
  unit        text
);
create index if not exists idx_sale_items_sale on sale_items (sale_id);

-- ---------- ตารางรับชำระหนี้ (ขายเชื่อ) ----------
create table if not exists payments (
  id          uuid primary key default gen_random_uuid(),
  customer_id uuid not null references customers(id) on delete cascade,
  amount      numeric(12,2) not null,
  staff_id    uuid references auth.users(id),
  created_at  timestamptz not null default now()
);
create index if not exists idx_payments_customer on payments (customer_id);

-- ---------- การส่งมอบสินค้า (สำหรับบิลที่จ่ายเงินแล้วแต่รับของภายหลัง) ----------
create table if not exists deliveries (
  id          uuid primary key default gen_random_uuid(),
  sale_id     uuid not null references sales(id) on delete cascade,
  note        text,
  staff_id    uuid references auth.users(id),
  created_at  timestamptz not null default now()
);
create index if not exists idx_deliveries_sale on deliveries (sale_id);

create table if not exists delivery_items (
  id           uuid primary key default gen_random_uuid(),
  delivery_id  uuid not null references deliveries(id) on delete cascade,
  sale_item_id uuid references sale_items(id) on delete set null,
  name         text not null,
  qty          integer not null
);
create index if not exists idx_delivery_items_delivery on delivery_items (delivery_id);

-- ลำดับเลขที่บิล (กันชนกันเมื่อขายพร้อมกันหลายเครื่อง)
create sequence if not exists bill_seq;

-- ============================================================
--  ฟังก์ชันบันทึกการขายแบบ atomic (ทำทั้งหมดในทรานแซกชันเดียว)
--  - สร้างเลขบิล / บันทึกบิล / บันทึกรายการ / ตัดสต็อก
--  - กันสต็อกติดลบ: ถ้าของไม่พอจะ rollback ทั้งบิล
-- ============================================================
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

-- ============================================================
--  ฟังก์ชันบันทึกการรับสินค้า (กรณีจ่ายแล้วรอรับ / ทยอยรับ)
--  - บันทึกการส่งมอบครั้งนี้ + อัปเดตสถานะบิล
--  - ไม่ตัดสต็อกซ้ำ (ตัดไปแล้วตอนขาย)
-- ============================================================
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

-- ============================================================
--  ฟังก์ชันยกเลิกบิล (คืนสต็อก + ทำเครื่องหมายยกเลิก)
--  - ยอดขาย/ยอดค้างจะไม่ถูกนับบิลที่ยกเลิก (กรองจากฝั่งแอป)
-- ============================================================
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

-- ============================================================
--  Row Level Security
--  ร้านเดียว พนักงานที่ล็อกอินแล้วเข้าถึงได้ทั้งหมด
-- ============================================================
alter table products   enable row level security;
alter table customers  enable row level security;
alter table sales      enable row level security;
alter table sale_items enable row level security;
alter table payments   enable row level security;
alter table deliveries     enable row level security;
alter table delivery_items enable row level security;

create policy "staff_all_products"   on products   for all to authenticated using (true) with check (true);
create policy "staff_all_customers"  on customers  for all to authenticated using (true) with check (true);
create policy "staff_all_sales"      on sales      for all to authenticated using (true) with check (true);
create policy "staff_all_sale_items" on sale_items for all to authenticated using (true) with check (true);
create policy "staff_all_payments"   on payments   for all to authenticated using (true) with check (true);
create policy "staff_all_deliveries"      on deliveries     for all to authenticated using (true) with check (true);
create policy "staff_all_delivery_items"  on delivery_items for all to authenticated using (true) with check (true);

-- สิทธิ์เรียกฟังก์ชัน + ใช้ sequence
grant usage on sequence bill_seq to authenticated;
grant execute on function create_sale(jsonb, numeric, numeric, numeric, uuid, text, text) to authenticated;
grant execute on function record_delivery(uuid, jsonb, text) to authenticated;
grant execute on function void_sale(uuid) to authenticated;

-- ============================================================
--  เปิด Realtime (ทุกเครื่องเห็นสต็อก/ยอดขายอัปเดตทันที)
-- ============================================================
alter publication supabase_realtime add table products;
alter publication supabase_realtime add table sales;
alter publication supabase_realtime add table payments;
alter publication supabase_realtime add table deliveries;

-- ============================================================
--  (ไม่บังคับ) ข้อมูลสินค้าตัวอย่างสำหรับเริ่มต้นทดสอบ
--  ลบคอมเมนต์ออกถ้าต้องการ seed
-- ============================================================
-- insert into products (code,name,category,price,unit,stock) values
--   ('FRT-001','ปุ๋ยยูเรีย 46-0-0 (50กก.)','ปุ๋ย',780,'กระสอบ',40),
--   ('FRT-002','ปุ๋ยสูตร 15-15-15 (50กก.)','ปุ๋ย',1050,'กระสอบ',32),
--   ('HRB-001','ไกลโฟเสท 48% (4ลิตร)','ยากำจัดวัชพืช',420,'แกลลอน',24),
--   ('INS-001','อะบาเมกติน 1.8% (1ลิตร)','ยากำจัดแมลง',350,'ขวด',22);

-- ============================================================
--  สำหรับคนที่เคยรัน schema เวอร์ชันก่อนหน้าแล้ว
--  รันส่วนนี้เพิ่มเพื่ออัปเดต (วิธีจ่ายเงินใหม่ + ระบบรอรับสินค้า):
-- ============================================================
-- alter table sales add column if not exists ref text;
-- alter table sales add column if not exists fulfillment text not null default 'immediate';
-- create table if not exists deliveries (
--   id uuid primary key default gen_random_uuid(),
--   sale_id uuid not null references sales(id) on delete cascade,
--   note text, staff_id uuid references auth.users(id),
--   created_at timestamptz not null default now());
-- create table if not exists delivery_items (
--   id uuid primary key default gen_random_uuid(),
--   delivery_id uuid not null references deliveries(id) on delete cascade,
--   sale_item_id uuid references sale_items(id) on delete set null,
--   name text not null, qty integer not null);
-- alter table deliveries enable row level security;
-- alter table delivery_items enable row level security;
-- create policy "staff_all_deliveries" on deliveries for all to authenticated using (true) with check (true);
-- create policy "staff_all_delivery_items" on delivery_items for all to authenticated using (true) with check (true);
-- alter publication supabase_realtime add table deliveries;
