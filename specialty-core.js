/* Adam QBank - shared specialty core (identical in the Admin and Student apps).
 *
 * This file is the single definition of the multi-specialty data contract. Both apps load it, so
 * they cannot disagree about specialty IDs, schema versions, package fields or validation rules.
 *
 *   Specialty -> Category -> Section -> Question
 *
 *   specialty   { schemaVersion, id, name, description, status, sortOrder, createdAt, updatedAt }
 *   taxonomy    { schemaVersion, specialtyId, updatedAt, categories: [ { id, name, order, status,
 *                 sections: [ { id, name, order, status } ] } ] }
 *   question    carries specialtyId, subject (= category name), chapter (= section name),
 *               subjectId (= category id), chapterId (= section id)
 *   package     manifest.schemaVersion = 2, manifest.specialty = { id, name },
 *               database.specialtyId, every item's specialtyId (when present) must match.
 *
 * Nothing in here touches the DOM, IndexedDB or the network, so it is safe to load first.
 */
(function (root) {
  'use strict';

  /** Version of the specialty-aware data contract (packages, profiles, Firestore documents). */
  var SCHEMA_VERSION = 2;
  /** Package/database shape used before specialties existed (Adam ENT 1.3.x). Treated as ENT. */
  var LEGACY_SCHEMA_VERSION = 1;
  /** The specialty that all pre-1.4 content, accounts and packages belong to. */
  var LEGACY_SPECIALTY_ID = 'ent';
  var LEGACY_SPECIALTY_NAME = 'ENT';

  var PRODUCT_NAME = 'Adam QBank';
  var PACKAGE_EXTENSION = '.qbpkg';
  var ACCEPTED_PACKAGE_EXTENSIONS = ['.qbpkg', '.entpkg', '.zip', '.json'];

  var STATUSES = ['active', 'inactive', 'archived'];
  var ID_PATTERN = /^[a-z][a-z0-9-]{1,38}[a-z0-9]$/;
  // 'main' is the legacy ENT pack path in Firestore; the others are collection / config names.
  var RESERVED_IDS = ['main', 'config', 'settings', 'access', 'admin', 'admins', 'users', 'reports', 'packs',
    'specialties', 'all', 'none', 'default', 'unscoped', 'null', 'undefined', 'legacy'];
  var LIMITS = { name: 80, description: 500, categories: 200, sectionsPerCategory: 500, itemName: 200 };

  /* ------------------------------------------------------------------ specialty ids */

  function slugify(name) {
    var s = String(name == null ? '' : name).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
      .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    if (s.length > 40) s = s.slice(0, 40).replace(/-+$/g, '');
    return s;
  }

  /** Returns '' when the id is acceptable, otherwise a user-facing reason. */
  function idProblem(id) {
    if (typeof id !== 'string' || !id) return 'A specialty ID is required.';
    if (!ID_PATTERN.test(id)) return 'A specialty ID must be 3-40 characters: lowercase letters, numbers and dashes, starting with a letter.';
    if (RESERVED_IDS.indexOf(id) !== -1) return '"' + id + '" is reserved and cannot be used as a specialty ID.';
    return '';
  }

  function isValidId(id) { return idProblem(id) === ''; }

  /** Suggests an unused id for a display name ("Internal Medicine" -> "internal-medicine"). */
  function suggestId(name, takenIds) {
    var taken = new Set(takenIds || []);
    var base = slugify(name);
    if (base.length < 3) base = (base + '-spec').replace(/^-+/, '');
    if (!/^[a-z]/.test(base)) base = 's-' + base;
    var candidate = base, n = 2;
    while (idProblem(candidate) || taken.has(candidate)) {
      candidate = base.slice(0, 36) + '-' + n++;
      if (n > 500) break;
    }
    return candidate;
  }

  function normalizeName(value) {
    return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  }

  function nameKey(value) {
    return normalizeName(value).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
  }

  /* ------------------------------------------------------------------ specialty record */

  function validateSpecialty(rec, opts) {
    opts = opts || {};
    var errors = [];
    if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return { valid: false, errors: ['The specialty is missing.'] };
    var p = idProblem(rec.id);
    if (p) errors.push(p);
    var name = normalizeName(rec.name);
    if (name.length < 2) errors.push('The specialty needs a display name (at least 2 characters).');
    if (name.length > LIMITS.name) errors.push('The specialty name is longer than ' + LIMITS.name + ' characters.');
    if (rec.description != null && String(rec.description).length > LIMITS.description) {
      errors.push('The description is longer than ' + LIMITS.description + ' characters.');
    }
    if (STATUSES.indexOf(rec.status) === -1) errors.push('The specialty status must be active, inactive or archived.');
    if (opts.takenNames && name) {
      var k = nameKey(name);
      var clash = (opts.takenNames || []).some(function (o) { return o && o.id !== rec.id && nameKey(o.name) === k; });
      if (clash) errors.push('Another specialty already uses the name "' + name + '".');
    }
    if (opts.takenIds && opts.isNew && (opts.takenIds || []).indexOf(rec.id) !== -1) errors.push('A specialty with ID "' + rec.id + '" already exists.');
    return { valid: errors.length === 0, errors: errors };
  }

  function makeSpecialty(fields, now) {
    var iso = now || new Date().toISOString();
    return {
      schemaVersion: SCHEMA_VERSION,
      id: String(fields.id),
      name: normalizeName(fields.name),
      description: String(fields.description == null ? '' : fields.description).trim(),
      status: fields.status || 'active',
      sortOrder: Number.isFinite(Number(fields.sortOrder)) ? Number(fields.sortOrder) : 0,
      createdAt: fields.createdAt || iso,
      updatedAt: iso
    };
  }

  var STATUS_LABELS = { active: 'Active', inactive: 'Inactive', archived: 'Archived' };
  var STATUS_HELP = {
    active: 'Open for registration. Students can study and download the bank.',
    inactive: 'Hidden from registration. Existing students see a "temporarily unavailable" notice; their data is kept.',
    archived: 'Retired. Hidden from registration and read-only for admins. Existing students see an "archived" notice; their data is kept.'
  };

  /* ------------------------------------------------------------------ taxonomy */

  var idCounter = 0;
  function newId(prefix) {
    var rnd;
    try {
      var a = new Uint32Array(2);
      root.crypto.getRandomValues(a);
      rnd = a[0].toString(36) + a[1].toString(36);
    } catch (e) { rnd = Math.random().toString(36).slice(2) + Date.now().toString(36); }
    idCounter++;
    return prefix + '-' + rnd.slice(0, 8) + idCounter.toString(36);
  }

  function emptyTaxonomy(specialtyId) {
    return { schemaVersion: SCHEMA_VERSION, specialtyId: specialtyId || '', updatedAt: new Date().toISOString(), categories: [] };
  }

  /** Cleans a taxonomy object into the canonical v2 shape (no validation of uniqueness). */
  function normalizeTaxonomy(raw, specialtyId) {
    var out = emptyTaxonomy(specialtyId || (raw && raw.specialtyId) || '');
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.categories)) return out;
    out.updatedAt = raw.updatedAt || out.updatedAt;
    raw.categories.forEach(function (c, ci) {
      if (!c || typeof c !== 'object') return;
      var cat = {
        id: String(c.id || ''),
        name: normalizeName(c.name),
        description: String(c.description == null ? '' : c.description).trim(),
        order: Number.isFinite(Number(c.order)) ? Number(c.order) : ci,
        status: c.status === 'archived' ? 'archived' : 'active',
        sections: []
      };
      (Array.isArray(c.sections) ? c.sections : []).forEach(function (s, si) {
        if (!s || typeof s !== 'object') return;
        var sec = {
          id: String(s.id || ''),
          name: normalizeName(s.name),
          order: Number.isFinite(Number(s.order)) ? Number(s.order) : si,
          status: s.status === 'archived' ? 'archived' : 'active'
        };
        if (s.number != null && Number.isFinite(Number(s.number))) sec.number = Number(s.number);
        if (s.partId) sec.partId = String(s.partId);
        cat.sections.push(sec);
      });
      cat.sections.sort(function (a, b) { return a.order - b.order; });
      out.categories.push(cat);
    });
    out.categories.sort(function (a, b) { return a.order - b.order; });
    return out;
  }

  /** Hard validation used before a taxonomy is saved, published or applied. */
  function validateTaxonomy(tax, specialtyId) {
    var errors = [];
    if (!tax || typeof tax !== 'object' || !Array.isArray(tax.categories)) return { valid: false, errors: ['The category list is missing.'] };
    if (Number(tax.schemaVersion) > SCHEMA_VERSION) errors.push('The category list uses a newer schema (' + tax.schemaVersion + ').');
    if (specialtyId && tax.specialtyId && tax.specialtyId !== specialtyId) {
      errors.push('The category list belongs to "' + tax.specialtyId + '", not "' + specialtyId + '".');
    }
    if (tax.categories.length > LIMITS.categories) errors.push('Too many categories (limit ' + LIMITS.categories + ').');
    var catIds = new Set(), secIds = new Set(), catNames = new Set();
    tax.categories.forEach(function (c) {
      if (!c.id) { errors.push('A category has no ID.'); return; }
      if (catIds.has(c.id)) errors.push('Category ID "' + c.id + '" is used twice.');
      catIds.add(c.id);
      if (!c.name) errors.push('A category has no name.');
      else if (c.name.length > LIMITS.itemName) errors.push('Category "' + c.name.slice(0, 30) + '..." has a name that is too long.');
      var ck = nameKey(c.name);
      if (ck && catNames.has(ck)) errors.push('Two categories are named "' + c.name + '".');
      catNames.add(ck);
      var secNames = new Set();
      if ((c.sections || []).length > LIMITS.sectionsPerCategory) errors.push('Category "' + c.name + '" has too many sections.');
      (c.sections || []).forEach(function (s) {
        if (!s.id) { errors.push('A section in "' + c.name + '" has no ID.'); return; }
        if (secIds.has(s.id)) errors.push('Section ID "' + s.id + '" is used twice (a section can belong to only one category).');
        secIds.add(s.id);
        if (!s.name) errors.push('A section in "' + c.name + '" has no name.');
        var sk = nameKey(s.name);
        if (sk && secNames.has(sk)) errors.push('Category "' + c.name + '" has two sections named "' + s.name + '".');
        secNames.add(sk);
      });
    });
    return { valid: errors.length === 0, errors: errors };
  }

  /** Looks a question's labels up in a taxonomy. Names are matched exactly (after trimming). */
  function indexTaxonomy(tax) {
    var byCatName = new Map(), byCatId = new Map(), secById = new Map();
    ((tax && tax.categories) || []).forEach(function (c) {
      byCatName.set(c.name, c);
      byCatId.set(c.id, c);
      (c.sections || []).forEach(function (s) { secById.set(s.id, { section: s, category: c }); });
    });
    return { byCatName: byCatName, byCatId: byCatId, secById: secById };
  }

  /** Reference check for one question against its specialty's taxonomy. Returns '' or a problem. */
  function questionTaxonomyProblem(q, index) {
    if (!q || !index) return '';
    if (q.chapterId) {
      var hit = index.secById.get(q.chapterId);
      if (!hit) return 'it references section "' + q.chapterId + '" which does not exist in this specialty';
      if (q.subjectId && hit.category.id !== q.subjectId) return 'its section "' + q.chapterId + '" does not belong to category "' + q.subjectId + '"';
    } else if (q.subjectId && !index.byCatId.has(q.subjectId)) {
      return 'it references category "' + q.subjectId + '" which does not exist in this specialty';
    }
    return '';
  }

  /* ------------------------------------------------------------------ package contract */

  function safeCompare(a, b) {
    var pa = String(a == null ? '0' : a).split('.').map(function (n) { return parseInt(n, 10) || 0; });
    var pb = String(b == null ? '0' : b).split('.').map(function (n) { return parseInt(n, 10) || 0; });
    for (var i = 0; i < Math.max(pa.length, pb.length); i++) {
      var x = pa[i] || 0, y = pb[i] || 0;
      if (x !== y) return x < y ? -1 : 1;
    }
    return 0;
  }

  /**
   * Reads which specialty a package claims to be for.
   * Returns { schema, specialtyId, specialtyName, legacy } or { error }.
   * - schema 2 packages MUST name a specialty, and manifest and database must agree.
   * - schema 1 packages (Adam ENT 1.3.x) carry no specialty; they are ENT packages.
   */
  function packageIdentity(manifest, database) {
    manifest = manifest || {}; database = database || {};
    var mSchema = Number(manifest.schemaVersion == null ? LEGACY_SCHEMA_VERSION : manifest.schemaVersion);
    var dSchema = Number(database.schemaVersion == null ? LEGACY_SCHEMA_VERSION : database.schemaVersion);
    if (!Number.isFinite(mSchema) || !Number.isFinite(dSchema)) return { error: 'The package has an invalid schema version.' };
    if (mSchema > SCHEMA_VERSION || dSchema > SCHEMA_VERSION) {
      return { error: 'This package uses a newer format (schema ' + Math.max(mSchema, dSchema) + '). Update the app before importing it.' };
    }
    if (mSchema !== dSchema) return { error: 'The package manifest (schema ' + mSchema + ') and database (schema ' + dSchema + ') disagree.' };
    if (mSchema <= LEGACY_SCHEMA_VERSION) {
      if (manifest.specialty || database.specialtyId) return { error: 'This package names a specialty but declares the old schema version.' };
      return { schema: LEGACY_SCHEMA_VERSION, specialtyId: LEGACY_SPECIALTY_ID, specialtyName: LEGACY_SPECIALTY_NAME, legacy: true };
    }
    var m = manifest.specialty && typeof manifest.specialty === 'object' ? manifest.specialty : null;
    if (!m || typeof m.id !== 'string' || !m.id) return { error: 'The package does not say which specialty it belongs to.' };
    if (typeof database.specialtyId !== 'string' || !database.specialtyId) return { error: 'The package content does not say which specialty it belongs to.' };
    if (m.id !== database.specialtyId) {
      return { error: 'The package is inconsistent: its manifest says "' + m.id + '" but its content says "' + database.specialtyId + '".' };
    }
    var p = idProblem(m.id);
    if (p) return { error: 'The package has an invalid specialty ID. ' + p };
    return { schema: SCHEMA_VERSION, specialtyId: m.id, specialtyName: normalizeName(m.name) || m.id, legacy: false };
  }

  /**
   * Full specialty gate for a package. `expectedSpecialtyId` is the specialty of the workspace
   * (admin) or of the signed-in student's account. Returns { ok, identity, errors, itemErrors }.
   * Item-level checks list the first few offenders; callers decide whether that blocks the import.
   */
  function validatePackageForSpecialty(manifest, database, expectedSpecialtyId, opts) {
    opts = opts || {};
    var identity = packageIdentity(manifest, database);
    if (identity.error) return { ok: false, identity: null, errors: [identity.error], itemErrors: [] };
    if (!expectedSpecialtyId) {
      return { ok: false, identity: identity, errors: ['No specialty is selected, so this package cannot be applied.'], itemErrors: [] };
    }
    var errors = [];
    if (identity.specialtyId !== expectedSpecialtyId) {
      var expectedName = opts.expectedSpecialtyName ? ' (' + opts.expectedSpecialtyName + ')' : '';
      errors.push('This package is for "' + identity.specialtyName + '" (' + identity.specialtyId + ') but this ' + (opts.subject || 'account') +
        ' is set to "' + expectedSpecialtyId + '"' + expectedName + '. Nothing was imported.');
      return { ok: false, identity: identity, errors: errors, itemErrors: [] };
    }
    var itemErrors = [];
    ['questions', 'lectures', 'flashcards', 'bookMeta'].forEach(function (type) {
      (Array.isArray(database[type]) ? database[type] : []).forEach(function (item) {
        if (item && item.specialtyId != null && item.specialtyId !== expectedSpecialtyId) {
          itemErrors.push({ type: type, uid: item.uid || null, reason: 'belongs to specialty "' + item.specialtyId + '", not "' + expectedSpecialtyId + '"' });
        }
      });
    });
    if (itemErrors.length) {
      errors.push(itemErrors.length + ' item(s) in the package belong to a different specialty. The package was rejected as a whole so nothing is mixed.');
    }
    // The v2 category tree travels as database.taxonomyV2; database.taxonomy stays a legacy {category: [sections]} map.
    if (database.taxonomyV2 && identity.schema >= SCHEMA_VERSION) {
      var tv = validateTaxonomy(normalizeTaxonomy(database.taxonomyV2, expectedSpecialtyId), expectedSpecialtyId);
      if (database.taxonomyV2.specialtyId && database.taxonomyV2.specialtyId !== expectedSpecialtyId) {
        tv = { valid: false, errors: ['The category list belongs to "' + database.taxonomyV2.specialtyId + '", not "' + expectedSpecialtyId + '".'] };
      }
      if (!tv.valid) errors = errors.concat(tv.errors.slice(0, 5).map(function (e) { return 'Categories: ' + e; }));
    }
    return { ok: errors.length === 0, identity: identity, errors: errors, itemErrors: itemErrors };
  }

  /* ------------------------------------------------------------------ scope keys (local storage) */

  function scopeKey(uid, specialtyId) { return String(uid || '') + '::' + String(specialtyId || ''); }

  root.EntSpecialtyCore = Object.freeze({
    SCHEMA_VERSION: SCHEMA_VERSION,
    LEGACY_SCHEMA_VERSION: LEGACY_SCHEMA_VERSION,
    LEGACY_SPECIALTY_ID: LEGACY_SPECIALTY_ID,
    LEGACY_SPECIALTY_NAME: LEGACY_SPECIALTY_NAME,
    PRODUCT_NAME: PRODUCT_NAME, PACKAGE_EXTENSION: PACKAGE_EXTENSION,
    ACCEPTED_PACKAGE_EXTENSIONS: ACCEPTED_PACKAGE_EXTENSIONS,
    STATUSES: STATUSES, STATUS_LABELS: STATUS_LABELS, STATUS_HELP: STATUS_HELP,
    RESERVED_IDS: RESERVED_IDS, LIMITS: LIMITS,
    slugify: slugify, idProblem: idProblem, isValidId: isValidId, suggestId: suggestId,
    normalizeName: normalizeName, nameKey: nameKey,
    validateSpecialty: validateSpecialty, makeSpecialty: makeSpecialty,
    newId: newId, emptyTaxonomy: emptyTaxonomy, normalizeTaxonomy: normalizeTaxonomy, validateTaxonomy: validateTaxonomy,
    indexTaxonomy: indexTaxonomy, questionTaxonomyProblem: questionTaxonomyProblem,
    packageIdentity: packageIdentity, validatePackageForSpecialty: validatePackageForSpecialty,
    compareVersions: safeCompare, scopeKey: scopeKey
  });
})(typeof window !== 'undefined' ? window : globalThis);
