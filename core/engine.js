import React, { useEffect, useMemo, useRef } from 'react';
import { StyleSheet, View } from 'react-native';
import { WebView } from 'react-native-webview';

// Everything that can be tuned lives here. Defaults keep the original models and quality.
export const ENGINE_CONFIG = {
  lib: 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1',
  seg: 'Xenova/segformer-b0-finetuned-ade-512-512',
  depth: 'onnx-community/depth-anything-v2-small',
  segDtype: 'fp32', // 'q8' = ~4x smaller download, tiny accuracy loss: A/B test before switching
  depthDtype: 'q8',
  maxLayers: 4, // output is smart-limited to 2..maxLayers depth layers (3-4 typical)
  // Git revision per model. 'main' = Hugging Face default (current behaviour, NOT pinned). To pin, for EACH model:
  //   1. open the model page on huggingface.co (seg: Xenova/segformer-b0-finetuned-ade-512-512,
  //      depth: onnx-community/depth-anything-v2-small) > "Files and versions" > "History" (the commits list);
  //   2. pick the commit you tested, click the copy icon next to it to get the FULL 40-char hash (not the 7-char short one);
  //   3. put it below, e.g. revision: { seg: '<40-char hash>', depth: '<40-char hash>' }, then bump cacheVersion to re-download.
  // No hash is filled in here on purpose: it must come from the real HF page.
  revision: { seg: 'main', depth: 'main' },
  cacheVersion: '1', // models are stored on-device after the first download; change this value to force a re-download
  modelHost: null, // optional own host for model files (null = Hugging Face)
  modelPath: null, // optional path template, e.g. '{model}/resolve/{revision}/'
  splitByDepth: true, // split a class whose depth histogram has two clear peaks (near + far part); false = old behaviour
  softEdges: true, // returned layer masks get a soft 3x3 edge (area/filter logic still uses the binary mask); false = binary masks
  guidedEdges: true, // refine class probabilities with a guided filter (guide = the analysis image) before the argmax, so mask edges stick to real image edges; false = old behaviour
  guidedRadius: 4, // guided filter window radius in analysis pixels (analysis image is at most 640 px); bigger = fixes larger misalignment but leaks more
  guidedEps: 1e-3, // guided filter regularisation on the 0..1 gray guide (variance units); smaller = follows image edges more, also texture
  idleDisposeMs: 20000, // models stay loaded this long after a job so the next job is fast (20s: both models sit in RAM, kept short for low-RAM phones); 0 = dispose right after each job
  // EXPERIMENTAL, both off by default (untested on a real phone):
  webgpu: false, // try device 'webgpu' when navigator.gpu exists, otherwise / on any failure fall back to 'wasm'
  parallelWorkers: false, // run segmentation and depth in two Web Workers at the same time
};

// Code that runs inside the hidden WebView. No backticks / dollar-brace allowed in here.
const ENGINE_SOURCE = String.raw`
(function () {
'use strict';
var CFG = __CFG__;
var lib = null;

function post(o) { try { window.ReactNativeWebView.postMessage(JSON.stringify(o)); } catch (e) {} }
function fail(stage, e) { post({ type: 'error', stage: stage, message: String((e && e.message) || e) }); }

// ---------- persistent model cache ----------
// Model files are saved on the device after the first download (IndexedDB, with the Cache API as a fallback),
// so later runs do not download them again. Every stored file carries an integrity record (expected size, SHA-256
// for .onnx) that is checked on every read; a failed check removes the record and counts as a miss.
var DBNAME = 'zharph-models-' + (CFG.cacheVersion || '1'), STORE = 'files', REC_V = 2, MIN_ONNX = 1048576;
var stats = { backend: 'none', hit: 0, miss: 0, stored: 0, healed: 0, evicted: 0 }, needDl = false, cacheNote = false, warned = {};
var totals = [], dbp = null;

function msgOf(e) { return String((e && e.message) || e); }
function warnOnce(tag, e) {
  if (warned[tag]) return;
  warned[tag] = 1;
  post({ type: 'warn', message: 'Model cache (' + tag + '): ' + msgOf(e) });
}
function isOnnx(key) { return /\.onnx(\?|$)/.test(key); }
function isJson(key) { return /\.json(\?|$)/.test(key); }
function baseName(key) { return String(key).split('?')[0].split('/').pop(); }

function sha256(buf) {
  try {
    if (!(typeof crypto !== 'undefined' && crypto.subtle && crypto.subtle.digest)) return Promise.resolve(null);
    return crypto.subtle.digest('SHA-256', buf).then(function (d) {
      var a = new Uint8Array(d), s = '', i;
      for (i = 0; i < a.length; i++) s += (a[i] < 16 ? '0' : '') + a[i].toString(16);
      return s;
    });
  } catch (e) { return Promise.resolve(null); }
}

function openDb() {
  if (dbp) return dbp;
  dbp = new Promise(function (ok, no) {
    try {
      var rq = indexedDB.open(DBNAME, 1);
      rq.onupgradeneeded = function () { rq.result.createObjectStore(STORE); };
      rq.onsuccess = function () { ok(rq.result); };
      rq.onerror = function () { no(rq.error || new Error('indexedDB open failed')); };
    } catch (e) { no(e); }
  });
  dbp.catch(function () { dbp = null; });
  return dbp;
}

function idb(mode, fn) {
  return openDb().then(function (db) {
    return new Promise(function (ok, no) {
      var tx = db.transaction(STORE, mode), res = fn(tx.objectStore(STORE));
      tx.oncomplete = function () { ok(res && res.result); };
      tx.onerror = tx.onabort = function () { no(tx.error || new Error('indexedDB transaction failed')); };
    });
  });
}

// Backend contract: get(k) -> record|null, set(k, buf, meta), del(k), evict(matchFn) -> number removed.
// A record is { v, buf, len, type, exp, sha }.
var backends = [
  {
    name: 'idb',
    get: function (k) {
      return idb('readonly', function (s) { return s.get(k); }).then(function (r) { return r && r.buf ? r : null; });
    },
    set: function (k, buf, meta) {
      return idb('readwrite', function (s) {
        return s.put({ v: REC_V, buf: buf, len: buf.byteLength, type: meta.type, exp: meta.exp, sha: meta.sha }, k);
      });
    },
    del: function (k) { return idb('readwrite', function (s) { return s.delete(k); }); },
    evict: function (match) {
      return openDb().then(function (db) {
        return new Promise(function (ok, no) {
          var tx = db.transaction(STORE, 'readwrite'), s = tx.objectStore(STORE), n = 0, rq = s.getAllKeys();
          rq.onsuccess = function () { rq.result.forEach(function (k) { if (match(String(k))) { s.delete(k); n++; } }); };
          tx.oncomplete = function () { ok(n); };
          tx.onerror = tx.onabort = function () { no(tx.error || new Error('indexedDB transaction failed')); };
        });
      });
    },
  },
  {
    name: 'cache-api',
    get: async function (k) {
      if (typeof caches === 'undefined') return null;
      var c = await caches.open(DBNAME), r = await c.match(k);
      if (!r) return null;
      var h = r.headers;
      return {
        v: Number(h.get('x-zharph-v')) || 0, buf: await r.arrayBuffer(), type: h.get('content-type') || '',
        len: Number(h.get('x-zharph-len')) || 0, exp: Number(h.get('x-zharph-exp')) || 0, sha: h.get('x-zharph-sha') || null,
      };
    },
    set: async function (k, buf, meta) {
      if (typeof caches === 'undefined') throw new Error('Cache API unavailable');
      var c = await caches.open(DBNAME);
      var headers = { 'content-type': meta.type || 'application/octet-stream', 'x-zharph-v': String(REC_V), 'x-zharph-len': String(buf.byteLength), 'x-zharph-exp': String(meta.exp || 0) };
      if (meta.sha) headers['x-zharph-sha'] = meta.sha;
      await c.put(k, new Response(buf, { headers: headers }));
    },
    del: async function (k) {
      if (typeof caches === 'undefined') return;
      var c = await caches.open(DBNAME);
      await c.delete(k);
    },
    evict: async function (match) {
      if (typeof caches === 'undefined') return 0;
      var c = await caches.open(DBNAME), ks = await c.keys(), n = 0, i;
      for (i = 0; i < ks.length; i++) if (match(ks[i].url)) { await c.delete(ks[i]); n++; }
      return n;
    },
  },
];

function keyOf(req) { return typeof req === 'string' ? req : (req && req.url) || String(req); }

// Size the progress events reported for this file (only trusted when the body was not content-encoded).
function totalFor(key) {
  var p = String(key).split('?')[0], i, t;
  for (i = 0; i < totals.length; i++) {
    t = totals[i];
    if (p.indexOf('/' + t.id + '/') >= 0 && p.slice(-(t.file.length + 1)) === '/' + t.file) return t.total;
  }
  return 0;
}

// Reasons not to store a freshly downloaded file. Returns '' when it looks complete and sane.
function suspect(key, buf, exp, enc) {
  var n = buf.byteLength, tot = totalFor(key);
  if (!n) return 'empty body';
  if (exp > 0 && !enc && exp !== n) return 'size ' + n + ' differs from content-length ' + exp;
  if (tot > 0 && !enc && tot !== n) return 'size ' + n + ' differs from progress total ' + tot;
  if (isOnnx(key)) {
    if (n < MIN_ONNX) return 'too small for a model file (' + n + ' bytes)';
    var b0 = new Uint8Array(buf, 0, 1)[0];
    if (b0 === 0x3c || b0 === 0x7b) return 'looks like an HTML/JSON error page';
  }
  if (isJson(key)) {
    try { JSON.parse(new TextDecoder().decode(buf)); } catch (e) { return 'invalid JSON'; }
  }
  return '';
}

// Real health check on read. .onnx: size + SHA-256; json and others: size only.
async function verify(rec, key) {
  var n = rec.buf ? rec.buf.byteLength : 0;
  if (rec.v !== REC_V || !n || n !== rec.len) return false; // records without integrity data (older versions) are not trusted
  if (rec.exp > 0 && n !== rec.exp) return false;
  if (isOnnx(key)) {
    if (n < MIN_ONNX) return false;
    if (rec.sha) {
      var h = await sha256(rec.buf);
      if (h && h !== rec.sha) return false;
    }
  }
  return true;
}

// Same match/put contract as the Web Cache API, which is what transformers.js expects of env.customCache.
var modelCache = {
  match: async function (req) {
    var key = keyOf(req), rec = null, i, be, r, ok;
    for (i = 0; i < backends.length && !rec; i++) {
      be = backends[i]; r = null;
      try { r = await be.get(key); } catch (e) { warnOnce(be.name + ' read', e); continue; }
      if (!r) continue;
      try { ok = await verify(r, key); } catch (e) { ok = false; }
      if (ok) { rec = r; stats.backend = be.name; continue; }
      stats.evicted++;
      warnOnce('integrity ' + baseName(key), 'stored copy failed the integrity check and was removed; it will be downloaded again');
      try { await be.del(key); } catch (e) { warnOnce(be.name + ' delete', e); }
    }
    var big = isOnnx(key);
    if (rec) {
      stats.hit++;
      if (big && !needDl && !cacheNote) { cacheNote = true; post({ type: 'progress', stage: 'cache', pct: 100 }); }
      return new Response(rec.buf, { status: 200, headers: { 'content-type': rec.type || 'application/octet-stream', 'content-length': String(rec.buf.byteLength) } });
    }
    stats.miss++;
    if (big) needDl = true;
    return undefined;
  },
  put: async function (req, response) {
    var key = keyOf(req);
    try {
      var buf = await response.arrayBuffer(), type = response.headers.get('content-type') || '';
      var exp = Number(response.headers.get('content-length')) || 0, enc = response.headers.get('content-encoding');
      var why = suspect(key, buf, exp, enc);
      if (why) { warnOnce('skip ' + baseName(key), 'not stored: ' + why); return; }
      var meta = { type: type, exp: enc ? 0 : exp, sha: isOnnx(key) ? await sha256(buf) : null };
      if (isOnnx(key) && !meta.sha) warnOnce('sha256', 'crypto.subtle unavailable; model files are verified by size only');
      for (var i = 0; i < backends.length; i++) {
        try {
          await backends[i].set(key, buf, meta);
          stats.stored++; stats.backend = backends[i].name;
          return;
        } catch (e) { warnOnce(backends[i].name + ' write', e); }
      }
    } catch (e) { warnOnce('put', e); }
  },
};

// Remove every cached file that belongs to one model (all backends). Returns how many entries were removed.
async function evictModel(id) {
  var tag = '/' + id + '/', n = 0, i;
  for (i = 0; i < backends.length; i++) {
    try { n += (await backends[i].evict(function (k) { return String(k).indexOf(tag) >= 0; })) || 0; }
    catch (e) { warnOnce(backends[i].name + ' evict', e); }
  }
  stats.evicted += n;
  return n;
}

// Drop model files saved under an older cacheVersion (IndexedDB and Cache API) so they do not waste storage.
function pruneOldCaches() {
  try {
    indexedDB.databases().then(function (list) {
      list.forEach(function (d) {
        if (d.name && d.name.indexOf('zharph-models-') === 0 && d.name !== DBNAME) indexedDB.deleteDatabase(d.name);
      });
    }).catch(function () {});
  } catch (e) {}
  try {
    if (typeof caches !== 'undefined' && caches.keys) {
      caches.keys().then(function (names) {
        names.forEach(function (n) {
          if (n.indexOf('zharph-models-') === 0 && n !== DBNAME) caches.delete(n).catch(function () {});
        });
      }).catch(function () {});
    }
  } catch (e) {}
}
var GUIDED_MAX_PX = 1500000; // above this many analysis pixels the guided path is skipped (the analysis image is normally at most 640 px)
function tick() { return new Promise(function (r) { setTimeout(r, 20); }); }
function roundTo(v, m) { return Math.max(m, Math.round(v / m) * m); }

function imgData(im, w, h) {
  var c = document.createElement('canvas'); c.width = w; c.height = h;
  var x = c.getContext('2d', { willReadFrequently: true });
  x.drawImage(im, 0, 0, w, h);
  return x.getImageData(0, 0, w, h);
}

function toTensorData(id, w, h) {
  var n = w * h, d = id.data, o = new Float32Array(3 * n);
  var m = [0.485, 0.456, 0.406], s = [0.229, 0.224, 0.225];
  for (var i = 0; i < n; i++) {
    o[i] = (d[i * 4] / 255 - m[0]) / s[0];
    o[n + i] = (d[i * 4 + 1] / 255 - m[1]) / s[1];
    o[n * 2 + i] = (d[i * 4 + 2] / 255 - m[2]) / s[2];
  }
  return o;
}

function resizeBilinear(src, sw, sh, dw, dh, out) {
  var o = out || new Float32Array(dw * dh), x0 = new Int32Array(dw), x1 = new Int32Array(dw), wx = new Float32Array(dw), x, y;
  for (x = 0; x < dw; x++) {
    var fx = Math.min(sw - 1, Math.max(0, (x + 0.5) * sw / dw - 0.5));
    x0[x] = fx | 0; x1[x] = Math.min(sw - 1, x0[x] + 1); wx[x] = fx - x0[x];
  }
  for (y = 0; y < dh; y++) {
    var fy = Math.min(sh - 1, Math.max(0, (y + 0.5) * sh / dh - 0.5)), y0 = fy | 0, y1 = Math.min(sh - 1, y0 + 1), wy = fy - y0;
    var r0 = y0 * sw, r1 = y1 * sw, base = y * dw;
    for (x = 0; x < dw; x++) {
      var t = src[r0 + x0[x]] + (src[r0 + x1[x]] - src[r0 + x0[x]]) * wx[x];
      var u = src[r1 + x0[x]] + (src[r1 + x1[x]] - src[r1 + x0[x]]) * wx[x];
      o[base + x] = t + (u - t) * wy;
    }
  }
  return o;
}

// 3x3 majority filter (separable box sums). Same result as the naive neighbour count.
function clean(m, o, tmp, w, h) {
  var x, y, i, s, row;
  for (y = 0; y < h; y++) {
    row = y * w;
    for (x = 0; x < w; x++) {
      i = row + x; s = m[i];
      if (x > 0) s += m[i - 1];
      if (x < w - 1) s += m[i + 1];
      tmp[i] = s;
    }
  }
  for (y = 0; y < h; y++) {
    var ny = 1 + (y > 0 ? 1 : 0) + (y < h - 1 ? 1 : 0);
    row = y * w;
    for (x = 0; x < w; x++) {
      i = row + x; s = tmp[i];
      if (y > 0) s += tmp[i - w];
      if (y < h - 1) s += tmp[i + w];
      var nx = 1 + (x > 0 ? 1 : 0) + (x < w - 1 ? 1 : 0);
      o[i] = s >= ((nx * ny + 1) >> 1) ? 1 : 0;
    }
  }
}

// Soft version of a binary mask for the JS side: 3x3 box blur (separable), border-normalised so a mask that
// touches the image border stays fully opaque there. m = 0/1 mask, o = Uint8 alpha 0..255, tmp = Uint8 scratch.
function soften(m, o, tmp, w, h) {
  var x, y, i, s, row, nx, ny;
  for (y = 0; y < h; y++) {
    row = y * w;
    for (x = 0; x < w; x++) {
      i = row + x; s = m[i];
      if (x > 0) s += m[i - 1];
      if (x < w - 1) s += m[i + 1];
      tmp[i] = s;
    }
  }
  for (y = 0; y < h; y++) {
    ny = 1 + (y > 0 ? 1 : 0) + (y < h - 1 ? 1 : 0);
    row = y * w;
    for (x = 0; x < w; x++) {
      i = row + x; s = tmp[i];
      if (y > 0) s += tmp[i - w];
      if (y < h - 1) s += tmp[i + w];
      nx = 1 + (x > 0 ? 1 : 0) + (x < w - 1 ? 1 : 0);
      o[i] = Math.round(s * 255 / (nx * ny));
    }
  }
}

// ---------- guided filter (edge-aware refinement of class probabilities) ----------
// Reference: He, Sun, Tang, "Guided Image Filtering". Gray guide, O(N) per filtered map: four box means.
// The filter is linear in the filtered map and keeps constants, so probabilities that sum to 1 still sum to 1.

// Radius and eps from the config, with safe fallbacks (radius 1..32 whole pixels, eps > 0).
function guidedParams(cfg) {
  var r = Math.round(Number(cfg && cfg.guidedRadius)), e = Number(cfg && cfg.guidedEps);
  if (!(r >= 1)) r = 4;
  if (!(e > 0)) e = 1e-3;
  return { r: Math.min(r, 32), eps: Math.max(e, 1e-6) };
}

// Mean over every (2r+1) x (2r+1) window, clipped at the image border and divided by the number of pixels really
// inside the window. Two separable passes with running sums, so the cost does not depend on r.
// src, dst, tmp: Float32Array(w*h); acc: Float64Array(w). dst may be src; tmp must be a different array.
function boxMean(src, dst, tmp, acc, w, h, r) {
  var x, y, s, row, row2, hi, a, b;
  for (y = 0; y < h; y++) {
    row = y * w; s = 0;
    for (x = 0, hi = Math.min(r, w - 1); x <= hi; x++) s += src[row + x];
    for (x = 0; x < w; x++) {
      a = x + r < w ? x + r : w - 1; b = x - r > 0 ? x - r : 0;
      tmp[row + x] = s / (a - b + 1);
      if (x + r + 1 < w) s += src[row + x + r + 1];
      if (x - r >= 0) s -= src[row + x - r];
    }
  }
  for (x = 0; x < w; x++) acc[x] = 0;
  for (y = 0, hi = Math.min(r, h - 1); y <= hi; y++) { row = y * w; for (x = 0; x < w; x++) acc[x] += tmp[row + x]; }
  for (y = 0; y < h; y++) {
    a = y + r < h ? y + r : h - 1; b = y - r > 0 ? y - r : 0;
    s = 1 / (a - b + 1); row = y * w;
    for (x = 0; x < w; x++) dst[row + x] = acc[x] * s;
    if (y + r + 1 < h) { row2 = (y + r + 1) * w; for (x = 0; x < w; x++) acc[x] += tmp[row2 + x]; }
    if (y - r >= 0) { row2 = (y - r) * w; for (x = 0; x < w; x++) acc[x] -= tmp[row2 + x]; }
  }
}

// Everything that depends only on the guide: its local mean and 1 / (local variance + eps). I = Float32Array(w*h) in 0..1.
function guidedPrepare(I, w, h, r, eps) {
  var n = w * h, c = {
    w: w, h: h, r: r, n: n, I: I, tmp: new Float32Array(n), acc: new Float64Array(w),
    mI: new Float32Array(n), inv: new Float32Array(n), s1: new Float32Array(n), s2: new Float32Array(n), s3: new Float32Array(n),
  }, i, v, II = c.s1;
  for (i = 0; i < n; i++) II[i] = I[i] * I[i];
  boxMean(I, c.mI, c.tmp, c.acc, w, h, r);
  boxMean(II, II, c.tmp, c.acc, w, h, r);
  for (i = 0; i < n; i++) { v = II[i] - c.mI[i] * c.mI[i]; c.inv[i] = 1 / ((v > 0 ? v : 0) + eps); }
  return c;
}

// q = guided filter of p (Float32Array(n), any range) with the prepared guide. q must be another Float32Array(n).
function guidedFilter(c, p, q) {
  var n = c.n, w = c.w, h = c.h, r = c.r, I = c.I, mI = c.mI, inv = c.inv, mp = c.s1, a = c.s2, b = c.s3, i, ai;
  for (i = 0; i < n; i++) q[i] = I[i] * p[i];
  boxMean(q, q, c.tmp, c.acc, w, h, r);
  boxMean(p, mp, c.tmp, c.acc, w, h, r);
  for (i = 0; i < n; i++) { ai = (q[i] - mI[i] * mp[i]) * inv[i]; a[i] = ai; b[i] = mp[i] - ai * mI[i]; }
  boxMean(a, a, c.tmp, c.acc, w, h, r);
  boxMean(b, b, c.tmp, c.acc, w, h, r);
  for (i = 0; i < n; i++) q[i] = a[i] * I[i] + b[i];
}

// Softmax over the kept classes at logit resolution, summed per group (several raw classes can share one group,
// e.g. building + house). koff[k] = offset of kept class k inside log (class-major), kgrp[k] = its group 0..ng-1.
// Returns Float32Array(ng * total): ng probability maps.
function groupProbs(log, total, koff, kgrp, kn, ng) {
  var P = new Float32Array(ng * total), e = new Float32Array(kn), p, k, m, v, s;
  for (p = 0; p < total; p++) {
    m = -Infinity;
    for (k = 0; k < kn; k++) { v = log[koff[k] + p]; if (v > m) m = v; }
    if (m === -Infinity) continue;
    s = 0;
    for (k = 0; k < kn; k++) { v = Math.exp(log[koff[k] + p] - m); e[k] = v; s += v; }
    for (k = 0; k < kn; k++) P[kgrp[k] * total + p] += e[k] / s;
  }
  return P;
}

// Per-pixel label = group with the highest guided-filtered probability. P = ng maps of lw x lh (see groupProbs);
// each map is bilinearly upsampled to w x h, then filtered with the guide I (Float32Array(w*h), 0..1).
// gid[g] is the value written into lab (Int16Array(w*h)) when group g wins.
function guidedLabels(P, ng, lw, lh, w, h, I, r, eps, gid, lab) {
  var n = w * h, total = lw * lh, c = guidedPrepare(I, w, h, r, eps);
  var up = new Float32Array(n), q = new Float32Array(n), best = new Float32Array(n).fill(-Infinity), g, i;
  lab.fill(-1);
  for (g = 0; g < ng; g++) {
    resizeBilinear(P.subarray(g * total, (g + 1) * total), lw, lh, w, h, up);
    guidedFilter(c, up, q);
    for (i = 0; i < n; i++) if (q[i] > best[i]) { best[i] = q[i]; lab[i] = gid[g]; }
  }
}
// ---------- end guided filter ----------

// Median bin position (0..1) of the 64-bin histogram h[off + lo .. off + hi - 1].
function histMedian(h, off, lo, hi) {
  var tot = 0, b, ac = 0;
  for (b = lo; b < hi; b++) tot += h[off + b];
  if (!tot) return (lo + hi) / 128;
  for (b = lo; b < hi; b++) { ac += h[off + b]; if (ac >= tot / 2) return (b + 0.5) / 64; }
  return (hi - 0.5) / 64;
}

// Does one class's 64-bin depth histogram have two clear peaks? Returns null or
// { cut, ratio, wLo, wHi, nLo, nHi }; pixels with bin >= cut are the near part.
// Needs: Otsu between-class variance ratio >= minRatio, a real valley between the two peaks
// (valley <= valleyMax * smaller peak), peaks at least minGap bins apart, both parts >= minPx pixels.
function splitByDepth(h, off, minPx, opt) {
  opt = opt || {};
  var minRatio = opt.minRatio || 0.7, valleyMax = opt.valleyMax || 0.5, minGap = opt.minGap || 10;
  var tot = 0, sum = 0, b, t;
  for (b = 0; b < 64; b++) { tot += h[off + b]; sum += b * h[off + b]; }
  if (tot < 2 * minPx) return null;
  var mean = sum / tot, vtot = 0;
  for (b = 0; b < 64; b++) vtot += h[off + b] * (b - mean) * (b - mean);
  if (vtot <= 0) return null;
  var w0 = 0, s0 = 0, best = -1, bt = 0;
  for (t = 1; t < 64; t++) {
    w0 += h[off + t - 1]; s0 += (t - 1) * h[off + t - 1];
    var w1 = tot - w0;
    if (w0 <= 0 || w1 <= 0) continue;
    var d = s0 / w0 - (sum - s0) / w1, bv = w0 * w1 * d * d / tot;
    if (bv > best) { best = bv; bt = t; }
  }
  if (bt <= 0 || best / vtot < minRatio) return null;
  var sm = new Float64Array(64);
  for (b = 0; b < 64; b++) sm[b] = (h[off + Math.max(0, b - 1)] + 2 * h[off + b] + h[off + Math.min(63, b + 1)]) / 4;
  var p0 = 0, p1 = bt;
  for (b = 0; b < bt; b++) if (sm[b] > sm[p0]) p0 = b;
  for (b = bt; b < 64; b++) if (sm[b] > sm[p1]) p1 = b;
  if (p1 - p0 < minGap) return null;
  var valley = Infinity;
  for (b = p0; b <= p1; b++) if (sm[b] < valley) valley = sm[b];
  if (valley > valleyMax * Math.min(sm[p0], sm[p1])) return null;
  var wLo = 0, wHi = 0;
  for (b = 0; b < bt; b++) wLo += h[off + b];
  for (b = bt; b < 64; b++) wHi += h[off + b];
  if (wLo < minPx || wHi < minPx) return null;
  return { cut: bt, ratio: best / vtot, wLo: wLo, wHi: wHi, nLo: histMedian(h, off, 0, bt), nHi: histMedian(h, off, bt, 64) };
}

// Fold groups smaller than minFrac of the image into the neighbouring group that is closest in depth.
// Every group is kept sorted by .n (depth): the neighbour test reads grp[x][0] as its min and the last member as its max.
function foldSmallGroups(grp, N, minFrac) {
  minFrac = minFrac || 0.02;
  function gArea(gr) { var t = 0; for (var q = 0; q < gr.length; q++) t += gr[q].w; return t; }
  var small, i;
  while (grp.length > 1) {
    small = -1;
    for (i = 0; i < grp.length; i++) if (gArea(grp[i]) / N < minFrac && (small < 0 || gArea(grp[i]) < gArea(grp[small]))) small = i;
    if (small < 0) break;
    var tgt = small === 0 ? 1 : small === grp.length - 1 ? small - 1 :
      (grp[small][0].n - grp[small - 1][grp[small - 1].length - 1].n <= grp[small + 1][0].n - grp[small][grp[small].length - 1].n ? small - 1 : small + 1);
    grp[tgt] = grp[tgt].concat(grp[small]);
    grp[tgt].sort(function (a, b) { return a.n - b.n; });
    grp.splice(small, 1);
  }
  return grp;
}

function names(id, C) {
  var defs = { sky: 'Sky', building: 'Building', house: 'Building', skyscraper: 'Building', tower: 'Building',
    tree: 'Trees & plants', palm: 'Trees & plants', plant: 'Trees & plants', flower: 'Trees & plants',
    grass: 'Grass', field: 'Grass', earth: 'Ground', land: 'Ground', road: 'Road', sidewalk: 'Road',
    mountain: 'Mountains', hill: 'Mountains', rock: 'Mountains', water: 'Water', sea: 'Water', river: 'Water',
    lake: 'Water', person: 'Person', car: 'Vehicle', bus: 'Vehicle', truck: 'Vehicle', bicycle: 'Vehicle',
    animal: 'Animal', wall: 'Wall & fence', fence: 'Wall & fence', bridge: 'Bridge' };
  var out = [], map = new Array(C);
  for (var i = 0; i < C; i++) {
    var raw = String((id && id[i]) || 'class ' + i).toLowerCase().split(',')[0].trim();
    var n = defs[raw] || raw.replace(/^./, function (c) { return c.toUpperCase(); });
    if (out.indexOf(n) < 0) out.push(n);
    map[i] = out.indexOf(n);
  }
  return { list: out, map: map };
}

// Optimal weighted 1-D split of items (sorted by .n, weighted by .w) into K contiguous groups.
function jenks(a, K) {
  var n = a.length, W = [0], S = [0], Q = [0], i, j, m;
  for (i = 0; i < n; i++) {
    W.push(W[i] + a[i].w); S.push(S[i] + a[i].w * a[i].n); Q.push(Q[i] + a[i].w * a[i].n * a[i].n);
  }
  function cost(s, e) {
    var w = W[e] - W[s]; if (w <= 0) return 0;
    var mu = S[e] - S[s]; return Q[e] - Q[s] - mu * mu / w;
  }
  var dp = [], bk = [];
  for (j = 0; j <= K; j++) { dp.push(new Float64Array(n + 1).fill(Infinity)); bk.push(new Int32Array(n + 1)); }
  dp[0][0] = 0;
  for (j = 1; j <= K; j++) for (i = j; i <= n; i++) for (m = j - 1; m < i; m++) {
    var c = dp[j - 1][m] + cost(m, i);
    if (c < dp[j][i]) { dp[j][i] = c; bk[j][i] = m; }
  }
  var starts = [], e = n;
  for (j = K; j >= 1; j--) { starts.unshift(bk[j][e]); e = bk[j][e]; }
  return { sse: dp[K][n], starts: starts };
}

// One combined download progress for both models.
var dl = { seg: [0, 0], depth: [0, 0] }, lastPct = -1;
function track(key, id) {
  return function (e) {
    if (e.status === 'progress' && e.file && e.total > 0) totals.push({ id: id, file: e.file, total: e.total });
    if (e.status !== 'progress' || !needDl) return; // files served from the device cache are not "downloads"
    if (e.file && !/\.onnx$/.test(e.file)) return;
    dl[key] = [e.loaded || 0, e.total || 0];
    var l = dl.seg[0] + dl.depth[0], t = dl.seg[1] + dl.depth[1];
    var pct = Math.min(99, t ? Math.floor(l * 100 / t) : Math.round(e.progress || 0));
    if (pct > lastPct) { lastPct = pct; post({ type: 'progress', stage: 'download', pct: pct }); }
  };
}

function revOf(kind) {
  var r = CFG.revision;
  if (r && typeof r === 'object') r = r[kind];
  return (typeof r === 'string' && r) || 'main';
}

// from_pretrained with self-healing: on any error the cached files of THIS model are cleared and it is tried once more.
async function loadModel(kind, cls, id, dtype) {
  function go() {
    return cls.from_pretrained(id, { device: 'wasm', dtype: dtype, revision: revOf(kind), progress_callback: track(kind, id) });
  }
  try { return await go(); }
  catch (e1) {
    var n = await evictModel(id);
    stats.healed++;
    dl[kind] = [0, 0];
    post({ type: 'warn', message: 'Model cache: loading ' + id + ' failed (' + msgOf(e1) + '); cleared ' + n + ' cached entries and retrying once' });
    return await go();
  }
}
// ---------- end model cache ----------

// ---------- model handles: persistent between jobs, optional WebGPU, optional Workers ----------
// Every model is used through one small facade { id2label, run(data, dims) -> {data, dims}, dispose() }, whether it
// lives on the main thread or in a Worker, so the analysis code below does not care.
var held = { seg: null, depth: null }, idleT = null, devP = null, workers = { seg: null, depth: null };
function noop() {}

function pickDevice() {
  if (!CFG.webgpu) return Promise.resolve('wasm');
  if (!devP) {
    devP = (async function () {
      try {
        if (!navigator.gpu) return 'wasm';
        var ad = await navigator.gpu.requestAdapter();
        return ad ? 'webgpu' : 'wasm';
      } catch (e) { return 'wasm'; }
    })();
  }
  return devP;
}

function wrapLocal(kind, m) {
  return {
    id2label: kind === 'seg' ? m.config.id2label : null,
    run: async function (data, dims) {
      var o = await m({ pixel_values: new lib.Tensor('float32', data, dims) });
      var t = kind === 'seg' ? o.logits : o.predicted_depth;
      return { data: t.data, dims: t.dims };
    },
    dispose: async function () { try { await m.dispose(); } catch (e) {} },
  };
}

function spawnWorker() {
  var url = URL.createObjectURL(new Blob([CFG.workerSrc], { type: 'text/javascript' }));
  var wk = { url: url, rid: 0, wait: {}, prog: null, ready: null };
  wk.w = new Worker(url, { type: 'module' });
  wk.w.onmessage = function (e) { onWorkerMsg(wk, e.data); };
  wk.w.onerror = function (e) {
    var err = new Error('Worker error: ' + ((e && e.message) || 'unknown')), id;
    for (id in wk.wait) { wk.wait[id].no(err); }
    wk.wait = {};
  };
  return wk;
}
function wcall(wk, msg, tr) {
  return new Promise(function (ok, no) { var id = ++wk.rid; wk.wait[id] = { ok: ok, no: no }; msg.rid = id; wk.w.postMessage(msg, tr || []); });
}
function onWorkerMsg(wk, m) {
  if (m.t === 'res') {
    var q = wk.wait[m.rid];
    if (q) { delete wk.wait[m.rid]; if (m.ok) q.ok(m.res); else q.no(new Error(m.err)); }
  } else if (m.t === 'progress') { if (wk.prog) wk.prog(m.ev); }
  else if (m.t === 'rpc') serveRpc(wk, m);
}
// The Worker has no cache of its own: it asks this thread, so the verified on-device model cache stays the single one.
async function serveRpc(wk, m) {
  var res = null, tr = [];
  try {
    if (m.op === 'match') {
      var r = await modelCache.match(m.key);
      if (r) {
        var b = await r.arrayBuffer(), h = {}, ct = r.headers.get('content-type'), cl = r.headers.get('content-length');
        if (ct) h['content-type'] = ct;
        if (cl) h['content-length'] = cl;
        res = { buf: b, headers: h }; tr = [b];
      }
    } else if (m.op === 'put') {
      await modelCache.put(m.key, new Response(m.buf, { headers: m.headers }));
    }
    wk.w.postMessage({ t: 'rpc-res', rid: m.rid, res: res }, tr);
  } catch (e) { wk.w.postMessage({ t: 'rpc-res', rid: m.rid, err: msgOf(e) }); }
}
function killWorker(kind) {
  var wk = workers[kind];
  workers[kind] = null;
  if (!wk) return;
  try { wk.w.terminate(); } catch (e) {}
  try { URL.revokeObjectURL(wk.url); } catch (e) {}
}

async function loadWorkerModel(kind, id, dtype) {
  var wk = workers[kind] || (workers[kind] = spawnWorker());
  wk.prog = track(kind, id);
  if (!wk.ready) wk.ready = wcall(wk, { t: 'init', cfg: { lib: CFG.lib, modelHost: CFG.modelHost, modelPath: CFG.modelPath } });
  await wk.ready;
  function go(dev) { return wcall(wk, { t: 'load', cls: kind, id: id, dtype: dtype, device: dev, revision: revOf(kind) }); }
  var info = null;
  if ((await pickDevice()) === 'webgpu') {
    try { info = await go('webgpu'); } catch (eg) { post({ type: 'warn', message: 'WebGPU failed for ' + id + ' (' + msgOf(eg) + '); using wasm' }); }
  }
  if (!info) {
    try { info = await go('wasm'); }
    catch (e1) {
      var n = await evictModel(id);
      stats.healed++;
      dl[kind] = [0, 0];
      post({ type: 'warn', message: 'Model cache: loading ' + id + ' failed (' + msgOf(e1) + '); cleared ' + n + ' cached entries and retrying once' });
      info = await go('wasm');
    }
  }
  return {
    id2label: info.id2label,
    run: function (data, dims) { return wcall(wk, { t: 'run', cls: kind, data: data, dims: dims }, [data.buffer]); },
    dispose: function () { return wcall(wk, { t: 'dispose' }).catch(noop).then(function () { killWorker(kind); }); },
  };
}

async function loadAuto(kind) {
  var cls = kind === 'seg' ? lib.AutoModelForSemanticSegmentation : lib.AutoModelForDepthEstimation;
  var id = kind === 'seg' ? CFG.seg : CFG.depth, dtype = kind === 'seg' ? CFG.segDtype : CFG.depthDtype;
  if (CFG.parallelWorkers && typeof Worker !== 'undefined' && CFG.workerSrc) {
    try { return await loadWorkerModel(kind, id, dtype); }
    catch (ew) { killWorker(kind); post({ type: 'warn', message: 'parallelWorkers unavailable for ' + id + ' (' + msgOf(ew) + '); using the main thread' }); }
  }
  var m = null;
  if ((await pickDevice()) === 'webgpu') {
    try { m = await cls.from_pretrained(id, { device: 'webgpu', dtype: dtype, revision: revOf(kind), progress_callback: track(kind, id) }); }
    catch (eg) { post({ type: 'warn', message: 'WebGPU failed for ' + id + ' (' + msgOf(eg) + '); using wasm' }); }
  }
  if (!m) m = await loadModel(kind, cls, id, dtype);
  return wrapLocal(kind, m);
}

function modelFor(kind) {
  if (!held[kind]) {
    var p = loadAuto(kind);
    held[kind] = p;
    p.catch(function () { if (held[kind] === p) held[kind] = null; });
  }
  return held[kind];
}
async function release(kind) {
  var p = held[kind];
  held[kind] = null;
  if (p) { try { await (await p).dispose(); } catch (e) {} }
}
async function disposeAll() {
  idleT = null;
  await release('seg'); await release('depth');
  killWorker('seg'); killWorker('depth');
  post({ type: 'idle', disposed: true });
}
function armIdle() {
  clearTimeout(idleT);
  if (CFG.idleDisposeMs > 0) idleT = setTimeout(disposeAll, CFG.idleDisposeMs);
}
// ---------- end model handles ----------

async function init() {
  try {
    lib = await import(CFG.lib);
    lib.env.allowLocalModels = false;
    if ('useCustomCache' in lib.env) {
      lib.env.useCustomCache = true;
      lib.env.customCache = modelCache;
      lib.env.useBrowserCache = false;
    } else {
      lib.env.useBrowserCache = true; // runtime without custom-cache support: fall back to the built-in cache
    }
    try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(function () {}); } catch (e) {}
    pruneOldCaches();
    if (CFG.modelHost) lib.env.remoteHost = CFG.modelHost;
    if (CFG.modelPath) lib.env.remotePathTemplate = CFG.modelPath;
    try { lib.env.backends.onnx.wasm.numThreads = 1; } catch (e) {}
    post({ type: 'ready' });
  } catch (e) {
    fail('init', 'Could not load the AI runtime. Check the internet connection.');
  }
}

// Jobs run one at a time, in arrival order. The WebView, the runtime and (for idleDisposeMs) the models stay alive between jobs.
var chain = Promise.resolve();
window.__analyze = function (job) {
  chain = chain.then(function () { return runJob(job); });
  return chain;
};

async function runJob(job) {
  try {
    clearTimeout(idleT);
    dl = { seg: [0, 0], depth: [0, 0] }; lastPct = -1; needDl = false; cacheNote = false; // progress is per job
    var keepModels = CFG.idleDisposeMs > 0;
    var t0 = performance.now(), tm = {};
    var W = job.width, H = job.height, L = Math.max(W, H), N = W * H, i, k, p, x, y;
    post({ type: 'progress', stage: 'prepare', pct: 0 });
    await tick();
    var im = await new Promise(function (ok, no) {
      var a = new Image();
      a.onload = function () { ok(a); };
      a.onerror = function () { no(new Error('Could not decode the image')); };
      a.src = 'data:image/jpeg;base64,' + job.base64;
    });

    // Both models start loading together; depth finishes downloading while segmentation runs.
    // (A model that is still held from the previous job is reused and needs no download.)
    if (!held.seg || !held.depth) post({ type: 'progress', stage: 'download', pct: 0 });
    var segP = modelFor('seg');
    var depP = modelFor('depth');
    depP.catch(noop);

    var sw = roundTo(W * 512 / L, 32), sh = roundTo(H * 512 / L, 32);
    var dw = roundTo(W * 336 / L, 14), dh = roundTo(H * 336 / L, 14);
    function runDepth() {
      return depP.then(function (dm) { return dm.run(toTensorData(imgData(im, dw, dh), dw, dh), [1, 3, dh, dw]); });
    }

    var seg = await segP;
    post({ type: 'progress', stage: 'segment', pct: 0 });
    await tick();
    var t1 = performance.now(), t2 = t1;
    var segRun = seg.run(toTensorData(imgData(im, sw, sh), sw, sh), [1, 3, sh, sw]);
    var depRun = null;
    if (CFG.parallelWorkers) { depRun = runDepth(); depRun.catch(noop); } // EXPERIMENTAL: depth runs while segmentation runs
    var so = await segRun;
    var C = so.dims[1], lh = so.dims[2], lw = so.dims[3], log = so.data;
    var g = names(seg.id2label, C), total = lh * lw;

    // argmax over classes, class-major so memory is read sequentially
    var bestV = new Float32Array(total).fill(-Infinity), bestC = new Int16Array(total).fill(-1), c, off, v;
    for (c = 0; c < C; c++) {
      off = c * total;
      for (p = 0; p < total; p++) { v = log[off + p]; if (v > bestV[p]) { bestV[p] = v; bestC[p] = c; } }
    }
    var cnt = new Uint32Array(C);
    for (p = 0; p < total; p++) if (bestC[p] >= 0) cnt[bestC[p]]++;
    if (!keepModels) await release('seg');
    bestV = null;
    tm.segment = Math.round(performance.now() - t1);

    var depth = null;
    try {
      post({ type: 'progress', stage: 'depth', pct: 0 });
      await tick();
      if (!depRun) { t2 = performance.now(); depRun = runDepth(); }
      var dout = await depRun;
      var dd = dout.dims;
      depth = resizeBilinear(dout.data, dd[dd.length - 1], dd[dd.length - 2], W, H);
      var mn = Infinity, mx = -Infinity;
      for (p = 0; p < N; p++) { if (depth[p] < mn) mn = depth[p]; if (depth[p] > mx) mx = depth[p]; }
      var rng = mx - mn || 1, dh2 = new Uint32Array(1024);
      for (p = 0; p < N; p++) dh2[Math.min(1023, ((depth[p] - mn) / rng * 1024) | 0)]++;
      var lo = 0, hi = 1023, cum = 0;
      for (i = 0; i < 1024; i++) { cum += dh2[i]; if (cum >= N * 0.005) { lo = i; break; } }
      cum = 0;
      for (i = 1023; i >= 0; i--) { cum += dh2[i]; if (cum >= N * 0.005) { hi = i; break; } }
      var dlo = mn + lo / 1024 * rng, span = Math.max(1e-6, (hi + 1 - lo) / 1024 * rng);
      for (p = 0; p < N; p++) { var dv = (depth[p] - dlo) / span; depth[p] = dv < 0 ? 0 : dv > 1 ? 1 : dv; }
      if (!keepModels) await release('depth');
      tm.depth = Math.round(performance.now() - t2);
    } catch (e) {
      depth = null;
      if (!keepModels) await release('depth');
      post({ type: 'warn', message: 'Depth model unavailable (after one cache-clearing retry if loading failed): ' + msgOf(e) + '; using semantic layers only' });
    }

    post({ type: 'progress', stage: 'refine', pct: 0 });
    await tick();
    var t3 = performance.now();

    // full-resolution labels: bilinear-upsample the logits of the classes that matter, then argmax.
    // (only ~5-15 classes are present, so this is cheap but gives smooth, accurate edges)
    var keep = [];
    for (c = 0; c < C; c++) if (cnt[c] / total >= 0.002) keep.push(c);
    keep.sort(function (a, b) { return cnt[b] - cnt[a]; });
    keep = keep.slice(0, 24);
    var kn = keep.length, lab = new Int16Array(N);
    var koff = new Int32Array(kn), kmap = new Int16Array(kn);
    for (k = 0; k < kn; k++) { koff[k] = keep[k] * total; kmap[k] = g.map[keep[k]]; }

    // Guided path (CFG.guidedEdges): probabilities of the kept classes (softmax, summed per group) are upsampled and
    // filtered with the analysis image as guide BEFORE the argmax, so label edges follow real image edges.
    // Any failure falls back to the plain bilinear-logit path below (the previous behaviour).
    var guided = false;
    if (kn && CFG.guidedEdges !== false && N <= GUIDED_MAX_PX) {
      try {
        var tg = performance.now(), gp = guidedParams(CFG), gseen = {}, gid = [], kgrp = new Int16Array(kn);
        for (k = 0; k < kn; k++) {
          if (gseen[kmap[k]] === undefined) { gseen[kmap[k]] = gid.length; gid.push(kmap[k]); }
          kgrp[k] = gseen[kmap[k]];
        }
        var gpix = imgData(im, W, H).data, gI = new Float32Array(N);
        for (i = 0; i < N; i++) gI[i] = (gpix[i * 4] * 0.299 + gpix[i * 4 + 1] * 0.587 + gpix[i * 4 + 2] * 0.114) / 255;
        guidedLabels(groupProbs(log, total, koff, kgrp, kn, gid.length), gid.length, lw, lh, W, H, gI, gp.r, gp.eps, gid, lab);
        guided = true;
        tm.guided = Math.round(performance.now() - tg);
      } catch (eg) {
        post({ type: 'warn', message: 'Guided edges failed (' + msgOf(eg) + '); using the plain bilinear labels' });
      }
    }
    if (!guided) {
      var bx0 = new Int32Array(W), bx1 = new Int32Array(W), bwx = new Float32Array(W);
      for (x = 0; x < W; x++) {
        var fxx = Math.min(lw - 1, Math.max(0, (x + 0.5) * lw / W - 0.5));
        bx0[x] = fxx | 0; bx1[x] = Math.min(lw - 1, bx0[x] + 1); bwx[x] = fxx - bx0[x];
      }
      // Exact shortcut: if the same class wins at all 4 surrounding low-res cells, bilinear interpolation
      // (a convex mix) cannot make another class win in between, so the full per-class test is skipped.
      var lowK = new Int16Array(total);
      if (kn) {
        for (p = 0; p < total; p++) {
          var bv0 = -Infinity, bk0 = 0;
          for (k = 0; k < kn; k++) { v = log[koff[k] + p]; if (v > bv0) { bv0 = v; bk0 = k; } }
          lowK[p] = bk0;
        }
      } else lab.fill(-1);
      for (y = 0; kn && y < H; y++) {
        var fyy = Math.min(lh - 1, Math.max(0, (y + 0.5) * lh / H - 0.5)), yy0 = fyy | 0, yy1 = Math.min(lh - 1, yy0 + 1), wyy = fyy - yy0;
        var ra = yy0 * lw, rb = yy1 * lw, lb = y * W;
        for (x = 0; x < W; x++) {
          var ia = ra + bx0[x], ib = ra + bx1[x], ic = rb + bx0[x], id = rb + bx1[x], wxx = bwx[x];
          var w0 = lowK[ia];
          if (w0 === lowK[ib] && w0 === lowK[ic] && w0 === lowK[id]) { lab[lb + x] = kmap[w0]; continue; }
          var bv = -Infinity, bk = -1;
          for (k = 0; k < kn; k++) {
            var o2 = koff[k], la = log[o2 + ia], lc = log[o2 + ic];
            v = (la + (log[o2 + ib] - la) * wxx) * (1 - wyy) + (lc + (log[o2 + id] - lc) * wxx) * wyy;
            if (v > bv) { bv = v; bk = k; }
          }
          lab[lb + x] = bk >= 0 ? kmap[bk] : -1;
        }
      }
    }
    so = null; log = null; bestC = null;

    // ONE pass: per-class area, mean height and depth histogram
    var K0 = g.list.length, area0 = new Float64Array(K0), sumY = new Float64Array(K0);
    var hist = depth ? new Uint32Array(K0 * 64) : null;
    for (y = 0; y < H; y++) {
      var r0 = y * W;
      for (x = 0; x < W; x++) {
        i = r0 + x; k = lab[i];
        if (k < 0) continue;
        area0[k]++; sumY[k] += y;
        if (hist) hist[k * 64 + Math.min(63, (depth[i] * 64) | 0)]++;
      }
    }

    // nearness per class: depth median (or image-height heuristic when depth is unavailable).
    // A class whose depth histogram has two clear peaks (a road or a row of trees running from near to far)
    // is split into a far and a near part, each its own entry with its own depth.
    var cls = [], b, extra = 0, splitAt = new Int16Array(K0), hiId = new Int16Array(K0);
    for (k = 0; k < K0; k++) {
      if (area0[k] / N < 0.004) continue;
      var nr = 0;
      if (g.list[k] === 'Sky') nr = 0;
      else if (hist) {
        var sp = CFG.splitByDepth === false ? null : splitByDepth(hist, k * 64, 0.02 * N);
        if (sp) {
          splitAt[k] = sp.cut; hiId[k] = K0 + extra++;
          cls.push({ k: k, v: k, n: sp.nLo, w: sp.wLo });
          cls.push({ k: k, v: hiId[k], n: sp.nHi, w: sp.wHi });
          continue;
        }
        nr = histMedian(hist, k * 64, 0, 64);
      } else nr = sumY[k] / area0[k] / H;
      cls.push({ k: k, v: k, n: nr, w: area0[k] });
    }
    cls.sort(function (a, b) { return a.n - b.n; });

    // smart layer count: 2..maxLayers, only as many as the depth spread really needs
    var n = cls.length, maxL = Math.max(2, Math.min(CFG.maxLayers || 4, 4)), Kuse = Math.min(n, 3);
    if (n > 2) {
      var s1 = jenks(cls, 1).sse || 1e-9;
      if (jenks(cls, 2).sse <= 0.06 * s1) Kuse = 2;
      else if (n >= 4 && maxL >= 4 && jenks(cls, 3).sse > 0.12 * s1) Kuse = 4;
    }
    Kuse = Math.min(Kuse, maxL, n); // maxLayers is a hard ceiling (before: only the 4th layer was gated)
    var starts = n ? jenks(cls, Kuse).starts : [], grp = [];
    for (i = 0; i < starts.length; i++) grp.push(cls.slice(starts[i], i + 1 < starts.length ? starts[i + 1] : n));

    // fold layers smaller than 2% of the image into their closest-depth neighbour
    grp = foldSmallGroups(grp, N);

    // pixel -> layer, then one cleaned mask per layer
    var toLayer = new Int8Array(K0 + extra).fill(-1), gi, q;
    for (gi = 0; gi < grp.length; gi++) for (q = 0; q < grp[gi].length; q++) toLayer[grp[gi][q].v] = gi;
    var pl = new Int8Array(N), kk, vv;
    for (i = 0; i < N; i++) {
      kk = lab[i];
      if (kk < 0) { pl[i] = -1; continue; }
      vv = kk;
      if (splitAt[kk] > 0 && Math.min(63, (depth[i] * 64) | 0) >= splitAt[kk]) vv = hiId[kk];
      pl[i] = toLayer[vv];
    }

    var mask = new Uint8Array(N), tmp = new Uint8Array(N), cl = new Uint8Array(N), soft = new Uint8Array(N);
    var cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    var cx = cv.getContext('2d'), idata = cx.createImageData(W, H), px = idata.data;
    for (i = 0; i < N; i++) { px[i * 4] = 255; px[i * 4 + 1] = 255; px[i * 4 + 2] = 255; }

    var groups = [];
    for (gi = 0; gi < grp.length; gi++) {
      for (i = 0; i < N; i++) mask[i] = pl[i] === gi ? 1 : 0;
      clean(mask, cl, tmp, W, H);
      var area = 0;
      for (i = 0; i < N; i++) area += cl[i];
      if (area / N < 0.006) continue;

      var items = grp[gi].slice().sort(function (a, b) { return b.w - a.w; }), wsum = 0, nsum = 0;
      for (q = 0; q < items.length; q++) { wsum += items[q].w; nsum += items[q].w * items[q].n; }
      var nm = [], nz, nn; // distinct class names by area (a split class can appear twice in one layer)
      for (nz = 0; nz < items.length; nz++) { nn = g.list[items[nz].k]; if (nm.indexOf(nn) < 0) nm.push(nn); }
      var top = nm[0];
      if (CFG.softEdges === false) { for (i = 0; i < N; i++) px[i * 4 + 3] = cl[i] ? 255 : 0; }
      else { soften(cl, soft, tmp, W, H); for (i = 0; i < N; i++) px[i * 4 + 3] = soft[i]; }
      cx.putImageData(idata, 0, 0);
      groups.push({
        label: nm.length > 1 ? top + ' + ' + nm[1] : top, group: top,
        area: area / N, nearness: nsum / wsum, mask: cv.toDataURL('image/png').split(',')[1],
      });
    }
    groups.sort(function (a, b) { return b.nearness - a.nearness; }); // nearest first, far/sky last
    for (i = 0; i < groups.length; i++) groups[i].id = 'layer-' + (i + 1);
    tm.refine = Math.round(performance.now() - t3);
    tm.total = Math.round(performance.now() - t0);
    post({ type: 'result', width: W, height: H, layers: groups, depthUsed: !!depth, timings: tm, cache: stats });
  } catch (e) {
    fail('analyze', e);
  } finally {
    if (CFG.idleDisposeMs > 0) armIdle();
    else { try { await disposeAll(); } catch (e2) {} }
  }
}

init();
})();
`;

// EXPERIMENTAL (config.parallelWorkers). Runs inside a Web Worker, one model per Worker. The Worker has no model cache
// of its own: match/put go to the WebView main thread, which owns the verified on-device cache. No backticks / dollar-brace here.
const WORKER_SOURCE = String.raw`
var lib = null, model = null, rid = 0, wait = {};
function rpc(msg, tr) {
  return new Promise(function (ok, no) { var id = ++rid; wait[id] = { ok: ok, no: no }; msg.rid = id; self.postMessage(msg, tr || []); });
}
function keyOf(req) { return typeof req === 'string' ? req : (req && req.url) || String(req); }
var proxyCache = {
  match: async function (req) {
    var r = await rpc({ t: 'rpc', op: 'match', key: keyOf(req) });
    return r ? new Response(r.buf, { status: 200, headers: r.headers }) : undefined;
  },
  put: async function (req, response) {
    var h = {};
    response.headers.forEach(function (v, k) { h[k] = v; });
    var buf = await response.arrayBuffer();
    await rpc({ t: 'rpc', op: 'put', key: keyOf(req), buf: buf, headers: h }, [buf]);
  },
};
self.onmessage = async function (e) {
  var m = e.data, out;
  if (m.t === 'rpc-res') {
    var w = wait[m.rid];
    if (w) { delete wait[m.rid]; if (m.err) w.no(new Error(m.err)); else w.ok(m.res); }
    return;
  }
  try {
    if (m.t === 'init') {
      lib = await import(m.cfg.lib);
      lib.env.allowLocalModels = false;
      lib.env.useCustomCache = true; lib.env.customCache = proxyCache; lib.env.useBrowserCache = false;
      if (m.cfg.modelHost) lib.env.remoteHost = m.cfg.modelHost;
      if (m.cfg.modelPath) lib.env.remotePathTemplate = m.cfg.modelPath;
      try { lib.env.backends.onnx.wasm.numThreads = 1; } catch (x) {}
      out = { ok: 1 };
    } else if (m.t === 'load') {
      var C = m.cls === 'seg' ? lib.AutoModelForSemanticSegmentation : lib.AutoModelForDepthEstimation;
      model = await C.from_pretrained(m.id, {
        device: m.device, dtype: m.dtype, revision: m.revision,
        progress_callback: function (ev) { self.postMessage({ t: 'progress', ev: ev }); },
      });
      out = { id2label: m.cls === 'seg' ? model.config.id2label : null };
    } else if (m.t === 'run') {
      var o = await model({ pixel_values: new lib.Tensor('float32', m.data, m.dims) });
      var t = m.cls === 'seg' ? o.logits : o.predicted_depth;
      out = { data: t.data, dims: t.dims };
    } else if (m.t === 'dispose') {
      try { if (model) await model.dispose(); } catch (x) {}
      model = null; out = { ok: 1 };
    }
    self.postMessage({ t: 'res', rid: m.rid, ok: 1, res: out });
  } catch (err) {
    self.postMessage({ t: 'res', rid: m.rid, ok: 0, err: String((err && err.message) || err) });
  }
};
`;

export function buildEngineHtml(overrides) {
  const cfg = { ...ENGINE_CONFIG, ...overrides };
  if (cfg.parallelWorkers) cfg.workerSrc = WORKER_SOURCE; // only shipped when the experimental flag is on
  const json = JSON.stringify(cfg).replace(/</g, '\\u003c');
  return '<!doctype html><html><body><script>' + ENGINE_SOURCE.replace('__CFG__', () => json) + '</script></body></html>';
}

const INACTIVITY_MS = 90000;

// Hidden worker. Same props as before: job, onProgress, onResult, onError.
// The WebView stays alive while this component is mounted: when `job` changes to a different image the new job is
// queued and run after the current one (onResult/onError fire once per job). With one job per mount nothing changes.
export default function DepthEngine({ job, config, onProgress, onResult, onError }) {
  const webRef = useRef(null);
  const timer = useRef(null);
  const ready = useRef(false);
  const busy = useRef(false);
  const inflight = useRef(null); // job sent to the WebView that has not answered yet
  const queue = useRef([]);
  const lastJob = useRef(null);
  const cb = useRef({});
  cb.current = { onProgress, onResult, onError };
  const cfgKey = JSON.stringify(config || {});
  // keyed by content, so an inline `config={{...}}` object never reloads the WebView on every render
  const html = useMemo(() => buildEngineHtml(config), [cfgKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const arm = () => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      busy.current = false;
      inflight.current = null;
      lastJob.current = null; // a retry with the same image is allowed after a timeout
      cb.current.onError && cb.current.onError('Layer analysis timed out');
    }, INACTIVITY_MS);
  };

  const pump = () => {
    if (!ready.current || busy.current || !webRef.current) return;
    const next = queue.current.shift();
    if (!next) return;
    busy.current = true;
    inflight.current = next;
    arm();
    webRef.current.injectJavaScript('window.__analyze(' + JSON.stringify(next) + ');true;');
  };

  const submit = (j) => {
    const l = lastJob.current;
    if (l && l.width === j.width && l.height === j.height && l.base64 === j.base64) return; // same image: already handled
    lastJob.current = j;
    queue.current.push(j);
    arm(); // covers the engine boot time too, like before
    pump();
  };

  useEffect(() => {
    if (job) submit(job);
  }, [job]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => clearTimeout(timer.current), []);

  const finishJob = () => {
    busy.current = false;
    inflight.current = null;
    clearTimeout(timer.current);
    if (queue.current.length) {
      arm();
      pump();
    }
  };

  const handleMessage = (event) => {
    let msg;
    try {
      msg = JSON.parse(event.nativeEvent.data);
    } catch (error) {
      return;
    }
    if (busy.current || queue.current.length) arm();
    if (msg.type === 'ready') {
      // also reached again if the WebView reloaded (new config): a job that was in flight is sent again
      if (inflight.current) queue.current.unshift(inflight.current);
      busy.current = false;
      inflight.current = null;
      ready.current = true;
      pump();
    } else if (msg.type === 'progress') {
      cb.current.onProgress && cb.current.onProgress(msg);
    } else if (msg.type === 'warn') {
      console.warn('[DepthEngine]', msg.message);
    } else if (msg.type === 'result') {
      if (typeof __DEV__ !== 'undefined' && __DEV__ && msg.cache) console.log('[DepthEngine] model cache', msg.cache);
      finishJob();
      cb.current.onResult && cb.current.onResult(msg);
    } else if (msg.type === 'error') {
      lastJob.current = null; // a retry with the same image is allowed after an error
      finishJob();
      cb.current.onError && cb.current.onError(msg.message || 'Layer analysis failed');
    }
  };

  return React.createElement(
    View,
    { pointerEvents: 'none', style: styles.hidden },
    React.createElement(WebView, {
      ref: webRef,
      source: { html, baseUrl: 'https://zharph.app/' },
      originWhitelist: ['*'],
      javaScriptEnabled: true,
      domStorageEnabled: true,
      cacheEnabled: true,
      cacheMode: 'LOAD_CACHE_ELSE_NETWORK', // runtime library + wasm come from the on-device HTTP cache once fetched
      onMessage: handleMessage,
      onError: () => cb.current.onError && cb.current.onError('The analysis engine could not start'),
      onRenderProcessGone: () => {
        ready.current = false; // the page is gone: models are lost, the WebView boots again below
        busy.current = false;
        inflight.current = null;
        lastJob.current = null;
        cb.current.onError && cb.current.onError('The analysis engine ran out of memory');
        try { webRef.current && webRef.current.reload(); } catch (e) {}
      },
      style: styles.web,
    }),
  );
}

const styles = StyleSheet.create({
  hidden: { position: 'absolute', left: 0, bottom: 0, width: 2, height: 2, opacity: 0, overflow: 'hidden' },
  web: { width: 2, height: 2 },
});
