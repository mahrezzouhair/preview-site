'use strict';
/**
 * YouCan Pay — منطق الدفع النقي (pure logic): بلا اعتماديات، بلا أسرار،
 * بلا اتصال بالشبكة ولا Firestore. هاد المودول كيستعملو:
 *  - functions/index.js (السيرفر الحقيقي)، و
 *  - tests/simulate-webhook.js (اختبار بمحاكاة Webhook بلا Firestore).
 * يعني قرار التفعيل كيتختبر بلا ما نحتاجو نشر ولا مفاتيح حقيقية.
 *
 * الحقائق المتحقق منها من توثيق YouCan Pay الرسمي (docs.youcan.shop):
 *  - Tokenize: POST https://youcanpay.com/api/tokenize بحقول form:
 *    amount (بأصغر وحدة: 2500 = 25.00 MAD)، currency، pri_key، order_id،
 *    success_url، error_url. الجواب: { transaction_id, token: { id } }.
 *  - Webhook: ترويسة X-YOUCANPAY-SIGNATURE = HMAC-SHA256 hex للجسم الخام
 *    (raw body) بالمفتاح الخاص. كائن الحدث:
 *    { id, event_name, sandbox, payload: { transaction: { id, amount,
 *    status, currency, order_id, base_amount, base_currency } } }.
 *    status = 1 كيعني خلاص ناجح في صيغة Webhook.
 *  - yp.js: https://youcanpay.com/yp.js — yp(pubKey, { locale: 'ar' }).
 *  - v2 Transactions API: GET https://youcanpay.com/api/v2/transactions
 *    بمصادقة Basic بالمفتاح الخاص؛ مبالغها بالوحدة الكبيرة ("100.00").
 *
 * ملاحظة وحدة المبلغ: توثيق Tokenize كيقول أصغر وحدة، بينما كائن
 * Transaction في v2 كيستعمل الوحدة الكبيرة بالعشرية. لهذا amountMatches
 * كيقبل القراءتين ديال نفس الثمن (49900 ولا 499) وكيسجل أنهي وحدة
 * تطابقات — ومنين يتدار أول اختبار Sandbox حقيقي، خاص يتضيق القبول
 * لوحدة وحدة (راجع functions/README.md).
 */
const crypto = require('node:crypto');

const COURSES = {
  hijama: { name: 'الحجامة', priceMad: 499, priceMinor: 49900 },
  bone: { name: 'تقويم العظام', priceMad: 499, priceMinor: 49900 },
  acu: { name: 'الوخز بالإبر الصينية', priceMad: 499, priceMinor: 49900 },
};
const CURRENCY = 'MAD';

function courseOf(courseId) {
  return COURSES[courseId] || null;
}

/* order_id فريد لكل محاولة دفع — كيتسجل في payment-orders باش
   Webhook يلقى شكون خلّص وشنو شرا (YouCan ما كيقبلش metadata مخصصة
   موثقة في Tokenize، لهذا الربط كيتم عبر سجلنا نحن). */
function buildOrderId(courseId, uid) {
  const rand = Math.random().toString(36).slice(2, 8);
  return 'ord_' + courseId + '_' + String(uid).slice(0, 8) + '_' + Date.now() + '_' + rand;
}

/* حقول Tokenize — بلا pri_key: المفتاح الخاص كيزيدو السيرفر فقط
   من الأسرار، وما كيدوزش أبداً عبر هاد المودول. */
function buildTokenizeFields({ amountMinor, currency, orderId, successUrl, errorUrl }) {
  return {
    amount: String(amountMinor),
    currency: currency,
    order_id: orderId,
    success_url: successUrl,
    error_url: errorUrl,
  };
}

/* التحقق من توقيع Webhook: HMAC-SHA256 hex للجسم الخام بالمفتاح
   الخاص، بمقارنة ثابتة الزمن. الجسم خاصو يبقى خام تماماً كيفما وصل
   (إعادة ترميز JSON كتبدل البايتات وكيفشل التوقيع). */
function verifySignature(rawBody, signatureHeader, privateKey) {
  if (!signatureHeader || !privateKey) return false;
  const expected = crypto.createHmac('sha256', privateKey).update(rawBody).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(String(signatureHeader), 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/* مطابقة المبلغ: كيرجع 'minor' ولا 'major' ولا null (ما طابقش). */
function amountMatches(txAmount, expectedMinor) {
  const n = Number(txAmount);
  if (Number.isNaN(n)) return null;
  if (n === expectedMinor) return 'minor';
  if (n === expectedMinor / 100) return 'major';
  return null;
}

/* استخراج الحقول اللي كيهمنا من كائن حدث Webhook. */
function parseWebhookEvent(body) {
  if (!body || typeof body !== 'object') throw new Error('webhook body is not an object');
  const p = body.payload || {};
  const tx = p.transaction || {};
  return {
    eventName: body.event_name,
    sandbox: body.sandbox === true,
    transactionId: tx.id || null,
    orderId: tx.order_id || null,
    amount: tx.amount != null ? String(tx.amount) : null,
    currency: tx.currency || null,
    baseAmount: tx.base_amount != null ? String(tx.base_amount) : null,
    baseCurrency: tx.base_currency || null,
    status: tx.status,
  };
}

/**
 * قرار التفعيل من حدث Webhook + سجل الطلب (payment-orders).
 *  - approve: كلشي متحقق → فعّل الدورة فوراً بلا موافقة يدوية.
 *  - ignore: حدث ماشي ديالنا (نوع آخر، خلاص فاشل، تكرار توصيل،
 *    ولا sandbox/live ما مطابقش للوضع) → جواب 200 بلا تفعيل.
 *  - reject: توقيع سليم لكن الطلب مجهول ولا المبلغ/العملة ما طابقوش
 *    → ما تفعّلش، وسجل الحادث للمراجعة.
 */
function decideActivation({ event, order, mode }) {
  if (event.eventName !== 'transaction.paid') {
    return { action: 'ignore', reason: 'not a transaction.paid event' };
  }
  if (event.status !== 1 && event.status !== 'paid') {
    return { action: 'ignore', reason: 'transaction not paid' };
  }
  if (mode === 'sandbox' && event.sandbox !== true) {
    return { action: 'ignore', reason: 'production event received in sandbox mode' };
  }
  if (mode === 'production' && event.sandbox === true) {
    return { action: 'ignore', reason: 'sandbox event received in production mode' };
  }
  if (!event.orderId || !order) {
    return { action: 'reject', reason: 'unknown order_id' };
  }
  if (order.status === 'paid') {
    return { action: 'ignore', reason: 'order already paid (duplicate delivery)' };
  }
  // المبلغ: إلا كانت العملة ماشي MAD لكن كاين مبلغ أساسي بـ MAD
  // (حالة التحويل من عملة أخرى)، استعمل المبلغ الأساسي.
  let effectiveAmount = event.amount;
  let effectiveCurrency = event.currency;
  if (effectiveCurrency !== 'MAD' && event.baseCurrency === 'MAD' && event.baseAmount) {
    effectiveAmount = event.baseAmount;
    effectiveCurrency = 'MAD';
  }
  if (effectiveCurrency !== 'MAD') {
    return { action: 'reject', reason: 'currency is not MAD' };
  }
  const matched = amountMatches(effectiveAmount, order.amountMinor);
  if (!matched) {
    return { action: 'reject', reason: 'amount mismatch: got ' + effectiveAmount + ' ' + effectiveCurrency };
  }
  return {
    action: 'approve',
    reason: 'signature + amount + order verified (unit: ' + matched + ')',
    amountUnit: matched,
  };
}

/* وثيقة التسجيل بنفس شكل الوثائق الحالية في course-enrollments،
   زائد حقل payment للتتبع. createdAt/activatedAt كيتسجلو في السيرفر
   بـ FieldValue.serverTimestamp (ما كاينينش هنا حيث هاد المودول نقي). */
function buildEnrollmentDoc({ uid, email, name, courseId, orderId, transactionId, amountMinor, currency }) {
  const course = COURSES[courseId];
  return {
    name: name || email,
    email: email,
    course: course ? course.name : courseId,
    courseId: courseId,
    method: 'card',
    status: 'approved',
    uid: uid,
    payment: {
      provider: 'youcanpay',
      orderId: orderId,
      transactionId: transactionId || null,
      amountMinor: amountMinor,
      currency: currency,
    },
    activatedBy: 'auto-youcanpay',
  };
}

module.exports = {
  COURSES,
  CURRENCY,
  courseOf,
  buildOrderId,
  buildTokenizeFields,
  verifySignature,
  amountMatches,
  parseWebhookEvent,
  decideActivation,
  buildEnrollmentDoc,
};
