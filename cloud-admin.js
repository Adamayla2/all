/* Adam QBank (Admin) - cloud publishing, specialty registry sync, student accounts and reports.
 *
 * Signs you in to Firebase with an account listed in the `admins` collection and:
 *
 *   specialties/<id>                  the specialty list students register from (display name, status ...)
 *   packs/<specialtyId>               small document: version, size, checksum, chunk count, specialtyId
 *   packs/<specialtyId>/chunks/...    the compressed package of THAT specialty, in ~600 KB pieces
 *   packs/main                        (ENT only, optional) legacy copy for students still on app 1.3.x
 *   settings/access                   subscriptionScope: 'selected' (own specialty) or 'all' (every specialty)
 *   users/<uid>                       student accounts (specialty, subscription)
 *   reports/<id>                      question reports, each tagged with the student's specialty
 *
 * Publishing always works on the OPEN specialty workspace only, asks you to confirm its name and ID,
 * and refuses to overwrite a pack that belongs to a different specialty. The Firestore rules
 * (firestore.rules) enforce the same ownership on the server.
 */
(function () {
  'use strict';

  var Core = window.EntSpecialtyCore;
  var CFG = window.ENT_FIREBASE || {};
  var CONFIGURED = !!(CFG.apiKey && CFG.projectId);
  var SESSION_KEY = 'ent_admin_cloud_session_v1';
  var INFO_KEY = 'ent_admin_cloud_info_v2'; // + ':' + specialtyId
  var CHUNK_BYTES = 600 * 1024;
  var REFRESH_MARGIN_MS = 60 * 1000;
  var LEGACY_PACK_ID = 'main';
  var FS = 'https://firestore.googleapis.com/v1/projects/' + encodeURIComponent(CFG.projectId || '') + '/databases/(default)/documents';
  var busy = false;

  /* ------------------------------------------------------------------ storage */

  function load(key) { try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch (e) { return null; } }
  function save(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch (e) { /* ignore */ } }
  function drop(key) { try { localStorage.removeItem(key); } catch (e) { /* ignore */ } }
  function infoKey(id) { return INFO_KEY + ':' + id; }

  /* ------------------------------------------------------------------ http */

  function cloudError(code, extra) {
    var e = new Error(code);
    e.code = code;
    if (extra) Object.assign(e, extra);
    return e;
  }

  async function request(url, options) {
    var res;
    try { res = await fetch(url, options); } catch (e) { throw cloudError('NETWORK'); }
    var data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    if (!res.ok) {
      var raw = (data && data.error && (data.error.message || data.error.status)) || ('HTTP_' + res.status);
      throw cloudError(String(raw).split(/[\s:]/)[0], { status: res.status });
    }
    return data;
  }

  function authHeaders(token, json) {
    var h = { Authorization: 'Bearer ' + token };
    if (json) h['Content-Type'] = 'application/json';
    return h;
  }

  function friendly(e) {
    switch (e && e.code) {
      case 'NETWORK': return 'No internet connection.';
      case 'NOT_ADMIN': return 'This account is not an admin. Add its UID to the admins collection in Firebase first.';
      case 'INVALID_LOGIN_CREDENTIALS':
      case 'EMAIL_NOT_FOUND':
      case 'INVALID_PASSWORD': return 'Wrong email or password.';
      case 'TOO_MANY_ATTEMPTS_TRY_LATER': return 'Too many attempts. Try again in a few minutes.';
      case 'PERMISSION_DENIED': return 'Firestore refused the request. Check that the rules are published and this account is an admin.';
      case 'NOT_SIGNED_IN': return 'Sign in under Settings → Cloud first.';
      default: return (e && e.message) || 'Something went wrong.';
    }
  }

  /* ------------------------------------------------------------------ session */

  async function signIn(email, password) {
    var data = await request('https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=' + encodeURIComponent(CFG.apiKey), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: String(email).trim(), password: password, returnSecureToken: true })
    });
    // Only accounts listed in /admins/{uid} may publish.
    try {
      await request(FS + '/admins/' + encodeURIComponent(data.localId), { headers: authHeaders(data.idToken) });
    } catch (e) {
      if (e.status === 404 || e.status === 403) throw cloudError('NOT_ADMIN');
      throw e;
    }
    var s = { uid: data.localId, email: String(email).trim(), idToken: data.idToken, refreshToken: data.refreshToken,
      expiresAt: Date.now() + Number(data.expiresIn || 3600) * 1000 };
    save(SESSION_KEY, s);
    return s;
  }

  async function token() {
    var s = load(SESSION_KEY);
    if (!s) throw cloudError('NOT_SIGNED_IN');
    if (s.expiresAt - Date.now() > REFRESH_MARGIN_MS) return s.idToken;
    var d = await request('https://securetoken.googleapis.com/v1/token?key=' + encodeURIComponent(CFG.apiKey), {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=refresh_token&refresh_token=' + encodeURIComponent(s.refreshToken)
    });
    s = Object.assign({}, s, { idToken: d.id_token, refreshToken: d.refresh_token || s.refreshToken,
      expiresAt: Date.now() + Number(d.expires_in || 3600) * 1000 });
    save(SESSION_KEY, s);
    return s.idToken;
  }

  function signOut() { drop(SESSION_KEY); }
  function isSignedIn() { return !!load(SESSION_KEY); }

  /* ------------------------------------------------------------------ small helpers */

  function hex(buffer) {
    return Array.prototype.map.call(new Uint8Array(buffer), function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
  }

  function bytesToB64(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }

  function pad(i) { return String(i).padStart(4, '0'); }
  function sv(v) { return { stringValue: String(v) }; }
  function iv(v) { return { integerValue: String(v) }; }
  function tv(iso) { return { timestampValue: iso }; }
  function tsMs(f) { return f && f.timestampValue ? Date.parse(f.timestampValue) : null; }
  function strOf(f) { return f && f.stringValue != null ? f.stringValue : ''; }
  function intOf(f) { return f && f.integerValue != null ? Number(f.integerValue) : 0; }
  function idOf(doc) { return String(doc && doc.name || '').split('/').pop(); }
  function el(id) { return document.getElementById(id); }
  function esc(v) { return typeof escapeHTML === 'function' ? escapeHTML(String(v == null ? '' : v)) : String(v == null ? '' : v); }

  function currentSpec() {
    var U = window.__entUpdatePkg;
    return U && typeof U.currentSpecialty === 'function' ? U.currentSpecialty() : null;
  }

  /* ------------------------------------------------------------------ specialties (registry sync) */

  function specialtyFields(s) {
    return {
      id: sv(s.id), name: sv(s.name), description: sv(s.description || ''), status: sv(s.status),
      sortOrder: iv(s.sortOrder || 0), schemaVersion: iv(Core.SCHEMA_VERSION),
      createdAt: tv(s.createdAt || new Date().toISOString()), updatedAt: tv(s.updatedAt || new Date().toISOString())
    };
  }

  function parseSpecialtyDoc(doc) {
    var f = (doc && doc.fields) || {};
    return {
      id: strOf(f.id) || idOf(doc), name: strOf(f.name), description: strOf(f.description), status: strOf(f.status) || 'inactive',
      sortOrder: intOf(f.sortOrder), createdAt: f.createdAt && f.createdAt.timestampValue || '', updatedAt: f.updatedAt && f.updatedAt.timestampValue || ''
    };
  }

  // Writes the listed specialties (default: every one with unsynced changes) to specialties/<id>.
  async function syncSpecialties(ids) {
    var Reg = window.EntRegistry;
    var want = ids && ids.length ? ids : Reg.dirtyIds();
    var tk = await token();
    var written = 0;
    for (var i = 0; i < want.length; i++) {
      var s = Reg.get(want[i]);
      if (!s) continue;
      await request(FS + '/specialties/' + encodeURIComponent(s.id), { method: 'PATCH', headers: authHeaders(tk, true), body: JSON.stringify({ fields: specialtyFields(s) }) });
      Reg.markSynced(s.id);
      written++;
    }
    return { written: written };
  }

  async function pullSpecialties() {
    var tk = await token();
    var out = [];
    var pageToken = '';
    do {
      var d = await request(FS + '/specialties?pageSize=300' + (pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : ''), { headers: authHeaders(tk) });
      (d.documents || []).forEach(function (doc) { out.push(parseSpecialtyDoc(doc)); });
      pageToken = d.nextPageToken || '';
    } while (pageToken);
    return window.EntRegistry.mergeFromCloud(out);
  }

  /* ------------------------------------------------------------------ subscription scope */

  async function readScope() {
    var tk = await token();
    try {
      var d = await request(FS + '/settings/access', { headers: authHeaders(tk) });
      var v = strOf((d.fields || {}).subscriptionScope);
      return v === 'all' ? 'all' : 'selected';
    } catch (e) { if (e.status === 404) return 'selected'; throw e; }
  }

  async function writeScope(scope) {
    if (scope !== 'all' && scope !== 'selected') throw new Error('Unknown scope.');
    var tk = await token();
    await request(FS + '/settings/access', {
      method: 'PATCH', headers: authHeaders(tk, true),
      body: JSON.stringify({ fields: { subscriptionScope: sv(scope), updatedAt: tv(new Date().toISOString()) } })
    });
    return scope;
  }

  /* ------------------------------------------------------------------ publishing */

  function parseMeta(doc) {
    var f = (doc && doc.fields) || {};
    return { version: strOf(f.version), prefix: strOf(f.prefix), chunkCount: intOf(f.chunkCount), gzBytes: intOf(f.gzBytes),
      rawBytes: intOf(f.rawBytes), questions: intOf(f.questions), specialtyId: strOf(f.specialtyId), specialtyName: strOf(f.specialtyName),
      updatedAt: f.updatedAt && f.updatedAt.timestampValue || '' };
  }

  async function readMeta(tk, packId) {
    try { return parseMeta(await request(FS + '/packs/' + encodeURIComponent(packId), { headers: authHeaders(tk) })); }
    catch (e) { if (e.status === 404) return null; throw e; }
  }

  // The pack document that a pack path currently holds must belong to the specialty being published.
  // (A pack written by app 1.3.x has no specialtyId: it is the ENT pack.)
  function packOwner(meta) { return meta ? (meta.specialtyId || Core.LEGACY_SPECIALTY_ID) : null; }

  async function uploadPack(tk, packId, spec, built, gz, sha, raw, progress) {
    var version = built.manifest.packageVersion;
    var prefix = 'v' + String(version).replace(/[^A-Za-z0-9]/g, '');
    var count = Math.max(1, Math.ceil(gz.length / CHUNK_BYTES));

    var previous = await readMeta(tk, packId);
    if (previous && packOwner(previous) !== spec.id) {
      throw cloudError('CROSS_SPECIALTY', { message: 'The pack at "' + packId + '" belongs to the "' + packOwner(previous) + '" specialty, not "' + spec.id + '". Nothing was uploaded.' });
    }

    for (var i = 0; i < count; i++) {
      progress('Uploading ' + (packId === LEGACY_PACK_ID ? 'legacy ENT copy ' : '') + (i + 1) + ' / ' + count + '...');
      var part = gz.subarray(i * CHUNK_BYTES, Math.min(gz.length, (i + 1) * CHUNK_BYTES));
      await request(FS + '/packs/' + encodeURIComponent(packId) + '/chunks/' + prefix + '_' + pad(i), {
        method: 'PATCH', headers: authHeaders(tk, true),
        body: JSON.stringify({ fields: { prefix: sv(prefix), i: iv(i), data: { bytesValue: bytesToB64(part) } } })
      });
    }

    var updatedAt = new Date().toISOString();
    var questions = built.manifest.contentSummary.questions;
    await request(FS + '/packs/' + encodeURIComponent(packId), {
      method: 'PATCH', headers: authHeaders(tk, true),
      body: JSON.stringify({ fields: { version: sv(version), prefix: sv(prefix), chunkCount: iv(count), gzBytes: iv(gz.length),
        rawBytes: iv(raw.length), sha256: sv(sha), questions: iv(questions), updatedAt: tv(updatedAt),
        specialtyId: sv(spec.id), specialtyName: sv(spec.name), schemaVersion: iv(Core.SCHEMA_VERSION) } })
    });

    // The new version is live; remove the previous version's chunks (best effort).
    if (previous && previous.prefix && previous.prefix !== prefix) {
      for (var j = 0; j < previous.chunkCount; j++) {
        try { await request(FS + '/packs/' + encodeURIComponent(packId) + '/chunks/' + previous.prefix + '_' + pad(j), { method: 'DELETE', headers: authHeaders(tk) }); }
        catch (e) { /* leftover chunk is harmless */ }
      }
    }
    return { version: version, questions: questions, gzBytes: gz.length, rawBytes: raw.length, chunkCount: count, updatedAt: updatedAt, packId: packId };
  }

  /**
   * Publishes the open specialty workspace.
   * options.legacyMirror (ENT only): also write the pre-1.4 location packs/main, built so that students
   * still on app 1.3.x can read it.
   */
  async function publish(progress, options) {
    options = options || {};
    var U = window.__entUpdatePkg;
    if (!U || typeof U.buildEntpkg !== 'function') throw cloudError('TOOLS', { message: 'The update tools are not ready yet.' });
    var spec = currentSpec();
    if (!spec || !spec.id) throw cloudError('NO_SPECIALTY', { message: 'Open a specialty workspace first.' });
    if (spec.archived) throw cloudError('ARCHIVED', { message: '"' + spec.name + '" is archived and read-only, so it cannot be published.' });
    var mirror = options.legacyMirror === true && spec.id === Core.LEGACY_SPECIALTY_ID;

    progress('Building the full package for ' + spec.name + '...');
    var built = await U.buildEntpkg({ mode: 'full', legacyCompatible: mirror });
    if (!built.manifest.specialty || built.manifest.specialty.id !== spec.id) {
      throw cloudError('MISMATCH', { message: 'The package was built for a different specialty than the one you confirmed. Nothing was uploaded.' });
    }
    var raw = new Uint8Array(await built.blob.arrayBuffer());

    progress('Compressing...');
    var gz = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
    var sha = hex(await crypto.subtle.digest('SHA-256', gz));

    var tk = await token();
    progress('Registering the specialty...');
    await syncSpecialties([spec.id]); // students and the rules need specialties/<id> to exist
    var main = await uploadPack(tk, spec.id, spec, built, gz, sha, raw, progress);
    if (mirror) await uploadPack(tk, LEGACY_PACK_ID, spec, built, gz, sha, raw, progress);

    var info = Object.assign({}, main, { specialtyId: spec.id, specialtyName: spec.name, legacyMirror: mirror });
    save(infoKey(spec.id), info);
    return info;
  }

  /* ------------------------------------------------------------------ student accounts */

  var pageSize = 300;
  var accounts = [];
  var accountsLoadedAt = 0;

  function parseUser(doc) {
    var f = doc.fields || {};
    var req = f.specialtyChangeRequest && f.specialtyChangeRequest.mapValue ? f.specialtyChangeRequest.mapValue.fields || {} : null;
    return {
      uid: idOf(doc),
      identifier: strOf(f.identifier) || '(no name)',
      createdAt: tsMs(f.createdAt) || 0,
      plan: strOf(f.plan) || 'none',
      expiresAt: tsMs(f.expiresAt),
      specialtyId: strOf(f.specialtyId),
      specialtyName: strOf(f.specialtyName),
      request: req ? { specialtyId: strOf(req.specialtyId), specialtyName: strOf(req.specialtyName), requestedAt: tsMs(req.requestedAt) || 0 } : null
    };
  }

  // Reads every student profile (one Firestore read each, so load on demand, not automatically).
  async function loadAccounts(progress) {
    var tk = await token();
    var out = [];
    var pageToken = '';
    do {
      var url = FS + '/users?pageSize=' + pageSize + (pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : '');
      var d = await request(url, { headers: authHeaders(tk) });
      (d.documents || []).forEach(function (doc) { out.push(parseUser(doc)); });
      pageToken = d.nextPageToken || '';
      if (progress) progress('Loaded ' + out.length + ' account(s)...');
    } while (pageToken && out.length < 5000);
    accounts = out.sort(function (a, b) { return b.createdAt - a.createdAt; });
    accountsLoadedAt = Date.now();
    return accounts;
  }

  function fmtDay(ms) {
    return new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }

  function accessOf(a) {
    if (a.plan === 'none' || !a.expiresAt) return { kind: 'free', text: 'Free (no subscription)' };
    var days = Math.ceil((a.expiresAt - Date.now()) / 86400000);
    if (a.expiresAt > Date.now()) return { kind: 'active', text: 'Active until ' + fmtDay(a.expiresAt) + ' (' + days + (days === 1 ? ' day' : ' days') + ' left)' };
    return { kind: 'expired', text: 'Expired on ' + fmtDay(a.expiresAt) };
  }

  function addMonths(ms, n) {
    var d = new Date(ms);
    d.setMonth(d.getMonth() + n);
    return d.getTime();
  }

  async function saveAccess(a, plan, expiresAt) {
    var tk = await token();
    await request(FS + '/users/' + encodeURIComponent(a.uid) + '?updateMask.fieldPaths=plan&updateMask.fieldPaths=expiresAt', {
      method: 'PATCH', headers: authHeaders(tk, true),
      body: JSON.stringify({ fields: { plan: sv(plan), expiresAt: expiresAt ? tv(new Date(expiresAt).toISOString()) : { nullValue: null } } })
    });
    a.plan = plan;
    a.expiresAt = expiresAt || null;
  }

  // +N months counts from the current expiry while the account is still active, otherwise from today.
  function extendAccount(a, months, label) {
    var base = a.expiresAt && a.expiresAt > Date.now() ? a.expiresAt : Date.now();
    return saveAccess(a, label, addMonths(base, months));
  }

  // Sets the student's specialty (and clears any pending change request). Their data on the device is never moved:
  // each specialty keeps its own local copy, so switching back later finds it again.
  async function assignSpecialty(a, spec, by) {
    var tk = await token();
    await request(FS + '/users/' + encodeURIComponent(a.uid) + '?updateMask.fieldPaths=schemaVersion&updateMask.fieldPaths=specialtyId' +
      '&updateMask.fieldPaths=specialtyName&updateMask.fieldPaths=specialtyAssignedAt&updateMask.fieldPaths=specialtyAssignedBy&updateMask.fieldPaths=specialtyChangeRequest', {
      method: 'PATCH', headers: authHeaders(tk, true),
      body: JSON.stringify({ fields: { schemaVersion: iv(Core.SCHEMA_VERSION), specialtyId: sv(spec.id), specialtyName: sv(spec.name),
        specialtyAssignedAt: tv(new Date().toISOString()), specialtyAssignedBy: sv(by || 'admin') } })
    });
    a.specialtyId = spec.id; a.specialtyName = spec.name; a.request = null;
  }

  async function declineRequest(a) {
    var tk = await token();
    await request(FS + '/users/' + encodeURIComponent(a.uid) + '?updateMask.fieldPaths=specialtyChangeRequest', {
      method: 'PATCH', headers: authHeaders(tk, true), body: JSON.stringify({ fields: {} })
    });
    a.request = null;
  }

  function specLabel(id, name) {
    var known = window.EntRegistry && window.EntRegistry.get(id);
    return (known && known.name) || name || id;
  }

  function acctMsg(text, isError) {
    var node = el('entAcctMsg');
    if (!node) return;
    node.textContent = text || '';
    node.style.color = isError ? 'var(--danger)' : 'var(--text2)';
  }

  function accountsCardHTML() {
    return '<div class="card"><div class="card-header">Student accounts</div>' +
      '<p style="font-size:0.85rem;color:var(--text2);">Every account that signs up appears here with the specialty it chose. Activate it for as long as you agree with the student; the app unlocks the question bank on their next launch. A student can only use their own specialty\'s questions.</p>' +
      '<button class="btn btn-outline btn-block" id="btnAcctLoad">Load accounts</button>' +
      '<input type="search" id="entAcctFilter" placeholder="Search username or email" autocomplete="off" autocapitalize="none" spellcheck="false" style="margin-top:10px;">' +
      '<select id="entAcctSpec" aria-label="Filter by specialty" style="margin-top:8px;"></select>' +
      '<div id="entAcctSummary" style="margin:6px 0;font-size:0.82rem;color:var(--text2);"></div>' +
      '<div id="entAcctBulk"></div>' +
      '<div id="entAcctList"></div>' +
      '<div id="entAcctMsg" style="margin-top:8px;font-size:0.82rem;color:var(--text2);"></div></div>';
  }

  function fillSpecFilter() {
    var sel = el('entAcctSpec');
    if (!sel) return;
    var keep = sel.value || 'all';
    var opts = ['<option value="all">All specialties</option>', '<option value="requests">Pending change requests</option>', '<option value="none">No specialty set (before 1.4)</option>'];
    window.EntRegistry.list().forEach(function (s) { opts.push('<option value="' + esc(s.id) + '">' + esc(s.name) + (s.status !== 'active' ? ' (' + esc(Core.STATUS_LABELS[s.status]) + ')' : '') + '</option>'); });
    sel.innerHTML = opts.join('');
    sel.value = Array.prototype.some.call(sel.options, function (o) { return o.value === keep; }) ? keep : 'all';
  }

  function renderAccounts() {
    var list = el('entAcctList');
    if (!list) return;
    fillSpecFilter();
    var filterEl = el('entAcctFilter');
    var q = filterEl ? filterEl.value.trim().toLowerCase() : '';
    var specFilter = (el('entAcctSpec') || {}).value || 'all';
    var counts = { active: 0, expired: 0, free: 0 };
    accounts.forEach(function (a) { counts[accessOf(a).kind]++; });
    var unassigned = accounts.filter(function (a) { return !a.specialtyId; }).length;
    var requests = accounts.filter(function (a) { return a.request; }).length;
    var summary = el('entAcctSummary');
    if (summary) {
      summary.textContent = accounts.length
        ? accounts.length + ' account(s): ' + counts.active + ' active, ' + counts.expired + ' expired, ' + counts.free + ' free · ' + requests + ' change request(s) · ' + unassigned + ' without a specialty'
        : '';
    }
    var bulk = el('entAcctBulk');
    if (bulk) {
      bulk.textContent = '';
      if (unassigned) {
        var b = document.createElement('button');
        b.type = 'button'; b.className = 'btn btn-sm btn-accent'; b.setAttribute('data-act', 'bulk-ent');
        b.textContent = 'Assign the ' + unassigned + ' account(s) with no specialty to ENT';
        bulk.appendChild(b);
        var note = document.createElement('div');
        note.style.cssText = 'font-size:0.78rem;color:var(--text-muted);margin:4px 0 8px;';
        note.textContent = 'Accounts created before specialties existed were ENT students. They also set this themselves the first time they open the new app.';
        bulk.appendChild(note);
      }
    }
    list.textContent = '';
    accounts.filter(function (a) {
      if (q && a.identifier.toLowerCase().indexOf(q) === -1) return false;
      if (specFilter === 'requests') return !!a.request;
      if (specFilter === 'none') return !a.specialtyId;
      if (specFilter !== 'all') return a.specialtyId === specFilter;
      return true;
    }).forEach(function (a) {
      var st = accessOf(a);
      var row = document.createElement('div');
      row.className = 'ent-acct';
      row.setAttribute('data-uid', a.uid);
      row.style.cssText = 'border:1px solid var(--border);border-radius:12px;padding:10px 12px;margin-bottom:8px;';

      var top = document.createElement('div');
      var name = document.createElement('b');
      name.textContent = a.identifier;
      top.appendChild(name);
      if (a.createdAt) {
        var created = document.createElement('span');
        created.style.cssText = 'font-size:0.75rem;color:var(--text-muted);margin-left:8px;';
        created.textContent = 'joined ' + fmtDay(a.createdAt);
        top.appendChild(created);
      }
      row.appendChild(top);

      var spec = document.createElement('div');
      spec.className = 'ent-acct-spec';
      spec.style.cssText = 'font-size:0.85rem;margin:4px 0 0;';
      spec.textContent = a.specialtyId ? 'Specialty: ' + specLabel(a.specialtyId, a.specialtyName) + ' (' + a.specialtyId + ')' : 'Specialty: not set yet (an ENT account from before 1.4)';
      row.appendChild(spec);

      if (a.request) {
        var rq = document.createElement('div');
        rq.style.cssText = 'font-size:0.82rem;margin:6px 0;padding:6px 8px;border-radius:8px;background:var(--surface-hover);';
        rq.textContent = 'Asked to change to ' + specLabel(a.request.specialtyId, a.request.specialtyName) + (a.request.requestedAt ? ' on ' + fmtDay(a.request.requestedAt) : '') + '.';
        [['approve', 'Approve'], ['decline', 'Decline']].forEach(function (pair) {
          var rb = document.createElement('button');
          rb.type = 'button'; rb.className = 'btn btn-sm btn-outline'; rb.style.marginLeft = '8px';
          rb.setAttribute('data-act', pair[0]); rb.textContent = pair[1];
          rq.appendChild(rb);
        });
        row.appendChild(rq);
      }

      var status = document.createElement('div');
      status.className = 'ent-acct-status';
      status.style.cssText = 'font-size:0.85rem;margin:4px 0 8px;color:' +
        (st.kind === 'active' ? 'var(--success,#16a34a)' : st.kind === 'expired' ? 'var(--danger,#dc2626)' : 'var(--text2)') + ';';
      status.textContent = st.text;
      row.appendChild(status);

      var actions = document.createElement('div');
      actions.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;';
      [['m1', '+1 month'], ['m3', '+3 months'], ['m12', '+12 months'], ['date', 'Set date'], ['spec', 'Change specialty'], ['stop', 'Stop']].forEach(function (pair) {
        var b2 = document.createElement('button');
        b2.type = 'button';
        b2.className = 'btn btn-sm ' + (pair[0] === 'stop' ? 'btn-danger' : 'btn-outline');
        b2.setAttribute('data-act', pair[0]);
        b2.textContent = pair[1];
        actions.appendChild(b2);
      });
      row.appendChild(actions);
      list.appendChild(row);
    });
  }

  function chooseSpecialty(a) {
    return new Promise(function (resolve) {
      var opts = window.EntRegistry.list().filter(function (s) { return s.status !== 'archived'; });
      if (!opts.length) { resolve(null); return; }
      var html = '<h3>Change specialty</h3><p style="font-size:0.9rem;margin:6px 0 12px;">Account: <b>' + esc(a.identifier) + '</b><br>Now: <b>' +
        esc(a.specialtyId ? specLabel(a.specialtyId, a.specialtyName) : 'not set') + '</b></p>' +
        '<label class="modal-field">New specialty<select id="entChooseSpec">' +
        opts.map(function (s) { return '<option value="' + esc(s.id) + '"' + (s.id === a.specialtyId ? ' selected' : '') + '>' + esc(s.name) + (s.status !== 'active' ? ' (' + esc(Core.STATUS_LABELS[s.status]) + ')' : '') + '</option>'; }).join('') + '</select></label>' +
        '<p style="font-size:0.8rem;color:var(--text2);">The student\'s progress in the old specialty stays on their device and returns if they are moved back. Nothing is merged between specialties.</p>' +
        '<button type="button" class="btn btn-primary btn-block" id="entChooseSpecOk">Change specialty</button>' +
        '<button type="button" class="btn btn-outline btn-block mt-2" id="entChooseSpecNo">Cancel</button>';
      showModal(html);
      el('entChooseSpecOk').addEventListener('click', function () {
        var id = el('entChooseSpec').value;
        closeModal();
        resolve(window.EntRegistry.get(id));
      });
      el('entChooseSpecNo').addEventListener('click', function () { closeModal(); resolve(null); });
    });
  }

  async function onAccountAction(e) {
    var btn = e.target.closest && e.target.closest('button[data-act]');
    if (!btn) return;
    if (typeof RBAC !== 'undefined' && !RBAC.requireAdmin()) return;
    var act = btn.getAttribute('data-act');
    if (act === 'bulk-ent') return bulkAssignEnt();
    var row = btn.closest('.ent-acct');
    var a = accounts.filter(function (x) { return row && x.uid === row.getAttribute('data-uid'); })[0];
    if (!a) return;
    try {
      if (act === 'm1') await extendAccount(a, 1, '1m');
      else if (act === 'm3') await extendAccount(a, 3, '3m');
      else if (act === 'm12') await extendAccount(a, 12, '12m');
      else if (act === 'date') {
        var d0 = a.expiresAt ? new Date(a.expiresAt) : new Date();
        var def = d0.getFullYear() + '-' + String(d0.getMonth() + 1).padStart(2, '0') + '-' + String(d0.getDate()).padStart(2, '0');
        var typed = window.prompt('Active until (YYYY-MM-DD) for ' + a.identifier + ':', def);
        if (typed === null) return;
        var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(typed).trim());
        var when = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 23, 59, 59) : null;
        if (!when || isNaN(when.getTime()) || when.getMonth() !== Number(m[2]) - 1) return acctMsg('Enter the date as YYYY-MM-DD, for example 2027-03-15.', true);
        await saveAccess(a, 'custom', when.getTime());
      } else if (act === 'stop') {
        if (!window.confirm('Stop access for ' + a.identifier + '? They keep their progress but lose the paid questions.')) return;
        await saveAccess(a, 'none', null);
      } else if (act === 'spec') {
        var chosen = await chooseSpecialty(a);
        if (!chosen || chosen.id === a.specialtyId) return;
        await assignSpecialty(a, chosen, 'admin');
        renderAccounts();
        return acctMsg(a.identifier + ' is now in ' + chosen.name + '. They see it the next time they open the app online.');
      } else if (act === 'approve') {
        var target = window.EntRegistry.get(a.request.specialtyId) || { id: a.request.specialtyId, name: a.request.specialtyName };
        if (target.status && target.status !== 'active' && !window.confirm('"' + target.name + '" is ' + (Core.STATUS_LABELS[target.status] || target.status).toLowerCase() + '. Move ' + a.identifier + ' there anyway?')) return;
        await assignSpecialty(a, target, 'admin-approved');
        renderAccounts();
        return acctMsg(a.identifier + ' moved to ' + target.name + '.');
      } else if (act === 'decline') {
        await declineRequest(a);
        renderAccounts();
        return acctMsg('Request declined. ' + a.identifier + ' stays in ' + specLabel(a.specialtyId, a.specialtyName) + '.');
      }
      renderAccounts();
      acctMsg(a.identifier + ': ' + accessOf(a).text + '.');
    } catch (err) {
      acctMsg('Could not update ' + a.identifier + ': ' + friendly(err), true);
    }
  }

  async function bulkAssignEnt() {
    var todo = accounts.filter(function (a) { return !a.specialtyId; });
    if (!todo.length) return;
    var ent = window.EntRegistry.get(Core.LEGACY_SPECIALTY_ID);
    if (!ent) return acctMsg('The ENT specialty is missing from this device\'s list.', true);
    if (!window.confirm('Assign ' + todo.length + ' account(s) that have no specialty to "' + ent.name + '"? This is what they would be set to automatically anyway.')) return;
    try {
      await syncSpecialties([ent.id]); // make sure specialties/ent exists in the cloud
      for (var i = 0; i < todo.length; i++) {
        acctMsg('Assigning ' + (i + 1) + ' / ' + todo.length + '...');
        await assignSpecialty(todo[i], ent, 'migration');
      }
      renderAccounts();
      acctMsg('Done: ' + todo.length + ' account(s) are now ENT students.');
    } catch (err) {
      renderAccounts();
      acctMsg('Stopped: ' + friendly(err), true);
    }
  }

  function wireAccounts() {
    var loadBtn = el('btnAcctLoad');
    if (!loadBtn) return;
    renderAccounts(); // accounts loaded earlier in this session stay visible after Settings re-renders
    loadBtn.addEventListener('click', async function () {
      if (typeof RBAC !== 'undefined' && !RBAC.requireAdmin()) return;
      loadBtn.disabled = true;
      acctMsg('Loading...');
      try {
        await loadAccounts(acctMsg);
        renderAccounts();
        acctMsg(accounts.length ? '' : 'No accounts yet.');
      } catch (e) {
        acctMsg('Could not load accounts: ' + friendly(e), true);
      } finally {
        loadBtn.disabled = false;
      }
    });
    var filter = el('entAcctFilter');
    if (filter) filter.addEventListener('input', renderAccounts);
    var specSel = el('entAcctSpec');
    if (specSel) specSel.addEventListener('change', renderAccounts);
    var list = el('entAcctList');
    if (list) list.addEventListener('click', onAccountAction);
    var bulk = el('entAcctBulk');
    if (bulk) bulk.addEventListener('click', onAccountAction);
  }

  /* ------------------------------------------------------------------ question reports */

  var REASON_LABELS = { wrong_answer: 'Wrong answer', wrong_explanation: 'Wrong explanation', typo: 'Typo / unclear', other: 'Other' };
  var reports = [];

  function parseReport(doc) {
    var f = doc.fields || {};
    return {
      id: idOf(doc),
      questionUid: strOf(f.questionUid),
      questionText: strOf(f.questionText),
      subject: strOf(f.subject),
      chapter: strOf(f.chapter),
      correctAnswer: strOf(f.correctAnswer),
      reason: strOf(f.reason),
      note: strOf(f.note),
      reporter: strOf(f.reporterIdentifier),
      specialtyId: strOf(f.specialtyId),
      specialtyName: strOf(f.specialtyName),
      createdAt: tsMs(f.createdAt) || 0
    };
  }

  // Reports written before specialties existed carry no specialtyId: they are ENT reports.
  function reportSpecialty(r) { return r.specialtyId || Core.LEGACY_SPECIALTY_ID; }

  // One Firestore read per report: load on demand, resolve (delete) reports once handled.
  async function loadReports(progress) {
    var tk = await token();
    var out = [];
    var pageToken = '';
    do {
      var url = FS + '/reports?pageSize=' + pageSize + (pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : '');
      var d = await request(url, { headers: authHeaders(tk) });
      (d.documents || []).forEach(function (doc) { out.push(parseReport(doc)); });
      pageToken = d.nextPageToken || '';
      if (progress) progress('Loaded ' + out.length + ' report(s)...');
    } while (pageToken && out.length < 5000);
    reports = out.sort(function (a, b) { return b.createdAt - a.createdAt; });
    return reports;
  }

  function reportsCardHTML() {
    return '<div class="card"><div class="card-header">Question reports</div>' +
      '<p style="font-size:0.85rem;color:var(--text2);">Problems students report on questions. Each report names the student\'s specialty. Open that specialty\'s workspace, fix the question in the Questions list, then tap Resolve.</p>' +
      '<button class="btn btn-outline btn-block" id="btnRepLoad">Load reports</button>' +
      '<input type="search" id="entRepFilter" placeholder="Search question, student or note" autocomplete="off" spellcheck="false" style="margin-top:10px;">' +
      '<select id="entRepSpec" aria-label="Filter reports by specialty" style="margin-top:8px;"></select>' +
      '<div id="entRepSummary" style="margin:6px 0;font-size:0.82rem;color:var(--text2);"></div>' +
      '<div id="entRepList"></div>' +
      '<div id="entRepMsg" style="margin-top:8px;font-size:0.82rem;color:var(--text2);"></div></div>';
  }

  function repMsg(text, isError) {
    var node = el('entRepMsg');
    if (!node) return;
    node.textContent = text || '';
    node.style.color = isError ? 'var(--danger)' : 'var(--text2)';
  }

  function fillReportSpecFilter() {
    var sel = el('entRepSpec');
    if (!sel) return;
    var keep = sel.value || 'all';
    var cur = currentSpec();
    var opts = ['<option value="all">All specialties</option>'];
    if (cur) opts.push('<option value="' + esc(cur.id) + '">Open workspace: ' + esc(cur.name) + '</option>');
    window.EntRegistry.list().forEach(function (s) { if (!cur || s.id !== cur.id) opts.push('<option value="' + esc(s.id) + '">' + esc(s.name) + '</option>'); });
    sel.innerHTML = opts.join('');
    sel.value = Array.prototype.some.call(sel.options, function (o) { return o.value === keep; }) ? keep : 'all';
  }

  function renderReports() {
    var list = el('entRepList');
    if (!list) return;
    fillReportSpecFilter();
    var filterEl = el('entRepFilter');
    var q = filterEl ? filterEl.value.trim().toLowerCase() : '';
    var specFilter = (el('entRepSpec') || {}).value || 'all';
    var counts = {};
    reports.forEach(function (r) { counts[r.reason] = (counts[r.reason] || 0) + 1; });
    var summary = el('entRepSummary');
    if (summary) {
      summary.textContent = reports.length
        ? reports.length + ' open report(s): ' + Object.keys(REASON_LABELS).map(function (k) { return (counts[k] || 0) + ' ' + REASON_LABELS[k].toLowerCase(); }).join(', ')
        : '';
    }
    list.textContent = '';
    reports.filter(function (r) {
      if (specFilter !== 'all' && reportSpecialty(r) !== specFilter) return false;
      return !q || (r.questionText + ' ' + r.reporter + ' ' + r.note + ' ' + r.subject + ' ' + r.chapter).toLowerCase().indexOf(q) !== -1;
    }).forEach(function (r) {
      var row = document.createElement('div');
      row.className = 'ent-report';
      row.setAttribute('data-rid', r.id);
      row.style.cssText = 'border:1px solid var(--border);border-radius:12px;padding:10px 12px;margin-bottom:8px;';

      var top = document.createElement('div');
      var reason = document.createElement('b');
      reason.className = 'ent-report-reason';
      reason.textContent = REASON_LABELS[r.reason] || r.reason || 'Report';
      top.appendChild(reason);
      var sid = reportSpecialty(r);
      var chip = document.createElement('span');
      chip.className = 'badge badge-primary ent-report-spec';
      chip.style.marginLeft = '8px';
      chip.textContent = specLabel(sid, r.specialtyName) + (r.specialtyId ? '' : ' (legacy)');
      top.appendChild(chip);
      var when = document.createElement('span');
      when.style.cssText = 'font-size:0.75rem;color:var(--text-muted);margin-left:8px;';
      when.textContent = r.createdAt ? fmtDay(r.createdAt) : '';
      top.appendChild(when);
      row.appendChild(top);

      var text = document.createElement('div');
      text.style.cssText = 'font-size:0.88rem;margin:4px 0;';
      text.setAttribute('dir', 'auto');
      text.textContent = r.questionText.length > 140 ? r.questionText.slice(0, 140) + '...' : r.questionText;
      row.appendChild(text);

      var meta = document.createElement('div');
      meta.style.cssText = 'font-size:0.78rem;color:var(--text2);';
      meta.textContent = [r.subject, r.chapter].filter(Boolean).join(' / ') + (r.subject || r.chapter ? ' - ' : '') + 'from ' + (r.reporter || 'unknown');
      row.appendChild(meta);

      if (r.note) {
        var note = document.createElement('div');
        note.style.cssText = 'font-size:0.85rem;margin-top:6px;padding:6px 8px;border-radius:8px;background:var(--bg-secondary,rgba(0,0,0,.05));';
        note.setAttribute('dir', 'auto');
        note.textContent = r.note;
        row.appendChild(note);
      }

      var detail = document.createElement('div');
      detail.className = 'ent-report-detail';
      detail.style.cssText = 'display:none;margin-top:8px;font-size:0.85rem;';
      row.appendChild(detail);

      var actions = document.createElement('div');
      actions.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;margin-top:8px;';
      var openHere = !currentSpec() || sid === currentSpec().id;
      var buttons = openHere ? [['show', 'Show question'], ['resolve', 'Resolve']] : [['workspace', 'Open ' + specLabel(sid, r.specialtyName) + ' workspace'], ['resolve', 'Resolve']];
      buttons.forEach(function (pair) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'btn btn-sm btn-outline';
        b.setAttribute('data-act', pair[0]);
        b.textContent = pair[1];
        actions.appendChild(b);
      });
      row.appendChild(actions);
      list.appendChild(row);
    });
  }

  // Shows the question as it is in THIS device's database for the report's specialty (the one you edit).
  async function showReportedQuestion(r, holder) {
    if (holder.style.display === 'block') { holder.style.display = 'none'; return; }
    holder.textContent = '';
    var all = await db.getAllQuestions();
    var q = all.filter(function (x) { return x.uid && x.uid === r.questionUid; })[0];
    if (!q) {
      holder.textContent = 'This question was not found in this specialty\'s workspace (it may have been deleted, or this device does not have it).';
    } else {
      var line = function (label, value, strong) {
        var d = document.createElement('div');
        d.style.margin = '2px 0';
        d.setAttribute('dir', 'auto');
        if (label) { var s = document.createElement('b'); s.textContent = label + ' '; d.appendChild(s); }
        var t = document.createElement(strong ? 'b' : 'span');
        t.textContent = value;
        d.appendChild(t);
        holder.appendChild(d);
      };
      line('Q:', q.questionText);
      ['A', 'B', 'C', 'D', 'E'].forEach(function (l) {
        if (q['option' + l]) line(l + '.', q['option' + l] + (l === q.correctAnswer ? '  ✓' : ''), l === q.correctAnswer);
      });
      if (r.correctAnswer && r.correctAnswer !== q.correctAnswer) line('', 'Note: the student saw "' + r.correctAnswer + '" as the correct answer; it is now "' + q.correctAnswer + '".');
      if (q.explanation) line('Explanation:', q.explanation);
    }
    holder.style.display = 'block';
  }

  async function onReportAction(e) {
    var btn = e.target.closest && e.target.closest('button[data-act]');
    if (!btn) return;
    if (typeof RBAC !== 'undefined' && !RBAC.requireAdmin()) return;
    var row = btn.closest('.ent-report');
    var r = reports.filter(function (x) { return row && x.id === row.getAttribute('data-rid'); })[0];
    if (!r) return;
    try {
      var act = btn.getAttribute('data-act');
      if (act === 'show') {
        await showReportedQuestion(r, row.querySelector('.ent-report-detail'));
      } else if (act === 'workspace') {
        var sid = reportSpecialty(r);
        if (!window.EntRegistry.get(sid)) return repMsg('This device does not have a "' + sid + '" workspace. Pull the specialty list from Specialties first.', true);
        if (typeof AppState !== 'undefined' && AppState.examInProgress) return repMsg('Finish or leave the exam first.', true);
        window.EntRegistry.openWorkspace(sid);
      } else {
        if (!window.confirm('Mark this report as resolved? It will be deleted.')) return;
        var tk = await token();
        await request(FS + '/reports/' + encodeURIComponent(r.id), { method: 'DELETE', headers: authHeaders(tk) });
        reports = reports.filter(function (x) { return x.id !== r.id; });
        renderReports();
        repMsg('Report resolved.');
      }
    } catch (err) {
      repMsg('Could not complete that: ' + friendly(err), true);
    }
  }

  function wireReports() {
    var loadBtn = el('btnRepLoad');
    if (!loadBtn) return;
    renderReports(); // reports loaded earlier in this session stay visible after Settings re-renders
    loadBtn.addEventListener('click', async function () {
      if (typeof RBAC !== 'undefined' && !RBAC.requireAdmin()) return;
      loadBtn.disabled = true;
      repMsg('Loading...');
      try {
        await loadReports(repMsg);
        renderReports();
        repMsg(reports.length ? '' : 'No open reports.');
      } catch (e) {
        repMsg('Could not load reports: ' + friendly(e), true);
      } finally {
        loadBtn.disabled = false;
      }
    });
    var filter = el('entRepFilter');
    if (filter) filter.addEventListener('input', renderReports);
    var specSel = el('entRepSpec');
    if (specSel) specSel.addEventListener('change', renderReports);
    var list = el('entRepList');
    if (list) list.addEventListener('click', onReportAction);
  }

  /* ------------------------------------------------------------------ access scope card + ENT migration checklist */

  function accessCardHTML() {
    return '<div class="card"><div class="card-header">Subscription scope</div>' +
      '<p style="font-size:0.85rem;color:var(--text2);">What does an active subscription unlock? This is enforced by the Firestore rules, not just by the app.</p>' +
      '<label style="display:flex;gap:8px;align-items:flex-start;margin:8px 0;"><input type="radio" name="entScope" value="selected"> <span><b>The student\'s own specialty only</b> (recommended). A student of Dermatology downloads only the Dermatology bank.</span></label>' +
      '<label style="display:flex;gap:8px;align-items:flex-start;margin:8px 0;"><input type="radio" name="entScope" value="all"> <span><b>All specialties.</b> Any active subscriber may download every active specialty\'s bank. The app still only shows the student\'s own specialty.</span></label>' +
      '<button class="btn btn-outline btn-block" id="btnScopeSave">Save scope</button>' +
      '<div id="entScopeMsg" style="margin-top:8px;font-size:0.82rem;color:var(--text2);"></div></div>';
  }

  function scopeMsg(text, isError) {
    var node = el('entScopeMsg');
    if (!node) return;
    node.textContent = text || '';
    node.style.color = isError ? 'var(--danger)' : 'var(--text2)';
  }

  async function wireScope() {
    var save2 = el('btnScopeSave');
    if (!save2) return;
    var radios = document.querySelectorAll('input[name="entScope"]');
    try {
      var current = await readScope();
      Array.prototype.forEach.call(radios, function (r) { r.checked = r.value === current; });
    } catch (e) { scopeMsg('Could not read the current scope: ' + friendly(e), true); }
    save2.addEventListener('click', async function () {
      if (typeof RBAC !== 'undefined' && !RBAC.requireAdmin()) return;
      var chosen = Array.prototype.filter.call(radios, function (r) { return r.checked; })[0];
      if (!chosen) return scopeMsg('Choose one option.', true);
      save2.disabled = true;
      try { await writeScope(chosen.value); scopeMsg('Saved: ' + (chosen.value === 'all' ? 'subscriptions cover all specialties.' : 'subscriptions cover the student\'s own specialty.')); }
      catch (e) { scopeMsg('Could not save: ' + friendly(e), true); }
      finally { save2.disabled = false; }
    });
  }

  function migrationCardHTML() {
    return '<div class="card"><div class="card-header">ENT migration check</div>' +
      '<p style="font-size:0.85rem;color:var(--text2);">If this project already served ENT students before specialties, run the check to see which one-time steps are still open. Nothing is changed by the check.</p>' +
      '<button class="btn btn-outline btn-block" id="btnMigCheck">Run check</button>' +
      '<div id="entMigResult" style="margin-top:10px;font-size:0.85rem;"></div></div>';
  }

  async function runMigrationCheck() {
    var box = el('entMigResult');
    if (!box) return;
    box.textContent = 'Checking...';
    var tk = await token();
    var rows = [];
    function row(ok, text) { rows.push('<div style="margin:4px 0;">' + (ok ? '✅ ' : '⬜ ') + esc(text) + '</div>'); }
    var specDoc = null, entPack = null, mainPack = null, scope = 'selected';
    try { specDoc = parseSpecialtyDoc(await request(FS + '/specialties/' + Core.LEGACY_SPECIALTY_ID, { headers: authHeaders(tk) })); } catch (e) { if (e.status !== 404) throw e; }
    entPack = await readMeta(tk, Core.LEGACY_SPECIALTY_ID);
    mainPack = await readMeta(tk, LEGACY_PACK_ID);
    try { scope = await readScope(); } catch (e) { /* default */ }
    row(!!specDoc, specDoc ? 'ENT exists in the cloud specialty list (status: ' + specDoc.status + ').' : 'ENT is not in the cloud specialty list yet → open Specialties and tap "Sync list to cloud".');
    row(!!entPack, entPack ? 'ENT bank published at packs/ent (' + entPack.questions + ' questions, version ' + entPack.version + ').' : 'ENT bank is not published at packs/ent yet → open the ENT workspace and publish it.');
    row(!!mainPack, mainPack ? 'The old packs/main copy exists (' + mainPack.questions + ' questions), so students on app 1.3.x still work.' : 'No old packs/main copy. Fine if every student has updated to 1.4.0; otherwise publish ENT with "also update the legacy copy".');
    if (accountsLoadedAt) {
      var n = accounts.filter(function (a) { return !a.specialtyId; }).length;
      row(n === 0, n ? n + ' student account(s) still have no specialty → use "Assign ... to ENT" in Student accounts.' : 'Every loaded student account has a specialty.');
    } else {
      row(false, 'Student accounts not loaded yet → tap "Load accounts" to count the ones without a specialty.');
    }
    row(true, 'Subscription scope: ' + (scope === 'all' ? 'all specialties' : 'the student\'s own specialty') + '.');
    box.innerHTML = rows.join('');
  }

  /* ------------------------------------------------------------------ UI */

  function fmtBytes(n) {
    return n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB';
  }

  function cardHTML() {
    var head = '<div class="card"><div class="card-header">Cloud (Firebase)</div>';
    if (!CONFIGURED) {
      return head + '<p style="font-size:0.85rem;color:var(--text2);">Firebase is not set up yet. Fill in <code>firebase-config.js</code> first (see FIREBASE-SETUP.md).</p></div>';
    }
    var s = load(SESSION_KEY);
    if (!s) {
      return head +
        '<p style="font-size:0.85rem;color:var(--text2);">Sign in with your admin account to publish question banks to subscribers.</p>' +
        '<label class="modal-field">Email<input type="email" id="entCloudEmail" autocomplete="username" autocapitalize="none" spellcheck="false"></label>' +
        '<label class="modal-field">Password<input type="password" id="entCloudPassword" autocomplete="current-password"></label>' +
        '<button class="btn btn-primary btn-block mt-2" id="btnCloudSignIn">Sign in</button>' +
        '<div id="entCloudMsg" style="margin-top:10px;font-size:0.82rem;color:var(--text2);"></div></div>';
    }
    var spec = currentSpec() || { id: '?', name: '?' };
    var info = load(infoKey(spec.id));
    var last = info
      ? 'Last published from this device: <b id="entCloudLast"></b>'
      : 'Nothing published for this specialty from this device yet.';
    var mirror = spec.id === Core.LEGACY_SPECIALTY_ID
      ? '<label style="display:flex;gap:8px;align-items:flex-start;margin:8px 0;font-size:0.82rem;"><input type="checkbox" id="entCloudMirror" checked> <span>Also update the old ENT location (<code>packs/main</code>) so students still on app 1.3.x keep working. Untick once everyone has updated.</span></label>'
      : '';
    return head +
      '<p style="font-size:0.85rem;color:var(--text2);margin-bottom:6px;">Signed in as <b id="entCloudWho"></b></p>' +
      '<div style="padding:10px 12px;border:1px solid var(--border);border-radius:12px;background:var(--primary-soft);margin:8px 0;font-size:0.88rem;">' +
      'Publishing target: <b id="entCloudSpecName"></b> <code id="entCloudSpecId"></code><br><span style="color:var(--text2);">Goes to <code>packs/' + esc(spec.id) + '</code>. Only this specialty\'s questions are included.</span></div>' +
      '<p style="font-size:0.85rem;color:var(--text2);">' + last + '</p>' +
      '<p style="font-size:0.8rem;color:var(--text-muted);">Publishes <b>all</b> current content of this specialty (not only the Free questions). Students of this specialty with an active subscription download it automatically.</p>' +
      mirror +
      '<button class="btn btn-accent btn-block mt-2" id="btnCloudPublish">Publish ' + esc(spec.name) + ' question bank</button>' +
      '<button class="btn btn-outline btn-block mt-2" id="btnCloudSignOut">Sign out</button>' +
      '<div id="entCloudMsg" style="margin-top:10px;font-size:0.82rem;color:var(--text2);"></div></div>' +
      accessCardHTML() + accountsCardHTML() + reportsCardHTML() + migrationCardHTML();
  }

  function setMsg(text, isError) {
    var node = el('entCloudMsg');
    if (!node) return;
    node.textContent = text || '';
    node.style.color = isError ? 'var(--danger)' : 'var(--text2)';
  }

  function rerender() {
    try { if (typeof navigateTo === 'function') navigateTo('settings'); } catch (e) { /* ignore */ }
  }

  function wire() {
    var s = load(SESSION_KEY);
    var who = el('entCloudWho');
    if (who && s) who.textContent = s.email;
    var spec = currentSpec();
    if (spec) {
      var nm = el('entCloudSpecName'), idn = el('entCloudSpecId');
      if (nm) nm.textContent = spec.name;
      if (idn) idn.textContent = spec.id;
    }
    var last = el('entCloudLast');
    var info = spec ? load(infoKey(spec.id)) : null;
    if (last && info) {
      last.textContent = info.version + ' - ' + info.questions + ' questions, ' + fmtBytes(info.gzBytes) +
        ' (' + new Date(info.updatedAt).toLocaleString() + ')';
    }

    var signInBtn = el('btnCloudSignIn');
    if (signInBtn) signInBtn.addEventListener('click', async function () {
      if (typeof RBAC !== 'undefined' && !RBAC.requireAdmin()) return;
      var email = el('entCloudEmail').value;
      var password = el('entCloudPassword').value;
      if (!email || !password) return setMsg('Enter your email and password.', true);
      signInBtn.disabled = true;
      setMsg('Signing in...');
      try { await signIn(email, password); rerender(); }
      catch (e) { setMsg(friendly(e), true); signInBtn.disabled = false; }
    });

    var outBtn = el('btnCloudSignOut');
    if (outBtn) outBtn.addEventListener('click', function () { signOut(); rerender(); });

    var pubBtn = el('btnCloudPublish');
    if (pubBtn) pubBtn.addEventListener('click', async function () {
      if (typeof RBAC !== 'undefined' && !RBAC.requireAdmin()) return;
      if (busy) return;
      var cur = currentSpec();
      if (!cur) return setMsg('Open a specialty workspace first.', true);
      var count = 0;
      try { count = (await db.getAllQuestions()).length; } catch (e) { count = 0; }
      var mirrorBox = el('entCloudMirror');
      var mirror = !!(mirrorBox && mirrorBox.checked);
      var scope = 'selected';
      try { scope = await readScope(); } catch (e) { /* shown below as the default */ }
      var ok = window.confirm('Publish this specialty?\n\n' +
        '    ' + cur.name + '   (ID: ' + cur.id + ')\n' +
        '    ' + count + ' question(s) from this workspace\n\n' +
        'It will REPLACE the bank that ' + cur.name + ' students download (packs/' + cur.id + (mirror ? ' and the old packs/main' : '') + '). Other specialties are not touched.\n' +
        'Subscription scope: ' + (scope === 'all' ? 'all specialties' : 'the student\'s own specialty') + '.\n\nContinue?');
      if (!ok) return;
      busy = true;
      pubBtn.disabled = true;
      try {
        var info2 = await publish(function (t) { setMsg(t); }, { legacyMirror: mirror });
        setMsg('Published ' + info2.specialtyName + ' ' + info2.version + ': ' + info2.questions + ' questions, ' + fmtBytes(info2.gzBytes) +
          ' in ' + info2.chunkCount + ' part(s)' + (info2.legacyMirror ? ' (and the legacy ENT copy)' : '') + '.');
        if (typeof showToast === 'function') showToast(info2.specialtyName + ' question bank published.', 'success');
        var lastEl = el('entCloudLast');
        if (lastEl) lastEl.textContent = info2.version + ' - ' + info2.questions + ' questions, ' + fmtBytes(info2.gzBytes);
      } catch (e) {
        if (e.code === 'NOT_SIGNED_IN') { signOut(); rerender(); }
        setMsg('Publish failed: ' + friendly(e), true);
        console.error('Cloud publish error', e);
      } finally {
        busy = false;
        pubBtn.disabled = false;
      }
    });

    var mig = el('btnMigCheck');
    if (mig) mig.addEventListener('click', async function () {
      if (typeof RBAC !== 'undefined' && !RBAC.requireAdmin()) return;
      mig.disabled = true;
      try { await runMigrationCheck(); } catch (e) { var box = el('entMigResult'); if (box) box.textContent = 'Check failed: ' + friendly(e); }
      finally { mig.disabled = false; }
    });

    wireScope();
    wireAccounts();
    wireReports();
  }

  window.EntCloudAdmin = {
    cardHTML: cardHTML, wire: wire, publish: publish, signIn: signIn, signOut: signOut, isSignedIn: isSignedIn,
    isConfigured: CONFIGURED, friendly: friendly,
    syncSpecialties: syncSpecialties, pullSpecialties: pullSpecialties, readScope: readScope, writeScope: writeScope,
    loadAccounts: loadAccounts,
    loadReports: loadReports,
    setPageSize: function (n) { pageSize = n; }
  };
})();
