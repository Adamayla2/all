# إعداد Firebase (مشروع واحد للنسختين)

المدة المتوقعة نحو 20 دقيقة. لا شيء هنا سرّي سوى كلمة مرور حسابك كمدير؛ المفتاح `apiKey` للويب يعرّف المشروع فقط ولا يحمي البيانات. الحماية الفعلية من قواعد Firestore وتسجيل الدخول.

## 1. إنشاء المشروع

1. افتح <https://console.firebase.google.com> ← *Add project* (لا تحتاج Analytics).
2. *Build ← Authentication ← Get started ← Sign-in method* ← فعّل **Email/Password**. (الطالب الذي يسجّل باسم مستخدم يحوّله التطبيق إلى بريد تقني تلقائيًا، فلا يحتاج بريدًا حقيقيًا.)
3. *Build ← Firestore Database ← Create database* ← وضع الإنتاج (production mode) ← اختر منطقة قريبة من طلابك.
4. *Project settings ← General ← Your apps ← Web app* ← سجّل تطبيقًا وانسخ `apiKey` و`projectId`.
5. يُنصح بتقييد المفتاح: Google Cloud Console ← *APIs & Services ← Credentials* ← قيّد المفتاح بـ *HTTP referrers* لنطاقَي موقعيك (و`localhost` أثناء التجربة).

## 2. تعبئة ملفي الإعداد (يأتيان فارغين)

`firebase-config.js` في **النسختين**:
```js
window.ENT_FIREBASE = { apiKey: '<apiKey الخاص بك>', projectId: '<projectId الخاص بك>' };
```
`subscription-config.js` في نسخة الطالب فقط: رقم واتساب (أرقام فقط بالصيغة الدولية)، أسماء الخطط وأسعارها، و`offlineGraceDays`.
لا تضع في هذه الملفات مفتاح خدمة (service account) ولا مفتاحًا خاصًا ولا كلمة مرور.

## 3. نشر قواعد الأمان

اختبرها أولًا (تحتاج Node 18+ وJava 11+؛ لا تلمس أي مشروع حقيقي):
```
cd firebase
npm install
npm test
```
ثم انشرها: Firestore ← *Rules* ← الصق محتوى `firebase/firestore.rules` ← *Publish*.
(أو `firebase deploy --only firestore:rules` بعد `firebase login` و`firebase use <مشروعك>`).

> تنبيه صريح: كُتبت القواعد مع اختبار آلي (`firestore-rules.test.js`) لكنه يحتاج محاكي Firestore الذي تعذّر تشغيله في بيئة إعداد الكود. شغّل `npm test` عندك قبل النشر.

## 4. اجعل نفسك مديرًا

1. افتح نسخة المدير ← *Settings ← Cloud (Firebase)* ← أدخل البريد وكلمة المرور ← *Sign in*.
   إن لم يكن للبريد حساب، أنشئه أولًا من *Authentication ← Users ← Add user*.
2. انسخ **UID** هذا المستخدم (من Authentication ← Users).
3. Firestore ← *Start collection* باسم `admins` ← معرّف المستند = الـ UID ← أي حقل (مثلًا `note: owner`).
   القواعد لا تسمح لأي تطبيق بإنشاء المديرين أو تعديلهم.
4. سجّل الدخول مجددًا في نسخة المدير؛ يعمل النشر وأدوات الحسابات الآن.

## 5. إنشاء التخصصات

نسخة المدير ← اضغط شارة التخصص أعلى الشاشة ← **Specialties**.
1. ENT موجود مسبقًا. أضف التخصصات الأخرى (الاسم + المعرّف؛ المعرّف دائم لا يتغير: 3–40 حرفًا، أحرف إنكليزية صغيرة وأرقام وشرطات، يبدأ بحرف).
2. ابنِ تصنيفات كل تخصص وأقسامه (*Categories & sections*) ثم أضف الأسئلة أو استوردها والتخصص مفتوح.
3. اضغط **Sync list to cloud** ليعرض التسجيل التخصصات *الفعّالة* للطلاب.

## 6. نشر بنوك الأسئلة

لكل تخصص: افتحه ← *Settings ← Cloud (Firebase)* ← *Publish <التخصص> question bank* ← اقرأ نافذة التأكيد (تذكر اسم التخصص) ← OK.
ENT: أبقِ خيار *Also update the old ENT location* مفعّلًا ما دام بعض الطلاب على 1.3.x.

اختياري: *Settings ← Subscription scope* ← `selected` (كل مشترك يرى تخصصه فقط) أو `all` (اشتراك واحد يفتح كل التخصصات الفعّالة). تفرضه القواعد من الخادم.

## 7. الأسئلة المجانية (اختياري)

في نسخة المدير والتخصص مفتوح: علّم الأسئلة بـ *Free* ثم *Export <التخصص> Free Pack*. ضع الملف في مجلد نسخة الطالب باسم `free-packs/<معرّف التخصص>.qbpkg` (مثل `free-packs/dermatology.qbpkg`) ثم انشر.

## 8. استضافة النسختين

أي استضافة ثابتة تصلح (Cloudflare Pages أو Netlify أو Firebase Hosting أو GitHub Pages) عبر HTTPS. أبقِ ملف `_headers`. انشر نسخة المدير على عنوان منفصل ولا تعلن رابطها.

## 9. التشغيل اليومي

* طالب جديد: يسجّل ويختار تخصصًا ← تفعّل اشتراكه من *Settings ← Student accounts*.
* طالب يريد تخصصًا آخر: يرسل طلبًا ← *Student accounts* ← Approve أو Decline. بياناته القديمة تبقى محفوظة.
* إغلاق تخصص: Specialties ← Deactivate أو Archive ← **Sync list to cloud**. يرى الطلاب شاشة "غير متاح" وتبقى بياناتهم؛ أعد تفعيله ثم زامن ليعود.
* تحديث بنك: عدّل في مساحة التخصص ← انشر من جديد؛ يصل الطلاب تلقائيًا.

## قائمة ما لا يفعله غيرك (المالك)

- [ ] إنشاء مشروع Firebase وتفعيل Email/Password
- [ ] إنشاء قاعدة Firestore
- [ ] وضع `apiKey` و`projectId` في `firebase-config.js` (النسختين) وبيانات واتساب والخطط في `subscription-config.js`
- [ ] تشغيل `npm test` في `firebase/` ثم نشر `firestore.rules`
- [ ] إنشاء مستخدم المدير ومستند `admins/{uid}`
- [ ] الدخول مرة في نسخة المدير، *Sync list to cloud*، ثم نشر كل بنك
- [ ] استضافة النسختين عبر HTTPS

## حلّ المشكلات

| الرسالة | السبب |
|---|---|
| "Sign-in is not set up yet" | `firebase-config.js` ما زال فارغًا |
| قائمة التسجيل تقول إن التخصصات لم تُحمَّل | القواعد غير منشورة، أو لا تخصص فعّال، أو لم تضغط Sync list to cloud |
| "Missing or insufficient permissions" عند النشر | لا يوجد مستند `admins/{uid}` لحسابك |
| الطالب يرى "your subscription does not include the … question bank" | الاشتراك منتهٍ، أو التخصص غير `active`، أو النطاق `selected` والحزمة لتخصص آخر |
| يتوقف النشر بـ `CROSS_SPECIALTY` | المسار `packs/<id>` يحوي بنك تخصص آخر؛ افتح التخصص الصحيح |
