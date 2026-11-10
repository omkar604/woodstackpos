#!/usr/bin/env node
/*
 * Woodstack POS server.
 * Node's built-in HTTP server and SQLite; no outside packages.
 *
 *   node server.js                       start the server (PORT, default 8080)
 *   node server.js add-user NAME LOGIN PASSWORD ROLE
 *                                        create or reset a staff login (roles: owner, manager, cashier, viewer)
 *   node server.js import FILE.json      load documents from a seed or export file
 *   node server.js backup                write a backup copy now
 *
 * Data lives in ./data (or DATA_DIR): pos.db plus nightly copies in data/backups.
 */
"use strict";
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");

const ROOT = __dirname;
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, "data"));
const PUBLIC_DIR = path.join(ROOT, "public");
const PORT = +process.env.PORT || 8080;
const HOST = process.env.HOST || "127.0.0.1";
const KEEP_BACKUPS = +process.env.KEEP_BACKUPS || 30;
const SESSION_DAYS = 30;
const MAX_BODY = 4 * 1024 * 1024;
const ROLES = { viewer: 0, cashier: 1, manager: 2, owner: 3 };
const APPROVAL_MINUTES = 15;
const VERSION = "2026.11.06-6 (quick buttons and new design; alerts name the store, item, user and who is on the clock; store credit; customer types; time clock; schedule; report builder)";

fs.mkdirSync(path.join(DATA_DIR, "backups"), { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, "pos.db"));
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS docs (
    path TEXT PRIMARY KEY, coll TEXT NOT NULL, id TEXT NOT NULL,
    data TEXT NOT NULL, version INTEGER NOT NULL, updated TEXT NOT NULL, updated_by TEXT
  );
  CREATE INDEX IF NOT EXISTS docs_coll ON docs(coll);
  CREATE INDEX IF NOT EXISTS docs_sales_date ON docs(coll, json_extract(data, '$.date'));
  CREATE INDEX IF NOT EXISTS docs_order_status ON docs(coll, json_extract(data, '$.st'));
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, login TEXT NOT NULL UNIQUE COLLATE NOCASE,
    salt TEXT NOT NULL, hash TEXT NOT NULL, role TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1,
    created TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
`);
try { db.exec("ALTER TABLE users ADD COLUMN disc REAL"); } catch { /* already there */ }

/* ---------- small helpers ---------- */
const now = () => new Date().toISOString();
const newId = (n = 12) => crypto.randomBytes(n).toString("base64url");
const r2 = x => Math.round((+x || 0) * 100) / 100;
const SEG = /^[A-Za-z0-9_\-.~:@+]{1,200}$/;
function splitPath(p) {
  if (typeof p !== "string") throw bad("Path must be text");
  const segs = p.split("/");
  if (segs.length < 2 || segs.length % 2 || segs.length > 16 || segs.some(s => !SEG.test(s) || s === "." || s === "..")) throw bad("Bad document path: " + p);
  return { coll: segs.slice(0, -1).join("/"), id: segs[segs.length - 1] };
}
function checkColl(c) {
  const segs = String(c).split("/");
  if (segs.length % 2 === 0 || segs.length > 15 || segs.some(s => !SEG.test(s) || s === "." || s === "..")) throw bad("Bad collection path: " + c);
  return c;
}
function bad(message, status = 400, code = "invalid_argument") { const e = new Error(message); e.status = status; e.code = code; return e; }
const isObj = v => v && typeof v === "object" && !Array.isArray(v);
const metaGet = (k, d = null) => { const v = db.prepare("SELECT v FROM meta WHERE k = ?").get(k)?.v; return v == null ? d : JSON.parse(v); };
const metaSet = (k, v) => db.prepare("INSERT INTO meta (k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").run(k, JSON.stringify(v));
const SECRET = metaGet("secret") || (() => { const s = newId(32); metaSet("secret", s); return s; })();

/* Merge `patch` into `base`. Objects merge, everything else replaces.
   Special values: {__delete:true} removes the field, {__inc:n} adds to a number,
   {__push:x} appends to an array. */
function merge(base, patch) {
  const out = isObj(base) ? { ...base } : {};
  for (const [k, v] of Object.entries(patch)) {
    if (isObj(v) && v.__delete === true) { delete out[k]; continue; }
    if (isObj(v) && "__inc" in v) { out[k] = r2((typeof out[k] === "number" ? out[k] : 0) + (+v.__inc || 0)); continue; }
    if (isObj(v) && "__push" in v) { out[k] = [...(Array.isArray(out[k]) ? out[k] : []), v.__push]; continue; }
    out[k] = isObj(v) ? merge(out[k], v) : v;
  }
  return out;
}
function stripOps(v) { // a plain "set" may not carry merge operators
  if (Array.isArray(v)) return v.map(stripOps);
  if (!isObj(v)) return v;
  if ("__inc" in v) return +v.__inc || 0;
  if ("__push" in v) return [v.__push];
  const o = {}; for (const [k, x] of Object.entries(v)) if (!(isObj(x) && x.__delete)) o[k] = stripOps(x); return o;
}

/* ---------- passwords and sessions ---------- */
function hashPw(pw, salt) { return crypto.scryptSync(String(pw), salt, 64).toString("hex"); }
function checkPw(u, pw) { return u && u.active && crypto.timingSafeEqual(Buffer.from(hashPw(pw || "", u.salt), "hex"), Buffer.from(u.hash, "hex")); }
function upsertUser({ id, name, login, password, role, active = 1, disc }) {
  if (!ROLES.hasOwnProperty(role)) throw bad("Role must be owner, manager, cashier or viewer");
  if (!name || !login) throw bad("Name and login are required");
  const existing = db.prepare("SELECT * FROM users WHERE id = ? OR login = ?").get(id || "", login);
  if (existing) {
    if (password) { const salt = newId(16); db.prepare("UPDATE users SET name=?, login=?, role=?, active=?, salt=?, hash=? WHERE id=?").run(name, login, role, active ? 1 : 0, salt, hashPw(password, salt), existing.id); db.prepare("DELETE FROM sessions WHERE user_id=?").run(existing.id); }
    else db.prepare("UPDATE users SET name=?, login=?, role=?, active=? WHERE id=?").run(name, login, role, active ? 1 : 0, existing.id);
    if (!active) db.prepare("DELETE FROM sessions WHERE user_id=?").run(existing.id);
    if (disc !== undefined) db.prepare("UPDATE users SET disc=? WHERE id=?").run(disc, existing.id);
    return existing.id;
  }
  if (!password || String(password).length < 4) throw bad("Password must be at least 4 characters");
  const uid = "u_" + newId(11), salt = newId(16);
  db.prepare("INSERT INTO users (id,name,login,salt,hash,role,active,created,disc) VALUES (?,?,?,?,?,?,?,?,?)").run(uid, name, login, salt, hashPw(password, salt), role, active ? 1 : 0, now(), disc ?? null);
  return uid;
}
/* Discount limits: a preset per role (owner sets them), overridden by an individual limit per person. Owners are unlimited. */
const DEFAULT_LIMITS = { viewer: 0, cashier: 10, manager: 30 };
function roleLimits() { return { ...DEFAULT_LIMITS, ...(readJSON("config/discounts")?.roles || {}) }; }
function limitFor(u) {
  if (!u) return 0;
  if (u.role === "owner") return 100;
  if (u.disc != null && u.disc !== "") return Math.max(0, Math.min(100, +u.disc));
  return Math.max(0, Math.min(100, +roleLimits()[u.role] || 0));
}
const publicUser = u => u && { id: u.id, name: u.name, login: u.login, role: u.role, active: !!u.active, disc: u.disc ?? null, limit: limitFor(u) };
function cookies(req) { const o = {}; for (const part of (req.headers.cookie || "").split(";")) { const i = part.indexOf("="); if (i > 0) o[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } return o; }
function sessionUser(req) {
  const t = cookies(req).ws_sess; if (!t) return null;
  const row = db.prepare("SELECT u.*, s.expires FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?").get(t);
  if (!row || row.expires < Date.now() || !row.active) return null;
  if (row.expires - Date.now() < (SESSION_DAYS - 1) * 864e5) db.prepare("UPDATE sessions SET expires=? WHERE token=?").run(Date.now() + SESSION_DAYS * 864e5, t);
  return row;
}
const secure = req => process.env.SECURE_COOKIES === "1" || req.headers["x-forwarded-proto"] === "https";
const fails = new Map(); // ip -> [timestamps]
function tooMany(ip) { const t = (fails.get(ip) || []).filter(x => Date.now() - x < 15 * 60e3); fails.set(ip, t); return t.length >= 10; }
function noteFail(ip) { (fails.get(ip) || fails.set(ip, []).get(ip)).push(Date.now()); }

/* ---------- approval codes: a colleague with a high enough limit (or an owner, for Gold SKUs) signs off ---------- */
function makeApproval(approverId) {
  const payload = Buffer.from(JSON.stringify({ by: approverId, exp: Date.now() + APPROVAL_MINUTES * 60e3, n: newId(6) })).toString("base64url");
  return payload + "." + crypto.createHmac("sha256", SECRET).update(payload).digest("base64url");
}
function readApproval(token) {
  if (typeof token !== "string" || !token.includes(".")) return null;
  const [payload, sig] = token.split(".");
  const want = crypto.createHmac("sha256", SECRET).update(payload).digest("base64url");
  if (sig.length !== want.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return null;
  try {
    const p = JSON.parse(Buffer.from(payload, "base64url").toString());
    const u = db.prepare("SELECT * FROM users WHERE id = ?").get(p.by);
    return p.exp > Date.now() && u?.active ? u : null;
  } catch { return null; }
}

/* ---------- catalog index (kept in memory, updated as catalog documents change) ---------- */
const catalog = { bySku: new Map(), chunkSkus: new Map() };
function indexChunk(chunkId, body) {
  for (const sku of catalog.chunkSkus.get(chunkId) || []) if (catalog.bySku.get(sku)?.chunk === chunkId) catalog.bySku.delete(sku);
  const skus = [];
  for (const [fid, f] of Object.entries(body?.fams || {})) {
    if (!isObj(f)) continue;
    for (const [sku, v] of Object.entries(f.v || {})) {
      if (!isObj(v)) continue;
      catalog.bySku.set(sku, { sku, fid, chunk: chunkId, gold: !!f.gold, archived: !!(f.x || v.x), name: f.n || "", opt: v.o || "", pr: +(v.pr ?? f.pr ?? 0), c: +(v.c ?? f.c ?? 0), st: v.st || {} });
      skus.push(sku);
    }
  }
  catalog.chunkSkus.set(chunkId, skus);
}
function loadCatalog() {
  catalog.bySku.clear(); catalog.chunkSkus.clear();
  for (const r of db.prepare("SELECT id, data FROM docs WHERE coll = 'catalog'").all()) indexChunk(r.id, JSON.parse(r.data));
}
const goldInBody = body => { const m = new Map(); for (const f of Object.values(body?.fams || {})) if (isObj(f)) for (const sku of Object.keys(f.v || {})) m.set(sku, !!f.gold); return m; };

/* ---------- access rules ----------
   viewer: read only. cashier: sales, customers, registers, transfers, counts (incl. RFID), stock levels, picking.
   manager: also products, prices and settings. owner: also Gold SKUs, staff managers, backups, Shopify. */
function canWrite(user, coll, op, data) {
  const lvl = ROLES[user.role] ?? -1;
  if (lvl >= ROLES.manager) return true;
  if (lvl < ROLES.cashier) return false;
  const top = coll.split("/")[0];
  if (["sales", "customers", "registers", "transfers", "closures", "adjustments", "rfid", "counts"].includes(top)) return true;
  if (top === "catalog" && op === "update") return onlyStock(data);
  if (top === "orders" && (op === "update" || op === "merge")) return isObj(data) && Object.keys(data).every(k => ["picked", "st", "loc", "pickNote", "pickBy", "pickAt"].includes(k)) && (data.st === undefined || ["new", "picking"].includes(data.st));
  return false;
}
function onlyStock(data) { // fams.<fid>.v.<sku>.st.<outlet> = number | {__inc}
  if (!isObj(data) || Object.keys(data).some(k => k !== "fams") || !isObj(data.fams)) return false;
  for (const fam of Object.values(data.fams)) {
    if (!isObj(fam) || Object.keys(fam).some(k => k !== "v") || !isObj(fam.v)) return false;
    for (const v of Object.values(fam.v)) {
      if (!isObj(v) || Object.keys(v).some(k => k !== "st") || !isObj(v.st)) return false;
      for (const n of Object.values(v.st)) if (!(typeof n === "number" || (isObj(n) && Object.keys(n).join() === "__inc" && typeof n.__inc === "number"))) return false;
    }
  }
  return true;
}
/* Every new sale line is checked: how far below the catalog price was it sold?
   Gold SKUs: any discount needs an owner. Everything else: up to the seller's limit, or an approval from someone whose limit covers it. */
function checkSaleLines(sale, user) {
  if (user.role === "owner" || !isObj(sale) || !Array.isArray(sale.lines)) return;
  const mine = limitFor(user);
  for (const l of sale.lines) {
    if (!(l.q > 0)) continue;
    const c = catalog.bySku.get(String(l.sku));
    const base = Math.max(+l.p || 0, c ? c.pr : 0);
    const full = r2(base * l.q); if (full <= 0) continue;
    const pct = Math.max(0, (1 - (+l.net || 0) / full) * 100);
    if (pct < 0.05) continue;
    const appr = readApproval(l.ap);
    const what = c ? `${c.name} ${c.opt}`.trim() : String(l.n || l.sku);
    if (c?.gold) { if (appr?.role !== "owner") throw bad(`${what} is a Gold SKU. Only an owner can discount it.`, 403); continue; }
    if (pct <= mine + 0.05) continue;
    if (appr && limitFor(appr) + 0.05 >= pct) continue;
    throw bad(`${Math.round(pct)}% off ${what} is over your ${mine}% discount limit. Ask a manager or owner to approve it.`, 403);
  }
}
function checkSalesDoc(oldBody, newBody, user) {
  if (user.role === "owner") return;
  const before = new Map((oldBody?.sales || []).map(s => [s.id, JSON.stringify(s.lines)]));
  for (const s of newBody?.sales || []) {
    if (!before.has(s.id)) { if (s.imp && ROLES[user.role] < ROLES.manager) throw bad("Only managers and owners can import sales.", 403); if (!s.imp) checkSaleLines(s, user); }
    else if (before.get(s.id) !== JSON.stringify(s.lines)) throw bad("Completed sales can’t be edited. Void it or do a return.", 403);
  }
}
function checkCatalogDoc(newBody, user) {
  if (user.role === "owner") return;
  for (const [sku, gold] of goldInBody(newBody)) {
    if (gold !== !!catalog.bySku.get(sku)?.gold) throw bad("Only an owner can mark or unmark Gold SKUs.", 403);
  }
  for (const f of Object.values(newBody?.fams || {})) {
    if (!isObj(f)) continue;
    for (const [sku, v] of Object.entries(f.v || {})) {
      const was = catalog.bySku.get(sku);
      if (was?.gold && Math.abs(+(v?.pr ?? f.pr ?? 0) - was.pr) > 0.005) throw bad(`Only an owner can change the price of a Gold SKU (${was.name}).`, 403);
    }
  }
}

/* ---------- store credit ----------
   A customer's balance lives on their customer record (credit). Every change also writes a ledger entry in "credit".
   Paying with store credit takes from the balance; refunding to store credit adds to it; voiding a sale puts it back.
   Nobody can change a balance directly; only sales and the Issue store credit button do. */
const isCredit = t => /store\s*credit/i.test(String(t || ""));
function creditDeltas(oldBody, newBody) {
  const before = new Map((oldBody?.sales || []).map(x => [x.id, x]));
  const out = new Map();
  const add = (cust, amt, type, sale) => { if (!cust) throw bad("Attach a customer to the sale to use store credit."); const e = out.get(cust) || out.set(cust, { delta: 0, entries: [] }).get(cust); e.delta = r2(e.delta + amt); e.entries.push({ amt: r2(amt), type, sale: sale.no, oi: sale.oi }); };
  for (const x of newBody?.sales || []) {
    if (x.imp) continue;
    const used = r2((x.pays || []).filter(p => isCredit(p.t)).reduce((a, p) => a + (+p.a || 0), 0));
    const was = before.get(x.id);
    if (!was && used) add(x.cust, -used, used > 0 ? "Paid with credit" : "Refund to credit", x);
    if (was && was.st !== "void" && x.st === "void" && used) add(x.cust, used, "Sale voided", x);
  }
  return out;
}
function applyCreditInTx(cust, delta, entries, actor, results) {
  const path = "customers/" + cust; splitPath(path);
  const cur = getDoc.get(path); if (!cur) throw bad("That customer no longer exists.");
  const c = JSON.parse(cur.data), bal = r2((+c.credit || 0) + delta);
  if (bal < -0.005) throw bad(`${c.name} has only ${"$" + r2(+c.credit || 0).toFixed(2)} in store credit.`);
  const body = { ...c, credit: bal };
  putDoc.run(path, "customers", cust, JSON.stringify(body), cur.version + 1, now(), actor);
  results.push({ path, coll: "customers", id: cust, exists: true, data: body, version: cur.version + 1, old: c });
  let running = r2(+c.credit || 0);
  for (const e of entries) {
    running = r2(running + e.amt);
    const id = newId(10), doc = { cust, ...e, bal: running, by: actor, at: now() };
    putDoc.run("credit/" + id, "credit", id, JSON.stringify(doc), 1, now(), actor);
    results.push({ path: "credit/" + id, coll: "credit", id, exists: true, data: doc, version: 1, old: null });
  }
}
function issueCredit({ cust, amount, reason, mode }, user) {
  if (ROLES[user.role] < ROLES.manager) throw bad("Only managers and owners can issue store credit.", 403);
  const c = readJSON("customers/" + cust); if (!c) throw bad("Choose a customer.");
  const why = String(reason || "").trim().slice(0, 200); if (!why) throw bad("Give a reason; it’s kept in the customer’s credit history.");
  const target = mode === "set" ? r2(+amount) : null;
  const delta = mode === "set" ? r2(target - (+c.credit || 0)) : r2(+amount);
  if (!Number.isFinite(delta)) throw bad("Enter an amount.");
  if (!delta) return { balance: r2(+c.credit || 0), unchanged: true };
  const results = [];
  db.exec("BEGIN IMMEDIATE");
  try { applyCreditInTx(cust, delta, [{ amt: delta, type: mode === "set" ? "Balance set" : delta > 0 ? "Issued" : "Removed", note: why }], user.id, results); db.exec("COMMIT"); }
  catch (e) { db.exec("ROLLBACK"); throw e; }
  for (const r of results) { const { old, ...pub } = r; broadcast(pub); }
  return { balance: results[0].data.credit };
}

/* ---------- documents ---------- */
const getDoc = db.prepare("SELECT data, version FROM docs WHERE path = ?");
const putDoc = db.prepare("INSERT INTO docs (path,coll,id,data,version,updated,updated_by) VALUES (?,?,?,?,?,?,?) ON CONFLICT(path) DO UPDATE SET data=excluded.data, version=excluded.version, updated=excluded.updated, updated_by=excluded.updated_by");
const delDoc = db.prepare("DELETE FROM docs WHERE path = ?");
const shape = (p, row) => { const { coll, id } = splitPath(p); return row ? { path: p, coll, id, exists: true, data: JSON.parse(row.data), version: row.version } : { path: p, coll, id, exists: false, data: null, version: 0 }; };
const readJSON = p => { const r = getDoc.get(p); return r ? JSON.parse(r.data) : null; };
const hooks = { afterWrite: [] };

/* user = null means a trusted internal write (Shopify sync, order packing). */
function applyWrites(ops, user, by) {
  if (!Array.isArray(ops) || !ops.length || ops.length > 200) throw bad("Send between 1 and 200 writes");
  const results = [];
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const w of ops) {
      const { coll, id } = splitPath(w.path);
      if (!["set", "update", "merge", "delete"].includes(w.op)) throw bad("Unknown write: " + w.op);
      if (w.op !== "delete" && !isObj(w.data)) throw bad("Document body must be an object");
      if (user && !canWrite(user, coll, w.op, w.data)) throw bad("Your role can’t change " + coll, 403);
      const cur = getDoc.get(w.path);
      const oldBody = cur ? JSON.parse(cur.data) : null;
      if (w.op === "delete") {
        if (user && coll === "catalog" && user.role !== "owner" && [...goldInBody(oldBody).values()].some(Boolean)) throw bad("Only an owner can remove Gold SKUs.", 403);
        delDoc.run(w.path); results.push({ path: w.path, coll, id, exists: false, data: null, version: (cur?.version || 0) + 1, old: oldBody }); continue;
      }
      if (w.op === "update" && !cur) throw bad("No document at " + w.path + " to update");
      const body = w.op === "set" ? stripOps(w.data) : merge(oldBody || {}, w.data);
      if (user && w.path === "config/discounts" && user.role !== "owner") throw bad("Only an owner can change discount limits.", 403);
      if (user && coll === "sales") checkSalesDoc(oldBody, body, user);
      if (user && coll === "credit") throw bad("Store credit changes go through sales or the Issue store credit button.", 403);
      if (user && coll === "customers" && r2(+body.credit || 0) !== r2(+oldBody?.credit || 0)) throw bad("Store credit can only change through a sale or Issue store credit.", 403);
      const creditFx = coll === "sales" ? creditDeltas(oldBody, body) : null;
      if (user && coll === "catalog") checkCatalogDoc(body, user);
      const text = JSON.stringify(body);
      if (text.length > 8 * 1024 * 1024) throw bad("Document too large");
      const version = (cur?.version || 0) + 1;
      putDoc.run(w.path, coll, id, text, version, now(), user ? user.id : (by || "system"));
      if (coll === "catalog") indexChunk(id, body);
      results.push({ path: w.path, coll, id, exists: true, data: body, version, old: oldBody });
      if (creftFxSize(creditFx)) for (const [cust, e] of creditFx) applyCreditInTx(cust, e.delta, e.entries, user ? user.id : (by || "system"), results);
    }
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); if (ops.some(w => w.path?.startsWith("catalog/"))) loadCatalog(); throw e; }
  for (const r of results) { if (r.coll === "catalog" && !r.exists) indexChunk(r.id, null); }
  for (const h of hooks.afterWrite) { try { h(results, user ? user.id : by); } catch (e) { console.error(e); } }
  for (const r of results) { const { old, ...pub } = r; broadcast(pub); }
  return results.map(({ old, ...pub }) => pub);
}

const creftFxSize = m => m && m.size;
const FIELD = /^[A-Za-z0-9_]{1,64}$/;
const OPS = { "==": "=", "!=": "!=", "<": "<", "<=": "<=", ">": ">", ">=": ">=" };
const sqlVal = v => (v === true ? 1 : v === false ? 0 : v);
function runQuery({ coll, where = [], orderBy = null, dir = "asc", limit = 0 }) {
  checkColl(coll);
  const sql = ["SELECT path, data, version FROM docs WHERE coll = ?"], args = [coll];
  if (!Array.isArray(where) || where.length > 10) throw bad("Up to 10 filters");
  for (const [f, op, v] of where) {
    if (!FIELD.test(f)) throw bad("Filters work on top-level fields only");
    const x = `json_extract(data, '$.${f}')`;
    if (OPS[op]) { sql.push(`AND ${x} ${OPS[op]} ?`); args.push(sqlVal(v)); }
    else if (op === "in" || op === "not-in") { if (!Array.isArray(v) || !v.length || v.length > 30) throw bad("in needs 1-30 values"); sql.push(`AND ${x} ${op === "in" ? "IN" : "NOT IN"} (${v.map(() => "?").join(",")})`); args.push(...v.map(sqlVal)); }
    else if (op === "array-contains") { sql.push(`AND EXISTS (SELECT 1 FROM json_each(data, '$.${f}') WHERE value = ?)`); args.push(sqlVal(v)); }
    else throw bad("Unknown filter operator " + op);
  }
  if (orderBy) { if (!FIELD.test(orderBy)) throw bad("Bad sort field"); sql.push(`ORDER BY json_extract(data, '$.${orderBy}') IS NULL, json_extract(data, '$.${orderBy}') ${dir === "desc" ? "DESC" : "ASC"}`); }
  else sql.push("ORDER BY id");
  if (limit) { sql.push("LIMIT ?"); args.push(Math.min(1000, Math.max(1, +limit))); }
  return db.prepare(sql.join(" ")).all(...args).map(r => shape(r.path, r));
}

/* ---------- live updates (Server-Sent Events) ---------- */
const clients = new Set();
function broadcast(doc) {
  const msg = `event: doc\ndata: ${JSON.stringify(doc)}\n\n`;
  for (const res of clients) res.write(msg);
}
setInterval(() => { for (const res of clients) res.write(": ping\n\n"); }, 25000).unref();

/* ---------- online orders: pack and ship ---------- */
function stockOps(lines, loc, sign) {
  const per = {};
  for (const l of lines) {
    const c = catalog.bySku.get(String(l.sku)); if (!c || !(l.q > 0)) continue;
    const fam = ((per[c.chunk] ??= {})[c.fid] ??= { v: {} });
    const cur = fam.v[c.sku]?.st?.[loc]?.__inc || 0;
    fam.v[c.sku] = { st: { [loc]: { __inc: cur + sign * l.q } } };
  }
  return Object.entries(per).map(([chunk, fams]) => ({ op: "update", path: "catalog/" + chunk, data: { fams } }));
}
function orderAction(id, action, body, user) {
  const p = "orders/" + id; splitPath(p);
  const o = readJSON(p); if (!o) throw bad("That order isn’t in the POS.", 404);
  const lvl = ROLES[user.role];
  const by = user.id, at = now();
  if (action === "pack") {
    if (lvl < ROLES.cashier) throw bad("Your role can’t pack orders.", 403);
    if (!["new", "picking"].includes(o.st)) throw bad("This order is already " + o.st + ".");
    const loc = Number.isInteger(body.loc) ? body.loc : o.loc;
    if (!Number.isInteger(loc)) throw bad("Choose which location this order ships from.");
    const lines = o.lines.filter(l => l.q > 0);
    const short = lines.filter(l => (o.picked?.[l.id] || 0) < l.q);
    if (short.length && !body.force) throw bad("Not every item has been scanned yet.");
    if (short.length && lvl < ROLES.manager) throw bad("Only a manager can pack an order without scanning every item.", 403);
    return applyWrites([...stockOps(lines.filter(l => l.sku), loc, -1), { op: "merge", path: p, data: { st: "packed", loc, packedAt: at, packedBy: by, boxes: +body.boxes || 1, weight: body.weight || "" } }], null, by);
  }
  if (action === "unpack") {
    if (lvl < ROLES.manager) throw bad("Ask a manager to unpack an order.", 403);
    if (o.st !== "packed") throw bad("Only packed orders can be unpacked.");
    return applyWrites([...stockOps(o.lines.filter(l => l.sku), o.loc, +1), { op: "merge", path: p, data: { st: "picking", packedAt: { __delete: true } } }], null, by);
  }
  if (action === "cancel") {
    if (lvl < ROLES.manager) throw bad("Ask a manager to cancel an order here.", 403);
    const ops = o.st === "packed" ? stockOps(o.lines.filter(l => l.sku), o.loc, +1) : [];
    return applyWrites([...ops, { op: "merge", path: p, data: { st: "cancelled", cancelledAt: at, cancelledBy: by } }], null, by);
  }
  throw bad("Unknown order action");
}

/* ---------- backups ---------- */
function backupNow(label) {
  const file = path.join(DATA_DIR, "backups", `pos-${label || new Date().toISOString().slice(0, 10)}.db`);
  try { fs.unlinkSync(file); } catch {}
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  const all = fs.readdirSync(path.join(DATA_DIR, "backups")).filter(f => /^pos-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort();
  for (const f of all.slice(0, Math.max(0, all.length - KEEP_BACKUPS))) fs.unlinkSync(path.join(DATA_DIR, "backups", f));
  metaSet("last_backup", now());
  return file;
}
function nightly() {
  const today = new Date().toISOString().slice(0, 10);
  if (metaGet("last_backup")?.slice(0, 10) !== today) { try { backupNow(); console.log("Backup written for", today); } catch (e) { console.error("Backup failed:", e.message); } }
}

/* ---------- seed / import ---------- */
function importFile(file) {
  const j = JSON.parse(fs.readFileSync(file, "utf8"));
  const docs = j.docs || j;
  db.exec("BEGIN");
  let n = 0;
  for (const [p, body] of Object.entries(docs)) { const { coll, id } = splitPath(p); const cur = getDoc.get(p); putDoc.run(p, coll, id, JSON.stringify(body), (cur?.version || 0) + 1, now(), "import"); n++; }
  db.exec("COMMIT");
  loadCatalog();
  return n;
}

/* ---------- staff ---------- */
function saveStaff(b, user) {
  const lvl = ROLES[user.role];
  const target = b.id ? db.prepare("SELECT * FROM users WHERE id = ?").get(b.id) : null;
  const role = String(b.role || target?.role || "cashier").toLowerCase();
  if (!ROLES.hasOwnProperty(role)) throw bad("Role must be owner, manager, cashier or viewer.");
  if (ROLES[role] >= ROLES.manager && lvl < ROLES.owner) throw bad("Only an owner can create or change managers and owners.", 403);
  if (target && ROLES[target.role] >= ROLES.manager && lvl < ROLES.owner) throw bad("Only an owner can change a manager or owner.", 403);
  const active = b.active !== false;
  if (target && target.id === user.id && (role !== user.role || !active)) throw bad("You can’t change your own role or turn off your own login.");
  if (target?.role === "owner" && (role !== "owner" || !active) && db.prepare("SELECT COUNT(*) n FROM users WHERE role='owner' AND active=1").get().n <= 1) throw bad("Keep at least one active owner.");
  let disc;
  if (b.disc !== undefined) {
    disc = b.disc === null || b.disc === "" ? null : Math.max(0, Math.min(100, +b.disc));
    if (disc !== null && Number.isNaN(disc)) throw bad("Discount limit must be a number from 0 to 100.");
    if (target?.id === user.id && lvl < ROLES.owner && disc !== (target.disc ?? null)) throw bad("You can’t change your own discount limit.", 403);
    if (lvl < ROLES.owner && disc !== null && disc > limitFor(user)) throw bad(`You can only give limits up to your own ${limitFor(user)}%.`, 403);
  }
  const id = upsertUser({ id: b.id, name: String(b.name || target?.name || "").trim(), login: String(b.login || target?.login || "").trim(), password: b.password || "", role, active, disc });
  return publicUser(db.prepare("SELECT * FROM users WHERE id = ?").get(id));
}

/* ---------- sales history import ---------- */
function importSales({ sales, deduct = false }, user) {
  if (!Array.isArray(sales) || !sales.length || sales.length > 5000) throw bad("Send between 1 and 5,000 sales at a time.");
  const outs = readJSON("config/main")?.outlets || [];
  const byDoc = new Map(); let skipped = 0;
  for (const s of sales) {
    if (!isObj(s) || !Array.isArray(s.lines) || !s.lines.length || !/^\d{4}-\d{2}-\d{2}T/.test(String(s.t)) || !outs[s.oi]) throw bad("Every sale needs a date, an outlet and at least one line.");
    const date = s.t.slice(0, 10), path = `sales/${date}_imp${s.oi}`;
    (byDoc.get(path) || byDoc.set(path, { date, oi: s.oi, list: [] }).get(path)).list.push(s);
  }
  const ops = [], stock = [];
  for (const [path, g] of byDoc) {
    const have = new Set((readJSON(path)?.sales || []).map(x => x.no));
    for (const s of g.list) {
      if (have.has(s.no)) { skipped++; continue; } have.add(s.no);
      const lines = s.lines.map(l => { const c = catalog.bySku.get(String(l.sku)); return { sku: String(l.sku || ""), fid: c?.fid, n: String(l.n || c?.name || l.sku || "Item").slice(0, 200), o: String(l.o || c?.opt || ""), q: +l.q || 1, p: r2(l.p), d: 0, net: r2(l.net), tax: r2(l.tax), c: c ? r2(c.c) : 0, b: String(l.b || "") }; });
      const sub = r2(lines.reduce((a, l) => a + l.net, 0)), tax = r2(lines.reduce((a, l) => a + l.tax, 0));
      const pays = Array.isArray(s.pays) && s.pays.length ? s.pays.map(p => ({ t: String(p.t || "Imported"), a: r2(p.a) })) : [{ t: "Imported", a: r2(sub + tax) }];
      const sale = { id: "imp_" + newId(8), no: String(s.no).slice(0, 60), t: s.t, oi: s.oi, ri: -1, imp: true, lines, sub, tax, tot: r2(sub + tax), cost: r2(lines.reduce((a, l) => a + l.c * l.q, 0)), items: lines.reduce((a, l) => a + l.q, 0), disc: 0, pays, change: 0, cust: s.cust || null, by: user.id, note: "Imported", st: "done" };
      ops.push({ op: "merge", path, data: { date: g.date, oi: g.oi, ri: -1, sales: { __push: sale } } });
      if (deduct) for (const l of lines) if (catalog.bySku.has(l.sku)) stock.push({ sku: l.sku, q: l.q, oi: s.oi });
    }
  }
  for (let i = 0; i < ops.length; i += 150) applyWrites(ops.slice(i, i + 150), null, user.id);
  if (stock.length) {
    const per = {};
    for (const x of stock) { const c = catalog.bySku.get(x.sku); const fam = ((per[c.chunk] ??= {})[c.fid] ??= { v: {} }); const cur = fam.v[x.sku]?.st?.[x.oi]?.__inc || 0; fam.v[x.sku] = { st: { ...(fam.v[x.sku]?.st || {}), [x.oi]: { __inc: cur - x.q } } }; }
    applyWrites(Object.entries(per).map(([chunk, fams]) => ({ op: "update", path: "catalog/" + chunk, data: { fams } })), null, user.id);
  }
  return { imported: ops.length, skipped };
}

/* ---------- Shopify ---------- */
const shopify = require("./shopify.js")({ db, metaGet, metaSet, readJSON, applyWrites, runQuery, catalog, hooks, bad, r2, now });
const alerts = require("./alerts.js")({ db, metaGet, metaSet, readJSON, runQuery, catalog, hooks, bad, now });
const reports = require("./reports.js")({ db, runQuery, readJSON, catalog, bad });

/* ---------- time clock: staff type their own login on any register ---------- */
function clockState(u) {
  const open = runQuery({ coll: "punches", where: [["uid", "==", u.id], ["open", "==", true]] })[0];
  if (!open) return { name: u.name, state: "out" };
  const brk = (open.data.breaks || []).find(b => !b.e);
  return { name: u.name, state: brk ? "break" : "in", since: brk ? brk.s : open.data.in, clockedIn: open.data.in, oi: open.data.oi, id: open.id };
}
function clockAction(b, sessionU) {
  let u = sessionU;
  if (b.login) {
    const o = db.prepare("SELECT * FROM users WHERE login = ?").get(String(b.login).trim());
    if (!checkPw(o, b.password)) throw bad("That login and password don’t match.", 403);
    u = o;
  }
  const st = clockState(u), at = now(), outs = readJSON("config/main")?.outlets || [];
  const done = () => ({ ...clockState(u), at });
  switch (b.action) {
    case "status": return st;
    case "in": {
      if (st.state !== "out") throw bad(`${u.name} is already clocked in at ${outs[st.oi]?.name || "a store"}.`);
      if (!outs[b.oi]) throw bad("Choose the store you’re working at.");
      applyWrites([{ op: "set", path: "punches/" + newId(10), data: { uid: u.id, oi: b.oi, date: reports.when(at).date, in: at, out: null, open: true, breaks: [] } }], null, u.id);
      return done();
    }
    case "break": {
      if (st.state !== "in") throw bad(st.state === "break" ? `${u.name} is already on a break.` : `${u.name} isn’t clocked in.`);
      const p = readJSON("punches/" + st.id);
      applyWrites([{ op: "update", path: "punches/" + st.id, data: { breaks: [...(p.breaks || []), { s: at }] } }], null, u.id); return done();
    }
    case "resume": {
      if (st.state !== "break") throw bad(`${u.name} isn’t on a break.`);
      const p = readJSON("punches/" + st.id);
      applyWrites([{ op: "update", path: "punches/" + st.id, data: { breaks: p.breaks.map(x => x.e ? x : { ...x, e: at }) } }], null, u.id); return done();
    }
    case "out": {
      if (st.state === "out") throw bad(`${u.name} isn’t clocked in.`);
      const p = readJSON("punches/" + st.id);
      applyWrites([{ op: "update", path: "punches/" + st.id, data: { out: at, open: false, breaks: (p.breaks || []).map(x => x.e ? x : { ...x, e: at }) } }], null, u.id); return done();
    }
  }
  throw bad("Unknown time clock action");
}

/* ---------- HTTP ---------- */
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".woff2": "font/woff2" };
const SEC_HEADERS = {
  "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY", "Referrer-Policy": "same-origin",
  "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'"
};
function send(res, status, body, headers = {}) {
  const isJson = typeof body !== "string" && !Buffer.isBuffer(body);
  res.writeHead(status, { ...SEC_HEADERS, "Cache-Control": "no-store", "Content-Type": isJson ? "application/json" : "text/plain; charset=utf-8", ...headers });
  res.end(isJson ? JSON.stringify(body) : body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", c => { size += c.length; if (size > MAX_BODY) { reject(bad("Request too large", 413)); req.destroy(); } else chunks.push(c); });
    req.on("end", () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}); } catch { reject(bad("Body is not valid JSON")); } });
    req.on("error", reject);
  });
}
function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname); if (rel === "/" || rel === "") rel = "/index.html";
  const file = path.join(PUBLIC_DIR, path.normalize(rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, "Forbidden");
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, "Not found");
    res.writeHead(200, { ...SEC_HEADERS, "Content-Type": TYPES[path.extname(file)] || "application/octet-stream", "Cache-Control": rel === "/index.html" ? "no-cache" : "public, max-age=300" });
    res.end(buf);
  });
}

async function api(req, res, url) {
  const p = url.pathname, m = req.method;
  const ip = req.headers["x-forwarded-for"]?.split(",")[0].trim() || req.socket.remoteAddress;
  if (m !== "GET" && req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) return send(res, 403, { error: "Cross-site request blocked" });

  if (p === "/api/login" && m === "POST") {
    if (tooMany(ip)) return send(res, 429, { error: "Too many attempts. Wait 15 minutes and try again." });
    const { login, password } = await readBody(req);
    const u = db.prepare("SELECT * FROM users WHERE login = ?").get(String(login || "").trim());
    if (!checkPw(u, password)) { noteFail(ip); return send(res, 401, { error: "That login and password don’t match." }); }
    fails.delete(ip);
    const token = newId(32);
    db.prepare("INSERT INTO sessions (token,user_id,expires) VALUES (?,?,?)").run(token, u.id, Date.now() + SESSION_DAYS * 864e5);
    return send(res, 200, { user: publicUser(u) }, { "Set-Cookie": `ws_sess=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure(req) ? "; Secure" : ""}` });
  }

  const user = sessionUser(req);
  if (!user) return send(res, 401, { error: "Please log in." });
  const lvl = ROLES[user.role];

  if (p === "/api/logout" && m === "POST") { db.prepare("DELETE FROM sessions WHERE token = ?").run(cookies(req).ws_sess); return send(res, 200, { ok: true }, { "Set-Cookie": "ws_sess=; Path=/; HttpOnly; Max-Age=0" }); }
  if (p === "/api/me") return send(res, 200, { user: publicUser(user) });

  if (p === "/api/events" && m === "GET") {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", "Connection": "keep-alive", "X-Accel-Buffering": "no" });
    res.write("retry: 3000\n\n");
    clients.add(res);
    req.on("close", () => clients.delete(res));
    return;
  }
  if (p === "/api/doc" && m === "GET") return send(res, 200, shape(url.searchParams.get("path"), getDoc.get(url.searchParams.get("path"))));
  if (p === "/api/query" && m === "POST") return send(res, 200, { docs: runQuery(await readBody(req)) });
  if (p === "/api/write" && m === "POST") { const { ops } = await readBody(req); return send(res, 200, { docs: applyWrites(ops, user) }); }

  // A colleague types their login on the register to approve a discount over the cashier's limit (an owner for Gold SKUs).
  if (p === "/api/approve" && m === "POST") {
    if (tooMany(ip)) return send(res, 429, { error: "Too many attempts. Wait 15 minutes and try again." });
    const { login, password, pct = 0, gold = false } = await readBody(req);
    const o = db.prepare("SELECT * FROM users WHERE login = ?").get(String(login || "").trim());
    if (!checkPw(o, password)) { noteFail(ip); return send(res, 403, { error: "That login and password don’t match." }); }
    if (gold && o.role !== "owner") return send(res, 403, { error: "Only an owner can approve a discount on a Gold SKU." });
    if (!gold && limitFor(o) + 0.05 < +pct) return send(res, 403, { error: `${o.name}’s limit is ${limitFor(o)}%, which doesn’t cover ${Math.round(pct)}%.` });
    return send(res, 200, { token: makeApproval(o.id), by: o.name, limit: limitFor(o), owner: o.role === "owner", minutes: APPROVAL_MINUTES });
  }
  if (p === "/api/credit" && m === "POST") return send(res, 200, issueCredit(await readBody(req), user));
  if (p === "/api/team" && m === "GET") return send(res, 200, { team: db.prepare("SELECT id, name, role, active FROM users ORDER BY name").all().map(u => ({ ...u, active: !!u.active })) });
  if (p === "/api/clock" && m === "POST") {
    const b = await readBody(req);
    if (b.login && tooMany(ip)) return send(res, 429, { error: "Too many attempts. Wait 15 minutes and try again." });
    try { return send(res, 200, clockAction(b, user)); } catch (e) { if (e.status === 403) noteFail(ip); throw e; }
  }
  if (p === "/api/report/datasets" && m === "GET") { if (lvl < ROLES.manager) return send(res, 403, { error: "Only managers and owners can build reports." }); return send(res, 200, reports.datasets()); }
  if (p === "/api/report" && m === "POST") { if (lvl < ROLES.manager) return send(res, 403, { error: "Only managers and owners can build reports." }); return send(res, 200, reports.run(await readBody(req))); }
  if (p.startsWith("/api/alerts/")) return send(res, 200, await alerts.route(p.slice(12), m, m === "GET" ? {} : await readBody(req), user));
  if (p === "/api/import/sales" && m === "POST") {
    if (lvl < ROLES.manager) return send(res, 403, { error: "Only managers and owners can import sales." });
    return send(res, 200, importSales(await readBody(req), user));
  }

  let mm;
  if ((mm = p.match(/^\/api\/orders\/([A-Za-z0-9_\-]+)\/(pack|unpack|cancel)$/)) && m === "POST") return send(res, 200, { docs: orderAction(mm[1], mm[2], await readBody(req), user) });
  if ((mm = p.match(/^\/api\/orders\/([A-Za-z0-9_\-]+)\/ship$/)) && m === "POST") {
    if (lvl < ROLES.cashier) return send(res, 403, { error: "Your role can’t ship orders." });
    return send(res, 200, await shopify.ship(mm[1], await readBody(req), user));
  }
  if (p.startsWith("/api/shopify/")) return send(res, 200, await shopify.route(p.slice(13), m, m === "GET" ? Object.fromEntries(url.searchParams) : await readBody(req), user));

  if (p === "/api/profiles" && m === "GET") {
    const ids = (url.searchParams.get("ids") || "").split(",").filter(Boolean).slice(0, 64);
    const out = {}; for (const id of ids) { const u = db.prepare("SELECT name FROM users WHERE id = ?").get(id); out[id] = { id, name: u?.name || "" }; }
    return send(res, 200, out);
  }
  if (p === "/api/users" && m === "GET") {
    if (lvl < ROLES.manager) return send(res, 403, { error: "Only managers and owners can see staff." });
    return send(res, 200, { users: db.prepare("SELECT * FROM users ORDER BY active DESC, name").all().map(publicUser) });
  }
  if (p === "/api/users" && m === "POST") {
    if (lvl < ROLES.manager) return send(res, 403, { error: "Only managers and owners can change staff." });
    return send(res, 200, { user: saveStaff(await readBody(req), user) });
  }
  if (p === "/api/users/import" && m === "POST") {
    if (lvl < ROLES.manager) return send(res, 403, { error: "Only managers and owners can import staff." });
    const { rows } = await readBody(req);
    if (!Array.isArray(rows) || rows.length > 2000) throw bad("Send up to 2,000 staff rows at a time.");
    const results = rows.map(r => {
      try {
        const target = db.prepare("SELECT * FROM users WHERE login = ?").get(String(r.login || "").trim());
        const u = saveStaff({ id: target?.id, ...r, active: r.active !== false }, user);
        return { ok: true, login: u.login, created: !target };
      } catch (e) { return { ok: false, login: r.login, error: e.message }; }
    });
    return send(res, 200, { results });
  }
  if (p === "/api/backup" && m === "GET") {
    if (lvl < ROLES.owner) return send(res, 403, { error: "Only an owner can download backups." });
    const tmp = path.join(DATA_DIR, `download-${newId(6)}.db`);
    db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
    const stream = fs.createReadStream(tmp);
    res.writeHead(200, { ...SEC_HEADERS, "Content-Type": "application/octet-stream", "Content-Disposition": `attachment; filename="woodstack-pos-${new Date().toISOString().slice(0, 10)}.db"` });
    stream.pipe(res); stream.on("close", () => fs.unlink(tmp, () => {}));
    return;
  }
  if (p === "/api/status" && m === "GET") {
    return send(res, 200, { version: VERSION, docs: db.prepare("SELECT COUNT(*) n FROM docs").get().n, lastBackup: metaGet("last_backup"), backups: fs.readdirSync(path.join(DATA_DIR, "backups")).filter(f => f.endsWith(".db")).length });
  }
  return send(res, 404, { error: "Not found" });
}

function startServer() {
  if (!db.prepare("SELECT COUNT(*) n FROM docs").get().n && fs.existsSync(path.join(DATA_DIR, "seed.json"))) console.log("Loaded", importFile(path.join(DATA_DIR, "seed.json")), "starting documents from data/seed.json");
  loadCatalog();
  if (!db.prepare("SELECT COUNT(*) n FROM users").get().n) console.warn("No logins yet. Create one: node server.js add-user \"Your Name\" yourlogin yourpassword owner");
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    try {
      if (url.pathname.startsWith("/api/")) await api(req, res, url);
      else if (req.method === "GET") serveStatic(req, res, url.pathname);
      else send(res, 405, "Method not allowed");
    } catch (e) {
      if (!res.headersSent) send(res, e.status || 500, { error: e.status ? e.message : "Something went wrong on the server.", code: e.code || "unavailable" });
      if (!e.status) console.error(e);
    }
  });
  server.listen(PORT, HOST, () => console.log(`Woodstack POS ${VERSION} listening on http://${HOST}:${PORT}`));
  nightly(); setInterval(nightly, 30 * 60e3).unref();
  setInterval(() => db.prepare("DELETE FROM sessions WHERE expires < ?").run(Date.now()), 3600e3).unref();
  shopify.start();
  alerts.start();
  const stop = () => { server.close(); for (const c of clients) c.end(); db.close(); process.exit(0); };
  process.on("SIGTERM", stop); process.on("SIGINT", stop);
}

/* ---------- command line ---------- */
const [cmd, ...args] = process.argv.slice(2);
if (!cmd || cmd === "start") startServer();
else if (cmd === "add-user") {
  const [name, login, password, role = "owner"] = args;
  if (!name || !login || !password) { console.error('Usage: node server.js add-user "Full Name" login password [owner|manager|cashier|viewer]'); process.exit(1); }
  try { upsertUser({ name, login, password, role }); console.log(`Login "${login}" is ready (${role}).`); } catch (e) { console.error(e.message); process.exit(1); }
} else if (cmd === "import") { console.log("Imported", importFile(args[0]), "documents"); }
else if (cmd === "backup") { console.log("Backup written to", backupNow(new Date().toISOString().slice(0, 10))); }
else { console.error("Unknown command. Use: start | add-user | import | backup"); process.exit(1); }
