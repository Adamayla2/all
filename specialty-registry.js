/* Adam QBank (Admin) - specialty registry and workspaces. LOADED FIRST, SYNCHRONOUSLY (no defer).
 *
 * The admin app manages several medical specialties. Each specialty is a separate WORKSPACE with its
 * own local database, so the questions, sections, lectures, flashcards, images, free-question flags
 * and backups of one specialty can never mix with another's:
 *
 *     specialty "ent"            -> database "ENTQuestionBank"        (the original database, untouched)
 *     any other specialty <id>   -> database "ENTAdminBank::<id>"
 *
 * Exactly one workspace is open at a time (EntWorkspace). Everything in the app - the question list,
 * search, reports, free-question counter, exports, publishing - works on the open workspace, and the
 * header always names it. Switching reloads the page so no in-memory state can leak across.
 *
 * The registry (this file) is the list of specialties. It is kept locally and mirrored to Firestore
 * (specialties/{id}) from Settings -> Cloud, which is where students read the list they register from.
 * A specialty's id is permanent; its display name can change at any time.
 */
(function (root) {
  'use strict';

  var Core = root.EntSpecialtyCore;
  var KEY = 'ent_admin_specialties_v2';
  var LEGACY_DB = 'ENTQuestionBank';

  function read() {
    try { var s = JSON.parse(root.localStorage.getItem(KEY) || 'null'); return s && Array.isArray(s.specialties) ? s : null; }
    catch (e) { return null; }
  }
  function write(state) {
    try { root.localStorage.setItem(KEY, JSON.stringify(state)); return true; } catch (e) { return false; }
  }

  function seed() {
    var now = new Date().toISOString();
    var ent = Core.makeSpecialty({
      id: Core.LEGACY_SPECIALTY_ID, name: Core.LEGACY_SPECIALTY_NAME,
      description: 'Ear, nose and throat. This is the original Adam ENT question bank, kept as the first specialty.',
      status: 'active', sortOrder: 0
    }, now);
    ent.dirty = true; ent.syncedAt = null; ent.migrated = true;
    return { schemaVersion: Core.SCHEMA_VERSION, activeId: ent.id, specialties: [ent], createdAt: now };
  }

  var state = read();
  if (!state) { state = seed(); write(state); }
  if (!state.specialties.some(function (s) { return s.id === state.activeId; })) {
    state.activeId = state.specialties[0] ? state.specialties[0].id : Core.LEGACY_SPECIALTY_ID;
    write(state);
  }

  function persist() { if (!write(state)) throw new Error('This browser could not save the specialty list (storage is full or blocked).'); }
  function find(id) { return state.specialties.filter(function (s) { return s.id === id; })[0] || null; }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  function dbNameFor(id) { return id === Core.LEGACY_SPECIALTY_ID ? LEGACY_DB : 'ENTAdminBank::' + id; }

  /* ------------------------------------------------------------------ registry */

  function list() {
    return state.specialties.slice().sort(function (a, b) { return (a.sortOrder - b.sortOrder) || a.name.localeCompare(b.name); }).map(clone);
  }
  function get(id) { var s = find(id); return s ? clone(s) : null; }

  function create(fields) {
    var name = Core.normalizeName(fields && fields.name);
    var id = fields && fields.id ? String(fields.id).trim().toLowerCase() : Core.suggestId(name, state.specialties.map(function (s) { return s.id; }));
    var rec = Core.makeSpecialty({
      id: id, name: name, description: fields && fields.description, status: (fields && fields.status) || 'active',
      sortOrder: state.specialties.reduce(function (m, s) { return Math.max(m, s.sortOrder); }, 0) + 1
    });
    var v = Core.validateSpecialty(rec, { takenNames: state.specialties, takenIds: state.specialties.map(function (s) { return s.id; }), isNew: true });
    if (!v.valid) { var err = new Error(v.errors[0]); err.details = v.errors; throw err; }
    rec.dirty = true; rec.syncedAt = null;
    state.specialties.push(rec);
    persist();
    return clone(rec);
  }

  function update(id, patch) {
    var rec = find(id);
    if (!rec) throw new Error('That specialty no longer exists.');
    if (rec.status === 'archived') throw new Error('An archived specialty is read-only. Restore it first.');
    var next = Object.assign({}, rec);
    if (patch.name != null) next.name = Core.normalizeName(patch.name);
    if (patch.description != null) next.description = String(patch.description).trim();
    if (patch.sortOrder != null && Number.isFinite(Number(patch.sortOrder))) next.sortOrder = Number(patch.sortOrder);
    var v = Core.validateSpecialty(next, { takenNames: state.specialties });
    if (!v.valid) { var err = new Error(v.errors[0]); err.details = v.errors; throw err; }
    next.updatedAt = new Date().toISOString();
    next.dirty = true;
    Object.assign(rec, next);
    persist();
    return clone(rec);
  }

  function setStatus(id, status) {
    var rec = find(id);
    if (!rec) throw new Error('That specialty no longer exists.');
    if (Core.STATUSES.indexOf(status) === -1) throw new Error('Unknown status.');
    if (rec.status === status) return clone(rec);
    rec.status = status;
    rec.updatedAt = new Date().toISOString();
    rec.dirty = true;
    persist();
    return clone(rec);
  }

  // Sets the display order (all statuses, archived ones included) from a list of ids.
  function reorder(ids) {
    var changed = false;
    (ids || []).forEach(function (id, i) {
      var rec = find(id);
      if (rec && rec.sortOrder !== i) { rec.sortOrder = i; rec.updatedAt = new Date().toISOString(); rec.dirty = true; changed = true; }
    });
    if (changed) persist();
  }

  function setActive(id) {
    if (!find(id)) throw new Error('That specialty no longer exists.');
    state.activeId = id;
    persist();
  }

  function markSynced(id, at) {
    var rec = find(id);
    if (rec) { rec.dirty = false; rec.syncedAt = at || new Date().toISOString(); persist(); }
  }

  function dirtyIds() { return state.specialties.filter(function (s) { return s.dirty; }).map(function (s) { return s.id; }); }

  // Adds specialties that exist in the cloud but not on this device, and takes newer cloud metadata for clean ones.
  function mergeFromCloud(cloudList) {
    var added = 0, updated = 0;
    (cloudList || []).forEach(function (c) {
      if (!c || !Core.isValidId(c.id)) return;
      var local = find(c.id);
      if (!local) {
        var rec = Core.makeSpecialty({ id: c.id, name: c.name, description: c.description, status: c.status, sortOrder: c.sortOrder, createdAt: c.createdAt }, c.updatedAt);
        rec.dirty = false; rec.syncedAt = new Date().toISOString();
        state.specialties.push(rec); added++;
      } else if (!local.dirty && c.updatedAt && c.updatedAt > local.updatedAt) {
        local.name = c.name || local.name; local.description = c.description || ''; local.status = c.status || local.status;
        local.sortOrder = c.sortOrder != null ? c.sortOrder : local.sortOrder; local.updatedAt = c.updatedAt; updated++;
      }
    });
    if (added || updated) persist();
    return { added: added, updated: updated };
  }

  /* ------------------------------------------------------------------ workspace (the open specialty) */

  var openId = state.activeId;
  function openRecord() { return find(openId); }

  var Workspace = {
    id: function () { return openId; },
    name: function () { var r = openRecord(); return r ? r.name : openId; },
    status: function () { var r = openRecord(); return r ? r.status : 'active'; },
    isArchived: function () { return Workspace.status() === 'archived'; },
    dbName: function () { return dbNameFor(openId); },
    record: function () { var r = openRecord(); return r ? clone(r) : null; },
    isLegacyDb: function () { return openId === Core.LEGACY_SPECIALTY_ID; }
  };

  /** Switches the open workspace and restarts the page inside it (no state survives a switch). */
  function openWorkspace(id) {
    setActive(id);
    root.location.reload();
  }

  /* ------------------------------------------------------------------ read-only look into another workspace */

  async function dbExists(name) {
    if (root.indexedDB && typeof root.indexedDB.databases === 'function') {
      try { return (await root.indexedDB.databases()).some(function (d) { return d.name === name; }); } catch (e) { /* fall through */ }
    }
    return name === LEGACY_DB || name === Workspace.dbName();
  }

  /** Question count and category count of a workspace, without creating or changing anything. */
  async function summarize(id) {
    var name = dbNameFor(id);
    var out = { questions: 0, categories: null, free: 0, exists: false };
    if (!(await dbExists(name))) return out;
    return new Promise(function (resolve) {
      var req;
      try { req = root.indexedDB.open(name); } catch (e) { resolve(out); return; }
      req.onerror = function () { resolve(out); };
      req.onupgradeneeded = function () { try { req.transaction.abort(); } catch (e) { /* new empty database: leave it */ } };
      req.onsuccess = function () {
        var d = req.result;
        try {
          out.exists = true;
          var stores = Array.prototype.slice.call(d.objectStoreNames);
          var tx = d.transaction(stores.filter(function (n) { return n === 'questions' || n === 'settings'; }), 'readonly');
          if (stores.indexOf('questions') !== -1) {
            var all = tx.objectStore('questions').getAll();
            all.onsuccess = function () { out.questions = (all.result || []).length; out.free = (all.result || []).filter(function (q) { return q.isFree === true; }).length; };
          }
          if (stores.indexOf('settings') !== -1) {
            var t = tx.objectStore('settings').get('ent_taxonomy_v2');
            t.onsuccess = function () {
              try {
                var raw = t.result && t.result.value; var tree = typeof raw === 'string' ? JSON.parse(raw) : raw;
                if (tree && Array.isArray(tree.categories)) out.categories = tree.categories.length;
              } catch (e) { /* ignore */ }
            };
          }
          tx.oncomplete = function () { d.close(); resolve(out); };
          tx.onerror = tx.onabort = function () { d.close(); resolve(out); };
        } catch (e) { try { d.close(); } catch (e2) { /* ignore */ } resolve(out); }
      };
    });
  }

  try {
    root.addEventListener('storage', function (e) {
      if (e.key !== KEY) return;
      var s = read();
      if (s && s.activeId !== openId) root.location.reload();
    });
  } catch (e) { /* ignore */ }

  root.EntWorkspace = Workspace;
  root.EntRegistry = {
    KEY: KEY, list: list, get: get, create: create, update: update, setStatus: setStatus, reorder: reorder, openWorkspace: openWorkspace,
    markSynced: markSynced, dirtyIds: dirtyIds, mergeFromCloud: mergeFromCloud, summarize: summarize, dbNameFor: dbNameFor,
    activeSpecialties: function () { return list().filter(function (s) { return s.status === 'active'; }); }
  };
})(window);
