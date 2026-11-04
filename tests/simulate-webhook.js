'use strict';
/**
 * اختبار منطق الدفع بمحاكاة Webhook — بلا Firestore، بلا شبكة، بلا مفاتيح
 * حقيقية. كيختبر غير المودول النقي functions/payment-logic.js.
 *
 * التشغيل: node tests/simulate-webhook.js   (من جذر موقع المعاينة)
 * الخروج: 0 إلا نجحو كاملين، 1 إلا فشل واحد على الأقل.
 *
 * متجه التوقيع المعروف: HMAC-SHA256 للجسم
 *   {"event_name":"transaction.paid","sandbox":true}
 * بالمفتاح 'pri_test_fake_key' = 71f8a5a18f3223634610ecb6eb7f92611b71489702e4888df60d0bc1bb49d830
 * (محسوب بأداة مستقلة — Python hmac — ماشي بنفس الكود المختبر).
 */
const crypto = require('node:crypto');
const logic = require('../functions/payment-logic');

const FAKE_KEY = 'pri_test_fake_key';
let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (extra ? ' — ' + extra : '')); }
}
function sign(body) {
  return crypto.createHmac('sha256', FAKE_KEY).update(body).digest('hex');
}
function event(overrides) {
  const base = {
    id: 'evt-1',
    event_name: 'transaction.paid',
    sandbox: true,
    payload: {
      token: { id: 'tok-1' },
      transaction: {
        id: 'tx-1', amount: '49900', status: 1, currency: 'MAD',
        order_id: 'ord_hijama_uid1234_1_abc123',
        base_amount: null, base_currency: null,
      },
    },
  };
  const tx = Object.assign({}, base.payload.transaction, (overrides && overrides.tx) || {});
  const out = Object.assign({}, base, overrides || {});
  out.payload = Object.assign({}, base.payload, { transaction: tx });
  delete out.tx;
  return out;
}
function order(overrides) {
  return Object.assign(
    { courseId: 'hijama', amountMinor: 49900, currency: 'MAD', status: 'pending' },
    overrides || {}
  );
}

/* 1. التوقيع: متجه معروف مستقل + جسم مبدل كيفشل + مفتاح خاطئ كيفشل. */
const KNOWN_BODY = '{"event_name":"transaction.paid","sandbox":true}';
const KNOWN_SIG = '71f8a5a18f3223634610ecb6eb7f92611b71489702e4888df60d0bc1bb49d830';
check('signature matches independent vector',
  logic.verifySignature(Buffer.from(KNOWN_BODY), KNOWN_SIG, FAKE_KEY) === true);
check('signature rejects tampered body',
  logic.verifySignature(Buffer.from(KNOWN_BODY + ' '), KNOWN_SIG, FAKE_KEY) === false);
check('signature rejects wrong key',
  logic.verifySignature(Buffer.from(KNOWN_BODY), KNOWN_SIG, 'pri_other_key') === false);
check('signature rejects missing header',
  logic.verifySignature(Buffer.from(KNOWN_BODY), null, FAKE_KEY) === false);

/* 2. قرار التفعيل: حالة ناجحة كاملة (وحدة صغرى). */
{
  const ev = logic.parseWebhookEvent(event());
  const d = logic.decideActivation({ event: ev, order: order(), mode: 'sandbox' });
  check('valid paid webhook (minor units) approves', d.action === 'approve', JSON.stringify(d));
  check('valid webhook reports unit minor', d.amountUnit === 'minor');
}
/* 3. وحدة كبرى ("499") كتقبل كقراءة ثانية لنفس الثمن. */
{
  const ev = logic.parseWebhookEvent(event({ tx: { amount: '499' } }));
  const d = logic.decideActivation({ event: ev, order: order(), mode: 'sandbox' });
  check('valid paid webhook (major units) approves', d.action === 'approve', JSON.stringify(d));
  check('major-unit case reports unit major', d.amountUnit === 'major');
}
/* 4. مبلغ خاطئ كيترفض. */
{
  const ev = logic.parseWebhookEvent(event({ tx: { amount: '10000' } }));
  const d = logic.decideActivation({ event: ev, order: order(), mode: 'sandbox' });
  check('wrong amount rejects', d.action === 'reject', JSON.stringify(d));
}
/* 5. عملة ماشي MAD كتترفض. */
{
  const ev = logic.parseWebhookEvent(event({ tx: { currency: 'USD' } }));
  const d = logic.decideActivation({ event: ev, order: order(), mode: 'sandbox' });
  check('non-MAD currency rejects', d.action === 'reject', JSON.stringify(d));
}
/* 6. حالة تحويل عملة: EUR مع مبلغ أساسي MAD كتقبل. */
{
  const ev = logic.parseWebhookEvent(event({
    tx: { currency: 'EUR', amount: '45', base_currency: 'MAD', base_amount: '49900' },
  }));
  const d = logic.decideActivation({ event: ev, order: order(), mode: 'sandbox' });
  check('converted currency with MAD base amount approves', d.action === 'approve', JSON.stringify(d));
}
/* 7. حدث ماشي paid: نوع آخر + حالة غير مدفوعة → تجاهل بلا تفعيل. */
{
  const ev1 = logic.parseWebhookEvent(event({ event_name: 'transaction.failed' }));
  const d1 = logic.decideActivation({ event: ev1, order: order(), mode: 'sandbox' });
  check('failed event ignored', d1.action === 'ignore');
  const ev2 = logic.parseWebhookEvent(event({ tx: { status: 0 } }));
  const d2 = logic.decideActivation({ event: ev2, order: order(), mode: 'sandbox' });
  check('unpaid status ignored', d2.action === 'ignore');
}
/* 8. عدم تطابق Sandbox/Production → تجاهل. */
{
  const evSandbox = logic.parseWebhookEvent(event());
  const d1 = logic.decideActivation({ event: evSandbox, order: order(), mode: 'production' });
  check('sandbox event ignored in production mode', d1.action === 'ignore');
  const evLive = logic.parseWebhookEvent(event({ sandbox: false }));
  const d2 = logic.decideActivation({ event: evLive, order: order(), mode: 'sandbox' });
  check('production event ignored in sandbox mode', d2.action === 'ignore');
}
/* 9. طلب مجهول + طلب مدفوع أصلاً (تكرار توصيل). */
{
  const ev = logic.parseWebhookEvent(event());
  const d1 = logic.decideActivation({ event: ev, order: null, mode: 'sandbox' });
  check('unknown order rejects', d1.action === 'reject');
  const d2 = logic.decideActivation({ event: ev, order: order({ status: 'paid' }), mode: 'sandbox' });
  check('duplicate delivery ignored (already paid)', d2.action === 'ignore');
}
/* 10. وثيقة التسجيل: الشكل الصحيح (card + approved + payment). */
{
  const doc = logic.buildEnrollmentDoc({
    uid: 'uid123456789', email: 'learner@example.com', name: 'متعلم',
    courseId: 'hijama', orderId: 'ord_hijama_uid1234_1_abc123',
    transactionId: 'tx-1', amountMinor: 49900, currency: 'MAD',
  });
  check('enrollment doc method is card', doc.method === 'card');
  check('enrollment doc status is approved', doc.status === 'approved');
  check('enrollment doc carries payment order', doc.payment && doc.payment.orderId === 'ord_hijama_uid1234_1_abc123');
  check('enrollment doc course name', doc.course === 'الحجامة');
}
/* 11. Tokenize: الحقول صحيحة وبلا pri_key (السر ما كيدوزش هنا). */
{
  const f = logic.buildTokenizeFields({
    amountMinor: 49900, currency: 'MAD', orderId: 'ord_x',
    successUrl: 'https://example.com/my-courses.html', errorUrl: 'https://example.com/payment.html',
  });
  check('tokenize amount is minor units', f.amount === '49900');
  check('tokenize carries no private key', !('pri_key' in f) && !('privateKey' in f));
}
/* 12. order_id فريد وبالصيغة المتوقعة. */
{
  const a = logic.buildOrderId('hijama', 'uid123456789');
  const b = logic.buildOrderId('hijama', 'uid123456789');
  check('order ids are unique', a !== b);
  check('order id format', a.indexOf('ord_hijama_') === 0);
}
/* 13. دورة مجهولة → null. */
check('unknown course returns null', logic.courseOf('nope') === null);
check('all three courses priced 499 MAD',
  logic.COURSES.hijama.priceMad === 499
  && logic.COURSES.bone.priceMad === 499
  && logic.COURSES.acu.priceMad === 499);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
