# Migrating Adam ENT 1.3.x to Adam QBank 1.4.0

The goal: existing ENT content, accounts and student progress keep working; nothing is deleted or moved without you.
Do the steps in this order. Steps marked **(owner)** need your Firebase login.

## Order of work

1. **(owner)** Fill `firebase-config.js` / `subscription-config.js` as in FIREBASE-SETUP.md (copy the values from your current 1.3.0 files).
2. **(owner)** Copy your current rules from the Firebase console to a safe place (they were not part of the 1.3.0 packages and are your rollback). Run `npm test` in `firebase/`, then publish `firestore.rules`.
   * Until `specialties/ent` exists, the rules still treat ENT as available and accounts without `specialtyId` as ENT, so the
     transition does not lock anyone out.
3. **(owner)** Add your `admins/{uid}` document (rules are now the only admin gate).
4. Deploy the **Admin app 1.4.0** over the old one. Your ENT questions, categories, backups and settings are still there
   (same database `ENTQuestionBank`); ENT appears as the first specialty. On first admin unlock you choose a passcode — the old
   fixed password no longer exists.
5. **(owner)** In the Admin app: Specialties → **Sync list to cloud** (this creates `specialties/ent`; add other specialties first if you like).
6. **(owner)** ENT workspace → *Publish ENT question bank* with *Also update the old ENT location* ticked (it is ticked by default for ENT). Students on 1.3.x keep
   reading `packs/main`; 1.4.0 students read `packs/ent`.
7. **(owner)** *Settings → Student accounts → Assign the N account(s) with no specialty to ENT*. (Optional: every 1.4.0 app also marks
   its own legacy account as ENT the first time it opens, so this step only makes the list complete.)
   *Settings → ENT migration check* confirms which of the two ENT locations and `specialties/ent` exist.
8. Deploy the **Student app 1.4.0**. Existing students stay signed in, are treated as ENT, keep their local database and progress.
9. When all students are on 1.4.0 you may untick *Also update the old ENT location* and delete `packs/main` in the console.
10. Add the new specialties, their categories/sections and questions; publish each; choose the subscription scope.

## What happens to existing data

| Item | After the upgrade |
|---|---|
| Admin questions, categories, backups, settings | Unchanged, now the ENT workspace. Rows get `specialtyId: "ent"` the next time they are written or exported. |
| ENT category tree (Otology, …) | Identical ids and names. |
| Student account (Firebase user) | Unchanged. Gets `specialtyId: "ent"`, `specialtyAssignedBy: "migration"` once. Plan and expiry are untouched. |
| Student local database, bookmarks, notes, progress | The legacy database `ENTQuestionBank` is kept as it is and becomes the ENT scope of the first ENT account that opens it on that device (normally the student who was signed in). Later accounts on the same device get their own databases (`ENTQB::<uid>::<specialty>`). |
| Published pack | `packs/main` stays valid; `packs/ent` is added. |
| Old reports (no specialty) | Shown as "ENT (legacy)". |
| Old packages `.entpkg` (v1) | Still importable; treated as ENT. |
| Old free pack `free-pack.entpkg` | Still used by ENT accounts. New files use `free-packs/<id>.qbpkg`. |

## Things to know

* **New accounts need 1.4.0.** The rules require a valid active `specialtyId` on every new account, so a student still running
  1.3.x can keep studying but cannot create a *new* account. Ask new students to reload/update the app.
* **ENT packages for old students.** Exports for ENT have a *Compatible with app 1.3.x* option (minimum app 1.2.7). Packages of every
  other specialty require 1.4.0, so an old app can never import them.
* **Sync after changing a specialty's status.** Status changes reach students only after *Sync list to cloud*.
* **Specialty ids are permanent.** Rename the display name freely; never reuse an id for another subject.
* **Rollback.** Nothing is destructive: re-deploy the 1.3.0 apps and paste back the rules you saved in step 2 and ENT works as before (packs/main and the
  local databases are untouched). New-specialty data would simply be ignored by 1.3.0.
