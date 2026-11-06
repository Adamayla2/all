/* Adam QBank - per-specialty category / section tree (identical in the Admin and Student apps).
 *
 *   Specialty -> Category -> Section -> Question
 *
 * The tree for the CURRENT specialty lives in the specialty's own database (settings key
 * "ent_taxonomy_v2"), so one specialty's categories can never show up in another one.
 *
 *  - Admin: edits it (Specialties -> Categories & sections) and ships it inside every package as
 *    database.taxonomyV2.
 *  - Student: receives it from the package of the student's own specialty.
 *  - ENT keeps its built-in Scott-Brown tree as the starting point (same IDs as before), until an
 *    administrator saves a changed tree. Other specialties start empty.
 *
 * Questions keep the field names subject (= category name) and chapter (= section name), plus
 * subjectId (= category id) and chapterId (= section id), so all existing filters, search and exam
 * code keep working.
 *
 * Loaded after app.js (it reads `db` and, for ENT, SCOTT_BROWN_TAXONOMY at call time).
 */
(function () {
  'use strict';

  var Core = window.EntSpecialtyCore;
  var KEY = 'ent_taxonomy_v2';
  var BASELINE_AT = '2000-01-01T00:00:00.000Z'; // marks the untouched built-in ENT tree
  var state = null;        // canonical tree saved in this database (or null)
  var baselineCache = null; // { forId, tree }
  var listeners = [];

  function specialtyId() {
    if (window.EntScope) return window.EntScope.specialtyId();
    if (window.EntWorkspace) return window.EntWorkspace.id();
    return null;
  }

  function isEnt() { return specialtyId() === Core.LEGACY_SPECIALTY_ID; }

  /** The built-in ENT tree, converted from SCOTT_BROWN_TAXONOMY with the same ids and numbering. */
  function fromScottBrown() {
    var src = typeof SCOTT_BROWN_TAXONOMY !== 'undefined' ? SCOTT_BROWN_TAXONOMY : [];
    var tax = Core.emptyTaxonomy(Core.LEGACY_SPECIALTY_ID);
    tax.updatedAt = BASELINE_AT;
    src.forEach(function (s, ci) {
      var cat = { id: s.subjectId, name: s.subject, description: '', order: ci, status: 'active', sections: [] };
      var order = 0;
      (s.chapters || []).forEach(function (c) {
        cat.sections.push({ id: c.chapterId, name: c.chapter, order: order++, status: 'active', number: c.chapterNumber });
      });
      (s.parts || []).forEach(function (p) {
        (p.chapters || []).forEach(function (c) {
          cat.sections.push({ id: c.chapterId, name: c.chapter, order: order++, status: 'active', number: c.chapterNumber, partId: p.partId });
        });
      });
      tax.categories.push(cat);
    });
    return tax;
  }

  function baseline() {
    var id = specialtyId();
    if (baselineCache && baselineCache.forId === id) return baselineCache.tree;
    var tree = isEnt() ? fromScottBrown() : Core.emptyTaxonomy(id || '');
    baselineCache = { forId: id, tree: tree };
    return tree;
  }

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  function notify() { listeners.forEach(function (cb) { try { cb(get()); } catch (e) { console.error(e); } }); }

  /* ------------------------------------------------------------------ read */

  async function load() {
    state = null;
    try {
      var raw = await db.getSetting(KEY, null);
      if (raw) {
        var parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
        var tree = Core.normalizeTaxonomy(parsed, specialtyId());
        // A tree saved for another specialty is never used (cannot normally happen: databases are per specialty).
        if (!tree.specialtyId || tree.specialtyId === specialtyId()) state = tree;
      }
    } catch (e) { state = null; }
    return get();
  }

  function get() { return state || baseline(); }
  function hasCustomTree() { return !!state; }
  /** True while the tree is still the untouched built-in ENT list (then the apps keep their classic alphabetical order). */
  function isBaseline() { return get().updatedAt === BASELINE_AT; }

  function index() { return Core.indexTaxonomy(get()); }

  /** Shape used by the classification code that was written for SCOTT_BROWN_TAXONOMY. */
  function asScottBrownShape() {
    return get().categories.map(function (c) {
      var chapters = [], parts = new Map();
      c.sections.forEach(function (s) {
        var ch = { chapterId: s.id, chapterNumber: s.number != null ? s.number : null, chapter: s.name, status: s.status };
        if (s.partId) {
          if (!parts.has(s.partId)) parts.set(s.partId, { partId: s.partId, part: s.partId, chapters: [] });
          parts.get(s.partId).chapters.push(ch);
        } else chapters.push(ch);
      });
      return { subjectId: c.id, subject: c.name, pending: false, chapters: chapters, parts: parts.size ? Array.from(parts.values()) : null, status: c.status };
    });
  }

  /* ------------------------------------------------------------------ write */

  async function save(tree) {
    var clean = Core.normalizeTaxonomy(tree, specialtyId());
    clean.specialtyId = specialtyId() || clean.specialtyId;
    clean.updatedAt = new Date().toISOString();
    // renumber orders to be contiguous so reordering is stable
    clean.categories.forEach(function (c, ci) { c.order = ci; c.sections.forEach(function (s, si) { s.order = si; }); });
    var v = Core.validateTaxonomy(clean, specialtyId());
    if (!v.valid) { var err = new Error(v.errors[0]); err.details = v.errors; throw err; }
    await db.setSetting(KEY, JSON.stringify(clean));
    state = clean;
    notify();
    return clean;
  }

  /** Editable deep copy of the current tree (for the admin editor). */
  function draft() { return clone(get()); }

  /**
   * Applies the tree from a package. A full/free package replaces the saved tree when it is not older
   * than the one already here; an incremental package merges categories and sections by id.
   */
  async function applyFromPackage(incoming, opts) {
    opts = opts || {};
    if (!incoming || !Array.isArray(incoming.categories)) return { applied: false };
    var tree = Core.normalizeTaxonomy(incoming, specialtyId());
    if (tree.specialtyId && tree.specialtyId !== specialtyId()) throw new Error('The category list belongs to a different specialty.');
    var v = Core.validateTaxonomy(tree, specialtyId());
    if (!v.valid) throw new Error(v.errors[0]);
    var current = state;
    if (opts.incremental && current) {
      var byId = new Map(current.categories.map(function (c) { return [c.id, c]; }));
      tree.categories.forEach(function (c) {
        var have = byId.get(c.id);
        if (!have) { current.categories.push(c); return; }
        have.name = c.name; have.status = c.status; have.order = c.order; have.description = c.description;
        var secs = new Map(have.sections.map(function (s) { return [s.id, s]; }));
        c.sections.forEach(function (s) { if (secs.has(s.id)) Object.assign(secs.get(s.id), s); else have.sections.push(s); });
      });
      current.updatedAt = tree.updatedAt;
      var merged = Core.validateTaxonomy(current, specialtyId());
      if (!merged.valid) throw new Error(merged.errors[0]);
      tree = Core.normalizeTaxonomy(current, specialtyId());
    } else if (current && current.updatedAt && tree.updatedAt && tree.updatedAt < current.updatedAt) {
      return { applied: false, reason: 'older' };
    }
    tree.specialtyId = specialtyId();
    await db.setSetting(KEY, JSON.stringify(tree));
    state = tree;
    notify();
    return { applied: true, categories: tree.categories.length };
  }

  /** The tree as it travels in a package (taxonomyV2) plus the legacy {category: [sections]} map. */
  function exportV2() {
    var t = clone(get());
    t.specialtyId = specialtyId();
    return t;
  }

  function exportLegacyMap() {
    var map = {};
    get().categories.forEach(function (c) { map[c.name] = c.sections.map(function (s) { return s.name; }); });
    return map;
  }

  /* ------------------------------------------------------------------ tree operations (pure, on a draft) */

  function findCategory(tree, id) { return tree.categories.filter(function (c) { return c.id === id; })[0] || null; }

  function findSection(tree, id) {
    for (var i = 0; i < tree.categories.length; i++) {
      var hit = tree.categories[i].sections.filter(function (s) { return s.id === id; })[0];
      if (hit) return { category: tree.categories[i], section: hit };
    }
    return null;
  }

  function addCategory(tree, name) {
    var n = Core.normalizeName(name);
    if (!n) throw new Error('Enter a category name.');
    if (tree.categories.some(function (c) { return Core.nameKey(c.name) === Core.nameKey(n); })) throw new Error('A category named "' + n + '" already exists.');
    var cat = { id: Core.newId('cat'), name: n, description: '', order: tree.categories.length, status: 'active', sections: [] };
    tree.categories.push(cat);
    return cat;
  }

  function addSection(tree, categoryId, name) {
    var cat = findCategory(tree, categoryId);
    if (!cat) throw new Error('That category no longer exists.');
    var n = Core.normalizeName(name);
    if (!n) throw new Error('Enter a section name.');
    if (cat.sections.some(function (s) { return Core.nameKey(s.name) === Core.nameKey(n); })) throw new Error('"' + cat.name + '" already has a section named "' + n + '".');
    var sec = { id: Core.newId('sec'), name: n, order: cat.sections.length, status: 'active' };
    cat.sections.push(sec);
    return sec;
  }

  function move(list, id, delta) {
    var i = list.findIndex(function (x) { return x.id === id; });
    var j = i + delta;
    if (i < 0 || j < 0 || j >= list.length) return false;
    var tmp = list[i]; list[i] = list[j]; list[j] = tmp;
    list.forEach(function (x, k) { x.order = k; });
    return true;
  }

  window.EntTaxonomy = {
    KEY: KEY, BASELINE_AT: BASELINE_AT, load: load, get: get, hasCustomTree: hasCustomTree, isBaseline: isBaseline, index: index, asScottBrownShape: asScottBrownShape,
    save: save, draft: draft, applyFromPackage: applyFromPackage, exportV2: exportV2, exportLegacyMap: exportLegacyMap,
    onChange: function (cb) { if (typeof cb === 'function') listeners.push(cb); },
    ops: { findCategory: findCategory, findSection: findSection, addCategory: addCategory, addSection: addSection, move: move },
    _fromScottBrown: fromScottBrown
  };
})();
