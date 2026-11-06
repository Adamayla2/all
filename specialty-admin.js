/* Adam QBank (Admin) - specialty management screens.   Loaded after app.js and taxonomy-store.js.
 *
 *   Header chip ........... always names the open specialty workspace; tap it to manage specialties
 *   Workspace banner ...... on every screen: which specialty you are editing, how many questions, read-only state
 *   Specialties view ...... create, edit, activate / deactivate, archive, reorder, open a workspace, sync the list to students
 *   Categories view ....... the open specialty's Category -> Section tree: add, rename, reorder, archive, move, delete (if unused)
 *
 * A specialty id is permanent. Specialties are archived rather than deleted so a student's account and
 * downloaded data never point at something that vanished.
 */
(function () {
  'use strict';

  var Core = window.EntSpecialtyCore;
  var Reg = window.EntRegistry;
  var Ws = window.EntWorkspace;
  var Tax = window.EntTaxonomy;

  function esc(v) { return escapeHTML(String(v == null ? '' : v)); }
  function toast(m, t) { showToast(m, t || 'info'); }
  function byId(id) { return document.getElementById(id); }
  function isAdmin() { return typeof RBAC !== 'undefined' && RBAC.isAdmin(); }
  function fmtDate(iso) { try { return iso ? new Date(iso).toLocaleString() : ''; } catch (e) { return ''; } }

  /* ------------------------------------------------------------------ styles */

  function injectStyles() {
    if (byId('entSpecStyles')) return;
    var st = document.createElement('style');
    st.id = 'entSpecStyles';
    st.textContent = [
      '.ws-chip{display:inline-flex;align-items:center;gap:6px;max-width:9.5rem;padding:6px 10px;border-radius:999px;border:1px solid var(--border);background:var(--primary-soft);color:var(--primary);font:inherit;font-size:.78rem;font-weight:700;cursor:pointer}',
      '.ws-chip span.ws-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.ws-dot{width:8px;height:8px;border-radius:50%;background:var(--success);flex:0 0 auto}',
      '.ws-chip.is-inactive .ws-dot{background:var(--warning)}',
      '.ws-chip.is-archived .ws-dot{background:var(--danger)}',
      '.ws-banner{display:flex;flex-wrap:wrap;align-items:center;gap:6px 12px;padding:10px 14px;margin:0 0 14px;border:1px solid var(--border);border-radius:14px;background:var(--primary-soft);font-size:.86rem}',
      '.ws-banner.is-archived{background:var(--danger-soft)}',
      '.ws-banner.is-inactive{background:var(--surface-hover)}',
      '.ws-banner code,.spec-card code{font-size:.78rem;padding:1px 6px;border-radius:6px;background:var(--surface-hover)}',
      '.ws-banner .ws-spacer{flex:1 1 auto}',
      '.spec-card{margin-bottom:12px}',
      '.spec-row{display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px}',
      '.spec-actions{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}',
      '.spec-muted{font-size:.82rem;color:var(--text2)}',
      '.tax-cat{border:1px solid var(--border);border-radius:14px;padding:12px;margin-bottom:12px}',
      '.tax-cat.is-archived{opacity:.7}',
      '.tax-sec{display:flex;flex-wrap:wrap;align-items:center;gap:6px 8px;padding:8px 0;border-top:1px solid var(--border)}',
      '.tax-sec .tax-name{flex:1 1 10rem;min-width:0;overflow-wrap:anywhere}',
      '.tax-inline{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px}',
      '.tax-inline input{flex:1 1 12rem;min-width:0}',
      '.tax-inline select{max-width:100%}'
    ].join('\n');
    document.head.appendChild(st);
  }

  /* ------------------------------------------------------------------ header chip + workspace banner */

  function renderChip() {
    var chip = byId('entWorkspaceChip');
    var label = byId('entWorkspaceChipLabel');
    var status = Ws.status();
    if (label) label.textContent = Ws.name();
    if (chip) {
      chip.classList.toggle('is-inactive', status === 'inactive');
      chip.classList.toggle('is-archived', status === 'archived');
      chip.title = 'Specialty: ' + Ws.name() + ' (' + Ws.id() + ', ' + (Core.STATUS_LABELS[status] || status) + '). Tap to manage specialties.';
      chip.setAttribute('aria-label', chip.title);
    }
    document.title = 'Adam QBank — Admin · ' + Ws.name();
  }

  async function bannerHTML(view) {
    var rec = Ws.record() || { name: Ws.id(), id: Ws.id(), status: 'active' };
    var count = 0;
    try { count = (await db.getAllQuestions()).length; } catch (e) { count = 0; }
    var status = rec.status;
    var note = '';
    if (status === 'archived') note = '<span><b>Read-only.</b> This specialty is archived. Restore it in Specialties to edit.</span>';
    else if (status === 'inactive') note = '<span class="spec-muted">Inactive: hidden from student registration.</span>';
    var link = view === 'specialties' ? '' : '<button type="button" class="btn btn-sm btn-outline" data-spec-act="goto-specialties">Switch specialty</button>';
    return '<div class="ws-banner is-' + esc(status) + '" id="entWsBanner" role="status">' +
      '<span>' + uiIcon('library') + ' Specialty: <b>' + esc(rec.name) + '</b> <code>' + esc(rec.id) + '</code></span>' +
      '<span class="badge ' + (status === 'active' ? 'badge-success' : status === 'archived' ? 'badge-danger' : 'badge-warning') + '">' + esc(Core.STATUS_LABELS[status] || status) + '</span>' +
      '<span class="spec-muted">' + count + ' question' + (count === 1 ? '' : 's') + '</span>' + note +
      '<span class="ws-spacer"></span>' + link + '</div>';
  }

  function afterRender(view) {
    return afterRenderInner(view).catch(function (e) { console.warn('[specialty-admin]', e); });
  }

  async function afterRenderInner(view) {
    renderChip();
    var main = byId('mainContent');
    if (!main) return;
    var old = byId('entWsBanner');
    if (old) old.remove();
    if (view === 'exam') return; // never interrupt an exam screen
    var html = await bannerHTML(view);
    if (AppState.currentView !== view) return; // user navigated away while counting
    main.insertAdjacentHTML('afterbegin', html);
    if (view === 'specialties') wireSpecialtyForm();
    if (view === 'specialties') loadCounts();
  }

  /* ------------------------------------------------------------------ specialties view */

  function statusBadge(status) {
    var cls = status === 'active' ? 'badge-success' : status === 'archived' ? 'badge-danger' : 'badge-warning';
    return '<span class="badge ' + cls + '">' + esc(Core.STATUS_LABELS[status] || status) + '</span>';
  }

  function btn(label, act, id, extra) {
    return '<button type="button" class="btn btn-sm ' + ((extra && extra.cls) || 'btn-outline') + '" data-spec-act="' + act + '" data-spec-id="' + esc(id) + '"' +
      ((extra && extra.disabled) ? ' disabled' : '') + '>' + label + '</button>';
  }

  function specCard(s, index, total, openId) {
    var isOpen = s.id === openId;
    var archived = s.status === 'archived';
    var actions = [];
    if (!isOpen) actions.push(btn(uiIcon('arrow-right') + ' Open workspace', 'open', s.id, { cls: 'btn-primary' }));
    else if (!archived) actions.push(btn(uiIcon('folder') + ' Categories &amp; sections', 'goto-taxonomy', s.id, { cls: 'btn-primary' }));
    if (!archived) {
      actions.push(btn(uiIcon('edit') + ' Edit', 'edit', s.id));
      actions.push(s.status === 'active' ? btn('Deactivate', 'status-inactive', s.id) : btn('Activate', 'status-active', s.id));
      actions.push(btn(uiIcon('folder') + ' Archive', 'status-archived', s.id, { cls: 'btn-danger' }));
      actions.push(btn('↑', 'up', s.id, { disabled: index === 0 }));
      actions.push(btn('↓', 'down', s.id, { disabled: index === total - 1 }));
    } else {
      actions.push(btn(uiIcon('restore') + ' Restore', 'status-active', s.id));
    }
    var sync = s.dirty
      ? '<span class="badge badge-warning">Not synced to students yet</span>'
      : '<span class="spec-muted">Synced ' + esc(fmtDate(s.syncedAt)) + '</span>';
    return '<div class="card spec-card" data-spec-card="' + esc(s.id) + '">' +
      '<div class="spec-row"><b style="font-size:1.02rem;">' + esc(s.name) + '</b> <code>' + esc(s.id) + '</code> ' + statusBadge(s.status) +
      (isOpen ? ' <span class="badge badge-primary">Open now</span>' : '') + '</div>' +
      (s.description ? '<p class="spec-muted" style="margin:6px 0 0;">' + esc(s.description) + '</p>' : '') +
      '<p class="spec-muted" style="margin:6px 0 0;">' + esc(Core.STATUS_HELP[s.status] || '') + '</p>' +
      '<div class="spec-row spec-muted" style="margin-top:8px;"><span id="specCounts-' + esc(s.id) + '">Counting…</span></div>' +
      '<div class="spec-row" style="margin-top:6px;">' + sync + '</div>' +
      '<div class="spec-actions">' + actions.join('') + '</div></div>';
  }

  function cloudCardHTML(pending) {
    return '<div class="card"><div class="card-header">' + uiIcon('upload') + ' Student registration list</div>' +
      '<p class="spec-muted">Students choose one of the <b>Active</b> specialties when they register. Changes made here reach students after you sync the list to the cloud (you must be signed in under Settings → Cloud).</p>' +
      '<p style="margin:8px 0;">' + (pending
        ? '<span class="badge badge-warning">' + pending + ' specialt' + (pending === 1 ? 'y has' : 'ies have') + ' unsynced changes</span>'
        : '<span class="badge badge-success">All specialties are synced</span>') + '</p>' +
      '<div class="spec-actions"><button type="button" class="btn btn-accent" data-spec-act="sync">' + uiIcon('upload') + ' Sync list to cloud</button>' +
      '<button type="button" class="btn btn-outline" data-spec-act="pull">' + uiIcon('download') + ' Pull list from cloud</button></div>' +
      '<div id="specCloudMsg" class="spec-muted" style="margin-top:8px;"></div></div>';
  }

  function createCardHTML() {
    return '<div class="card"><div class="card-header">' + uiIcon('plus') + ' New specialty</div>' +
      '<form id="specCreateForm" autocomplete="off" novalidate>' +
      '<label class="modal-field">Display name *<input type="text" id="specNewName" maxlength="' + Core.LIMITS.name + '" placeholder="e.g. Dermatology"></label>' +
      '<label class="modal-field">Specialty ID (permanent) *<input type="text" id="specNewId" maxlength="40" autocapitalize="none" spellcheck="false" placeholder="e.g. dermatology"></label>' +
      '<div id="specIdHint" class="spec-muted" style="margin:-8px 0 12px;"></div>' +
      '<label class="modal-field">Description (optional)<textarea id="specNewDesc" rows="2" maxlength="' + Core.LIMITS.description + '"></textarea></label>' +
      '<button type="submit" class="btn btn-primary btn-block">' + uiIcon('plus') + ' Create specialty</button></form></div>';
  }

  async function renderSpecialties() {
    var list = Reg.list();
    var pending = Reg.dirtyIds().length;
    var intro = '<div class="card"><p class="spec-muted" style="margin:0;">Each specialty is a separate workspace with its own categories, sections, questions, free pack and published bank. ' +
      'Nothing is shared between specialties. Open a workspace to edit it; the header always shows which one you are in.</p></div>';
    return '<div class="view-header"><h2>' + uiIcon('library') + ' Specialties</h2></div>' + intro + cloudCardHTML(pending) +
      list.map(function (s, i) { return specCard(s, i, list.length, Ws.id()); }).join('') + createCardHTML();
  }

  async function loadCounts() {
    var list = Reg.list();
    for (var i = 0; i < list.length; i++) {
      var s = list[i];
      var el = byId('specCounts-' + s.id);
      if (!el) continue;
      try {
        var r = await Reg.summarize(s.id);
        el.textContent = r.exists
          ? r.questions + ' question' + (r.questions === 1 ? '' : 's') + ' · ' + (r.categories == null ? 'default' : r.categories) + ' categor' + (r.categories === 1 ? 'y' : 'ies') + ' · ' + r.free + ' free'
          : 'Empty workspace (nothing added yet)';
      } catch (e) { el.textContent = ''; }
    }
  }

  function wireSpecialtyForm() {
    var form = byId('specCreateForm');
    if (!form || form.__wired) return;
    form.__wired = true;
    var nameEl = byId('specNewName'), idEl = byId('specNewId'), hint = byId('specIdHint');
    var touched = false;
    function check() {
      var id = idEl.value.trim().toLowerCase();
      var taken = Reg.list().map(function (x) { return x.id; });
      var problem = id ? (Core.idProblem(id) || (taken.indexOf(id) !== -1 ? 'A specialty with this ID already exists.' : '')) : '';
      hint.textContent = problem;
      hint.style.color = problem ? 'var(--danger)' : 'var(--text2)';
      return !problem;
    }
    nameEl.addEventListener('input', function () {
      if (!touched) idEl.value = nameEl.value.trim() ? Core.suggestId(nameEl.value, Reg.list().map(function (x) { return x.id; })) : '';
      check();
    });
    idEl.addEventListener('input', function () { touched = true; check(); });
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (!isAdmin()) return toast('Unlock Admin mode first.', 'error');
      try {
        var rec = Reg.create({ name: nameEl.value, id: idEl.value.trim().toLowerCase() || undefined, description: byId('specNewDesc').value });
        toast('Specialty "' + rec.name + '" created. Open its workspace to add categories and questions.', 'success');
        renderViewSafely('specialties');
      } catch (err) { toast(err.message, 'error'); }
    });
  }

  function editModal(id) {
    var s = Reg.get(id);
    if (!s) return toast('That specialty no longer exists.', 'error');
    showModal('<h3>' + uiIcon('edit') + ' Edit specialty</h3>' +
      '<form id="specEditForm" novalidate>' +
      '<label class="modal-field">Display name *<input type="text" id="specEditName" maxlength="' + Core.LIMITS.name + '" value="' + esc(s.name) + '"></label>' +
      '<label class="modal-field">Specialty ID (permanent)<input type="text" value="' + esc(s.id) + '" disabled></label>' +
      '<label class="modal-field">Description (optional)<textarea id="specEditDesc" rows="3" maxlength="' + Core.LIMITS.description + '">' + esc(s.description) + '</textarea></label>' +
      '<p class="spec-muted">Renaming changes only the display name. The ID, and every student\'s link to this specialty, stay the same.</p>' +
      '<button type="submit" class="btn btn-primary btn-block">Save</button>' +
      '<button type="button" class="btn btn-outline btn-block mt-2" onclick="closeModal()">Cancel</button></form>');
    byId('specEditForm').addEventListener('submit', function (e) {
      e.preventDefault();
      try {
        Reg.update(id, { name: byId('specEditName').value, description: byId('specEditDesc').value });
        closeModal();
        toast('Saved. Sync the list so students see the new name.', 'success');
        renderChip();
        renderViewSafely('specialties');
      } catch (err) { toast(err.message, 'error'); }
    });
  }

  function confirmStatus(s, status) {
    if (status === 'inactive') {
      return window.confirm('Deactivate "' + s.name + '"?\n\nNew students can no longer register for it, and existing students will see "temporarily unavailable" until you activate it again. Nobody\'s data is deleted or moved.');
    }
    if (status === 'archived') {
      return window.confirm('Archive "' + s.name + '"?\n\nIt becomes read-only for you, disappears from registration, and its students see an "archived" notice. Their accounts and downloaded data are kept, never moved to another specialty. You can restore it later.');
    }
    return true;
  }

  async function changeStatus(id, status) {
    var s = Reg.get(id);
    if (!s) throw new Error('That specialty no longer exists.');
    if (status === 'active' && s.status === 'active') return;
    if (!confirmStatus(s, status)) return;
    Reg.setStatus(id, status);
    toast('"' + s.name + '" is now ' + (Core.STATUS_LABELS[status] || status).toLowerCase() + '. Sync the list so students see this.', 'success');
    renderChip();
    await renderViewSafely('specialties');
  }

  function reorder(id, delta) {
    var ids = Reg.list().map(function (s) { return s.id; });
    var i = ids.indexOf(id), j = i + delta;
    if (i < 0 || j < 0 || j >= ids.length) return;
    var tmp = ids[i]; ids[i] = ids[j]; ids[j] = tmp;
    Reg.reorder(ids);
    return renderViewSafely('specialties');
  }

  function cloudMsg(text, isError) {
    var el = byId('specCloudMsg');
    if (!el) return;
    el.textContent = text || '';
    el.style.color = isError ? 'var(--danger)' : 'var(--text2)';
  }

  async function syncList() {
    var C = window.EntCloudAdmin;
    if (!C || !C.isConfigured) return cloudMsg('Firebase is not set up yet (see firebase-config.js).', true);
    if (!C.isSignedIn()) return cloudMsg('Sign in under Settings → Cloud first.', true);
    cloudMsg('Syncing…');
    try {
      var r = await C.syncSpecialties();
      cloudMsg(r.written ? 'Synced ' + r.written + ' specialt' + (r.written === 1 ? 'y' : 'ies') + '. Students will see the change the next time they open the app.' : 'Everything was already synced.');
      await renderViewSafely('specialties');
    } catch (e) { cloudMsg('Sync failed: ' + C.friendly(e), true); }
  }

  async function pullList() {
    var C = window.EntCloudAdmin;
    if (!C || !C.isConfigured) return cloudMsg('Firebase is not set up yet (see firebase-config.js).', true);
    if (!C.isSignedIn()) return cloudMsg('Sign in under Settings → Cloud first.', true);
    cloudMsg('Reading the cloud list…');
    try {
      var r = await C.pullSpecialties();
      toast(r.added || r.updated ? 'Pulled ' + r.added + ' new and ' + r.updated + ' updated specialt' + (r.added + r.updated === 1 ? 'y' : 'ies') + '.' : 'Nothing new in the cloud.', 'success');
      await renderViewSafely('specialties');
    } catch (e) { cloudMsg('Could not read the cloud list: ' + C.friendly(e), true); }
  }

  /* ------------------------------------------------------------------ categories & sections view */

  function placeOf(q, idx) {
    var hit = q.chapterId && idx.secById.get(q.chapterId);
    if (hit) return { cat: hit.category, sec: hit.section };
    var cat = (q.subjectId && idx.byCatId.get(q.subjectId)) || idx.byCatName.get(String(q.subject == null ? '' : q.subject).trim()) || null;
    var sec = null;
    if (cat && q.chapter) sec = cat.sections.filter(function (s) { return s.name === String(q.chapter).trim(); })[0] || null;
    return { cat: cat, sec: sec };
  }

  async function renderTaxonomy() {
    var tree = Tax.get();
    var idx = Core.indexTaxonomy(tree);
    var qs = await db.getAllQuestions();
    var catCount = {}, secCount = {}, unplaced = 0;
    qs.forEach(function (q) {
      var p = placeOf(q, idx);
      if (!p.cat) { unplaced++; return; }
      catCount[p.cat.id] = (catCount[p.cat.id] || 0) + 1;
      if (p.sec) secCount[p.sec.id] = (secCount[p.sec.id] || 0) + 1;
    });
    var ro = Ws.isArchived();
    var dis = ro ? ' disabled' : '';
    var intro = '<div class="card"><p class="spec-muted" style="margin:0;">Categories and sections belong only to <b>' + esc(Ws.name()) + '</b>. ' +
      'Every question is placed in one category and one section. Students of this specialty see exactly this list after you export or publish. ' +
      'Renaming updates the questions that use the name. Archive a category or section to retire it without losing questions; delete is only possible while nothing uses it.' +
      (Tax.isBaseline() ? ' This is the built-in ENT list; your first change saves it as your own editable copy (the built-in IDs are kept).' : '') + '</p></div>';
    var addCat = '<div class="card"><div class="card-header">' + uiIcon('plus') + ' Add a category</div>' +
      '<div class="tax-inline"><input type="text" id="taxNewCategory" maxlength="' + Core.LIMITS.itemName + '" placeholder="e.g. Skin infections"' + dis + '>' +
      '<button type="button" class="btn btn-primary" data-spec-act="tax-add-cat"' + dis + '>' + uiIcon('plus') + ' Add category</button></div></div>';
    var warn = unplaced
      ? '<div class="card"><span class="badge badge-warning">' + unplaced + ' question' + (unplaced === 1 ? ' is' : 's are') + ' not in any category yet</span> ' +
        '<span class="spec-muted">Open the question and use Reclassify, or use Classification Review in the admin tools.</span></div>' : '';
    var cats = tree.categories.length ? tree.categories.map(function (c, ci) {
      var archived = c.status === 'archived';
      var secs = c.sections.map(function (s, si) {
        var sArch = s.status === 'archived';
        var moveOpts = tree.categories.filter(function (o) { return o.id !== c.id && o.status !== 'archived'; })
          .map(function (o) { return '<option value="' + esc(o.id) + '">' + esc(o.name) + '</option>'; }).join('');
        return '<div class="tax-sec" data-sec-id="' + esc(s.id) + '" data-cat-id="' + esc(c.id) + '">' +
          '<span class="tax-name">' + esc(s.name) + (sArch ? ' <span class="badge badge-warning">Archived</span>' : '') + '</span>' +
          '<span class="spec-muted">' + (secCount[s.id] || 0) + ' q</span>' +
          '<button type="button" class="btn btn-sm btn-outline" data-spec-act="tax-sec-up"' + (si === 0 || ro ? ' disabled' : '') + '>↑</button>' +
          '<button type="button" class="btn btn-sm btn-outline" data-spec-act="tax-sec-down"' + (si === c.sections.length - 1 || ro ? ' disabled' : '') + '>↓</button>' +
          '<button type="button" class="btn btn-sm btn-outline" data-spec-act="tax-sec-rename"' + dis + '>Rename</button>' +
          '<button type="button" class="btn btn-sm btn-outline" data-spec-act="tax-sec-' + (sArch ? 'restore' : 'archive') + '"' + dis + '>' + (sArch ? 'Restore' : 'Archive') + '</button>' +
          '<button type="button" class="btn btn-sm btn-danger" data-spec-act="tax-sec-delete"' + dis + '>Delete</button>' +
          (moveOpts ? '<select data-spec-change="tax-sec-move" aria-label="Move section to another category"' + dis + '><option value="">Move to…</option>' + moveOpts + '</select>' : '') +
          '</div>';
      }).join('');
      return '<div class="tax-cat' + (archived ? ' is-archived' : '') + '" data-cat-id="' + esc(c.id) + '">' +
        '<div class="spec-row"><b>' + esc(c.name) + '</b>' + (archived ? ' <span class="badge badge-warning">Archived</span>' : '') +
        '<span class="spec-muted">' + (catCount[c.id] || 0) + ' question' + (catCount[c.id] === 1 ? '' : 's') + ' · ' + c.sections.length + ' section' + (c.sections.length === 1 ? '' : 's') + '</span></div>' +
        '<div class="spec-actions">' +
        '<button type="button" class="btn btn-sm btn-outline" data-spec-act="tax-cat-up"' + (ci === 0 || ro ? ' disabled' : '') + '>↑</button>' +
        '<button type="button" class="btn btn-sm btn-outline" data-spec-act="tax-cat-down"' + (ci === tree.categories.length - 1 || ro ? ' disabled' : '') + '>↓</button>' +
        '<button type="button" class="btn btn-sm btn-outline" data-spec-act="tax-cat-rename"' + dis + '>Rename</button>' +
        '<button type="button" class="btn btn-sm btn-outline" data-spec-act="tax-cat-' + (archived ? 'restore' : 'archive') + '"' + dis + '>' + (archived ? 'Restore' : 'Archive') + '</button>' +
        '<button type="button" class="btn btn-sm btn-danger" data-spec-act="tax-cat-delete"' + dis + '>Delete</button></div>' +
        '<div style="margin-top:8px;">' + (secs || '<p class="spec-muted" style="margin:6px 0;">No sections yet.</p>') + '</div>' +
        '<div class="tax-inline"><input type="text" maxlength="' + Core.LIMITS.itemName + '" placeholder="New section in ' + esc(c.name) + '" data-new-section="' + esc(c.id) + '"' + dis + '>' +
        '<button type="button" class="btn btn-sm btn-primary" data-spec-act="tax-add-sec"' + dis + '>' + uiIcon('plus') + ' Add section</button></div></div>';
    }).join('') : '<div class="card"><p class="spec-muted" style="margin:0;">No categories yet. Add the first one above, then add sections inside it. Questions can only be classified into categories that exist here.</p></div>';
    return '<div class="view-header"><h2>' + uiIcon('folder') + ' Categories &amp; sections</h2></div>' + intro + addCat + warn + cats +
      '<button type="button" class="btn btn-outline btn-block" data-spec-act="goto-specialties">' + uiIcon('arrow-left') + ' Back to Specialties</button>';
  }

  /** Applies one edit to the category tree, rewriting the questions that carry a changed name. */
  async function mutateTree(mutator, rewrite) {
    if (Ws.isArchived()) throw new Error('"' + Ws.name() + '" is archived and read-only.');
    await db.ensureReady();
    var before = Tax.draft();
    var after = Tax.draft();
    mutator(after);
    var check = Core.validateTaxonomy(Core.normalizeTaxonomy(after, Ws.id()), Ws.id());
    if (!check.valid) throw new Error(check.errors[0]);
    var affected = [];
    if (rewrite) {
      var oldIdx = Core.indexTaxonomy(before);
      (await db.getAllQuestions()).forEach(function (q) {
        var copy = JSON.parse(JSON.stringify(q));
        var wasApproved = isQuestionClassificationApproved(q);
        if (rewrite(copy, oldIdx)) { copy.__approved = wasApproved; affected.push(copy); }
      });
    }
    await Tax.save(after);
    if (!affected.length) return 0;
    try {
      var now = new Date().toISOString();
      affected.forEach(function (c) {
        var approved = c.__approved; delete c.__approved;
        c.subjectId = c.chapterId = c.chapterNumber = c.partId = null;
        normalizeQuestionClassification(c, { approve: approved });
        c.updatedAt = now;
      });
      await new Promise(function (resolve, reject) {
        var tx = db.db.transaction('questions', 'readwrite');
        var store = tx.objectStore('questions');
        affected.forEach(function (c) { store.put(c); });
        tx.oncomplete = resolve;
        tx.onerror = function () { reject(tx.error); };
        tx.onabort = function () { reject(tx.error || new Error('The questions could not be updated.')); };
      });
      db._invalidateCache();
    } catch (err) {
      try { await Tax.save(before); } catch (e) { /* best effort */ }
      throw err;
    }
    return affected.length;
  }

  async function usedBy(test) {
    var idx = Core.indexTaxonomy(Tax.get());
    return (await db.getAllQuestions()).filter(function (q) { return test(placeOf(q, idx)); }).length;
  }

  function dupName(list, name, exceptId) {
    var k = Core.nameKey(name);
    return list.some(function (x) { return x.id !== exceptId && Core.nameKey(x.name) === k; });
  }

  async function taxAction(act, el) {
    var catEl = el.closest('[data-cat-id]');
    var catId = catEl && catEl.getAttribute('data-cat-id');
    var secEl = el.closest('[data-sec-id]');
    var secId = secEl && secEl.getAttribute('data-sec-id');
    var changed = 0, message = '';

    if (act === 'tax-add-cat') {
      var input = byId('taxNewCategory');
      var name = Core.normalizeName(input && input.value);
      await mutateTree(function (t) { Tax.ops.addCategory(t, name); });
      message = 'Category added.';
    } else if (act === 'tax-add-sec') {
      var field = catEl.querySelector('[data-new-section]');
      var sname = Core.normalizeName(field && field.value);
      await mutateTree(function (t) { Tax.ops.addSection(t, catId, sname); });
      message = 'Section added.';
    } else if (act === 'tax-cat-rename') {
      var cur = Tax.ops.findCategory(Tax.get(), catId);
      var nn = window.prompt('New category name:', cur.name);
      if (nn === null) return;
      nn = Core.normalizeName(nn);
      if (!nn) throw new Error('Enter a name.');
      if (nn === cur.name) return;
      changed = await mutateTree(function (t) {
        if (dupName(t.categories, nn, catId)) throw new Error('Another category is already named "' + nn + '".');
        Tax.ops.findCategory(t, catId).name = nn;
      }, function (q, oldIdx) { var p = placeOf(q, oldIdx); if (p.cat && p.cat.id === catId) { q.subject = nn; return true; } return false; });
      message = 'Renamed' + (changed ? '; ' + changed + ' question(s) updated.' : '.');
    } else if (act === 'tax-sec-rename') {
      var found = Tax.ops.findSection(Tax.get(), secId);
      var sn = window.prompt('New section name:', found.section.name);
      if (sn === null) return;
      sn = Core.normalizeName(sn);
      if (!sn) throw new Error('Enter a name.');
      if (sn === found.section.name) return;
      changed = await mutateTree(function (t) {
        var f = Tax.ops.findSection(t, secId);
        if (dupName(f.category.sections, sn, secId)) throw new Error('"' + f.category.name + '" already has a section named "' + sn + '".');
        f.section.name = sn;
      }, function (q, oldIdx) { var p = placeOf(q, oldIdx); if (p.sec && p.sec.id === secId) { q.chapter = sn; return true; } return false; });
      message = 'Renamed' + (changed ? '; ' + changed + ' question(s) updated.' : '.');
    } else if (act === 'tax-cat-archive' || act === 'tax-cat-restore') {
      await mutateTree(function (t) { Tax.ops.findCategory(t, catId).status = act === 'tax-cat-archive' ? 'archived' : 'active'; });
      message = act === 'tax-cat-archive' ? 'Category archived. Its questions are kept.' : 'Category restored.';
    } else if (act === 'tax-sec-archive' || act === 'tax-sec-restore') {
      await mutateTree(function (t) { Tax.ops.findSection(t, secId).section.status = act === 'tax-sec-archive' ? 'archived' : 'active'; });
      message = act === 'tax-sec-archive' ? 'Section archived. Its questions are kept.' : 'Section restored.';
    } else if (act === 'tax-cat-delete') {
      var n = await usedBy(function (p) { return p.cat && p.cat.id === catId; });
      if (n) throw new Error(n + ' question(s) are in this category. Move or reclassify them first, or archive the category instead.');
      var c0 = Tax.ops.findCategory(Tax.get(), catId);
      if (!window.confirm('Delete the empty category "' + c0.name + '" and its ' + c0.sections.length + ' section(s)?')) return;
      await mutateTree(function (t) { t.categories = t.categories.filter(function (c) { return c.id !== catId; }); });
      message = 'Category deleted.';
    } else if (act === 'tax-sec-delete') {
      var m = await usedBy(function (p) { return p.sec && p.sec.id === secId; });
      if (m) throw new Error(m + ' question(s) are in this section. Move or reclassify them first, or archive the section instead.');
      var s0 = Tax.ops.findSection(Tax.get(), secId).section;
      if (!window.confirm('Delete the empty section "' + s0.name + '"?')) return;
      await mutateTree(function (t) { var f = Tax.ops.findSection(t, secId); f.category.sections = f.category.sections.filter(function (s) { return s.id !== secId; }); });
      message = 'Section deleted.';
    } else if (act === 'tax-cat-up' || act === 'tax-cat-down') {
      await mutateTree(function (t) { Tax.ops.move(t.categories, catId, act === 'tax-cat-up' ? -1 : 1); });
    } else if (act === 'tax-sec-up' || act === 'tax-sec-down') {
      await mutateTree(function (t) { Tax.ops.move(Tax.ops.findSection(t, secId).category.sections, secId, act === 'tax-sec-up' ? -1 : 1); });
    }
    if (message) toast(message, 'success');
    await renderViewSafely('taxonomy');
  }

  async function moveSection(el) {
    var row = el.closest('[data-sec-id]');
    var secId = row.getAttribute('data-sec-id');
    var toId = el.value;
    if (!toId) return;
    try {
      var tree = Tax.get();
      var target = Tax.ops.findCategory(tree, toId);
      var from = Tax.ops.findSection(tree, secId);
      if (!target || !from) throw new Error('That category or section no longer exists.');
      if (!window.confirm('Move section "' + from.section.name + '" from "' + from.category.name + '" to "' + target.name + '"? Its questions move with it.')) { el.value = ''; return; }
      var moved = await mutateTree(function (t) {
        var f = Tax.ops.findSection(t, secId);
        var dest = Tax.ops.findCategory(t, toId);
        if (dupName(dest.sections, f.section.name, secId)) throw new Error('"' + dest.name + '" already has a section named "' + f.section.name + '".');
        f.category.sections = f.category.sections.filter(function (s) { return s.id !== secId; });
        f.section.order = dest.sections.length;
        dest.sections.push(f.section);
      }, function (q, oldIdx) {
        var p = placeOf(q, oldIdx);
        if (p.sec && p.sec.id === secId) { q.subject = target.name; q.chapter = from.section.name; return true; }
        return false;
      });
      toast('Section moved' + (moved ? '; ' + moved + ' question(s) updated.' : '.'), 'success');
      await renderViewSafely('taxonomy');
    } catch (err) { el.value = ''; toast(err.message, 'error'); }
  }

  /* ------------------------------------------------------------------ events */

  async function onClick(e) {
    var el = e.target.closest && e.target.closest('[data-spec-act]');
    if (!el) return;
    var act = el.getAttribute('data-spec-act');
    var id = el.getAttribute('data-spec-id') || '';
    if (!isAdmin()) { toast('Unlock Admin mode first (lock icon in the header).', 'error'); return; }
    try {
      if (act === 'goto-specialties') return void navigateTo('specialties');
      if (act === 'goto-taxonomy') return void navigateTo('taxonomy');
      if (act.indexOf('tax-') === 0) return await taxAction(act, el);
      if (act === 'open') {
        if (AppState.examInProgress) return toast('Finish or leave the exam before switching specialty.', 'warning');
        var s = Reg.get(id);
        if (!s) return;
        return Reg.openWorkspace(id);
      }
      if (act === 'edit') return editModal(id);
      if (act.indexOf('status-') === 0) return await changeStatus(id, act.slice(7));
      if (act === 'up') return await reorder(id, -1);
      if (act === 'down') return await reorder(id, 1);
      if (act === 'sync') return await syncList();
      if (act === 'pull') return await pullList();
    } catch (err) {
      toast(err.message || 'Something went wrong.', 'error');
    }
  }

  function onChange(e) {
    var el = e.target.closest && e.target.closest('[data-spec-change="tax-sec-move"]');
    if (el && isAdmin()) moveSection(el);
  }

  function start() {
    injectStyles();
    renderChip();
    var chip = byId('entWorkspaceChip');
    if (chip) chip.addEventListener('click', function () {
      if (!isAdmin()) return toast('Specialty: ' + Ws.name() + '. Unlock Admin mode to manage specialties.', 'info');
      navigateTo('specialties');
    });
    document.addEventListener('click', onClick);
    document.addEventListener('change', onChange);
  }

  window.EntSpecialtyAdmin = {
    renderSpecialties: renderSpecialties, renderTaxonomy: renderTaxonomy, afterRender: afterRender, renderChip: renderChip,
    _placeOf: placeOf
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
