// ============================================================
//  ตั้งค่า Supabase
//  *** ต้องวาง "คีย์ anon" 1 บรรทัดเท่านั้น (บรรทัดที่ 9) ***
//  หาได้จาก: Supabase > Project Settings > API > anon public key
// ============================================================

export const SUPABASE_URL = "https://oqzlixenwqaavubyglcn.supabase.co";

export const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9xemxpeGVud3FhYXZ1YnlnbGNuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODEwNTc5MTcsImV4cCI6MjA5NjYzMzkxN30.uGCp7duB0d9pkhyTRczQsgeYuxWbeNfP2Vzxj5jYBgI";

// ชื่อร้าน + ข้อมูลที่จะพิมพ์บนใบเสร็จ
export const SHOP = {
  name: "ส่งเสริมการเกษตร",
  address: "108/4 หมู่ที่4 ต.น้ำอ่าง อ.ตรอน จ.อุตรดิตถ์",
  phone: "086-678-8906",
  taxId: "3530200091573",
  // เบอร์พร้อมเพย์ หรือเลขบัตรประชาชนที่ผูกพร้อมเพย์ของร้าน (สำหรับสร้าง QR รับเงิน)
  promptpayId: "1530200062101",
};