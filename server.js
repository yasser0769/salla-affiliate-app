/**
 * ===================================================
 * سلة - تطبيق روابط التسويق بالعمولة
 * Salla Affiliate Button App - Backend Server
 * ===================================================
 * 
 * يعمل هذا السيرفر كـ "وسيط" بين:
 * - متجر التاجر على سلة (يسأل: ما رابط هذا المنتج؟)
 * - لوحة إدارة التاجر (يخزن/يعدل الروابط)
 */

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// ===================================================
// إعدادات أساسية
// ===================================================
app.use(express.json());
app.use(cors({
  origin: '*', // في الإنتاج: حدد دومينات سلة فقط
  methods: ['GET', 'POST', 'PUT', 'DELETE']
}));

// ===================================================
// قاعدة البيانات (مؤقتة في الذاكرة للتجربة)
// في الإنتاج: استخدم MongoDB أو PostgreSQL
// ===================================================

// تخزين tokens التجار (بعد تثبيت التطبيق)
const merchants = new Map();
// merchants structure:
// { merchantId: { accessToken, storeDomain, installedAt } }

// تخزين روابط المنتجات
const affiliateLinks = new Map();
// affiliateLinks structure:
// { "merchantId_productId": { url, buttonText, buttonColor, enabled } }

// ===================================================
// 1. OAuth - تثبيت التطبيق من سلة
// ===================================================

/**
 * عندما يثبت التاجر التطبيق، سلة ترسل له هنا
 * (Easy Mode - سلة ترسل التوكن تلقائياً)
 */
app.post('/webhooks/app/store/authorize', express.raw({ type: '*/*' }), (req, res) => {
  // التحقق من صحة الطلب (أنه من سلة وليس من شخص آخر)
  const signature = req.headers['x-salla-signature'];
  const webhookSecret = process.env.WEBHOOK_SECRET || 'your-webhook-secret';
  
  const body = req.body.toString();
  const computedHMAC = crypto
    .createHmac('sha256', webhookSecret)
    .update(body)
    .digest('hex');

  if (signature !== computedHMAC) {
    console.log('❌ Invalid signature - rejected');
    return res.sendStatus(401);
  }

  const data = JSON.parse(body);
  const { merchant, data: authData } = data;
  
  // حفظ بيانات التاجر
  merchants.set(String(merchant), {
    accessToken: authData.access_token,
    refreshToken: authData.refresh_token,
    expiresAt: authData.expires,
    installedAt: new Date().toISOString()
  });

  console.log(`✅ New merchant installed: ${merchant}`);
  res.sendStatus(200);
});

// ===================================================
// 2. API للوحة الإدارة (يستخدمها التاجر)
// ===================================================

/**
 * جلب جميع روابط التاجر
 * GET /api/links?merchant_id=123
 */
app.get('/api/links', (req, res) => {
  const { merchant_id } = req.query;
  
  if (!merchant_id) {
    return res.status(400).json({ error: 'merchant_id مطلوب' });
  }

  // جمع كل روابط هذا التاجر
  const merchantLinks = {};
  affiliateLinks.forEach((value, key) => {
    if (key.startsWith(`${merchant_id}_`)) {
      const productId = key.split('_')[1];
      merchantLinks[productId] = value;
    }
  });

  res.json({ success: true, links: merchantLinks });
});

/**
 * حفظ/تحديث رابط منتج معين
 * POST /api/links
 * Body: { merchant_id, product_id, url, button_text, button_color, enabled }
 */
app.post('/api/links', (req, res) => {
  const { merchant_id, product_id, url, button_text, button_color, enabled } = req.body;

  if (!merchant_id || !product_id || !url) {
    return res.status(400).json({ error: 'merchant_id, product_id, url كلها مطلوبة' });
  }

  // التحقق البسيط من الرابط
  try {
    new URL(url);
  } catch {
    return res.status(400).json({ error: 'الرابط غير صحيح' });
  }

  const key = `${merchant_id}_${product_id}`;
  affiliateLinks.set(key, {
    url,
    buttonText: button_text || 'اشترِ من أمازون',
    buttonColor: button_color || '#FF9900',
    enabled: enabled !== false,
    updatedAt: new Date().toISOString()
  });

  console.log(`✅ Link saved for merchant ${merchant_id}, product ${product_id}`);
  res.json({ success: true, message: 'تم الحفظ بنجاح' });
});

/**
 * حذف رابط منتج
 * DELETE /api/links/:product_id?merchant_id=123
 */
app.delete('/api/links/:product_id', (req, res) => {
  const { product_id } = req.params;
  const { merchant_id } = req.query;

  const key = `${merchant_id}_${product_id}`;
  affiliateLinks.delete(key);

  res.json({ success: true, message: 'تم الحذف' });
});

// ===================================================
// 3. API العام للمتجر (يستخدمه الـ Snippet)
// ===================================================

/**
 * هذا هو الأهم! عندما يفتح زبون صفحة منتج،
 * الـ Snippet يسأل: "هل هذا المنتج عنده رابط؟"
 * 
 * GET /api/public/button?merchant_id=123&product_id=456
 */
app.get('/api/public/button', (req, res) => {
  // السماح لمتاجر سلة بالوصول (CORS)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, max-age=300'); // cache 5 دقائق

  const { merchant_id, product_id } = req.query;

  if (!merchant_id || !product_id) {
    return res.json({ hasButton: false });
  }

  const key = `${merchant_id}_${product_id}`;
  const link = affiliateLinks.get(key);

  if (!link || !link.enabled) {
    return res.json({ hasButton: false });
  }

  res.json({
    hasButton: true,
    url: link.url,
    buttonText: link.buttonText,
    buttonColor: link.buttonColor
  });
});

// ===================================================
// 4. Webhook عند إلغاء تثبيت التطبيق
// ===================================================
app.post('/webhooks/app/uninstalled', express.json(), (req, res) => {
  const { merchant } = req.body;
  merchants.delete(String(merchant));
  console.log(`🗑️ Merchant ${merchant} uninstalled the app`);
  res.sendStatus(200);
});

// ===================================================
// تشغيل السيرفر
// ===================================================
app.listen(PORT, () => {
  console.log(`
🚀 السيرفر يعمل على البورت ${PORT}
📦 Endpoints:
   - POST /webhooks/app/store/authorize  ← سلة ترسل هنا عند التثبيت
   - GET  /api/links?merchant_id=X       ← لوحة الإدارة تجلب الروابط
   - POST /api/links                     ← لوحة الإدارة تحفظ رابط
   - DELETE /api/links/:id               ← لوحة الإدارة تحذف رابط
   - GET  /api/public/button             ← المتجر يسأل عن الزر ✨
  `);
});

module.exports = app;
