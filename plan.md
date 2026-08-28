แผนโปรเจกต์: Mobile Camera OCR Quiz Auto-Answer
เป้าหมาย

เว็บแอป (มือถือ) ที่เปิดกล้อง ถ่าย/สแกนหน้าจอเกมที่แสดงคำถาม+ตัวเลือก แล้วจับคู่กับฐานข้อมูลคำถาม-คำตอบ (JSON) เพื่อบอกคำตอบที่ถูกต้อง ภายในเวลา < 5 วินาที

Stack
Next.js (App Router, PWA-ready)
Supabase — เก็บ questions.json (table หรือ storage)
Vercel — deploy
OCR: เริ่มด้วย Tesseract.js (client-side, lang=tha) → ถ้าไม่แม่นพอ ค่อย fallback ไป cloud OCR (Google Cloud Vision / Typhoon OCR) ผ่าน API route
Fuzzy matching: Fuse.js
Phase 1 — Setup พื้นฐาน
Init Next.js project, ตั้งค่า PWA (manifest.json, service worker) เพื่อให้ขอสิทธิ์กล้องได้ลื่นบนมือถือ
Device detection: window.matchMedia('(pointer: coarse)') + userAgent check
Desktop → แสดง QR code ให้สแกนเปิดในมือถือ
Mobile → ไปหน้ากล้องเลย
Phase 2 — Camera Capture Component
ใช้ navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } })
แสดง video stream เต็มจอ + overlay กรอบนำสายตา (คล้าย QR scanner) ให้ผู้ใช้จัดกล้องให้คำถาม/ตัวเลือกอยู่ในกรอบ
ปุ่ม capture → วาดเฟรมปัจจุบันลง <canvas> → ได้ภาพนิ่งเป็น base64/Blob
(ทางเลือก) โหมด continuous scan — ยิง OCR ทุก N ms อัตโนมัติโดยไม่ต้องกดปุ่ม
Phase 3 — OCR Pipeline
เริ่มด้วย Tesseract.js (lang: 'tha') รันฝั่ง client
Preprocess ภาพก่อน OCR: grayscale, เพิ่ม contrast, deskew ถ้าเอียง (ใช้ canvas API หรือ opencv.js)
Benchmark ความแม่นกับภาพถ่ายจริงจากกล้อง (ไม่ใช่ screenshot) — ถ้าไม่พอ ทำ API route /api/ocr เรียก cloud OCR แทน
Output: ข้อความดิบทั้งภาพ พร้อม bounding box ของแต่ละบรรทัด/คำ
Phase 4 — แยกคำถาม vs ตัวเลือก (ไม่มีพิกัดตายตัวแบบ screenshot)

Heuristic ที่ใช้แทนพิกัดคงที่:

บรรทัดที่ลงท้าย "?" หรืออยู่ตำแหน่งบน/กลางของภาพ และยาวกว่าบรรทัดอื่น → คำถาม
ข้อความที่อยู่ในกรอบสี่เหลี่ยม/ปุ่ม (detect จาก bounding box ที่ OCR ให้มา) → ตัวเลือก
ถ้า heuristic ไม่ชัวร์ อาจให้ผู้ใช้แตะเลือกกรอบคำถาม/ตัวเลือกเองครั้งแรก (calibration แบบ manual)
Phase 5 — Matching Logic
OCR text → normalize (ตัดช่องว่าง, unify ตัวอักษรที่ OCR สับสนบ่อย)
→ exact match กับ Map<question, answer> ที่โหลดจาก Supabase
→ ถ้าไม่เจอ → Fuse.js fuzzy match หา question ใกล้เคียงที่สุด
→ ได้ answer string
→ findIndex ใน options array ที่ normalize แล้วตรงกับ answer
Phase 6 — แสดงผล
ไฮไลต์ตัวเลือกที่ถูกต้องบนหน้าจอ (overlay บนภาพ preview หรือแสดงเป็น text ใหญ่ๆ)
แสดง confidence/fallback ถ้า fuzzy match คะแนนต่ำเกินไป (เตือนผู้ใช้ว่าอาจไม่ชัวร์)
Phase 7 — Data Layer
Supabase table questions (question TEXT, answer TEXT)
โหลดทั้งหมดเข้า memory ตอน app start (หรือ cache ใน IndexedDB สำหรับ offline)
Lookup ผ่าน Map ในหน่วยความจำ ไม่ query ต่อครั้ง
Performance Budget (เป้า < 5 วิ)
ขั้นตอน เวลาโดยประมาณ
เปิดกล้อง + capture ~50–200ms
Preprocess ภาพ ~50–100ms
OCR 300ms–1.5s (client) / +network ถ้า cloud
Normalize + Match <10ms
แสดงผล <50ms
สิ่งที่ต้อง benchmark/ทดสอบจริงก่อนลุยเต็มที่
ความแม่นของ Tesseract.js กับภาพถ่ายกล้องมือถือจริง (แสงสะท้อน, มุมเอียง) เทียบกับ cloud OCR
Latency จริงของ cloud OCR ถ้าต้อง fallback
Heuristic แยกคำถาม/ตัวเลือกทำงานได้แม่นแค่ไหนโดยไม่มีพิกัดตายตัว
