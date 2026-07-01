// ============================================================
//  DATA LAYER — แหล่งเดียวที่คุยกับฐานข้อมูล
//  ส่วนอื่นของแอป (app.js) เรียกใช้ผ่านฟังก์ชันเหล่านี้เท่านั้น
//  อนาคตถ้าย้าย backend (เช่นไป self-host) แก้แค่ไฟล์นี้
// ============================================================
import { supabase } from "./supabaseClient.js";

/* ---------- สินค้า ---------- */
export async function getProducts() {
  const { data, error } = await supabase.from("products").select("*").order("name");
  if (error) throw error;
  return data;
}
export async function saveProduct(p) {
  const row = { code: p.code, name: p.name, category: p.category, price: p.price, cost: p.cost, unit: p.unit, stock: p.stock };
  if (p.id) {
    const { error } = await supabase.from("products").update(row).eq("id", p.id);
    if (error) throw error;
  } else {
    const { error } = await supabase.from("products").insert(row);
    if (error) throw error;
  }
}
export async function deleteProduct(id) {
  const { error } = await supabase.from("products").delete().eq("id", id);
  if (error) throw error;
}
export async function adjustStock(id, current, delta) {
  const { error } = await supabase.from("products").update({ stock: current + delta }).eq("id", id);
  if (error) throw error;
}

/* ---------- ลูกค้า ---------- */
export async function getCustomers() {
  const { data, error } = await supabase.from("customers").select("*").order("name");
  if (error) throw error;
  return data;
}
export async function saveCustomer(c) {
  const row = { name: c.name, phone: c.phone, area: c.area, note: c.note };
  if (c.id) {
    const { error } = await supabase.from("customers").update(row).eq("id", c.id);
    if (error) throw error;
    return c.id;
  } else {
    const { data, error } = await supabase.from("customers").insert(row).select("id").single();
    if (error) throw error;
    return data.id;
  }
}
// ลบลูกค้า (ประวัติการขายยังอยู่แต่จะไม่ผูกชื่อ ตาม schema: sales.customer_id = set null, payments = cascade)
export async function deleteCustomer(id) {
  const { error } = await supabase.from("customers").delete().eq("id", id);
  if (error) throw error;
}

// สรุปยอดของลูกค้าทุกคน: { id: {owe, total, count} }
export async function getCustomerBalances() {
  const [{ data: salesRows, error: e1 }, { data: payRows, error: e2 }] = await Promise.all([
    supabase.from("sales").select("customer_id, total, pay_type, status"),
    supabase.from("payments").select("customer_id, amount"),
  ]);
  if (e1) throw e1;
  if (e2) throw e2;
  const map = {};
  (salesRows || []).forEach((s) => {
    if (!s.customer_id || s.status === "void") return;
    if (!map[s.customer_id]) map[s.customer_id] = { owe: 0, total: 0, count: 0 };
    map[s.customer_id].total += Number(s.total);
    map[s.customer_id].count += 1;
    if (s.pay_type === "credit") map[s.customer_id].owe += Number(s.total);
  });
  (payRows || []).forEach((p) => {
    if (!map[p.customer_id]) map[p.customer_id] = { owe: 0, total: 0, count: 0 };
    map[p.customer_id].owe -= Number(p.amount);
  });
  return map;
}

// ประวัติของลูกค้าหนึ่งคน
export async function getCustomerHistory(id) {
  const [{ data: sales, error: e1 }, { data: pays, error: e2 }] = await Promise.all([
    supabase.from("sales").select("*, sale_items(*)").eq("customer_id", id).order("created_at", { ascending: false }),
    supabase.from("payments").select("*").eq("customer_id", id).order("created_at", { ascending: false }),
  ]);
  if (e1) throw e1;
  if (e2) throw e2;
  return { sales: sales || [], payments: pays || [] };
}

/* ---------- การขาย ---------- */
// บันทึกบิลแบบ atomic ผ่าน RPC (ตัดสต็อกในทรานแซกชันเดียว)
export async function createSale({ items, total, received, change, customerId, payType, ref, fulfillment }) {
  const payload = items.map((i) => ({
    product_id: i.id, name: i.name, price: i.price, qty: i.qty, unit: i.unit,
  }));
  const { data, error } = await supabase.rpc("create_sale", {
    p_items: payload, p_total: total, p_received: received,
    p_change: change, p_customer: customerId, p_pay_type: payType,
    p_fulfillment: fulfillment || "immediate",
  });
  if (error) throw error;
  if (ref) {
    await supabase.from("sales").update({ ref }).eq("id", data.id);
    data.ref = ref;
  }
  return data;
}

/* ---------- การส่งมอบสินค้า (รอรับ / ทยอยรับ) ---------- */
// บิลที่ยังรอรับสินค้า พร้อมรายการและยอดที่รับไปแล้ว
export async function getPendingPickups() {
  const { data, error } = await supabase
    .from("sales")
    .select("*, sale_items(*), customers(name), deliveries(*, delivery_items(*))")
    .eq("fulfillment", "deferred")
    .neq("status", "void")
    .order("created_at", { ascending: true });
  if (error) throw error;
  return (data || []).map(enrichPickup);
}

export async function voidSale(saleId) {
  const { data, error } = await supabase.rpc("void_sale", { p_sale_id: saleId });
  if (error) throw error;
  return data;
}

// ดึงบิลล่าสุด (ทุกวัน) ไว้ค้นหา/พิมพ์ซ้ำ
export async function getRecentSales(limit = 200) {
  const { data, error } = await supabase
    .from("sales")
    .select("*, sale_items(*), customers(name)")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data || [];
}

// ดึงบิลย้อนหลังตามจำนวนวัน ใช้สำหรับคำนวณ "สินค้าขายดี 30 วัน"
export async function getSalesSince(days = 30, pageSize = 1000) {
  const since = new Date(Date.now() - Number(days || 30) * 24 * 60 * 60 * 1000).toISOString();
  let all = [];
  let from = 0;
  const size = Math.max(100, Math.min(Number(pageSize || 1000), 1000));
  while (true) {
    const to = from + size - 1;
    const { data, error } = await supabase
      .from("sales")
      .select("*, sale_items(*), customers(name)")
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .range(from, to);
    if (error) throw error;
    const rows = data || [];
    all = all.concat(rows);
    if (rows.length < size) break;
    from += size;
    if (all.length >= 5000) break; // กันโหลดหนักเกินไปสำหรับหน้าขาย
  }
  return all;
}

// ดึงบิลของวันที่ระบุ (day = "YYYY-MM-DD" ตามวันไทย) ไว้พิมพ์รายงานย้อนหลัง
export async function getSalesByDate(day) {
  const { data, error } = await supabase
    .from("sales")
    .select("*, sale_items(*), customers(name)")
    .gte("created_at", day + "T00:00:00+07:00")
    .lte("created_at", day + "T23:59:59+07:00")
    .order("created_at", { ascending: true });
  if (error) throw error;
  return data || [];
}

// รายละเอียดการรับของบิลเดียว
export async function getPickupDetail(saleId) {
  const { data, error } = await supabase
    .from("sales")
    .select("*, sale_items(*), customers(name), deliveries(*, delivery_items(*))")
    .eq("id", saleId)
    .single();
  if (error) throw error;
  return enrichPickup(data);
}

// คำนวณ รับแล้ว/คงเหลือ ต่อรายการ
function enrichPickup(sale) {
  const deliveredBy = {};
  (sale.deliveries || []).forEach((d) => (d.delivery_items || []).forEach((di) => {
    deliveredBy[di.sale_item_id] = (deliveredBy[di.sale_item_id] || 0) + di.qty;
  }));
  const lines = (sale.sale_items || []).map((it) => {
    const delivered = deliveredBy[it.id] || 0;
    return { ...it, delivered, remaining: it.qty - delivered };
  });
  const remainingTotal = lines.reduce((a, l) => a + l.remaining, 0);
  return { ...sale, lines, remainingTotal };
}

export async function recordDelivery(saleId, lines, note) {
  const payload = lines.filter((l) => l.qty > 0).map((l) => ({
    sale_item_id: l.sale_item_id, qty: l.qty,
  }));
  if (!payload.length) throw new Error("ไม่มีรายการที่จะจ่าย");
  const { data, error } = await supabase.rpc("record_delivery", {
    p_sale_id: saleId, p_items: payload, p_note: note || null,
  });
  if (error) throw error;
  return data;
}

export async function recordPayment(customerId, amount) {
  const { error } = await supabase.from("payments").insert({ customer_id: customerId, amount });
  if (error) throw error;
}

// บิลของวันนี้ (สำหรับหน้ารายงาน)
export async function getTodaySales() {
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const { data, error } = await supabase
    .from("sales")
    .select("*, sale_items(*), customers(name)")
    .gte("created_at", start.toISOString())
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data;
}

/* ---------- Realtime: แจ้งเมื่อข้อมูลเปลี่ยนจากเครื่องอื่น ---------- */
export function subscribeChanges(onChange) {
  return supabase
    .channel("pos-changes")
    .on("postgres_changes", { event: "*", schema: "public", table: "products" }, () => onChange("products"))
    .on("postgres_changes", { event: "*", schema: "public", table: "sales" }, () => onChange("sales"))
    .on("postgres_changes", { event: "*", schema: "public", table: "payments" }, () => onChange("payments"))
    .on("postgres_changes", { event: "*", schema: "public", table: "deliveries" }, () => onChange("deliveries"))
    .subscribe();
}


// ============================================================
// โค้ดสำหรับระบบจอลูกค้าข้ามเครื่อง (แท็บเล็ต)
// ============================================================
let displayChan = null;

export function sendToCustomerDisplay(data) {
  if (!displayChan) {
    // 💡 หากตัวแปรเชื่อมต่อ Supabase ในไฟล์นี้ไม่ได้ชื่อ 'supabase' 
    // ให้แก้คำว่า supabase เป็นชื่อตัวแปรที่คุณตั้งไว้นะคะ
    displayChan = supabase.channel('customer_display');
    displayChan.subscribe();
  }
  displayChan.send({ type: 'broadcast', event: 'sync_screen', payload: data });
}

export function listenToCustomerDisplay(callback) {
  const chan = supabase.channel('customer_display');
  chan.on('broadcast', { event: 'sync_screen' }, (event) => {
    callback(event.payload);
  }).subscribe();
}
// ---------- จอลูกค้าเพิ่งเปิด: ขอสถานะตะกร้าปัจจุบันทันที (ใช้ช่องแยก) ----------
// (ฝั่งจอลูกค้า) ส่งคำขอไปยังเครื่องขายเมื่อจอเพิ่งเปิด
export function requestCustomerSync() {
  const ch = supabase.channel('customer_display_sync');
  ch.subscribe((status) => {
    if (status === 'SUBSCRIBED') ch.send({ type: 'broadcast', event: 'request', payload: {} });
  });
}
// (ฝั่งเครื่องขาย) ฟังคำขอ แล้วเรียก callback เพื่อส่งสถานะปัจจุบันกลับ
export function onCustomerSyncRequest(callback) {
  supabase.channel('customer_display_sync')
    .on('broadcast', { event: 'request' }, () => callback())
    .subscribe();
}

// ============================================================
//  สถานะการชำระต่อบิล (สำหรับใบเสร็จ "ชำระแล้ว")
//  ระบบคิดหนี้เป็นยอดรวมต่อลูกค้า ไม่ได้ผูกเงินก้อนกับบิล
//  จึงใช้หลัก FIFO: เงินที่ลูกค้าจ่ายมา ตัดบิลเชื่อที่เก่าที่สุดก่อน
//  คืน map: saleId -> { total, paid, remaining }
// ============================================================
// helper ให้ app.js เรียก supabase โดยตรง (เฉพาะ query ที่ไม่มี wrapper)
export function _supabase() { return supabase; }

export async function getCreditPaidMap() {
  const [{ data: sales, error: e1 }, { data: pays, error: e2 }] = await Promise.all([
    supabase.from("sales").select("id, customer_id, total, pay_type, status, created_at")
      .neq("status", "void").order("created_at", { ascending: true }),
    supabase.from("payments").select("customer_id, amount"),
  ]);
  if (e1) throw e1;
  if (e2) throw e2;
  // รวมเงินที่จ่ายมาแล้วต่อลูกค้า = เงินก้อนที่เอาไปไล่ตัดบิล
  const pool = {};
  (pays || []).forEach((p) => { pool[p.customer_id] = (pool[p.customer_id] || 0) + Number(p.amount); });
  const map = {};
  (sales || []).forEach((s) => {
    if (s.pay_type !== "credit" || !s.customer_id) return;
    const avail = pool[s.customer_id] || 0;
    const total = Number(s.total);
    const paid = Math.min(avail, total);
    pool[s.customer_id] = avail - paid;
    map[s.id] = { total, paid, remaining: total - paid };
  });
  return map;
}
