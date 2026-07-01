// ============================================================
//  APP CONTROLLER — จัดการ UI ทั้งหมด
//  คุยกับฐานข้อมูลผ่าน db.js เท่านั้น (ไม่แตะ Supabase ตรงๆ)
// ============================================================
import * as DB from "./db.js";
import { getSession, signIn, signOut, onAuthChange } from "./auth.js";
import { SHOP } from "./config.js";
import QRCode from "https://esm.sh/qrcode@1.5.4";

const $ = (id) => document.getElementById(id);
const baht = (n) => "฿" + Number(n || 0).toLocaleString("th-TH", { maximumFractionDigits: 2 });
const PAY_LABEL = { cash: "เงินสด", promptpay: "พร้อมเพย์", farmer_card: "บัตรเกษตรกร", credit: "ขายเชื่อ" };

// ---------- ตัวช่วยแยกสินค้ายกลัง (ไม่ต้องเพิ่มคอลัมน์ฐานข้อมูล) ----------
function productSaleKind(p) {
  const text = `${p?.name || ""} ${p?.category || ""} ${p?.unit || ""} ${p?.code || ""}`.toLowerCase();
  if (/(ยกลัง|ขายส่ง|ลัง|แพ็ค|แพ็ก|โหล|box|case|carton|wholesale)/i.test(text)) return { key: "box", label: "📦 ยกลัง" };
  return null;
}
function isRetailCategory(c) {
  return /^(ปลีก|ขายปลีก|retail)$/i.test(String(c || "").trim());
}
function displayCategory(c) {
  return isRetailCategory(c) ? "-" : (c || "-");
}
function productSearchText(p) {
  const kind = productSaleKind(p);
  return [p?.name, p?.code, p?.category, p?.unit, kind?.key === "box" ? "ขายส่ง ยกลัง ลัง" : ""]
    .filter(Boolean).join(" ").toLowerCase();
}
function saleKindBadge(p) {
  const kind = productSaleKind(p);
  if (!kind) return "";
  return `<span class="sale-kind ${kind.key}">${kind.label}</span>`;
}

// ---------- ป้ายสถานะสินค้า: คำนวณจากข้อมูลจริงที่มีอยู่แล้ว ไม่ต้องเพิ่มคอลัมน์ฐานข้อมูล ----------
// ขายดี = คำนวณจากยอดขาย 200 บิลล่าสุด (เหมือนแท็บ "ขายดี" เดิม)
let topBestSellerIds = new Set();
function statusBadge(p) {
  if (topBestSellerIds.has(p.id)) return '<span class="badge badge-best">⭐ ขายดี</span>';
  return "";
}

// ---------- ไอคอนหมวดสินค้า: จับคู่จากชื่อหมวด ไม่ต้องเพิ่มคอลัมน์ฐานข้อมูล ----------
function catIcon(name) {
  if (name === BEST) return "⭐";
  if (name === "ทั้งหมด") return "🗂️";
  const s = String(name || "");
  if (/ปุ๋ยอินทรีย์|อินทรีย์/.test(s)) return "🌿";
  if (/ปุ๋ย/.test(s)) return "🌱";
  if (/ยา|เคมี|สารป้องกัน|กำจัด/.test(s)) return "🧴";
  if (/เมล็ด/.test(s)) return "🌾";
  if (/อุปกรณ์|เครื่องมือ/.test(s)) return "🛠️";
  return "📦";
}

// สร้าง payload พร้อมเพย์ (มาตรฐาน EMVCo) แบบฝังในตัว ไม่พึ่ง CDN
function ppF(id, v) { return id + ("00" + v.length).slice(-2) + v; }
function ppTarget(id) { const n = ("" + id).replace(/[^0-9]/g, ""); if (n.length >= 13) return n; return ("0000000000000" + n.replace(/^0/, "66")).slice(-13); }
function ppCRC(d) { let c = 0xFFFF; for (let i = 0; i < d.length; i++) { c ^= d.charCodeAt(i) << 8; for (let j = 0; j < 8; j++) { c = (c & 0x8000) ? ((c << 1) ^ 0x1021) : (c << 1); c &= 0xFFFF; } } return ("000" + c.toString(16).toUpperCase()).slice(-4); }
function generatePayload(target, opts) {
  const amt = opts && opts.amount;
  const t = ("" + target).replace(/[^0-9]/g, "");
  const type = t.length >= 15 ? "03" : t.length >= 13 ? "02" : "01";
  const merchant = ppF("00", "A000000677010111") + ppF(type, ppTarget(target));
  const data = ppF("00", "01") + ppF("01", amt ? "12" : "11") + ppF("29", merchant) + ppF("53", "764") + (amt ? ppF("54", amt.toFixed(2)) : "") + ppF("58", "TH");
  const s = data + "6304";
  return s + ppCRC(s);
}

// ---------- state ----------
let products = [], customers = [], balances = {}, todaySales = [];
let creditPaid = {};
let cart = [], activeCat = "ทั้งหมด";
const BEST = "⭐ ขายดี";
let bestSellers = {};
const RCPT_LOGO = '<svg class="logo-mark" width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:block;margin:0 auto 6px;color:var(--grn2)" xmlns="http://www.w3.org/2000/svg"><path d="M12 20v-7"/><path d="M12 13c0-3.3-2.7-6-6-6 0 3.3 2.7 6 6 6Z"/><path d="M12 13c0-3.3 2.7-6 6-6 0 3.3-2.7 6-6 6Z"/></svg>';
let saleCustId = null, currentCustId = null, payType = "cash";
let currentCreditBills = [], currentCustomerSales = [], selectedCreditBills = new Set(), taxSale = null;
let editProdId = null, editCustId = null, custFromPicker = false;
let fulfillMode = "immediate", pendingSales = [], pickupSaleId = null, pickupDetail = null;
let rtChannel = null;

// ---------- พักตะกร้า (เก็บไว้เฉพาะเครื่องนี้ด้วย localStorage) ----------
const HELD_CARTS_KEY = "agri-pos-held-carts-v1";
let heldCarts = [];

const App = {};
window.App = App;

// ============================================================
//  AUTH
// ============================================================
async function boot() {
  const session = await getSession();
  if (session) await enterApp();
  else showLogin();
  onAuthChange((s) => { if (!s) showLogin(); });
}
function showLogin() {
  $("appRoot").classList.add("hidden");
  $("loginScreen").classList.remove("hidden");
  if (rtChannel) { rtChannel.unsubscribe(); rtChannel = null; }
}
App.login = async function () {
  const btn = $("liBtn"); $("liErr").textContent = "";
  btn.disabled = true; btn.textContent = "กำลังเข้าสู่ระบบ...";
  try {
    await signIn($("liEmail").value.trim(), $("liPass").value);
    await enterApp();
  } catch (e) {
    $("liErr").textContent = "เข้าสู่ระบบไม่สำเร็จ — ตรวจอีเมล/รหัสผ่าน";
  } finally {
    btn.disabled = false; btn.textContent = "เข้าสู่ระบบ";
  }
};
App.logout = async function () { await signOut(); showLogin(); };

async function enterApp() {
  $("loginScreen").classList.add("hidden");
  $("appRoot").classList.remove("hidden");
  tickClock(); setInterval(tickClock, 1000);
  initFooter();
  await loadAll();
  rtChannel = DB.subscribeChanges(async (table) => {
    try {
      if (table === "products") products = await DB.getProducts();
      if (table === "sales" || table === "payments") {
        [balances, todaySales, creditPaid] = await Promise.all([DB.getCustomerBalances(), DB.getTodaySales(), DB.getCreditPaidMap()]);
      }
      if (table === "sales" || table === "deliveries") {
        pendingSales = await DB.getPendingPickups();
      }
      if (table === "sales") loadBestSellers();
      renderActive();
    } catch (e) { /* เงียบไว้ ไม่รบกวนการขาย */ }
  });
}

function initFooter() {
  const nm = $("footShopName"); if (nm) nm.textContent = SHOP.name;
  const tx = $("footTaxId"); if (tx && SHOP.taxId) tx.textContent = "เลขประจำตัวผู้เสียภาษี: " + SHOP.taxId;
  const ph = $("footPhone"); if (ph && SHOP.phone) ph.textContent = "โทร. " + SHOP.phone;
  const setOnline = () => {
    const el = $("footOnline"); if (!el) return;
    el.classList.toggle("off", !navigator.onLine);
    el.querySelector(".ol-txt").textContent = navigator.onLine ? "ออนไลน์" : "ออฟไลน์";
  };
  setOnline();
  window.addEventListener("online", setOnline);
  window.addEventListener("offline", setOnline);
}

async function loadAll() {
  try {
    [products, customers, balances, todaySales, pendingSales, creditPaid] = await Promise.all([
      DB.getProducts(), DB.getCustomers(), DB.getCustomerBalances(), DB.getTodaySales(), DB.getPendingPickups(), DB.getCreditPaidMap(),
    ]);
    loadHeldCarts();
    renderCatBar(); renderGrid(); renderCart(); updateCustPick();
    loadBestSellers();
    // ปิดป็อปอัพแจ้งเตือนสต็อกใกล้หมดบนสุดตามที่ร้านต้องการ
    // ยังสามารถกดดูสินค้าใกล้หมดได้จากหน้า "สต็อกสินค้า" > ปุ่ม "ใกล้หมด"
  } catch (e) { toast("โหลดข้อมูลไม่สำเร็จ — ตรวจการตั้งค่า Supabase", true); }
}

// ============================================================
//  NAV
// ============================================================
App.go = function (v) {
  document.querySelectorAll(".view").forEach((e) => e.classList.remove("active"));
  $("view-" + v).classList.add("active");
  document.querySelectorAll("nav button").forEach((b) => b.classList.toggle("active", b.dataset.view === v));
  const _ss = $("stockSearch"); if (_ss) _ss.value = "";   // เคลียร์คำค้นหาสต็อกเมื่อสลับเมนู
  if (v === "report") { renderReport(); loadRecentSales(); }
  if (v === "stock") renderStock();
  if (v === "customer") { renderCustomers(); DB.getCustomerBalances().then((b) => { balances = b; renderCustomers(); }).catch(() => {}); }
  if (v === "pickup") renderPickups();
};
function renderActive() {
  const v = document.querySelector(".view.active")?.id || "";
  renderGrid(); renderCart();
  if (v === "view-report") renderReport();
  if (v === "view-stock") renderStock();
  if (v === "view-customer") renderCustomers();
  if (v === "view-pickup") renderPickups();
}
function tickClock() {
  const d = new Date();
  const text = d.toLocaleDateString("th-TH", { weekday: "short", day: "numeric", month: "short" })
    + " · " + d.toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit" });
  const head = $("clock"); if (head) head.textContent = text;
  const foot = $("footClock"); if (foot) foot.textContent = text;
}

// ---------- balance helpers ----------
const owe = (id) => Math.max(0, balances[id]?.owe || 0);

function creditBillStatuses(sales, payments) {
  let payPool = (payments || []).reduce((a, p) => a + Number(p.amount || 0), 0);
  return (sales || [])
    .filter((s) => s.pay_type === "credit" && s.status !== "void")
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
    .map((s) => {
      const total = Number(s.total || 0);
      const paid = Math.min(payPool, total);
      payPool = Math.max(0, payPool - paid);
      return {
        sale: s,
        billNo: s.bill_no || "-",
        date: new Date(s.created_at),
        total,
        paid,
        remaining: Math.max(0, total - paid),
        qty: (s.sale_items || []).reduce((a, i) => a + Number(i.qty || 0), 0),
        itemCount: (s.sale_items || []).length,
      };
    });
}

function billDate(d, withTime = true) {
  return d.toLocaleString("th-TH", withTime
    ? { day: "2-digit", month: "short", year: "2-digit", hour: "2-digit", minute: "2-digit" }
    : { day: "2-digit", month: "short", year: "2-digit" });
}

function updateSelectedCreditAmount() {
  const total = currentCreditBills
    .filter((b) => selectedCreditBills.has(b.sale.id))
    .reduce((a, b) => a + b.remaining, 0);
  if ($("cdSelAmt")) $("cdSelAmt").textContent = baht(total);
  if ($("cdPayAmt") && total > 0) $("cdPayAmt").value = total.toFixed(2);
}

function renderCreditBillList(bills) {
  currentCreditBills = bills.filter((b) => b.remaining > 0.001);
  selectedCreditBills = new Set();
  const box = $("cdCreditBox");
  const list = $("cdCreditBills");
  if (!box || !list) return;
  if (!currentCreditBills.length) {
    box.style.display = "none";
    list.innerHTML = "";
    updateSelectedCreditAmount();
    return;
  }
  const totalOwed = currentCreditBills.reduce((a, b) => a + b.remaining, 0);
  box.style.display = "block";
  list.innerHTML = `
    <div class="credit-total-line"><span>ยอดค้างรวมจากบิลที่ยังไม่ปิด</span><b>${baht(totalOwed)}</b></div>
    ${currentCreditBills.map((b) => `
      <div class="credit-bill-row">
        <label class="credit-check"><input type="checkbox" onchange="App.toggleCreditBill('${b.sale.id}', this.checked)"></label>
        <div class="credit-bill-main">
          <div><b>${b.billNo}</b> <span class="tag cr">ค้าง ${baht(b.remaining)}</span></div>
          <div class="hl">วันที่ ${billDate(b.date)} · ยอดบิล ${baht(b.total)} · ชำระแล้ว ${baht(b.paid)} · ${b.itemCount} รายการ / ${b.qty} ชิ้น</div>
        </div>
        <button class="mini" type="button" onclick="event.stopPropagation();App.reprintCustomerSale('${b.sale.id}')">พิมพ์ใบเสร็จซ้ำ</button>
      </div>`).join("")}
  `;
  updateSelectedCreditAmount();
}

// ============================================================
//  SALES / CATALOG
// ============================================================
function renderCatBar() {
  const cats = ["ทั้งหมด", BEST, ...new Set(products.map((p) => p.category).filter((c) => c && !isRetailCategory(c)))];
  $("catBar").innerHTML = cats.map((c) =>
    `<button class="${c === activeCat ? "active" : ""}" onclick="App.setCat('${c.replace(/'/g, "\\'")}')"><span class="ci">${catIcon(c)}</span>${c.replace(/^⭐ /, "")}</button>`).join("");
}
App.setCat = function (c) { activeCat = c; renderCatBar(); renderGrid(); };
App.renderGrid = renderGrid;
function renderGrid() {
  const q = ($("search")?.value || "").toLowerCase().trim();
  let list;
  if (activeCat === BEST) {
    list = products.filter((p) => (bestSellers[p.id] || 0) > 0).sort((a, b) => (bestSellers[b.id] || 0) - (bestSellers[a.id] || 0)).slice(0, 18);
  } else {
    list = products.filter((p) => activeCat === "ทั้งหมด" || p.category === activeCat);
  }
  if (q) list = list.filter((p) => productSearchText(p).includes(q));
  const emptyMsg = activeCat === BEST ? "ยังไม่มีข้อมูลสินค้าขายดี (ขายสักพักแล้วจะขึ้นเอง)" : "ไม่พบสินค้า";
  $("prodGrid").innerHTML = list.map((p) => {
    const low = p.stock <= 10;
    const kind = productSaleKind(p);
    const codeLine = p.code ? `<span class="code">${p.code}</span>` : "";
    return `<button class="prod ${p.stock <= 0 ? "out" : ""} ${kind ? "kind-" + kind.key : ""}" onclick="App.addToCart('${p.id}')">
      <span class="stk ${low ? "low" : ""}">เหลือ ${p.stock}</span>
      <span class="badges">${saleKindBadge(p)}${statusBadge(p)}</span>
      <span class="nm">${p.name}</span>
      <span class="pr">${baht(p.price)} <small>/${p.unit || "ชิ้น"}</small></span>${codeLine}</button>`;
  }).join("") || `<div class="empty" style="grid-column:1/-1">${emptyMsg}</div>`;
}
async function loadBestSellers() {
  try {
    const sales = await DB.getRecentSales(200);
    const agg = {};
    sales.filter((s) => s.status !== "void").forEach((s) => (s.sale_items || []).forEach((i) => { if (i.product_id) agg[i.product_id] = (agg[i.product_id] || 0) + i.qty; }));
    bestSellers = agg;
    topBestSellerIds = new Set(Object.entries(agg).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([id]) => id));
    renderGrid();
  } catch (e) { /* เงียบไว้ */ }
}
App.addToCart = function (id) {
  const p = products.find((x) => x.id === id); if (!p) return;
  const c = cart.find((x) => x.id === id); const now = c ? c.qty : 0;
  if (now >= p.stock) { toast("สต็อกไม่พอ"); return; }
  if (c) c.qty++; else cart.push({ id, qty: 1 });
  renderCart();
};
App.clearSearchSoon = function () {
  setTimeout(() => {
    const s = $("search");
    if (s && document.activeElement !== s && s.value) { s.value = ""; renderGrid(); }
  }, 200);
};
App.searchKey = function (e) {
  if (e.key !== "Enter") return;
  e.preventDefault();
  const q = ($("search").value || "").trim(); if (!q) return;
  const ql = q.toLowerCase();
  let p = products.find((x) => (x.code || "").toLowerCase() === ql);
  if (!p) {
    const exactNames = products.filter((x) => (x.name || "").toLowerCase() === ql);
    if (exactNames.length === 1) p = exactNames[0];
    else if (exactNames.length > 1) {
      activeCat = "ทั้งหมด"; renderCatBar(); renderGrid();
      toast("พบสินค้าชื่อเดียวกันหลายแบบ — เลือกจากการ์ดสินค้าโดยดูป้ายยกลัง/ราคา", true);
      return;
    }
  }
  if (!p) {
    const m = products.filter((x) => productSearchText(x).includes(ql));
    if (m.length === 1) p = m[0];
    else if (m.length > 1) {
      activeCat = "ทั้งหมด"; renderCatBar(); renderGrid();
      toast("พบหลายรายการ — เลือกสินค้าให้ตรง โดยดูป้ายยกลัง/ราคา", true);
      return;
    }
  }
  if (!p) { toast("ไม่พบสินค้า: " + q, true); return; }
  if (p.stock <= 0) { toast(p.name + " หมดสต็อก", true); $("search").value = ""; renderGrid(); return; }
  App.addToCart(p.id);
  $("search").value = ""; renderGrid(); $("search").focus();
  const kind = productSaleKind(p);
  toast("+1 " + p.name + (kind ? " · " + kind.label : "") + " ✓");
};
App.changeQty = function (id, d) {
  const c = cart.find((x) => x.id === id); if (!c) return;
  const p = products.find((x) => x.id === id);
  c.qty += d;
  if (c.qty <= 0) cart = cart.filter((x) => x.id !== id);
  else if (c.qty > p.stock) { c.qty = p.stock; toast("สต็อกไม่พอ"); }
  renderCart();
};
App.removeItem = function (id) {
  cart = cart.filter((x) => x.id !== id);
  renderCart();
};
App.setQty = function (id, val) {
  const c = cart.find((x) => x.id === id); if (!c) return;
  const p = products.find((x) => x.id === id);
  let q = parseInt(val, 10);
  if (isNaN(q) || q < 1) q = 1;
  if (p && q > p.stock) { q = p.stock; toast("สต็อกไม่พอ (เหลือ " + p.stock + ")"); }
  c.qty = q;
  renderCart();
};


function esc(s) {
  return String(s ?? "").replace(/[&<>"]/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[m]));
}
function loadHeldCarts() {
  try {
    const raw = localStorage.getItem(HELD_CARTS_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    heldCarts = Array.isArray(arr) ? arr.filter((h) => h && Array.isArray(h.items) && h.items.length) : [];
  } catch (e) { heldCarts = []; }
  return heldCarts;
}
function saveHeldCarts() {
  try { localStorage.setItem(HELD_CARTS_KEY, JSON.stringify(heldCarts.slice(0, 20))); }
  catch (e) { /* localStorage เต็ม/ถูกปิด ใช้งานต่อได้แต่ไม่บันทึก */ }
  updateHeldCartCount();
}
function makeHeldCartFromCurrent() {
  const cust = saleCustId ? customers.find((c) => c.id === saleCustId) : null;
  const items = cart.map((c) => {
    const p = products.find((x) => x.id === c.id);
    return { id: c.id, qty: c.qty, name: p?.name || "สินค้า", price: Number(p?.price || 0), unit: p?.unit || "" };
  }).filter((i) => i.id && i.qty > 0);
  return {
    id: "hc_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7),
    createdAt: new Date().toISOString(),
    customerId: saleCustId || null,
    customerName: cust?.name || "ลูกค้าทั่วไป",
    items,
    qty: items.reduce((a, i) => a + Number(i.qty || 0), 0),
    total: items.reduce((a, i) => a + Number(i.price || 0) * Number(i.qty || 0), 0),
  };
}
function heldDate(iso) {
  const d = new Date(iso || Date.now());
  return d.toLocaleString("th-TH", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}
function updateHeldCartCount() {
  const n = heldCarts.length;
  const b = $("heldCartsBtn");
  if (b) b.innerHTML = `🧺 ตะกร้าที่พักไว้ <b>${n}</b>`;
}
function renderHeldCartsList() {
  const box = $("heldCartsList"); if (!box) return;
  loadHeldCarts();
  if (!heldCarts.length) {
    box.innerHTML = '<div class="empty">ยังไม่มีตะกร้าที่พักไว้</div>';
    updateHeldCartCount();
    return;
  }
  box.innerHTML = heldCarts.map((h) => {
    const itemNames = (h.items || []).slice(0, 3).map((i) => `${esc(i.name || "สินค้า")} × ${Number(i.qty || 0)}`).join(" · ");
    const more = (h.items || []).length > 3 ? ` · +${(h.items || []).length - 3} รายการ` : "";
    const total = Number(h.total || 0);
    const qty = Number(h.qty || (h.items || []).reduce((a, i) => a + Number(i.qty || 0), 0));
    return `<div class="heldcart-row">
      <div class="heldcart-main">
        <div class="heldcart-title"><b>${esc(h.customerName || "ลูกค้าทั่วไป")}</b><span class="tag wait">พักไว้</span></div>
        <div class="heldcart-sub">${heldDate(h.createdAt)} · ${(h.items || []).length} รายการ / ${qty} ชิ้น · ${baht(total)}</div>
        <div class="heldcart-items">${itemNames}${more}</div>
      </div>
      <div class="heldcart-actions">
        <button class="mini" onclick="App.restoreHeldCart('${h.id}')">เรียกคืน</button>
        <button class="mini danger" onclick="App.deleteHeldCart('${h.id}')">ลบ</button>
      </div>
    </div>`;
  }).join("");
  updateHeldCartCount();
}

App.holdCart = function () {
  if (!cart.length) { toast("ยังไม่มีสินค้าให้พักตะกร้า"); return; }
  loadHeldCarts();
  const hold = makeHeldCartFromCurrent();
  if (!hold.items.length) return;
  heldCarts.unshift(hold);
  heldCarts = heldCarts.slice(0, 20);
  saveHeldCarts();
  cart = []; saleCustId = null;
  updateCustPick(); renderCart();
  toast("พักตะกร้าแล้ว ✓");
};
App.openHeldCarts = function () {
  renderHeldCartsList();
  $("heldCartsOverlay").classList.add("show");
};
App.closeHeldCarts = function () { $("heldCartsOverlay").classList.remove("show"); };
App.deleteHeldCart = function (id) {
  loadHeldCarts();
  heldCarts = heldCarts.filter((h) => h.id !== id);
  saveHeldCarts();
  renderHeldCartsList();
  toast("ลบตะกร้าที่พักไว้แล้ว");
};
App.restoreHeldCart = function (id) {
  loadHeldCarts();
  const h = heldCarts.find((x) => x.id === id);
  if (!h) { renderHeldCartsList(); return; }
  let changed = false;
  const restored = [];
  (h.items || []).forEach((it) => {
    const p = products.find((x) => x.id === it.id);
    if (!p || Number(p.stock || 0) <= 0) { changed = true; return; }
    const qty = Math.min(Number(it.qty || 0), Number(p.stock || 0));
    if (qty < Number(it.qty || 0)) changed = true;
    if (qty > 0) restored.push({ id: p.id, qty });
  });
  if (!restored.length) {
    renderHeldCartsList();
    toast("เรียกคืนไม่ได้ — สินค้าในตะกร้านี้หมดสต็อกแล้ว", true);
    return;
  }
  if (cart.length) {
    const ok = confirm("ตะกร้าปัจจุบันยังมีสินค้า\nกด OK เพื่อพักตะกร้าปัจจุบันก่อน แล้วเรียกคืนตะกร้านี้\nกด Cancel เพื่อยกเลิก");
    if (!ok) return;
    const cur = makeHeldCartFromCurrent();
    if (cur.items.length) heldCarts.unshift(cur);
  }
  heldCarts = heldCarts.filter((x) => x.id !== id);
  cart = restored;
  saleCustId = (h.customerId && customers.some((c) => c.id === h.customerId)) ? h.customerId : null;
  saveHeldCarts();
  updateCustPick(); renderCart(); renderHeldCartsList();
  App.closeHeldCarts();
  toast(changed ? "เรียกคืนแล้ว แต่บางรายการสต็อกไม่พอ" : "เรียกคืนตะกร้าแล้ว ✓");
};

// ============================================================
// ฟังก์ชันสำหรับปุ่ม "ยกเลิกรายการทั้งหมด" (แบบกดปุ๊บลบปั๊บ ไม่ถามซ้ำ)
// ============================================================
App.clearCart = function () {
  if (cart.length === 0) return; 
  cart = []; // เคลียร์ตะกร้าเป็น 0 ทันที
  renderCart(); // สั่งให้อัปเดตหน้าจอหลัก
  toast("ยกเลิกรายการทั้งหมดแล้ว 🗑️"); // ขึ้นข้อความแจ้งเตือนมุมจอ
};

const cartTotal = () => cart.reduce((s, c) => { const p = products.find((x) => x.id === c.id); return s + (p ? p.price * c.qty : 0); }, 0);
const cartQty = () => cart.reduce((s, c) => s + c.qty, 0);

// ---------- ตัวจัดการเชื่อมต่อจอลูกค้าข้ามเครื่อง (Supabase) ----------
const custChan = {
  postMessage: (data) => {
    if (typeof DB.sendToCustomerDisplay === "function") {
      DB.sendToCustomerDisplay(data);
    }
  }
};

function broadcastCustomer(extra) {
  const items = cart.map((c) => { const p = products.find((x) => x.id === c.id); return p ? { name: p.name, price: p.price, qty: c.qty, unit: p.unit } : null; }).filter(Boolean);
  custChan.postMessage(Object.assign({ type: "cart", items, total: cartTotal(), shop: SHOP.name }, extra || {}));
}

// จอลูกค้าเพิ่งเปิด (เช่นแท็บเล็ต) ขอสถานะมา → ส่งตะกร้าปัจจุบันให้ทันที
if (typeof DB.onCustomerSyncRequest === "function") {
  DB.onCustomerSyncRequest(() => broadcastCustomer());
}

// ============================================================
// เรนเดอร์ตะกร้าสินค้า (เพิ่มคำสั่งเสกปุ่มยกเลิกอัตโนมัติ)
// ============================================================
function renderCart() {
  const box = $("cartItems");
  if (!cart.length) box.innerHTML = '<div class="empty">ยังไม่มีสินค้า<br>แตะสินค้าหรือค้นหาเพื่อเพิ่ม</div>';
  else box.innerHTML = cart.map((c) => {
    const p = products.find((x) => x.id === c.id);
    return `<div class="ci">
      <div class="ci-row1">
        <div class="n">${p.name}</div>
        <button class="ci-del" type="button" onclick="App.removeItem('${c.id}')" aria-label="ลบ ${esc(p.name)}" title="ลบรายการ">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>
        </button>
      </div>
      <div class="ci-row2">
        <span class="p">${baht(p.price)} × ${c.qty}</span>
        <div class="qty"><button onclick="App.changeQty('${c.id}',-1)">−</button><input class="qin" type="number" inputmode="numeric" min="1" value="${c.qty}" onchange="App.setQty('${c.id}',this.value)" onfocus="this.select()"><button onclick="App.changeQty('${c.id}',1)">+</button></div>
        <span class="lt">${baht(p.price * c.qty)}</span>
      </div>
    </div>`;
  }).join("");
  $("cartCount").textContent = cart.length + " รายการ";
  document.title = cart.length > 0 ? `(${cart.length}) POS — ส่งเสริมการเกษตร` : "POS — ส่งเสริมการเกษตร";
  $("sumQty").textContent = cartQty();
  $("sumTotal").textContent = baht(cartTotal());
  $("payBtn").disabled = !cart.length;

  // --- ปุ่มพักตะกร้า / เรียกคืนตะกร้า / ยกเลิกรายการ ใต้ปุ่มชำระเงิน ---
  let holdActions = $("heldCartActions");
  if (!holdActions && $("payBtn")) {
    holdActions = document.createElement("div");
    holdActions.id = "heldCartActions";
    holdActions.style.cssText = "display:flex;gap:8px;margin-top:10px;";
    holdActions.innerHTML = `<button id="holdCartBtn" type="button" onclick="App.holdCart()" style="flex:1;padding:12px;background:#fff8e1;color:#8a5a00;border:1px solid #f3d27a;border-radius:8px;font-weight:700;cursor:pointer">⏸ พักตะกร้า</button><button id="heldCartsBtn" type="button" onclick="App.openHeldCarts()" style="flex:1;padding:12px;background:#e8f5e9;color:#1f6e28;border:1px solid #b7ddb9;border-radius:8px;font-weight:700;cursor:pointer">🧺 ตะกร้าที่พักไว้ <b>0</b></button>`;
    $("payBtn").parentNode.appendChild(holdActions);
  }
  if (holdActions) {
    const hb = $("holdCartBtn");
    if (hb) { hb.disabled = !cart.length; hb.style.opacity = cart.length ? "1" : ".55"; hb.style.cursor = cart.length ? "pointer" : "not-allowed"; }
  }
  updateHeldCartCount();

  let clearBtn = $("clearCartBtn");
  if (!clearBtn && $("payBtn")) {
     clearBtn = document.createElement("button");
     clearBtn.id = "clearCartBtn";
     clearBtn.onclick = App.clearCart;
     clearBtn.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg> ยกเลิกรายการ`;
     clearBtn.style.cssText = "width: 100%; margin-top: 10px; padding: 12px; background: #ffebee; color: #d32f2f; border: 1px solid #ffcdd2; border-radius: 8px; font-weight: 600; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 8px;";
     $("payBtn").parentNode.appendChild(clearBtn);
  }
  if (clearBtn) clearBtn.style.display = cart.length ? "flex" : "none";
  // --- จบโค้ดปุ่มตะกร้า ---

  broadcastCustomer();
}

// ---------- customer picker (cart) ----------
App.openCustPicker = function () { $("pickerSearch").value = ""; renderPicker(); $("custPickerOverlay").classList.add("show"); };
App.closeCustPicker = function () { $("custPickerOverlay").classList.remove("show"); };
App.renderPicker = renderPicker;
function renderPicker() {
  const q = ($("pickerSearch").value || "").toLowerCase().trim();
  const list = customers.filter((c) => !q || c.name.toLowerCase().includes(q) || (c.phone || "").includes(q));
  $("pickerList").innerHTML = list.length ? list.map((c) =>
    `<div class="pickrow" onclick="App.pickCust('${c.id}')"><div class="pn">${c.name}<small>${c.phone || "-"} ${c.area ? "· " + c.area : ""}</small></div>${owe(c.id) > 0 ? `<span class="owe">ค้าง ${baht(owe(c.id))}</span>` : ""}</div>`
  ).join("") : '<div class="empty">ยังไม่มีลูกค้า กด "+ ลูกค้าใหม่"</div>';
}
App.pickCust = function (id) { saleCustId = id; App.closeCustPicker(); updateCustPick(); };
App.clearCust = function () { saleCustId = null; updateCustPick(); };
function updateCustPick() {
  const t = $("custPickText"), x = $("custClear");
  if (saleCustId) {
    const c = customers.find((x) => x.id === saleCustId);
    t.innerHTML = `${c.name}${owe(c.id) > 0 ? ` <span class="owe">· ค้าง ${baht(owe(c.id))}</span>` : ""}`;
    x.classList.remove("hidden");
  } else { t.textContent = "+ เลือกลูกค้า (ไม่บังคับ)"; x.classList.add("hidden"); }
}

// ---------- checkout ----------
App.openCheckout = function () {
  if (!cart.length) return;
  const t = cartTotal();
  $("coTotal").textContent = baht(t);
  $("coCustLine").textContent = saleCustId ? "ลูกค้า: " + customers.find((c) => c.id === saleCustId).name : "ลูกค้าทั่วไป";
  $("received").value = "";
  const opts = [t, Math.ceil(t / 100) * 100, Math.ceil(t / 500) * 500, Math.ceil(t / 1000) * 1000];
  const uniq = [...new Set(opts)].filter((x) => x >= t);
  $("quickpay").innerHTML = uniq.map((v) => `<button onclick="App.setReceived(${v})">${baht(v)}</button>`).join("");
  $("ppRef").value = ""; $("cardRef").value = "";
  App.setFulfill("immediate");
  App.setPayType("cash");
  $("checkoutOverlay").classList.add("show");
};
App.closeCheckout = function () { $("checkoutOverlay").classList.remove("show"); broadcastCustomer(); };

App.setPayType = function (t) {
  payType = t;
  $("ptCash").className = t === "cash" ? "sel" : "";
  $("ptPromptpay").className = t === "promptpay" ? "sel" : "";
  $("ptCard").className = t === "farmer_card" ? "sel" : "";
  $("ptCredit").className = t === "credit" ? "sel cr" : "";
  $("cashBox").classList.toggle("hidden", t !== "cash");
  $("promptpayBox").classList.toggle("hidden", t !== "promptpay");
  $("cardBox").classList.toggle("hidden", t !== "farmer_card");
  $("creditBox").classList.toggle("hidden", t !== "credit");
  if (t !== "promptpay") broadcastCustomer();

  const btn = $("confirmBtn");
  if (t === "cash") {
    App.calcChange();
  } else if (t === "promptpay") {
    btn.disabled = false; btn.style.opacity = 1;
    showQR();
  } else if (t === "farmer_card") {
    btn.disabled = false; btn.style.opacity = 1;
  } else if (t === "credit") {
    const note = $("creditNote");
    if (!saleCustId) {
      note.textContent = "⚠ ต้องเลือกลูกค้าก่อนจึงจะขายเชื่อได้ — ปิดหน้านี้แล้วกด \"เลือกลูกค้า\"";
      btn.disabled = true; btn.style.opacity = .5;
    } else {
      const c = customers.find((x) => x.id === saleCustId), cur = owe(c.id);
      note.innerHTML = `ลงบัญชีเชื่อให้ <b>${c.name}</b><br>ยอดค้างเดิม ${baht(cur)} → หลังบิลนี้ ${baht(cur + cartTotal())}`;
      btn.disabled = false; btn.style.opacity = 1;
    }
  }
};

// สร้าง PromptPay QR ตามยอดเงินจริง
async function showQR() {
  const t = cartTotal();
  $("qrAmt").textContent = baht(t);
  try {
    const payload = generatePayload(SHOP.promptpayId, { amount: t });
    const url = await QRCode.toDataURL(payload, { margin: 1, width: 400 });
    $("qrImg").src = url;
    custChan.postMessage({ type: "qr", img: url, total: t });
  } catch (e) {
    $("qrImg").removeAttribute("src");
    toast("สร้าง QR ไม่สำเร็จ — ตรวจเลขพร้อมเพย์ใน config", true);
  }
}

App.setReceived = function (v) { $("received").value = v; App.calcChange(); };
App.calcChange = function () {
  const t = cartTotal(), r = parseFloat($("received").value) || 0, ch = r - t;
  const line = $("changeLine"); $("changeVal").textContent = baht(Math.abs(ch));
  const btn = $("confirmBtn");
  if (ch < 0) { line.classList.add("neg"); line.querySelector("span").textContent = "ยังขาดอีก"; btn.disabled = true; btn.style.opacity = .5; }
  else { line.classList.remove("neg"); line.querySelector("span").textContent = "เงินทอน"; btn.disabled = false; btn.style.opacity = 1; }
};

App.confirmSale = async function () {
  const t = cartTotal();
  let received = 0, change = 0, ref = null;

  if (payType === "cash") {
    received = parseFloat($("received").value) || 0;
    if (received < t) return;
    change = received - t;
  } else if (payType === "promptpay") {
    received = t; ref = $("ppRef").value.trim() || null;
  } else if (payType === "farmer_card") {
    received = t; ref = $("cardRef").value.trim() || null;
  } else if (payType === "credit") {
    if (!saleCustId) return;
  }

  const items = cart.map((c) => { const p = products.find((x) => x.id === c.id); return { id: c.id, name: p.name, price: p.price, qty: c.qty, unit: p.unit }; });
  const btn = $("confirmBtn"); btn.disabled = true; btn.textContent = "กำลังบันทึก...";
  try {
    const sale = await DB.createSale({ items, total: t, received, change, customerId: saleCustId, payType, ref, fulfillment: fulfillMode });
    await buildReceipt(sale, items);
    custChan.postMessage({ type: "done" });
    App.closeCheckout();
    cart = []; saleCustId = null; updateCustPick(); renderCart();
    [products, balances, todaySales, pendingSales, creditPaid] = await Promise.all([DB.getProducts(), DB.getCustomerBalances(), DB.getTodaySales(), DB.getPendingPickups(), DB.getCreditPaidMap()]);
    renderGrid();
    $("receiptOverlay").classList.add("show");
    setTimeout(() => window.print(), 300);
    toast(payType === "credit" ? "ลงบัญชีขายเชื่อแล้ว ✓" : "บันทึกการขายแล้ว ✓");
  } catch (e) {
    toast("บันทึกไม่สำเร็จ: " + (e.message || "ลองใหม่"), true);
  } finally {
    btn.textContent = "ยืนยัน + ปริ้นใบเสร็จ";
  }
};

App.closeReceipt = function () { $("receiptOverlay").classList.remove("show"); };

async function buildPromptPayReceiptQR(sale) {
  if (!sale || sale.pay_type !== "promptpay" || sale.status === "void" || !SHOP.promptpayId) return "";
  try {
    const amount = Number(sale.total || 0);
    const payload = generatePayload(SHOP.promptpayId, { amount });
    const url = await QRCode.toDataURL(payload, { margin: 1, width: 260 });
    return `<div class="receipt-qr">
        <div class="qr-title">QR พร้อมเพย์</div>
        <img src="${url}" alt="PromptPay QR">
        <div class="qr-amount">ยอดชำระ ${baht(amount)}</div>
      </div>`;
  } catch (e) {
    console.warn("Receipt QR generation failed", e);
    return "";
  }
}

async function buildReceipt(sale, items) {
  const now = new Date(sale.created_at || Date.now());
  const dateStr = now.toLocaleString("th-TH", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
  const cust = sale.customer_id ? customers.find((c) => c.id === sale.customer_id) : null;
  const lines = items.map((it) => `<div class="ritem"><div class="top"><span>${it.name}</span><span>${baht(it.price * it.qty)}</span></div><div class="sub">${baht(it.price)} × ${it.qty} ${it.unit || ""}</div></div>`).join("");
  const receiptQR = await buildPromptPayReceiptQR(sale);

  let titleTxt = "ใบเสร็จรับเงิน";
  if (sale.pay_type === "credit") {
    const stt = creditPaid[sale.id];
    const remt = stt ? stt.remaining : Number(sale.total);
    titleTxt = remt <= 0.001 ? "ใบเสร็จรับเงิน" : "ใบรับสินค้า";
  }
  // ป้ายสถานะการรับสินค้า (เด่นชัดแบบสแตมป์)
  let fulfillStamp = "";
  if (sale.fulfillment === "deferred") {
    fulfillStamp = sale.pay_type === "credit"
      ? '<div class="rstatus" style="color:#d9772b;border-color:#d9772b">** รอรับสินค้า **</div>'
      : '<div class="rstatus" style="color:#d9772b;border-color:#d9772b">** ชำระแล้ว · รอรับสินค้า **</div>';
  } else if (sale.fulfillment === "complete") {
    fulfillStamp = '<div class="rstatus" style="color:var(--grn2);border-color:var(--grn2)">** รับสินค้าครบแล้ว **</div>';
  }

  let payRows = "";
  if (sale.pay_type === "cash") {
    payRows = `<div class="rrow"><span>ชำระโดย</span><span>เงินสด</span></div><div class="rrow"><span>รับเงิน</span><span>${baht(sale.received)}</span></div><div class="rrow"><span>เงินทอน</span><span>${baht(sale.change)}</span></div>`;
  } else if (sale.pay_type === "promptpay") {
    payRows = `<div class="rrow"><span>ชำระโดย</span><span>พร้อมเพย์ (QR)</span></div>${sale.ref ? `<div class="rrow"><span>อ้างอิง</span><span>${sale.ref}</span></div>` : ""}`;
  } else if (sale.pay_type === "farmer_card") {
    payRows = `<div class="rrow"><span>ชำระโดย</span><span>บัตรสินเชื่อเกษตรกร</span></div>${sale.ref ? `<div class="rrow"><span>เลขอนุมัติ</span><span>${sale.ref}</span></div>` : ""}`;
  } else {
    const st = creditPaid[sale.id];
    const total = Number(sale.total);
    const rem = st ? st.remaining : total;
    const paid = st ? st.paid : 0;
    if (rem <= 0.001) {
      payRows = `<div class="rrow"><span>ชำระโดย</span><span>ขายเชื่อ (ชำระครบแล้ว)</span></div><div class="rrow"><span>ยอดบิลนี้</span><span>${baht(total)}</span></div><div class="rstatus">** ชำระครบแล้ว **</div>`;
    } else if (paid > 0.001) {
      payRows = `<div class="rrow"><span>ชำระโดย</span><span>ขายเชื่อ / ลงบัญชี</span></div><div class="rrow"><span>ยอดบิลนี้</span><span>${baht(total)}</span></div><div class="rrow"><span>ชำระแล้ว</span><span>${baht(paid)}</span></div><div class="rrow" style="font-weight:700"><span>คงเหลือบิลนี้</span><span>${baht(rem)}</span></div><div class="rstatus">** ชำระบางส่วน **</div>`;
    } else {
      payRows = `<div class="rrow"><span>ชำระโดย</span><span>ขายเชื่อ / ลงบัญชี</span></div><div class="rrow" style="font-weight:700"><span>ยอดค้างบิลนี้</span><span>${baht(total)}</span></div><div class="rstatus">** ค้างชำระ **</div>`;
    }
  }

  $("rcptContent").innerHTML = `
    <div class="rhead">
      ${RCPT_LOGO}<div class="shop">${SHOP.name}</div>
      <div class="ctr">${SHOP.address}</div>
      ${SHOP.taxId ? `<div class="ctr">เลขประจำตัวผู้เสียภาษี : ${SHOP.taxId}</div>` : ""}
      <div class="ctr">โทร. ${SHOP.phone}</div>
    </div>
    <div class="rtitle">${titleTxt}</div>
    <div class="rrow"><span>เลขที่บิล</span><span>${sale.bill_no}</span></div>
    <div class="rrow"><span>วันที่</span><span>${dateStr}</span></div>
    ${cust ? `<div class="rrow"><span>ลูกค้า</span><span>${cust.name}</span></div>` : ""}
    <div class="rline"></div>
    <div class="ritems-head"><span>รายการ</span><span>จำนวนเงิน</span></div>
    ${lines}
    <div class="rline"></div>
    <div class="rtotal"><span>รวมทั้งสิ้น</span><b>${baht(sale.total)}</b></div>
    ${payRows}
    ${sale.pay_type === "promptpay" ? '<div class="rline"></div>' : '<div class="rline thin"></div>'}
    ${sale.status === "void" ? '<div class="rstatus">** ยกเลิกแล้ว / VOID **</div>' : ""}
    ${fulfillStamp}
    ${receiptQR}
    ${sale.pay_type === "promptpay" ? '<div class="rline thin"></div>' : ""}
    <div class="rfoot">ขอบคุณที่ใช้บริการ</div>`;
}

function genDocNo(prefix) {
  const d = new Date(), z = (n) => String(n).padStart(2, "0");
  return `${prefix}-${String(d.getFullYear()).slice(-2)}${z(d.getMonth() + 1)}${z(d.getDate())}-${z(d.getHours())}${z(d.getMinutes())}${z(d.getSeconds())}`;
}

// ใบเสร็จชำระยอดค้าง (ลูกค้าค้างเชื่อ มาจ่ายภายหลัง) — แบบแจกแจงประวัติการชำระ
function buildPaymentReceipt(p) {
  const dateStr = (p.date || new Date()).toLocaleString("th-TH", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
  const dfmt = (d) => d.toLocaleString("th-TH", { day: "2-digit", month: "2-digit", year: "numeric" });
  const settled = p.remaining <= 0.001;
  const payLines = (p.payList || []).map((x, i) => {
    const last = i === p.payList.length - 1;
    return `<div class="rrow"${last ? ' style="font-weight:700"' : ""}><span>${dfmt(x.date)}${last ? " (ครั้งนี้)" : ""}</span><span>${baht(x.amount)}</span></div>`;
  }).join("");
  $("rcptContent").innerHTML = `
    <div class="rhead">
      ${RCPT_LOGO}<div class="shop">${SHOP.name}</div>
      <div class="ctr">${SHOP.address}</div>
      ${SHOP.taxId ? `<div class="ctr">เลขประจำตัวผู้เสียภาษี : ${SHOP.taxId}</div>` : ""}
      <div class="ctr">โทร. ${SHOP.phone}</div>
    </div>
    <div class="rtitle">ใบเสร็จชำระยอดค้าง</div>
    <div class="rrow"><span>เลขที่เอกสาร</span><span>${p.docNo}</span></div>
    <div class="rrow"><span>วันที่</span><span>${dateStr}</span></div>
    <div class="rrow"><span>ลูกค้า</span><span>${p.name}</span></div>
    <div class="rline"></div>
    <div class="rrow" style="font-weight:700"><span>ยอดค้างรวมทั้งหมด</span><span>${baht(p.totalDebt)}</span></div>
    <div class="rline thin"></div>
    <div class="ritems-head"><span>ประวัติการชำระ</span><span>จำนวนเงิน</span></div>
    ${payLines}
    <div class="rline thin"></div>
    <div class="rrow"><span>รวมชำระแล้ว</span><span>${baht(p.totalPaid)}</span></div>
    <div class="rtotal"><span>ยอดคงเหลือ</span><b>${baht(p.remaining)}</b></div>
    ${settled ? `<div class="rstatus">** ชำระครบแล้ว **</div>` : ""}
    <div class="rline"></div>
    <div class="rrow"><span>ชำระโดย</span><span>เงินสด</span></div>
    <div class="rsign" style="margin-top:14px">ผู้รับเงิน ...............................</div>
    <div class="rline thin"></div>
    <div class="rfoot">ขอบคุณที่ใช้บริการ</div>`;
}

function buildCreditStatementReceipt(c, bills) {
  const lines = bills.map((b) => `
    <div class="ritem">
      <div class="top"><span>${b.billNo}</span><span>${baht(b.remaining)}</span></div>
      <div class="sub">วันที่ ${billDate(b.date)} · ยอดบิล ${baht(b.total)} · ชำระแล้ว ${baht(b.paid)}</div>
    </div>`).join("");
  const total = bills.reduce((a, b) => a + b.remaining, 0);
  $("rcptContent").innerHTML = `
    <div class="rhead">
      ${RCPT_LOGO}<div class="shop">${SHOP.name}</div>
      <div class="ctr">${SHOP.address}</div>
      ${SHOP.taxId ? `<div class="ctr">เลขประจำตัวผู้เสียภาษี : ${SHOP.taxId}</div>` : ""}
      <div class="ctr">โทร. ${SHOP.phone}</div>
    </div>
    <div class="rtitle">ใบแจกแจงยอดค้างชำระ</div>
    <div class="rrow"><span>เลขที่เอกสาร</span><span>${genDocNo("ST")}</span></div>
    <div class="rrow"><span>วันที่พิมพ์</span><span>${new Date().toLocaleString("th-TH", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" })}</span></div>
    <div class="rrow"><span>ลูกค้า</span><span>${c.name}</span></div>
    <div class="rline"></div>
    <div class="ritems-head"><span>บิลที่ค้าง</span><span>ยอดค้าง</span></div>
    ${lines}
    <div class="rline"></div>
    <div class="rtotal"><span>ยอดค้างรวมทั้งหมด</span><b>${baht(total)}</b></div>
    <div class="rline thin"></div>
    <div class="rsign"><div>ผู้รับทราบยอด ______________________</div><div>ผู้แจ้งยอด ______________________</div></div>`;
}

// ============================================================
//  รอรับสินค้า (จ่ายแล้ว รับของภายหลัง / ทยอยรับ)
// ============================================================
App.setFulfill = function (m) {
  fulfillMode = m;
  $("flNow").className = m === "immediate" ? "sel" : "";
  $("flLater").className = m === "deferred" ? "sel" : "";
};

function renderPickups() {
  const q = ($("pickupSearch")?.value || "").toLowerCase().trim();
  const list = pendingSales.filter((s) => !q || (s.bill_no || "").toLowerCase().includes(q) || (s.customers?.name || "").toLowerCase().includes(q));
  const totalRemain = pendingSales.reduce((a, s) => a + (s.remainingTotal || 0), 0);
  $("pickupSub").textContent = `รอรับ ${pendingSales.length} บิล · ค้างส่งมอบรวม ${totalRemain} ชิ้น`;
  $("pickupBody").innerHTML = list.length ? list.map((s) => {
    const cname = s.customers?.name || "ทั่วไป";
    const delivered = (s.lines || []).reduce((a, l) => a + l.delivered, 0);
    const status = delivered > 0 ? '<span class="tag part">รับบางส่วน</span>' : '<span class="tag wait">ยังไม่รับ</span>';
    return `<tr class="clk" onclick="App.openPickup('${s.id}')"><td>${new Date(s.created_at).toLocaleDateString("th-TH", { day: "2-digit", month: "short" })}</td><td>${s.bill_no}</td><td>${cname}</td><td>${status}</td><td class="num">${s.remainingTotal}</td><td class="num">${baht(s.total)}</td></tr>`;
  }).join("") : '<tr><td colspan="6" style="text-align:center;color:var(--muted)">ไม่มีบิลรอรับสินค้า</td></tr>';
}
App.renderPickups = renderPickups;

App.openPickup = async function (id) {
  pickupSaleId = id; pickupDetail = null;
  $("puTitle").textContent = "บันทึกรับสินค้า";
  $("puMeta").textContent = "กำลังโหลด...";
  $("puBody").innerHTML = "";
  $("pickupOverlay").classList.add("show");
  try {
    const d = await DB.getPickupDetail(id);
    pickupDetail = d;
    const cname = d.customers?.name || "ลูกค้าทั่วไป";
    $("puMeta").textContent = `บิล ${d.bill_no} · ${cname} · ${new Date(d.created_at).toLocaleDateString("th-TH", { day: "2-digit", month: "short", year: "numeric" })}`;
    $("puBody").innerHTML = d.lines.map((l) => `<tr>
      <td>${l.name}</td>
      <td class="num">${l.qty}</td>
      <td class="num">${l.delivered}</td>
      <td class="num">${l.remaining}</td>
      <td class="num"><input type="number" class="pu-inp" data-si="${l.id}" data-rem="${l.remaining}" value="${l.remaining}" min="0" max="${l.remaining}" ${l.remaining <= 0 ? "disabled" : ""}></td>
    </tr>`).join("");
  } catch (e) { $("puMeta").textContent = "โหลดข้อมูลไม่สำเร็จ"; }
};
App.closePickup = function () { $("pickupOverlay").classList.remove("show"); };
App.fillAllPickup = function () {
  document.querySelectorAll("#puBody .pu-inp").forEach((inp) => { if (!inp.disabled) inp.value = inp.dataset.rem; });
};
App.savePickup = async function () {
  if (!pickupDetail) return;
  const lines = [];
  document.querySelectorAll("#puBody .pu-inp").forEach((inp) => {
    const qty = parseInt(inp.value) || 0, rem = parseInt(inp.dataset.rem) || 0;
    if (qty > 0) lines.push({ sale_item_id: inp.dataset.si, qty: Math.min(qty, rem) });
  });
  if (!lines.length) { toast("ยังไม่ได้ระบุจำนวนที่รับ"); return; }
  try {
    await DB.recordDelivery(pickupSaleId, lines, null);
    const deliveredLines = lines.map((l) => {
      const li = pickupDetail.lines.find((x) => x.id === l.sale_item_id);
      return { name: li.name, qty: l.qty, unit: li.unit };
    });
    pendingSales = await DB.getPendingPickups();
    const fresh = await DB.getPickupDetail(pickupSaleId).catch(() => null);
    const remainingAfter = fresh ? fresh.remainingTotal : 0;
    buildDeliverySlip(pickupDetail, deliveredLines, remainingAfter, remainingAfter <= 0);
    App.closePickup();
    renderPickups();
    $("receiptOverlay").classList.add("show");
    toast("บันทึกการรับสินค้าแล้ว ✓");
  } catch (e) { toast("บันทึกไม่สำเร็จ: " + (e.message || "ลองใหม่"), true); }
};

function buildDeliverySlip(sale, delivered, remainingAfter, complete) {
  const now = new Date();
  const dateStr = now.toLocaleString("th-TH", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
  const custName = sale.customers?.name || (sale.customer_id ? (customers.find((c) => c.id === sale.customer_id) || {}).name : null);
  const lines = delivered.map((it) => `<div class="ritem"><div class="top"><span>${it.name}</span><span>${it.qty} ${it.unit || ""}</span></div></div>`).join("");
  $("rcptContent").innerHTML = `
    <div class="rhead">
      ${RCPT_LOGO}<div class="shop">${SHOP.name}</div>
      <div class="ctr">${SHOP.address}</div>
      ${SHOP.taxId ? `<div class="ctr">เลขประจำตัวผู้เสียภาษี : ${SHOP.taxId}</div>` : ""}
      <div class="ctr">โทร. ${SHOP.phone}</div>
    </div>
    <div class="rtitle">ใบส่งมอบสินค้า</div>
    <div class="rrow"><span>อ้างอิงบิล</span><span>${sale.bill_no}</span></div>
    <div class="rrow"><span>วันที่รับ</span><span>${dateStr}</span></div>
    ${custName ? `<div class="rrow"><span>ลูกค้า</span><span>${custName}</span></div>` : ""}
    <div class="rline"></div>
    <div class="ritems-head"><span>รายการที่รับ</span><span>จำนวน</span></div>
    ${lines}
    <div class="rline"></div>
    <div class="rrow" style="font-weight:700"><span>สถานะ</span><span>${complete ? "รับครบแล้ว" : "ยังเหลือรับ " + remainingAfter + " ชิ้น"}</span></div>
    <div class="rline thin"></div>
    <div class="rsign"><div>ผู้รับสินค้า ______________________</div><div>ผู้ส่งมอบ ______________________</div></div>`;
}

// ============================================================
//  LOW STOCK BANNER
// ============================================================
function showLowStockBanner(msg) {
  let el = document.getElementById("lowStockBanner");
  if (!el) {
    el = document.createElement("div");
    el.id = "lowStockBanner";
    el.style.cssText = "position:fixed;top:0;left:0;right:0;z-index:200;background:#e65c00;color:#fff;font-size:14px;font-weight:600;padding:10px 16px;display:flex;align-items:center;justify-content:space-between;gap:12px;box-shadow:0 2px 8px rgba(0,0,0,.2)";
    document.body.prepend(el);
  }
  el.innerHTML = `<span>${msg}</span><div style="display:flex;gap:8px"><button onclick="App.switchTab('stock')" style="background:rgba(255,255,255,.25);border:none;color:#fff;font-weight:700;padding:5px 12px;border-radius:8px;cursor:pointer;font-size:13px">ดูสต็อก</button><button onclick="this.closest('#lowStockBanner').remove()" style="background:none;border:none;color:#fff;cursor:pointer;font-size:18px;line-height:1;padding:0 4px">×</button></div>`;
}

// ============================================================
//  CUSTOMERS
// ============================================================
App.renderCustomers = renderCustomers;
function renderCustomers() {
  const q = ($("custSearch").value || "").toLowerCase().trim();
  const list = customers.filter((c) => !q || c.name.toLowerCase().includes(q) || (c.phone || "").includes(q));
  const totalOwe = customers.reduce((a, c) => a + owe(c.id), 0);
  $("custSub").textContent = `ทั้งหมด ${customers.length} ราย · ยอดค้างชำระรวม ${baht(totalOwe)}`;
  $("custBody").innerHTML = list.length ? list.map((c) => {
    const o = owe(c.id), b = balances[c.id] || { count: 0 };
    return `<tr class="clk" onclick="App.openCustDetail('${c.id}')"><td>${c.name}</td><td>${c.phone || "-"}</td><td style="color:var(--muted)">${c.area || "-"}</td><td class="num">${b.count}</td><td class="num"><span class="owe ${o <= 0 ? "zero" : ""}">${o > 0 ? baht(o) : "-"}</span></td></tr>`;
  }).join("") : '<tr><td colspan="5" style="text-align:center;color:var(--muted)">ยังไม่มีลูกค้า</td></tr>';
}
App.openCustomer = function (id, fromPicker) {
  editCustId = id || null; custFromPicker = !!fromPicker;
  $("custModalTitle").textContent = id ? "แก้ไขลูกค้า" : "เพิ่มลูกค้า";
  const c = id ? customers.find((x) => x.id === id) : { name: "", phone: "", area: "", note: "" };
  $("cName").value = c.name; $("cPhone").value = c.phone || ""; $("cArea").value = c.area || ""; $("cNote").value = c.note || "";
  App.closeCustPicker(); App.closeCustDetail();
  $("customerOverlay").classList.add("show");
};
App.editCurrentCustomer = function () { App.openCustomer(currentCustId); };
App.closeCustomer = function () { $("customerOverlay").classList.remove("show"); };
App.saveCustomer = async function () {
  const name = $("cName").value.trim(); if (!name) { toast("กรุณาใส่ชื่อลูกค้า"); return; }
  try {
    const id = await DB.saveCustomer({ id: editCustId, name, phone: $("cPhone").value.trim(), area: $("cArea").value.trim(), note: $("cNote").value.trim() });
    customers = await DB.getCustomers();
    App.closeCustomer();
    if (custFromPicker) { saleCustId = id; updateCustPick(); }
    renderCustomers(); toast("บันทึกลูกค้าแล้ว ✓");
  } catch (e) { toast("บันทึกไม่สำเร็จ", true); }
};
App.openCustDetail = async function (id) {
  currentCustId = id; const c = customers.find((x) => x.id === id);
  $("cdName").textContent = c.name;
  $("cdMeta").textContent = `${c.phone || "ไม่มีเบอร์"} ${c.area ? "· " + c.area : ""} ${c.note ? "· " + c.note : ""}`;
  $("cdTotal").textContent = baht(balances[id]?.total || 0);
  const o = owe(id);
  $("cdOwe").textContent = baht(o);
  $("cdPayBox").style.display = o > 0 ? "flex" : "none";
  $("cdPayAmt").value = "";
  if ($("cdCreditBox")) $("cdCreditBox").style.display = "none";
  if ($("cdCreditBills")) $("cdCreditBills").innerHTML = "";
  currentCustomerSales = [];
  currentCreditBills = [];
  selectedCreditBills = new Set();
  $("cdHist").innerHTML = '<div class="empty">กำลังโหลด...</div>';
  $("custDetailOverlay").classList.add("show");
  try {
    const { sales, payments } = await DB.getCustomerHistory(id);
    currentCustomerSales = sales || [];
    // คำนวณยอดสดจากประวัติจริง กันยอดแคชเพี้ยน (เช่น จ่ายปิดยอดแล้วซื้อเชื่อใหม่วันเดียวกัน)
    const _valid = (sales || []).filter((s) => s.status !== "void");
    const _total = _valid.reduce((a, s) => a + Number(s.total), 0);
    const _creditBills = creditBillStatuses(sales || [], payments || []);
    const _owe = _creditBills.reduce((a, b) => a + b.remaining, 0);
    $("cdTotal").textContent = baht(_total);
    $("cdOwe").textContent = baht(_owe);
    $("cdPayBox").style.display = _owe > 0 ? "flex" : "none";
    renderCreditBillList(_creditBills);
    const rows = (sales || []).map((s) => {
      const isVoid = s.status === "void";
      const st = _creditBills.find((b) => b.sale.id === s.id);
      const creditInfo = st && st.remaining > 0.001 ? ` <span class="tag cr">ค้าง ${baht(st.remaining)}</span>` : "";
      const reprintBtn = `<button class="mini" type="button" onclick="event.stopPropagation();App.reprintCustomerSale('${s.id}')">พิมพ์ซ้ำ</button>`;
      return `<div class="histrow"${isVoid ? ' style="opacity:.55"' : ""}><div><div>${(s.sale_items || []).length} รายการ · ${(s.sale_items || []).reduce((a, i) => a + i.qty, 0)} ชิ้น<span class="tag ${s.pay_type === "credit" ? "cr" : "cash"}">${PAY_LABEL[s.pay_type] || s.pay_type}</span>${creditInfo}${isVoid ? '<span class="tag" style="background:#fdecea;color:#c0392b;margin-left:4px">ยกเลิกแล้ว</span>' : ""}</div><div class="hl">${s.bill_no} · ${new Date(s.created_at).toLocaleString("th-TH", { day: "2-digit", month: "short", year: "2-digit", hour: "2-digit", minute: "2-digit" })}</div></div><div style="display:flex;align-items:center;gap:6px;font-family:var(--font);font-weight:600${isVoid ? ";text-decoration:line-through" : ""}"><span>${baht(s.total)}</span>${reprintBtn}</div></div>`;
    });
    const payRows = payments.map((p) => `<div class="histrow"><div><div style="color:var(--accent)">รับชำระหนี้</div><div class="hl">${new Date(p.created_at).toLocaleString("th-TH", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}</div></div><div style="font-family:var(--font);font-weight:600;color:var(--accent)">−${baht(p.amount)}</div></div>`);
    const all = [...rows, ...payRows];
    $("cdHist").innerHTML = all.length ? all.join("") : '<div class="empty">ยังไม่มีประวัติ</div>';
  } catch (e) { $("cdHist").innerHTML = '<div class="empty">โหลดประวัติไม่สำเร็จ</div>'; }
};
App.toggleCreditBill = function (saleId, checked) {
  if (checked) selectedCreditBills.add(saleId);
  else selectedCreditBills.delete(saleId);
  updateSelectedCreditAmount();
};
App.selectAllBills = function () {
  if (!currentCreditBills.length) return;
  const allSelected = currentCreditBills.every((b) => selectedCreditBills.has(b.sale.id));
  selectedCreditBills = new Set(allSelected ? [] : currentCreditBills.map((b) => b.sale.id));
  document.querySelectorAll("#cdCreditBills input[type='checkbox']").forEach((cb) => { cb.checked = !allSelected; });
  updateSelectedCreditAmount();
};
App.reprintCustomerSale = async function (saleId) {
  const s = currentCustomerSales.find((x) => x.id === saleId)
    || currentCreditBills.find((b) => b.sale.id === saleId)?.sale
    || findSale(saleId);
  if (!s) { toast("ไม่พบบิลนี้", true); return; }
  const items = (s.sale_items || []).map((it) => ({ name: it.name, price: it.price, qty: it.qty, unit: it.unit }));
  await buildReceipt(s, items);
  $("receiptOverlay").classList.add("show");
};
App.printCreditStatement = function () {
  const c = customers.find((x) => x.id === currentCustId);
  const selected = currentCreditBills.filter((b) => selectedCreditBills.has(b.sale.id));
  const list = selected.length ? selected : currentCreditBills;
  if (!c || !list.length) { toast("ไม่มีบิลค้างชำระให้พิมพ์", true); return; }
  buildCreditStatementReceipt(c, list);
  $("receiptOverlay").classList.add("show");
  setTimeout(() => window.print(), 300);
};
App.closeCustDetail = function () { $("custDetailOverlay").classList.remove("show"); };
App.deleteCurrentCustomer = async function () {
  const c = customers.find((x) => x.id === currentCustId);
  if (!c) return;
  try {
    // เช็คยอดค้างสดจากประวัติจริง กันลบลูกค้าที่ยังค้างเงิน
    const { sales, payments } = await DB.getCustomerHistory(currentCustId);
    const valid = (sales || []).filter((s) => s.status !== "void");
    const credit = valid.filter((s) => s.pay_type === "credit").reduce((a, s) => a + Number(s.total), 0);
    const paid = (payments || []).reduce((a, p) => a + Number(p.amount), 0);
    const o = Math.max(0, credit - paid);
    if (o > 0) {
      alert(`ลบไม่ได้ค้าบ — ลูกค้า "${c.name}" ยังมียอดค้างชำระ ${baht(o)}\nกรุณาเคลียร์ยอดค้างให้เป็น ฿0 ก่อนจึงจะลบได้`);
      return;
    }
  } catch (e) { toast("เช็คยอดค้างไม่สำเร็จ ลองใหม่อีกครั้ง", true); return; }
  const _typed = prompt(`พิมพ์ชื่อลูกค้าเพื่อยืนยันการลบ:\n"${c.name}"\n\n⚠️ ข้อมูลการรับชำระจะถูกลบถาวร`);
  if (_typed === null) return;
  if (_typed.trim() !== c.name.trim()) { toast("ชื่อลูกค้าไม่ตรง — ยกเลิกการลบ", true); return; }
  try {
    await DB.deleteCustomer(currentCustId);
    [customers, balances] = await Promise.all([DB.getCustomers(), DB.getCustomerBalances()]);
    App.closeCustDetail();
    renderCustomers();
    toast("ลบลูกค้าแล้ว ✓");
  } catch (e) { toast("ลบไม่สำเร็จ", true); }
};
App.recordPayment = async function () {
  const amt = parseFloat($("cdPayAmt").value) || 0;
  if (amt <= 0) { toast("ใส่จำนวนเงิน"); return; }
  const oweBefore = owe(currentCustId);
  if (amt > oweBefore + 0.001 && !confirm(`ยอดที่รับ (${baht(amt)}) มากกว่ายอดค้าง (${baht(oweBefore)}) ดำเนินการต่อ?`)) return;
  try {
    await DB.recordPayment(currentCustId, amt);
    [balances, creditPaid] = await Promise.all([DB.getCustomerBalances(), DB.getCreditPaidMap()]);
    const c = customers.find((x) => x.id === currentCustId);
    // ดึงประวัติเพื่อทำใบแจกแจงหนี้ (ยอดหนี้รวม + ประวัติชำระ + คงเหลือ)
    const { sales, payments } = await DB.getCustomerHistory(currentCustId);
    const totalDebt = (sales || []).filter((s) => s.pay_type === "credit" && s.status !== "void").reduce((a, s) => a + Number(s.total), 0);
    const payList = (payments || []).map((x) => ({ date: new Date(x.created_at), amount: Number(x.amount) })).sort((a, b) => a.date - b.date);
    const totalPaid = payList.reduce((a, x) => a + x.amount, 0);
    const remaining = Math.max(0, totalDebt - totalPaid);
    await App.openCustDetail(currentCustId);
    renderCustomers();
    // ออกใบเสร็จชำระยอดค้าง + พิมพ์อัตโนมัติ
    buildPaymentReceipt({ name: c ? c.name : "-", docNo: genDocNo("RC"), date: new Date(), totalDebt, payList, totalPaid, remaining });
    $("receiptOverlay").classList.add("show");
    setTimeout(() => window.print(), 300);
    toast("บันทึกรับชำระแล้ว ✓");
  } catch (e) { toast("บันทึกไม่สำเร็จ", true); }
};

// ============================================================
//  STOCK
// ============================================================
App.renderStock = renderStock;
let stockLowOnly = false;
let stockSortKey = "name", stockSortDir = "asc";
App.sortStock = function (key) {
  if (stockSortKey === key) stockSortDir = stockSortDir === "asc" ? "desc" : "asc";
  else { stockSortKey = key; stockSortDir = "asc"; }
  renderStock();
};
App.toggleLowStock = function () { stockLowOnly = !stockLowOnly; renderStock(); };
function renderStock() {
  const sel = $("stockCat");
  if (sel) {
    const cats = [...new Set(products.map((p) => p.category).filter(Boolean))].sort((a, b) => a.localeCompare(b, "th"));
    const cur = sel.value || "";
    sel.innerHTML = '<option value="">ทุกหมวด</option>' + cats.map((c) => `<option value="${c}">${c}</option>`).join("");
    sel.value = cur;
  }
  const cat = sel ? sel.value : "";
  const q = ($("stockSearch").value || "").toLowerCase().trim();
  const base = products.filter((p) => (!cat || p.category === cat) && (!q || productSearchText(p).includes(q)));
  const lowCount = base.filter((p) => p.stock <= 10).length;
  const tg = $("lowToggle");
  if (tg) { tg.textContent = `ใกล้หมด${lowCount ? ` (${lowCount})` : ""}`; tg.classList.toggle("on", stockLowOnly); }
  const list = stockLowOnly ? base.filter((p) => p.stock <= 10) : base;
  const sorted = list.slice();
  const dir = stockSortDir === "desc" ? -1 : 1;
  sorted.sort((a, b) => {
    let r;
    if (stockSortKey === "price") r = a.price - b.price;
    else if (stockSortKey === "profit") r = (a.price - (a.cost || 0)) - (b.price - (b.cost || 0));
    else if (stockSortKey === "stock") r = a.stock - b.stock;
    else r = a.name.localeCompare(b.name, "th");
    return r * dir;
  });
  ["name", "price", "profit", "stock"].forEach((k) => {
    const th = $("th-" + k); if (!th) return;
    th.classList.toggle("active", stockSortKey === k);
    const ar = th.querySelector(".sarrow");
    if (ar) ar.textContent = stockSortKey === k ? (stockSortDir === "asc" ? " ▲" : " ▼") : "";
  });
  const val = list.reduce((s, p) => s + p.price * p.stock, 0);
  $("stockSub").textContent = `${cat || "ทุกหมวด"} · ${list.length} รายการ · มูลค่าสต็อก ${baht(val)} · ใกล้หมด ${lowCount}`;
  $("stockBody").innerHTML = sorted.map((p, i) => {
    const low = p.stock <= 10;
    const profit = (p.price || 0) - (p.cost || 0);
    const margin = p.price > 0 ? Math.round(profit / p.price * 100) : 0;
    const pColor = profit > 0 ? "var(--grn2)" : (profit < 0 ? "var(--danger)" : "var(--muted)");
    return `<tr><td style="color:var(--muted)">${i + 1}</td><td style="color:var(--muted);font-family:var(--font);font-size:13px">${p.code || "-"}</td><td><div class="stock-name-cell"><span>${p.name}</span>${saleKindBadge(p)}</div></td><td style="color:var(--muted)">${displayCategory(p.category)}</td><td class="num">${baht(p.price)}<small style="color:var(--muted)">/${p.unit || ""}</small></td><td class="num" style="color:var(--muted)">${baht(p.cost || 0)}</td><td class="num" style="color:${pColor};font-weight:600">${baht(profit)}<small style="color:var(--muted);font-weight:400"> ${margin}%</small></td><td class="num"><span class="stkbadge ${low ? "low" : "ok"}">${p.stock}</span></td><td class="num"><button class="mini" onclick="App.adjustStock('${p.id}',1)">+1</button><button class="mini" onclick="App.adjustStock('${p.id}',10)">+10</button><button class="mini" onclick="App.openProduct('${p.id}')">แก้ไข</button><button class="mini" style="color:var(--danger)" onclick="App.delProduct('${p.id}')">ลบ</button></td></tr>`;
  }).join("") || '<tr><td colspan="9" style="text-align:center;color:var(--muted)">ไม่พบสินค้า</td></tr>';
}
App.adjustStock = async function (id, d) {
  const p = products.find((x) => x.id === id);
  try { await DB.adjustStock(id, p.stock, d); products = await DB.getProducts(); renderStock(); renderGrid(); }
  catch (e) { toast("ปรับสต็อกไม่สำเร็จ", true); }
};
App.openProduct = function (id) {
  editProdId = id || null;
  $("prodModalTitle").textContent = id ? "แก้ไขสินค้า" : "เพิ่มสินค้า";
  const p = id ? products.find((x) => x.id === id) : { name: "", code: "", category: "", price: "", cost: "", unit: "", stock: "" };
  $("pName").value = p.name; $("pCode").value = p.code || ""; $("pCat").value = p.category || "";
  $("pPrice").value = p.price; $("pCost").value = p.cost || ""; $("pUnit").value = p.unit || ""; $("pStock").value = p.stock;
  $("productOverlay").classList.add("show");
};
App.closeProduct = function () { $("productOverlay").classList.remove("show"); };
App.saveProduct = async function () {
  const name = $("pName").value.trim(); if (!name) { toast("กรุณาใส่ชื่อสินค้า"); return; }
  try {
    await DB.saveProduct({ id: editProdId, name, code: $("pCode").value.trim(), category: $("pCat").value.trim(), price: parseFloat($("pPrice").value) || 0, cost: parseFloat($("pCost").value) || 0, unit: $("pUnit").value.trim(), stock: parseInt($("pStock").value) || 0 });
    products = await DB.getProducts();
    App.closeProduct(); renderStock(); renderCatBar(); renderGrid(); toast("บันทึกสินค้าแล้ว ✓");
  } catch (e) { toast("บันทึกไม่สำเร็จ", true); }
};
App.delProduct = async function (id) {
  const p = products.find((x) => x.id === id);
  if (!p) return;
  const typed = prompt(`พิมพ์ชื่อสินค้าเพื่อยืนยันการลบ:\n"${p.name}"`);
  if (typed === null) return; // กด cancel
  if (typed.trim() !== p.name.trim()) { toast("ชื่อสินค้าไม่ตรง — ยกเลิกการลบ", true); return; }
  try {
    await DB.deleteProduct(id);
    products = products.filter((x) => x.id !== id); cart = cart.filter((x) => x.id !== id);
    renderStock(); renderCatBar(); renderGrid(); renderCart();
  } catch (e) { toast("ลบไม่สำเร็จ", true); }
};

// ============================================================
//  REPORT
// ============================================================
function sumBy(type) { return todaySales.filter((s) => s.status !== "void" && s.pay_type === type).reduce((a, s) => a + Number(s.total), 0); }
let curSummary = null;
function summaryAgg(sales) {
  const active = (sales || []).filter((s) => s.status !== "void");
  const agg = {};
  active.forEach((s) => (s.sale_items || []).forEach((i) => { if (!agg[i.name]) agg[i.name] = { qty: 0, sum: 0, profit: 0 }; agg[i.name].qty += i.qty; agg[i.name].sum += i.price * i.qty; agg[i.name].profit += (i.price - (i.cost || 0)) * i.qty; }));
  const rows = Object.entries(agg).sort((a, b) => b[1].qty - a[1].qty);
  return { active, rows, totQty: rows.reduce((a, [, v]) => a + v.qty, 0), totSum: rows.reduce((a, [, v]) => a + v.sum, 0), totProfit: rows.reduce((a, [, v]) => a + v.profit, 0) };
}
function renderSummaryTable(sales, dateStr) {
  const r = summaryAgg(sales);
  curSummary = { date: dateStr, active: r.active, rows: r.rows, totQty: r.totQty, totSum: r.totSum, totProfit: r.totProfit };
  $("topBody").innerHTML = r.rows.length
    ? r.rows.map(([n, v], i) => `<tr><td>${i + 1}</td><td>${n}</td><td class="num">${v.qty}</td><td class="num">${baht(v.sum)}</td><td class="num" style="color:var(--grn2)">${baht(v.profit)}</td></tr>`).join("")
      + `<tr style="font-weight:700;background:var(--elev)"><td></td><td>รวม ${r.rows.length} รายการ</td><td class="num">${r.totQty}</td><td class="num">${baht(r.totSum)}</td><td class="num" style="color:var(--grn2)">${baht(r.totProfit)}</td></tr>`
    : '<tr><td colspan="5" style="text-align:center;color:var(--muted)">ไม่มีการขายในวันที่เลือก</td></tr>';
}
App.loadDaySummary = async function () {
  const d = $("sumDate").value; if (!d) return;
  const todayStr = new Date().toLocaleDateString("en-CA");
  try {
    const sales = d === todayStr ? todaySales : await DB.getSalesByDate(d);
    renderSummaryTable(sales, d);
    if (!sales.length) toast("วันที่เลือกไม่มีการขาย");
  } catch (e) { toast("โหลดข้อมูลวันที่เลือกไม่สำเร็จ", true); }
};
App.exportDaySummary = function () {
  const cs = curSummary || Object.assign({ date: new Date().toLocaleDateString("en-CA") }, summaryAgg(todaySales));
  const rows = [["สรุปการขายรายวัน " + cs.date], ["ลำดับ", "สินค้า", "จำนวน", "ยอดขาย (บาท)", "กำไร (บาท)"]];
  cs.rows.forEach(([n, v], i) => rows.push([i + 1, n, v.qty, v.sum, v.profit]));
  rows.push(["", "รวม " + cs.rows.length + " รายการ", cs.totQty, cs.totSum, cs.totProfit]);
  csvDownload(`สรุปขายรายวัน_${cs.date}.csv`, rows);
  toast("ส่งออกสรุปรายวันแล้ว ✓");
};

// ─── รายงานรายเดือน ───────────────────────────────────────
let monthSummary = null;
App.loadMonthlySummary = async function () {
  const m = $("sumMonth").value; if (!m) return;
  const [year, mon] = m.split("-");
  // วันแรก-วันสุดท้ายของเดือน (UTC+7)
  const start = `${m}-01T00:00:00+07:00`;
  const lastDay = new Date(parseInt(year), parseInt(mon), 0).getDate();
  const end   = `${m}-${String(lastDay).padStart(2,"0")}T23:59:59+07:00`;
  try {
    // ดึงบิลทั้งเดือนผ่าน supabase โดยตรง
    const sb = DB._supabase();
    const { data, error } = await sb.from("sales")
      .select("*, sale_items(*), customers(name)")
      .gte("created_at", start).lte("created_at", end)
      .order("created_at", { ascending: true });
    if (error) throw error;
    const sales = data || [];
    const r = summaryAgg(sales);
    monthSummary = { month: m, ...r };
    // ยอดแยกช่องทาง
    const active = r.active;
    const sumBy  = (pt) => active.filter((s) => s.pay_type === pt).reduce((a, s) => a + Number(s.total), 0);
    const label  = new Date(parseInt(year), parseInt(mon)-1, 1).toLocaleDateString("th-TH", { month:"long", year:"numeric" });
    $("monthReportLabel").textContent = label;
    $("mTotSales").textContent  = baht(r.totSum);
    $("mTotProfit").textContent = baht(r.totProfit);
    $("mTotBills").textContent  = active.length + " บิล";
    $("mCash").textContent      = baht(sumBy("cash"));
    $("mQR").textContent        = baht(sumBy("promptpay"));
    $("mCard").textContent      = baht(sumBy("farmer_card"));
    $("mCredit").textContent    = baht(sumBy("credit"));
    $("monthReportBox").style.display = "block";
  } catch(e) { toast("โหลดรายงานเดือนไม่สำเร็จ", true); }
};

App.printMonthlySummary = function () {
  if (!monthSummary) { toast("เลือกเดือนก่อนนะคะ"); return; }
  const ms = monthSummary;
  const [year, mon] = ms.month.split("-");
  const label = new Date(parseInt(year), parseInt(mon)-1, 1).toLocaleDateString("th-TH", { month:"long", year:"numeric" });
  const active = ms.active || [];
  const sumBy  = (pt) => active.filter((s) => s.pay_type === pt).reduce((a, s) => a + Number(s.total), 0);
  const byCash = sumBy("cash"), byQR = sumBy("promptpay"), byCard = sumBy("farmer_card"), byCredit = sumBy("credit");
  const marginPct = ms.totSum > 0 ? Math.round(ms.totProfit / ms.totSum * 100) : 0;
  const margin = (v) => v.sum > 0 ? Math.round(v.profit / v.sum * 100) : 0;
  const lines = ms.rows.length
    ? ms.rows.sort((a,b) => b[1].sum - a[1].sum).map(([n,v]) =>
        `<div class="ritem"><div class="top"><span>${n}</span><span>${baht(v.sum)}</span></div>
         <div class="sub">${v.qty} หน่วย · กำไร ${baht(v.profit)} (${margin(v)}%)</div></div>`).join("")
    : '<div class="ctr">ไม่มีการขายในเดือนนี้</div>';
  const payRows = [
    byCash   > 0 ? `<div class="rrow"><span>เงินสด</span><span>${baht(byCash)}</span></div>` : "",
    byQR     > 0 ? `<div class="rrow"><span>พร้อมเพย์ (QR)</span><span>${baht(byQR)}</span></div>` : "",
    byCard   > 0 ? `<div class="rrow"><span>บัตรสินเชื่อเกษตรกร</span><span>${baht(byCard)}</span></div>` : "",
    byCredit > 0 ? `<div class="rrow"><span>ขายเชื่อ</span><span>${baht(byCredit)}</span></div>` : "",
  ].filter(Boolean).join("");
  $("rcptContent").innerHTML = `
    <div class="rhead">
      ${RCPT_LOGO}<div class="shop">${SHOP.name}</div>
      <div class="ctr">${SHOP.address}</div>
    </div>
    <div class="rtitle">รายงานการขายรายเดือน</div>
    <div class="rrow"><span>เดือน</span><span>${label}</span></div>
    <div class="rrow"><span>จำนวนบิล</span><span>${active.length} บิล</span></div>
    <div class="rline"></div>
    <div class="ritems-head"><span>รายการสินค้า (เรียงยอดขาย)</span><span>ยอดขาย</span></div>
    ${lines}
    <div class="rline"></div>
    <div class="rrow" style="font-weight:700"><span>ยอดขายรวม</span><span>${baht(ms.totSum)}</span></div>
    <div class="rtotal"><span>กำไรขั้นต้น</span><b>${baht(ms.totProfit)}</b></div>
    <div class="rrow" style="font-size:13px;color:#555"><span>อัตรากำไร</span><span>${marginPct}%</span></div>
    <div class="rline thin"></div>
    <div class="ritems-head" style="margin-top:4px"><span>แยกตามช่องทางชำระ</span><span></span></div>
    ${payRows || '<div class="ctr">ไม่มีข้อมูล</div>'}
    <div class="rline thin"></div>
    <div class="rfoot">พิมพ์เมื่อ ${new Date().toLocaleString("th-TH",{day:"2-digit",month:"short",hour:"2-digit",minute:"2-digit"})} · ${SHOP.name}</div>`;
  $("receiptOverlay").classList.add("show");
  setTimeout(() => window.print(), 300);
};

App.exportMonthlySummary = function () {
  if (!monthSummary) { toast("เลือกเดือนก่อนนะคะ"); return; }
  const ms = monthSummary;
  const rows = [["สรุปการขายรายเดือน " + ms.month], ["ลำดับ","สินค้า","จำนวน","ยอดขาย (บาท)","กำไร (บาท)"]];
  ms.rows.forEach(([n,v],i) => rows.push([i+1, n, v.qty, v.sum, v.profit]));
  rows.push(["","รวม " + ms.rows.length + " รายการ", ms.totQty, ms.totSum, ms.totProfit]);
  csvDownload(`สรุปขายรายเดือน_${ms.month}.csv`, rows);
  toast("ส่งออกสรุปรายเดือนแล้ว ✓");
};
function renderReport() {
  const active = todaySales.filter((s) => s.status !== "void");
  const total = active.reduce((s, x) => s + Number(x.total), 0);
  const profit = active.reduce((a, s) => a + (s.sale_items || []).reduce((b, i) => b + (Number(i.price) - Number(i.cost || 0)) * i.qty, 0), 0);
  const outstanding = customers.reduce((a, c) => a + owe(c.id), 0);
  $("reportDate").textContent = new Date().toLocaleDateString("th-TH", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  $("rSales").textContent = baht(total);
  $("rProfit").textContent = baht(profit);
  $("rCash").textContent = baht(sumBy("cash"));
  $("rQR").textContent = baht(sumBy("promptpay"));
  $("rCard").textContent = baht(sumBy("farmer_card"));
  $("rCredit").textContent = baht(sumBy("credit"));
  $("rBills").textContent = active.length;
  $("rOutstanding").textContent = baht(outstanding);

  const todayStr = new Date().toLocaleDateString("en-CA");
  if ($("sumDate")) $("sumDate").value = todayStr;
  renderSummaryTable(todaySales, todayStr);

  $("billBody").innerHTML = todaySales.length ? todaySales.map((s) => {
    const cname = s.customers?.name || "ทั่วไป";
    const tagClass = s.pay_type === "credit" ? "cr" : "cash";
    const voided = s.status === "void";
    const voidTag = voided ? '<span class="tag void">ยกเลิก</span>' : "";
    const style = voided ? ' style="opacity:.55;text-decoration:line-through"' : "";
    return `<tr class="clk" onclick="App.openSaleActions('${s.id}')"><td${style}>${new Date(s.created_at).toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit" })}</td><td${style}>${s.bill_no}</td><td${style}>${cname}</td><td><span class="tag ${tagClass}">${PAY_LABEL[s.pay_type] || s.pay_type}</span>${voidTag}</td><td class="num"${style}>${(s.sale_items || []).reduce((a, i) => a + i.qty, 0)}</td><td class="num"${style}>${baht(s.total)}</td></tr>`;
  }).join("") : '<tr><td colspan="6" style="text-align:center;color:var(--muted)">ยังไม่มีบิลวันนี้</td></tr>';
}

App.printDaySummary = function () {
  const cs = curSummary || Object.assign({ date: new Date().toLocaleDateString("en-CA") }, summaryAgg(todaySales));
  const dateLabel = new Date(cs.date + "T00:00:00+07:00").toLocaleDateString("th-TH", { weekday:"long", day:"numeric", month:"long", year:"numeric" });

  // ยอดแยกช่องทางชำระ
  const active = cs.active || [];
  const sumBy  = (pt) => active.filter((s) => s.pay_type === pt).reduce((a, s) => a + Number(s.total), 0);
  const byCash = sumBy("cash"), byQR = sumBy("promptpay");
  const byCard = sumBy("farmer_card"), byCredit = sumBy("credit");
  const payRows = [
    byCash   > 0 ? `<div class="rrow"><span>เงินสด</span><span>${baht(byCash)}</span></div>` : "",
    byQR     > 0 ? `<div class="rrow"><span>พร้อมเพย์ (QR)</span><span>${baht(byQR)}</span></div>` : "",
    byCard   > 0 ? `<div class="rrow"><span>บัตรสินเชื่อเกษตรกร</span><span>${baht(byCard)}</span></div>` : "",
    byCredit > 0 ? `<div class="rrow"><span>ขายเชื่อ</span><span>${baht(byCredit)}</span></div>` : "",
  ].filter(Boolean).join("");

  // รายการสินค้า + กำไรต่อรายการ (ไม่แสดงต้นทุน)
  const margin = (v) => v.sum > 0 ? Math.round(v.profit / v.sum * 100) : 0;
  const lines = cs.rows.length
    ? cs.rows.map(([n, v]) => `
        <div class="ritem">
          <div class="top"><span>${n}</span><span>${baht(v.sum)}</span></div>
          <div class="sub">${v.qty} หน่วย · กำไร ${baht(v.profit)} (${margin(v)}%)</div>
        </div>`).join("")
    : '<div class="ctr" style="margin:10px 0">ไม่มีการขายในวันที่เลือก</div>';

  const marginPct = cs.totSum > 0 ? Math.round(cs.totProfit / cs.totSum * 100) : 0;

  $("rcptContent").innerHTML = `
    <div class="rhead">
      ${RCPT_LOGO}<div class="shop">${SHOP.name}</div>
      <div class="ctr">${SHOP.address}</div>
    </div>
    <div class="rtitle">รายงานการขายประจำวัน</div>
    <div class="rrow"><span>วันที่</span><span>${dateLabel}</span></div>
    <div class="rrow"><span>จำนวนบิล</span><span>${active.length} บิล</span></div>
    <div class="rline"></div>
    <div class="ritems-head"><span>รายการสินค้าที่ขาย</span><span>ยอดขาย</span></div>
    ${lines}
    <div class="rline"></div>
    <div class="rrow" style="font-weight:700"><span>ยอดขายรวม</span><span>${baht(cs.totSum)}</span></div>
    <div class="rtotal"><span>กำไรขั้นต้น</span><b>${baht(cs.totProfit)}</b></div>
    <div class="rrow" style="font-size:13px;color:#555"><span>อัตรากำไร</span><span>${marginPct}%</span></div>
    <div class="rline thin"></div>
    <div class="ritems-head" style="margin-top:4px"><span>แยกตามช่องทางชำระ</span><span></span></div>
    ${payRows || '<div class="ctr">ไม่มีข้อมูล</div>'}
    <div class="rline thin"></div>
    <div class="rfoot">พิมพ์เมื่อ ${new Date().toLocaleString("th-TH",{hour:"2-digit",minute:"2-digit"})} · ${SHOP.name}</div>`;
  $("receiptOverlay").classList.add("show");
};

// ---------- จัดการบิล: รีปริ้น / ยกเลิก ----------
let saActiveId = null, recentSales = [];
function findSale(id) { return todaySales.find((x) => x.id === id) || recentSales.find((x) => x.id === id) || null; }

async function loadRecentSales() {
  try { recentSales = await DB.getRecentSales(200); App.searchBills(); }
  catch (e) { /* เงียบไว้ */ }
}
App.searchBills = function () {
  const term = ($("billSearch")?.value || "").trim().toLowerCase();
  let list = recentSales;
  if (term) list = recentSales.filter((s) =>
    (s.bill_no || "").toLowerCase().includes(term) ||
    (s.customers?.name || "").toLowerCase().includes(term) ||
    new Date(s.created_at).toLocaleDateString("th-TH").includes(term));
  else list = recentSales.slice(0, 12);
  $("searchBody").innerHTML = list.length ? list.map((s) => {
    const cname = s.customers?.name || "ทั่วไป";
    const voided = s.status === "void";
    const st = voided ? ' style="opacity:.55;text-decoration:line-through"' : "";
    const vt = voided ? '<span class="tag void">ยกเลิก</span>' : "";
    return `<tr class="clk" onclick="App.openSaleActions('${s.id}')"><td${st}>${new Date(s.created_at).toLocaleDateString("th-TH", { day: "2-digit", month: "short", year: "2-digit" })}</td><td${st}>${s.bill_no}</td><td${st}>${cname}</td><td><span class="tag ${s.pay_type === "credit" ? "cr" : "cash"}">${PAY_LABEL[s.pay_type] || s.pay_type}</span>${vt}</td><td class="num"${st}>${baht(s.total)}</td></tr>`;
  }).join("") : `<tr><td colspan="5" style="text-align:center;color:var(--muted)">${term ? "ไม่พบบิลที่ค้นหา" : "ยังไม่มีบิล"}</td></tr>`;
};

App.openSaleActions = function (id) {
  saActiveId = id;
  const s = findSale(id); if (!s) return;
  const cname = s.customers?.name || "ทั่วไป";
  const dateStr = new Date(s.created_at).toLocaleDateString("th-TH", { day: "2-digit", month: "short", year: "2-digit" });
  $("saTitle").textContent = `บิล ${s.bill_no} · ${dateStr} · ${cname} · ${baht(s.total)}`;
  const items = (s.sale_items || []).map((it) => `<div class="histrow"><div><div>${it.name}</div><div class="hl">${baht(it.price)} × ${it.qty} ${it.unit || ""}</div></div><div style="font-weight:600">${baht(it.price * it.qty)}</div></div>`).join("");
  const voided = s.status === "void";
  $("saInfo").innerHTML = items + (voided ? '<div class="hl" style="color:var(--red);margin-top:10px;font-weight:700">บิลนี้ถูกยกเลิกแล้ว</div>' : "");
  $("saVoidBtn").style.display = voided ? "none" : "";
  if ($("saTaxBtn")) $("saTaxBtn").style.display = voided ? "none" : "";
  $("saleActionsOverlay").classList.add("show");
};
App.closeSaleActions = function () { $("saleActionsOverlay").classList.remove("show"); };
App.reprintSale = async function () {
  const s = findSale(saActiveId); if (!s) return;
  const items = (s.sale_items || []).map((it) => ({ name: it.name, price: it.price, qty: it.qty, unit: it.unit }));
  await buildReceipt(s, items);
  App.closeSaleActions();
  $("receiptOverlay").classList.add("show");
};
App.voidSale = async function () {
  const s = findSale(saActiveId); if (!s) return;
  if (!confirm(`ยืนยันยกเลิกบิล ${s.bill_no}?\nระบบจะคืนสต็อกสินค้าทั้งหมดในบิลนี้`)) return;
  try {
    await DB.voidSale(saActiveId);
    [products, balances, todaySales, pendingSales, recentSales, creditPaid] = await Promise.all([DB.getProducts(), DB.getCustomerBalances(), DB.getTodaySales(), DB.getPendingPickups(), DB.getRecentSales(200), DB.getCreditPaidMap()]);
    App.closeSaleActions(); renderReport(); App.searchBills(); renderGrid();
    toast("ยกเลิกบิลแล้ว · คืนสต็อกเรียบร้อย ✓");
  } catch (e) { toast("ยกเลิกไม่สำเร็จ: " + (e.message || "ลองใหม่"), true); }
};

// ============================================================
//  ใบกำกับภาษี/ใบเสร็จรับเงิน
// ============================================================
App.openTaxInvoice = function (saleId) {
  const s = saleId ? findSale(saleId) : findSale(saActiveId);
  if (!s) { toast("กรุณาเลือกบิลก่อนออกใบกำกับภาษี", true); return; }
  if (s.status === "void") { toast("บิลที่ยกเลิกแล้วออกใบกำกับภาษีไม่ได้", true); return; }
  taxSale = s;
  const cname = s.customers?.name || (s.customer_id ? (customers.find((c) => c.id === s.customer_id) || {}).name : "");
  $("taxBuyerName").value = cname || "";
  $("taxBuyerAddr").value = "";
  $("taxBuyerTaxId").value = "";
  $("taxBuyerBranch").value = "";
  $("taxInvoiceOverlay").classList.add("show");
};
App.closeTaxInvoice = function () { $("taxInvoiceOverlay").classList.remove("show"); };
App.printTaxInvoice = function () {
  const s = taxSale || findSale(saActiveId);
  if (!s) { toast("ไม่พบบิลสำหรับออกใบกำกับภาษี", true); return; }
  const buyerName = $("taxBuyerName").value.trim();
  const buyerAddr = $("taxBuyerAddr").value.trim();
  const buyerAddrPrint = buyerAddr.replace(/^ที่\s*/i, "");
  const buyerTaxId = $("taxBuyerTaxId").value.trim();
  const buyerBranch = $("taxBuyerBranch").value.trim();
  if (!buyerName || !buyerAddr) { toast("กรอกชื่อผู้ซื้อและที่อยู่ก่อนนะคะ", true); return; }

  const total = Number(s.total || 0);
  const beforeVat = total / 1.07;
  const vat = total - beforeVat;
  const dateStr = new Date(s.created_at).toLocaleString("th-TH", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
  const items = (s.sale_items || []).map((it) => `
    <div class="ritem">
      <div class="top"><span>${it.name}</span><span>${baht(Number(it.price) * Number(it.qty))}</span></div>
      <div class="sub">${baht(it.price)} × ${it.qty} ${it.unit || ""}</div>
    </div>`).join("");

  $("rcptContent").innerHTML = `
    <div class="rhead">
      ${RCPT_LOGO}<div class="shop">${SHOP.name}</div>
      <div class="ctr">${SHOP.address}</div>
      ${SHOP.taxId ? `<div class="ctr">เลขประจำตัวผู้เสียภาษี : ${SHOP.taxId}</div>` : ""}
      <div class="ctr">โทร. ${SHOP.phone}</div>
    </div>
    <div class="rtitle tax-title">ใบกำกับภาษี/ใบเสร็จรับเงิน</div>
    <div class="rrow"><span>เลขที่ใบกำกับภาษี</span><span>${genDocNo("TAX")}</span></div>
    <div class="rrow"><span>อ้างอิงบิล</span><span>${s.bill_no || "-"}</span></div>
    <div class="rrow"><span>วันที่ขาย</span><span>${dateStr}</span></div>
    <div class="rline thin"></div>
    <div class="rbuyer">
      <div class="line"><span class="label">ผู้ซื้อ :</span><span class="val">${buyerName}</span></div>
      <div class="line"><span class="label">ที่อยู่ :</span><span class="val">${buyerAddrPrint}</span></div>
      ${buyerTaxId ? `<div class="line"><span class="label">เลขประจำตัวผู้เสียภาษี :</span><span class="val">${buyerTaxId}</span></div>` : ""}
      ${buyerBranch ? `<div class="line"><span class="label">สาขา :</span><span class="val">${buyerBranch}</span></div>` : ""}
    </div>
    <div class="rline"></div>
    <div class="ritems-head"><span>รายการ</span><span>จำนวนเงิน</span></div>
    ${items}
    <div class="rline"></div>
    <div class="rrow"><span>มูลค่าก่อน VAT</span><span>${baht(beforeVat)}</span></div>
    <div class="rrow"><span>ภาษีมูลค่าเพิ่ม 7%</span><span>${baht(vat)}</span></div>
    <div class="rtotal"><span>รวมทั้งสิ้น</span><b>${baht(total)}</b></div>
    <div class="rline thin"></div>
    <div class="rfoot">เอกสารนี้ออกจากบิล ${s.bill_no || "-"}</div>`;
  App.closeTaxInvoice();
  App.closeSaleActions();
  $("receiptOverlay").classList.add("show");
  setTimeout(() => window.print(), 300);
};

// ============================================================
//  misc
// ============================================================
// ============================================================
//  สำรองข้อมูล: ส่งออก CSV (เปิดด้วย Excel ได้, รองรับภาษาไทย)
// ============================================================
function csvDownload(name, rows) {
  const csv = rows.map((r) => r.map((c) => { const s = c == null ? "" : String(c); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }).join(",")).join("\r\n");
  const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a"); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
App.exportProducts = function () {
  const rows = [["รหัส", "ชื่อสินค้า", "หมวด", "ราคาขาย", "ต้นทุน", "คงเหลือ", "หน่วย"]];
  products.forEach((p) => rows.push([p.code || "", p.name, p.category || "", p.price, p.cost || 0, p.stock, p.unit || ""]));
  csvDownload(`สินค้า_${new Date().toLocaleDateString("en-CA")}.csv`, rows);
  toast("ส่งออกรายการสินค้าแล้ว ✓");
};
App.exportSales = async function () {
  try {
    const sales = await DB.getRecentSales(1000);
    const rows = [["วันที่", "เวลา", "เลขที่บิล", "ลูกค้า", "สินค้า", "จำนวน", "ราคา/หน่วย", "รวม", "วิธีจ่าย", "สถานะ"]];
    sales.forEach((s) => {
      const d = new Date(s.created_at);
      const date = d.toLocaleDateString("en-CA");
      const time = d.toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit" });
      const cname = (s.customers && s.customers.name) || "ทั่วไป";
      const pay = PAY_LABEL[s.pay_type] || s.pay_type;
      const st = s.status === "void" ? "ยกเลิก" : "ปกติ";
      (s.sale_items || []).forEach((it) => rows.push([date, time, s.bill_no, cname, it.name, it.qty, it.price, it.price * it.qty, pay, st]));
    });
    csvDownload(`การขาย_${new Date().toLocaleDateString("en-CA")}.csv`, rows);
    toast("ส่งออกประวัติการขายแล้ว ✓");
  } catch (e) { toast("ส่งออกไม่สำเร็จ: " + (e.message || "ลองใหม่"), true); }
};

let toastT;
function toast(m, isErr) {
  const t = $("toast"); t.textContent = m; t.className = "toast show" + (isErr ? " err" : "");
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove("show"), 2200);
}

// ดักการยิงบาร์โค้ดทั้งหน้าขาย แม้ไม่ได้โฟกัสช่องค้นหา
// (ทำงานเฉพาะหน้าขายสินค้า, ไม่มีหน้าต่างเปิดอยู่, และไม่ได้กำลังพิมพ์ในช่องอื่น)
document.addEventListener("keydown", (e) => {
  if (!$("view-sales")?.classList.contains("active")) return;
  if (document.querySelector(".overlay.show")) return;
  const ae = document.activeElement;
  if (ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA" || ae.tagName === "SELECT" || ae.isContentEditable)) return;
  if (e.ctrlKey || e.altKey || e.metaKey) return;
  const sb = $("search"); if (!sb) return;
  if (e.key === "Enter") { App.searchKey(e); return; }
  if (e.key === "Backspace") { sb.value = sb.value.slice(0, -1); renderGrid(); e.preventDefault(); return; }
  if (e.key.length === 1) { sb.value += e.key; renderGrid(); e.preventDefault(); }
});

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  const open = document.querySelector(".overlay.show");
  if (open) { open.classList.remove("show"); e.preventDefault(); }
});

boot();