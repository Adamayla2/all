# Firebase setup (one project for both apps)

Plan for about 20 minutes. Nothing here is secret except your own admin password; the web `apiKey` only identifies the project.

## 1. Create the project

1. <https://console.firebase.google.com> → *Add project* (Analytics is not needed).
2. *Build → Authentication → Get started → Sign-in method* → enable **Email/Password**. (Students who register with a username
   are mapped to a technical e-mail address by the app; no real e-mail is needed.)
3. *Build → Firestore Database → Create database* → production mode, choose a region near your students.
4. *Project settings → General → Your apps → Web app (`</>`)* → register an app. Copy `apiKey` and `projectId`.
5. Recommended: Google Cloud console → *APIs & Services → Credentials* → restrict that API key to *HTTP referrers* = the
   domains where you host the two apps (and `localhost` while testing).

## 2. Fill the two configuration files (they ship empty)

`firebase-config.js` — in **both** apps:
```js
window.ENT_FIREBASE = { apiKey: '<your apiKey>', projectId: '<your projectId>' };
```
`subscription-config.js` — Student app only: your WhatsApp number (digits, international format), plan labels/prices, and
`offlineGraceDays`. Never put a service-account key, private key or password in these files.

## 3. Publish the security rules

Test first (needs Node 18+ and Java 11+; touches no real project):
```
cd firebase
npm install
npm test
```
Then publish: Firestore → *Rules* → paste `firebase/firestore.rules` → *Publish*
(or `firebase deploy --only firestore:rules` after `firebase login` and `firebase use <your-project>`).

## 4. Make yourself an admin

1. Open the Admin app, *Settings → Cloud (Firebase)* → enter an e-mail and password → *Sign in*.
   If this e-mail has no account yet, create it first in *Authentication → Users → Add user*.
2. Copy that user's **UID** (Authentication → Users).
3. Firestore → *Start collection* `admins` → document ID = the UID → any field (for example `note: owner`).
   Rules never let an app create or edit admins.
4. Sign in again in the Admin app; publishing and account tools now work.

## 5. Create the specialties

Admin app → tap the specialty chip → **Specialties**.
1. ENT is already there. Add the others (name + id; the id is permanent).
2. Build each specialty's categories and sections (*Categories & sections*), then import or add questions while that
   specialty is open.
3. Press **Sync list to cloud** so the registration screen can list the *active* specialties.

## 6. Publish the question banks

For each specialty: open it → *Settings → Cloud (Firebase)* → *Publish <Specialty> question bank* → read the confirmation
(it names the specialty) → OK. ENT: keep *Also update the old ENT location* ticked while some students are still on 1.3.x.

Optional: *Settings → Subscription scope* → `selected` (each subscriber gets their own specialty) or `all`.

## 7. Free questions (optional)

In the Admin app, with a specialty open, mark questions *Free* and use *Export <Specialty> Free Pack*. Place the file in the
Student app's folder as `free-packs/<specialtyId>.qbpkg` (for example `free-packs/dermatology.qbpkg`) and deploy.

## 8. Host the two apps

Any static host works (Cloudflare Pages, Netlify, Firebase Hosting, GitHub Pages). Serve over HTTPS. Keep the `_headers` file
(it stops the service worker and manifest from being cached stale). Deploy the Admin app on a separate address and do not
publish its link.

## 9. Everyday operation

* New student: they register and pick a specialty → you activate the subscription in *Settings → Student accounts*.
* Student wants another specialty: they send a request → *Student accounts* → Approve (or Decline). Their old data is kept.
* Close a specialty: Specialties → Deactivate or Archive → **Sync list to cloud**. Students see an "unavailable" screen and keep
  their data; reactivate and sync to reopen.
* Update a bank: edit in the specialty's workspace → publish again. Students receive it automatically.

## Checklist — what only the owner can do

- [ ] Create the Firebase project and enable Email/Password sign-in
- [ ] Create the Firestore database
- [ ] Put `apiKey` + `projectId` into `firebase-config.js` (both apps) and WhatsApp/plans into `subscription-config.js`
- [ ] Run `npm test` in `firebase/`, then publish `firestore.rules`
- [ ] Create your admin user and the `admins/{uid}` document
- [ ] Sign in once in the Admin app and press *Sync list to cloud*, then publish each bank
- [ ] Host both apps over HTTPS

## Troubleshooting

| Message | Cause |
|---|---|
| "Sign-in is not set up yet" | `firebase-config.js` is still empty |
| Registration list says "could not load specialties" | rules not published, no active specialty, or *Sync list to cloud* was not pressed |
| "Missing or insufficient permissions" when publishing | your UID has no `admins/{uid}` document |
| Student sees "your subscription does not include the … question bank" | plan expired, specialty not `active`, or scope is `selected` and the pack belongs to another specialty |
| Publish stops with `CROSS_SPECIALTY` | `packs/<id>` already holds a bank of another specialty; open the right specialty |
