'use strict';
/**
 * YouCan Pay — دوال السيرفر (Firebase Functions v2).
 *
 * ⚠️ هاد الكود مكتوب فقط — ما منشور ما متنشرش (NOT DEPLOYED).
 * النشر كيتطلب ترقية مشروع Firebase لـ Blaze (Spark ما كينشرش الدوال
 * وما كيسمحش بالاتصال بخدمات خارج Google) — والنشر ماشي من مهام هاد
 * البناء. راجع README.md ديال هاد المجلد قبل أي نشر.
 *
 * الدالتان:
 *  1. createPayment — كتولد رمز دفع (token) من YouCan Pay. كتطلب رمز
 *     دخول Firebase صالح (ID token) وكتطابق uid ديالو مع الطلب، باش
 *     حتى واحد ما يقدر يخلق دفع لحساب شخص آخر.
 *  2. youcanWebhook — كيستقبل إشعار نجاح الخلاص من YouCan Pay، كيتحقق
 *     من التوقيع HMAC، من المبلغ، ومن الطلب، ومن بعد كيكتب التسجيل
 *     في Firestore بحالة approved بلا أي موافقة يدوية، وكيصيفط إيميل
 *     تأكيد للمتعلم. مسار التحويل البنكي ما كيتمسش: كيبقى يدوي كيفما كان.
 *
 * الأسرار (من متغيرات البيئة / أسرار الدوال فقط — أبداً في الكود):
 *  YOUCAN_PRIVATE_KEY — المفتاح الخاص (pri_...) — للتوقيع والتحقق.
 *  YOUCAN_PUBLIC_KEY  — المفتاح العمومي (pub_...) — كيرجع للمتصفح.
 *  YOUCAN_MODE        — sandbox ولا production.
 *  SITE_URL           — رابط الموقع (المعاينة حالياً، الدومين من بعد).
 *  ALLOWED_ORIGINS    — أصول CORS المسموحة، مفصولة بفاصلة.
 *  SMTP_HOST/PORT/USER/PASS/FROM — لإيميل التأكيد (إلا ما تسجلوش،
 *  التفعيل كيتم عادي والإيميل كيتخطى مع تحذير في السجل).
 */
const { onRequest } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');
const nodemailer = require('nodemailer');
const logic = require('./payment-logic');

admin.initializeApp();
const db = admin.firestore();
const auth = admin.auth();

const PRIVATE_KEY = process.env.YOUCAN_PRIVATE_KEY || '';
const PUBLIC_KEY = process.env.YOUCAN_PUBLIC_KEY || '';
const MODE = (process.env.YOUCAN_MODE || 'sandbox').toLowerCase();
const SITE_URL = (process.env.SITE_URL || 'https://mahrezzouhair.github.io/preview-site').replace(/\/$/, '');
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'https://mahrezzouhair.github.io')
  .split(',').map((s) => s.trim()).filter(Boolean);
const TOKENIZE_URL = 'https://youcanpay.com/api/tokenize';
const TRANSACTIONS_URL = 'https://youcanpay.com/api/v2/transactions';

function applyCors(req, res) {
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.includes(origin)) res.set('Access-Control-Allow-Origin', origin);
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.set('Vary', 'Origin');
}
function sendJson(res, code, obj) {
  res.status(code).json(obj);
}

/* إعادة التحقق من المعاملة عبر Transactions API (دفاع إضافي).
   كترجع: 'confirmed' | 'contradicted' | 'unknown' (خطأ/شكل غير متوقع).
   'unknown' ما كيبلوكيش التفعيل: التوقيع HMAC هو آلية الثقة الموثقة. */
async function reverifyTransaction(orderId) {
  try {
    const url = TRANSACTIONS_URL
      + '?filters[0][field]=order_id'
      + '&filters[0][value]=' + encodeURIComponent(orderId);
    const r = await fetch(url, {
      headers: {
        Accept: 'application/json',
        Authorization: 'Basic ' + Buffer.from(PRIVATE_KEY + ':').toString('base64'),
      },
    });
    if (!r.ok) return 'unknown';
    const data = await r.json();
    const list = Array.isArray(data.data) ? data.data : [];
    if (list.length !== 1) return 'unknown';
    const tx = list[0];
    const amount = tx.amount && tx.amount.amount != null ? String(tx.amount.amount) : null;
    return { status: tx.status, amount, currency: tx.amount ? tx.amount.currency : null };
  } catch (e) {
    console.warn('reverifyTransaction failed:', e.message);
    return 'unknown';
  }
}

function buildConfirmationEmail({ name, courseName }) {
  const link = SITE_URL + '/my-courses.html';
  const subject = 'تم تفعيل دورتك — ' + courseName;
  const text = 'سلام ' + name + '،\n\n'
    + 'تم استلام الأداء ديالك وتفعيل دورة ' + courseName + ' بنجاح.\n'
    + 'الدورة دابا مفتوحة ليك في صفحة «دوراتي»: ' + link + '\n\n'
    + 'ملاحظة: الدروس محمية — بلا تحميل، وبعلامة مائية باسمك.\n\n'
    + 'بالتوفيق في التكوين!\nزهير محرز';
  const html = '<div dir="rtl" style="font-family:sans-serif;line-height:1.8">'
    + '<p>سلام ' + name + '،</p>'
    + '<p>تم استلام الأداء ديالك وتفعيل دورة <b>' + courseName + '</b> بنجاح.</p>'
    + '<p><a href="' + link + '">دخل لدوراتي ←</a></p>'
    + '<p style="color:#666">ملاحظة: الدروس محمية — بلا تحميل، وبعلامة مائية باسمك.</p>'
    + '<p>بالتوفيق في التكوين!<br>زهير محرز</p></div>';
  return { subject, text, html };
}

async function sendConfirmationEmail(to, vars) {
  const { host, port, user, pass, from } = {
    host: process.env.SMTP_HOST || '',
    port: Number(process.env.SMTP_PORT || 587),
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.SMTP_FROM || '',
  };
  if (!host || !user || !pass || !from) {
    console.warn('SMTP not configured — confirmation email skipped for', to);
    return false;
  }
  const mail = buildConfirmationEmail(vars);
  const transport = nodemailer.createTransport({ host, port, secure: port === 465, auth: { user, pass } });
  await transport.sendMail({ from, to, subject: mail.subject, text: mail.text, html: mail.html });
  return true;
}

/* ==================================================================
 * POST /createPayment — { courseId } + Authorization: Bearer <idToken>
 * كيرجع { tokenId, transactionId } ولا خطأ.
 * ================================================================== */
exports.createPayment = onRequest(
  { region: 'europe-west1', secrets: ['YOUCAN_PRIVATE_KEY', 'YOUCAN_PUBLIC_KEY', 'SMTP_PASS'] },
  async (req, res) => {
    applyCors(req, res);
    if (req.method === 'OPTIONS') return res.status(204).send('');
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method_not_allowed' });
    try {
      if (!PRIVATE_KEY) return sendJson(res, 500, { error: 'server_not_configured' });
      const header = req.headers.authorization || '';
      const match = header.match(/^Bearer (.+)$/);
      if (!match) return sendJson(res, 401, { error: 'missing_id_token' });
      const decoded = await auth.verifyIdToken(match[1]);
      const uid = decoded.uid;
      const email = decoded.email;
      if (!email) return sendJson(res, 400, { error: 'account_has_no_email' });
      const courseId = req.body && req.body.courseId;
      const course = logic.courseOf(courseId);
      if (!course) return sendJson(res, 400, { error: 'unknown_course' });

      // منع الدفع المكرر: إلا كانت الدورة مفعّلة أصلاً، ما نولدوش رمز جديد.
      const existing = await db.collection('course-enrollments')
        .where('uid', '==', uid).where('courseId', '==', courseId).get();
      let alreadyActive = false;
      existing.forEach((d) => { if (d.data().status === 'approved') alreadyActive = true; });
      if (alreadyActive) return sendJson(res, 409, { error: 'already_active' });

      let name = email;
      try {
        const userDoc = await db.collection('users').doc(uid).get();
        if (userDoc.exists && userDoc.data().name) name = userDoc.data().name;
      } catch (e) { /* الاسم اختياري — الإيميل كافي */ }

      const orderId = logic.buildOrderId(courseId, uid);
      await db.collection('payment-orders').doc(orderId).set({
        uid, email, name, courseId,
        amountMinor: course.priceMinor,
        currency: logic.CURRENCY,
        status: 'pending',
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      const fields = logic.buildTokenizeFields({
        amountMinor: course.priceMinor,
        currency: logic.CURRENCY,
        orderId,
        successUrl: SITE_URL + '/my-courses.html',
        errorUrl: SITE_URL + '/payment.html?course=' + courseId + '&method=card&pay=error',
      });
      const form = new URLSearchParams({ ...fields, pri_key: PRIVATE_KEY });
      const r = await fetch(TOKENIZE_URL, {
        method: 'POST',
        headers: { Accept: 'application/json' },
        body: form,
      });
      if (!r.ok) {
        console.error('tokenize failed:', r.status, await r.text().catch(() => ''));
        return sendJson(res, 502, { error: 'tokenize_failed' });
      }
      const data = await r.json();
      if (!data.token || !data.token.id) {
        console.error('tokenize bad response:', JSON.stringify(data).slice(0, 500));
        return sendJson(res, 502, { error: 'tokenize_failed' });
      }
      return sendJson(res, 200, { tokenId: data.token.id, transactionId: data.transaction_id || null });
    } catch (e) {
      console.error('createPayment error:', e);
      return sendJson(res, 500, { error: 'internal' });
    }
  }
);

/* ==================================================================
 * POST /youcanWebhook — إشعار YouCan Pay (JSON + ترويسة التوقيع).
 * كيرجع دائماً 2xx إلا في حالة توقيع خاطئ (403) ولا غياب الجسم الخام
 * (400) — باش YouCan ما يعاودش إرسال حدث مرفوض بسبب منطقي.
 * ================================================================== */
exports.youcanWebhook = onRequest(
  { region: 'europe-west1', secrets: ['YOUCAN_PRIVATE_KEY', 'SMTP_PASS'] },
  async (req, res) => {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method_not_allowed' });
    try {
      if (!PRIVATE_KEY) return sendJson(res, 500, { error: 'server_not_configured' });
      const rawBody = req.rawBody;
      if (!rawBody) {
        // بلا الجسم الخام ما يمكنش نتحقق من التوقيع — رفض مغلق.
        console.error('webhook without rawBody — refusing');
        return sendJson(res, 400, { error: 'missing_raw_body' });
      }
      const signature = req.headers['x-youcanpay-signature'];
      if (!logic.verifySignature(rawBody, signature, PRIVATE_KEY)) {
        console.warn('webhook signature mismatch');
        return sendJson(res, 403, { error: 'bad_signature' });
      }
      let body;
      try { body = JSON.parse(rawBody.toString('utf8')); }
      catch (e) { return sendJson(res, 400, { error: 'bad_json' }); }
      const event = logic.parseWebhookEvent(body);

      const orderRef = event.orderId ? db.collection('payment-orders').doc(event.orderId) : null;
      const orderSnap = orderRef ? await orderRef.get() : null;
      const order = orderSnap && orderSnap.exists ? orderSnap.data() : null;
      const decision = logic.decideActivation({ event, order, mode: MODE });
      console.log('webhook decision:', decision.action, decision.reason, 'order:', event.orderId);

      if (decision.action !== 'approve') {
        if (decision.action === 'reject') {
          await db.collection('payment-events').add({
            orderId: event.orderId || null,
            event: event.eventName || null,
            decision: 'reject',
            reason: decision.reason,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
          });
        }
        return sendJson(res, 200, { ok: true, decision: decision.action });
      }

      // دفاع إضافي: إعادة قراءة المعاملة من API. إلا ناقضات السجل، رفض.
      // إلا تعذرات القراءة، كنمشيو بالتوقيع (آلية الثقة الموثقة).
      const check = await reverifyTransaction(event.orderId);
      if (check !== 'unknown' && (check.status !== 'paid' || check.amount == null)) {
        console.warn('webhook contradicted by Transactions API:', JSON.stringify(check));
        await db.collection('payment-events').add({
          orderId: event.orderId, event: event.eventName, decision: 'reject',
          reason: 'transactions_api_contradiction',
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        return sendJson(res, 200, { ok: true, decision: 'reject' });
      }

      // Upsert: إلا كان طلب معلق لنفس الدورة، كيترقى هو؛ وإلا كيتخلق
      // تسجيل جديد. هاكا ما كيتضاعفش التسجيل مع التحويل البنكي ولا مع
      // تكرار توصيل Webhook (payment-orders كيتحول لـ paid مرة وحدة).
      const courseId = order.courseId;
      const uid = order.uid;
      const email = order.email;
      const doc = logic.buildEnrollmentDoc({
        uid, email, name: order.name || email, courseId,
        orderId: event.orderId, transactionId: event.transactionId,
        amountMinor: order.amountMinor, currency: order.currency,
      });
      const stamp = admin.firestore.FieldValue.serverTimestamp();
      const prior = await db.collection('course-enrollments')
        .where('uid', '==', uid).where('courseId', '==', courseId).get();
      let target = null;
      prior.forEach((d) => {
        const s = d.data().status;
        if (s !== 'rejected' && !target) target = d.ref;
      });
      if (target) {
        await target.update({
          status: 'approved', method: 'card', payment: doc.payment,
          activatedBy: 'auto-youcanpay', activatedAt: stamp,
        });
      } else {
        await db.collection('course-enrollments').add({ ...doc, createdAt: stamp, activatedAt: stamp });
      }
      await orderRef.update({
        status: 'paid', transactionId: event.transactionId || null,
        paidAt: stamp,
      });
      await db.collection('payment-events').add({
        orderId: event.orderId, event: event.eventName, decision: 'approve',
        reason: decision.reason,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      // الإيميل إشعار فقط — الفشل ديالو ما كيلغيش التفعيل.
      try {
        await sendConfirmationEmail(email, { name: order.name || email, courseName: doc.course });
      } catch (e) {
        console.warn('confirmation email failed:', e.message);
      }
      return sendJson(res, 200, { ok: true, decision: 'approve' });
    } catch (e) {
      console.error('youcanWebhook error:', e);
      return sendJson(res, 500, { error: 'internal' });
    }
  }
);
