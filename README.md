# Adam QBank 1.4.0 — Admin app

Multi-specialty medical question-bank platform. This folder is the **Admin app**. Its companion is the
**Student app** (`Adam-QBank-Student-v1.4.0`). Both are plain static files (no build step) that talk to one
Firebase project over REST (Authentication + Firestore). Both were Adam ENT 1.3.0; ENT is now simply one specialty.

| You want to… | Read |
|---|---|
| Set up Firebase, rules, config files, first admin | [FIREBASE-SETUP.md](FIREBASE-SETUP.md) (عربي: [FIREBASE-SETUP-AR.md](FIREBASE-SETUP-AR.md)) |
| Upgrade an existing Adam ENT 1.3.x installation | [MIGRATION.md](MIGRATION.md) |
| Run / change the security rules and their tests | [firebase/README.md](firebase/README.md) |

No credential, key or secret is shipped in this package. `firebase-config.js` is empty; you fill it in.

---

## 1. The model

```
Specialty  ->  Category  ->  Section  ->  Question
 (ENT)         (Otology)     (Hearing tests)
```

* Every question belongs to **exactly one** specialty, category and section.
* A specialty has a **stable id** (`ent`, `dermatology`, …; 3–40 chars, lowercase letters, digits and hyphens,
  starts with a letter, never changes), a display **name**, an optional description and a **status**:
  `active` (students can register and read), `inactive` (closed for now), `archived` (closed and read-only in the admin).
  Specialties are never deleted.
* Categories and sections are stored per specialty. In question rows the older field names are kept for compatibility:
  `subject` = category name, `chapter` = section name, `subjectId` / `chapterId` = their ids.
* ENT keeps its built-in classic tree (Otology, Rhinology, … with the same ids as before). A new specialty starts empty.

## 2. Admin app

**Workspaces.** The admin works in one specialty at a time. Each specialty has its own local database
(ENT keeps `ENTQuestionBank`, the others use `ENTAdminBank::<id>`), so questions, categories, sections, backups,
imports, exports, free selection and reports can never be mixed. The open specialty is shown in the header chip and in a
banner; tap the chip to switch specialty. An archived specialty opens read-only.

**Specialties** (tap the chip → Specialties): create, edit name/description, activate, deactivate, archive, restore,
reorder, open its workspace, and **Sync list to cloud** (publishes the list of specialties to Firestore; students can only
register into an `active` one). Use *Pull list from cloud* to load the list on a new device.

**Categories & sections** (Specialties → *Categories & sections*): add, rename, reorder, move a section to another
category, archive/restore, delete when unused. Renaming rewrites the questions that use the old name.
Questions keep their creation order inside a section; move a question with *Reclassify* in the Questions list.

**Import / export.**
* Export (Settings → *Update package*) builds a `.qbpkg` file for the open specialty. The card shows the specialty and asks
  you to confirm it before the file is created. ENT also offers *Compatible with app 1.3.x* so students still on 1.3.x can read it.
* Import accepts `.qbpkg` (also `.entpkg`, `.zip`, `.json`). A package of another specialty is **refused as a whole**.
  A v1 package without a specialty is treated as ENT.
* Backups record their specialty and refuse to restore into another one.

**Free questions.** Mark questions *Free* in the Questions list, then Settings → *Export <Specialty> Free Pack*. Put the file
in `free-packs/<specialtyId>.qbpkg` next to the Student app's `index.html` (ENT may also keep the old `free-pack.entpkg`).

**Cloud publishing** (Settings → *Cloud (Firebase)*): sign in with your admin e-mail, open the specialty, press
*Publish <Specialty> question bank*. The confirm dialog names the specialty. It writes `packs/<specialtyId>` and refuses to
overwrite a pack that belongs to another specialty (`CROSS_SPECIALTY`). For ENT you can also refresh the old
`packs/main` copy so students still on 1.3.x keep working.

**Subscription scope** (Settings → *Subscription scope*): `selected` (default) — a subscriber reads only the bank of the
specialty on their account; `all` — an active subscription opens every active specialty. Enforced by the rules, not just the UI.

**Student accounts** (Settings → *Student accounts*): shows each student's specialty, filters by specialty, extends or stops
a subscription, changes a student's specialty, approves/declines a student's change request, and (for the migration)
*Assign the N account(s) with no specialty to ENT*.

**Reports** (Settings → *Question reports*): each report shows its specialty; filter by specialty; *Show question* jumps to the
right workspace.

**Admin mode and the passcode.** Version 1.3.0 shipped a fixed password inside `app.js`. It was removed. The first time you
unlock Admin mode the app asks you to choose a passcode (at least 8 characters) for that device; only a salted PBKDF2 hash is
stored. This only hides the admin screens on the device. The real protection is the Firestore rules plus `admins/{uid}`.

## 3. Student app (summary)

* Registration: username or e-mail + password + **one active specialty** (list loaded from Firestore, no hard-coded list).
* Everything is filtered by the account's specialty: categories, sections, questions, search, bookmarks, notes, exam mode,
  progress, free questions, reports, imported / downloaded / local data. Data is stored per student **and** specialty.
* The specialty is shown in the header and in Settings. Changing it is never silent: the student sends a request, the admin
  approves it (or changes it directly), the page reloads into the other scope, and the old scope's data stays untouched.
* A specialty that is inactive, archived or deleted shows a clear "unavailable" screen. The student is not moved and nothing
  is deleted; the bank returns as soon as the specialty is active again.
* Works offline after the first sign-in, as before.

## 4. Package format v2 (`.qbpkg`)

A zip file: `manifest.json`, `database.json`, optional `assets/`.

```jsonc
// manifest.json
{ "schemaVersion": 2,
  "specialty": { "id": "dermatology", "name": "Dermatology" },
  "packageVersion": "2026.11.05.1", "minAppVersion": "1.4.0",
  "sha256": "<hash of database.json>", "counts": { "questions": 120 } }
// database.json
{ "specialtyId": "dermatology",
  "taxonomyV2": { "categories": [ { "id": "...", "name": "...", "sections": [ { "id": "...", "name": "..." } ] } ] },
  "taxonomy": { /* legacy map, kept for old readers */ },
  "questions": [ { "uid": "...", "specialtyId": "dermatology", "subjectId": "...", "chapterId": "...", "...": "..." } ] }
```

Validation on import: schema version, SHA-256, `specialtyId` equals the account/workspace specialty, every item names the same
specialty (or none, for v1), no duplicate uids, every question points to a category and section that exist in the package
tree. Any failure rejects the **whole** package before anything is written. ENT packages built with *Compatible with app 1.3.x* set
`minAppVersion` to 1.2.7 so unchanged 1.3.x students can import them (that app ignores unknown fields).

## 5. Firestore layout

| Path | Content | Who writes |
|---|---|---|
| `specialties/{id}` | id, name, description, status, sortOrder, schemaVersion | admin |
| `users/{uid}` | identifier, plan, expiresAt, **specialtyId**, specialtyName, specialtyAssignedBy, specialtyChangeRequest | student creates own (plan `none`, active specialty); student may only add a change request; admin does the rest |
| `packs/{specialtyId}` + `/chunks/*` | published bank | admin |
| `packs/main` | legacy ENT copy | admin |
| `settings/access` | `subscriptionScope` = `selected` \| `all` | admin |
| `reports/{uid}_{questionUid}` | report with `specialtyId` | student creates (own specialty only), admin reads |
| `admins/{uid}` | membership marker | you, in the console |

The rules in `firebase/firestore.rules` enforce: a student reads only the pack of their own specialty (unless scope is `all`),
only while the subscription is active and the specialty is `active`; students cannot change their plan, expiry or specialty;
reports must carry the student's own specialty; only admins publish and manage.

## 6. What needs the owner

See the checklist at the end of [FIREBASE-SETUP.md](FIREBASE-SETUP.md): create the Firebase project, enable Email/Password,
fill `firebase-config.js` (both apps) and `subscription-config.js` (student), publish the rules, add `admins/{uid}`, sign in
once to publish. Nothing in these zips can do that for you.

## 7. Honest limits of this release

* The security rules were written together with an automated test (`firebase/firestore-rules.test.js`) but that test needs the
  Firestore emulator, which could not be started where the code was produced. **Run `npm test` in `firebase/` before you publish the rules.**
* Reordering is available for specialties, categories and sections. Questions keep their creation order.
* A browser-side check (headless Chromium with a mocked Firebase) covered registration, isolation, switching, blocked states,
  package gates, publishing, migration from 1.3.0 and offline reload. It does not replace a trial against your real project.
