/*
 * Shopify connection for the Woodstack POS.
 *  - Brings in WOODstack.com orders every 2 minutes for pick and pack.
 *  - Sends stock levels to one Shopify location so the website doesn't oversell.
 *  - Marks orders fulfilled in Shopify (with tracking) when they ship.
 * Uses the Admin GraphQL API with a Dev Dashboard app (client credentials grant),
 * or a legacy custom-app access token if you already have one.
 */
"use strict";
const crypto = require("node:crypto");
const API_VERSION = "2026-10";

module.exports = function shopifyModule(ctx) {
  const { db, metaGet, metaSet, readJSON, applyWrites, runQuery, catalog, hooks, bad, r2, now } = ctx;
  db.exec(`
    CREATE TABLE IF NOT EXISTS shopify_variants (code TEXT PRIMARY KEY, inventory_item_id TEXT NOT NULL, variant_id TEXT NOT NULL, title TEXT);
    CREATE TABLE IF NOT EXISTS shopify_pushed (sku TEXT PRIMARY KEY, qty INTEGER NOT NULL, at TEXT NOT NULL);
  `);
  const ROLE = { viewer: 0, cashier: 1, manager: 2, owner: 3 };
  const settings = () => ({ enabled: false, shop: "", clientId: "", clientSecret: "", accessToken: "", locationId: "", locationName: "", outlets: null, buffer: 1, syncOrders: true, pushStock: true, notify: true, ...(metaGet("shopify") || {}) });
  const state = () => ({ since: null, lastOrderSync: null, lastStockPush: null, lastVariantSync: null, shopName: "", errors: [], ...(metaGet("shopify_state") || {}) });
  const setState = patch => metaSet("shopify_state", { ...state(), ...patch });
  function logError(where, e) {
    const s = state(); const msg = `${where}: ${e.message || e}`;
    console.error("[shopify]", msg);
    setState({ errors: [{ at: now(), msg }, ...s.errors].slice(0, 20) });
  }
  const numId = gid => String(gid || "").split("/").pop();
  const domain = s => { let d = String(s.shop || "").trim().replace(/^https?:\/\//, "").replace(/\/.*$/, ""); if (d && !d.includes(".")) d += ".myshopify.com"; return d; };
  const base = s => process.env.SHOPIFY_TEST_BASE || `https://${domain(s)}`;

  /* ---------- auth + GraphQL ---------- */
  let cached = { token: "", exp: 0, key: "" };
  async function token(s) {
    if (s.accessToken) return s.accessToken;
    const key = s.shop + s.clientId;
    if (cached.key === key && cached.exp > Date.now() + 5 * 60e3) return cached.token;
    if (!s.shop || !s.clientId || !s.clientSecret) throw new Error("Shopify isn’t set up yet. Add the store address, Client ID and Client secret in Setup.");
    const res = await fetch(`${base(s)}/admin/oauth/access_token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "client_credentials", client_id: s.clientId, client_secret: s.clientSecret }) });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || !j.access_token) throw new Error(j.error === "shop_not_permitted" ? "Shopify refused: the app and the store must be in the same Shopify organization." : `Shopify login failed (${res.status}). Check the Client ID and Client secret, and that the app is installed on the store.`);
    cached = { token: j.access_token, exp: Date.now() + (+j.expires_in || 86399) * 1000, key };
    return cached.token;
  }
  async function gql(query, variables = {}, s = settings(), attempt = 0) {
    const res = await fetch(`${base(s)}/admin/api/${API_VERSION}/graphql.json`, { method: "POST", headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": await token(s) }, body: JSON.stringify({ query, variables }) });
    if (res.status === 401 && attempt < 1 && !s.accessToken) { cached.exp = 0; return gql(query, variables, s, attempt + 1); }
    if ((res.status === 429 || res.status >= 500) && attempt < 5) { await new Promise(r => setTimeout(r, 1500 * (attempt + 1))); return gql(query, variables, s, attempt + 1); }
    const j = await res.json().catch(() => ({}));
    if (j.errors?.some(e => e.extensions?.code === "THROTTLED") && attempt < 6) { await new Promise(r => setTimeout(r, 2000 * (attempt + 1))); return gql(query, variables, s, attempt + 1); }
    if (!res.ok || j.errors?.length) throw new Error(j.errors?.map(e => e.message).join("; ") || `Shopify returned ${res.status}`);
    return j.data;
  }

  /* ---------- which POS outlets feed the website ---------- */
  function outlets() { return readJSON("config/main")?.outlets || []; }
  function onlineOutlets(s = settings()) {
    const outs = outlets();
    if (Array.isArray(s.outlets) && s.outlets.length) return s.outlets.filter(i => outs[i]);
    // default: warehouses and the online outlet first, then every store
    const idx = outs.map((o, i) => i);
    const rank = i => /warehouse/i.test(outs[i].name) && !/harrington/i.test(outs[i].name) ? 0 : /\.com/i.test(outs[i].name) ? 1 : /warehouse/i.test(outs[i].name) ? 2 : 3;
    return idx.sort((a, b) => rank(a) - rank(b) || a - b);
  }
  const isStore = i => !/warehouse|\.com/i.test(outlets()[i]?.name || "");

  function openOrders() { return runQuery({ coll: "orders", where: [["st", "in", ["new", "picking"]]] }).map(d => ({ id: d.id, ...d.data })); }
  function reserved(open = openOrders()) {
    const all = new Map(), at = new Map();
    for (const o of open) for (const l of o.lines || []) if (l.sku) {
      all.set(l.sku, (all.get(l.sku) || 0) + l.q);
      const k = o.loc + "|" + l.sku; at.set(k, (at.get(k) || 0) + l.q);
    }
    return { all, at };
  }
  function availableOnline(sku, res, s = settings()) {
    const c = catalog.bySku.get(sku); if (!c || c.archived) return 0;
    let n = 0;
    for (const oi of onlineOutlets(s)) n += Math.max(0, (+c.st[oi] || 0) - (isStore(oi) ? (+s.buffer || 0) : 0));
    return Math.max(0, n - (res.all.get(sku) || 0));
  }

  /* ---------- orders in ---------- */
  const ORDER_FIELDS = `id name createdAt updatedAt cancelledAt displayFulfillmentStatus displayFinancialStatus email phone note
    totalPriceSet { shopMoney { amount } }
    shippingLine { title }
    shippingAddress { name address1 address2 city provinceCode zip countryCodeV2 phone }
    lineItems(first: 100) { nodes { id title variantTitle sku quantity unfulfilledQuantity variant { id barcode sku } originalUnitPriceSet { shopMoney { amount } } } }`;

  function matchSku(li) {
    for (const code of [li.variant?.barcode, li.variant?.sku, li.sku]) { const c = String(code || "").trim(); if (c && catalog.bySku.has(c)) return c; }
    return null;
  }
  function chooseLocation(lines, open, s) {
    const res = reserved(open);
    const order = onlineOutlets(s);
    let best = null;
    for (const oi of order) {
      let covered = 0, need = 0;
      for (const l of lines) { need += l.q; if (!l.sku) continue; const c = catalog.bySku.get(l.sku); const free = (+c?.st?.[oi] || 0) - (res.at.get(oi + "|" + l.sku) || 0); covered += Math.min(l.q, Math.max(0, free)); }
      if (need && covered === need) return { loc: oi, partial: false };
      if (!best || covered > best.covered) best = { loc: oi, covered };
    }
    return { loc: best?.loc ?? order[0] ?? 0, partial: true };
  }
  function orderDoc(node) {
    const a = node.shippingAddress || {};
    return {
      src: "shopify", sid: node.id, name: node.name, placed: node.createdAt, date: String(node.createdAt).slice(0, 10), updated: node.updatedAt,
      email: node.email || "", phone: node.phone || a.phone || "", note: node.note || "",
      ship: { name: a.name || "", a1: a.address1 || "", a2: a.address2 || "", city: a.city || "", prov: a.provinceCode || "", zip: a.zip || "", country: a.countryCodeV2 || "", phone: a.phone || "" },
      method: node.shippingLine?.title || "", total: r2(node.totalPriceSet?.shopMoney?.amount), fin: node.displayFinancialStatus || "", shFul: node.displayFulfillmentStatus || ""
    };
  }
  function linesOf(node) {
    return (node.lineItems?.nodes || []).filter(li => li.unfulfilledQuantity > 0).map(li => ({
      id: numId(li.id), sku: matchSku(li), code: li.variant?.barcode || li.variant?.sku || li.sku || "", title: li.title, variant: li.variantTitle || "", q: li.unfulfilledQuantity, price: r2(li.originalUnitPriceSet?.shopMoney?.amount)
    }));
  }
  async function syncOrders() {
    const s = settings(); if (!s.enabled || !s.syncOrders) return { skipped: true };
    const st = state();
    const since = new Date(st.since ? Date.parse(st.since) - 2 * 60e3 : Date.now() - 14 * 864e5).toISOString();
    let after = null, newest = st.since, created = 0, updated = 0;
    const open = openOrders();
    do {
      const d = await gql(`query($q: String!, $after: String) { orders(first: 50, after: $after, sortKey: UPDATED_AT, query: $q) { pageInfo { hasNextPage endCursor } nodes { ${ORDER_FIELDS} } } }`, { q: `updated_at:>='${since}'`, after }, s);
      for (const node of d.orders.nodes) {
        if (!newest || node.updatedAt > newest) newest = node.updatedAt;
        const id = numId(node.id), path = "orders/" + id, cur = readJSON(path);
        const base = orderDoc(node);
        if (!cur) {
          if (node.cancelledAt || ["FULFILLED", "RESTOCKED", "FULFILLMENT_NOT_REQUIRED"].includes(node.displayFulfillmentStatus)) continue;
          const lines = linesOf(node); if (!lines.length) continue;
          const { loc, partial } = chooseLocation(lines, open, s);
          const doc = { ...base, lines, st: "new", loc, autoLoc: loc, partial, unmatched: lines.filter(l => !l.sku).length, picked: {}, received: now() };
          applyWrites([{ op: "set", path, data: doc }], null, "shopify");
          open.push({ id, ...doc }); created++;
        } else {
          const patch = { ...base };
          if (node.cancelledAt && !["shipped", "cancelled", "done"].includes(cur.st)) { if (cur.st === "packed") patch.shCancelled = true; else patch.st = "cancelled"; }
          else if (node.displayFulfillmentStatus === "FULFILLED" && ["new", "picking"].includes(cur.st)) patch.st = "done";
          else if (cur.st === "new") { const lines = linesOf(node); if (lines.length) { patch.lines = lines; patch.unmatched = lines.filter(l => !l.sku).length; } }
          applyWrites([{ op: "merge", path, data: patch }], null, "shopify"); updated++;
        }
      }
      after = d.orders.pageInfo.hasNextPage ? d.orders.pageInfo.endCursor : null;
    } while (after);
    setState({ since: newest || now(), lastOrderSync: now() });
    return { created, updated };
  }

  /* ---------- stock out ---------- */
  async function refreshVariants() {
    const s = settings(); let after = null, n = 0;
    const ins = db.prepare("INSERT INTO shopify_variants (code, inventory_item_id, variant_id, title) VALUES (?,?,?,?) ON CONFLICT(code) DO UPDATE SET inventory_item_id=excluded.inventory_item_id, variant_id=excluded.variant_id, title=excluded.title");
    const seen = new Set();
    do {
      const d = await gql(`query($after: String) { productVariants(first: 250, after: $after) { pageInfo { hasNextPage endCursor } nodes { id sku barcode displayName inventoryItem { id tracked } } } }`, { after }, s);
      db.exec("BEGIN");
      for (const v of d.productVariants.nodes) {
        if (!v.inventoryItem) continue;
        for (const code of [v.barcode, v.sku]) { const c = String(code || "").trim(); if (c && !seen.has(c)) { seen.add(c); ins.run(c, v.inventoryItem.id, v.id, v.displayName || ""); } }
        n++;
      }
      db.exec("COMMIT");
      after = d.productVariants.pageInfo.hasNextPage ? d.productVariants.pageInfo.endCursor : null;
    } while (after);
    if (seen.size) { const del = db.prepare("DELETE FROM shopify_variants WHERE code = ?"); for (const r of db.prepare("SELECT code FROM shopify_variants").all()) if (!seen.has(r.code)) del.run(r.code); }
    setState({ lastVariantSync: now() });
    return { variants: n };
  }
  const variantFor = db.prepare("SELECT inventory_item_id FROM shopify_variants WHERE code = ?");
  const pushedGet = db.prepare("SELECT qty FROM shopify_pushed WHERE sku = ?");
  const pushedSet = db.prepare("INSERT INTO shopify_pushed (sku, qty, at) VALUES (?,?,?) ON CONFLICT(sku) DO UPDATE SET qty=excluded.qty, at=excluded.at");
  async function pushSkus(skus, force = false) {
    const s = settings(); if (!s.enabled || !s.pushStock) return { skipped: true };
    if (!s.locationId) throw new Error("Choose which Shopify location gets the stock counts.");
    const res = reserved();
    const items = [];
    for (const sku of new Set(skus)) {
      const inv = variantFor.get(sku)?.inventory_item_id; if (!inv) continue;
      const qty = availableOnline(sku, res, s);
      if (!force && pushedGet.get(sku)?.qty === qty) continue;
      items.push({ sku, inv, qty });
    }
    let sent = 0;
    for (let i = 0; i < items.length; i += 100) {
      const batch = items.slice(i, i + 100);
      const d = await gql(`mutation inventorySetQuantities($input: InventorySetQuantitiesInput!, $idempotencyKey: String!) {
        inventorySetQuantities(input: $input) @idempotent(key: $idempotencyKey) { userErrors { code field message } } }`,
        { idempotencyKey: crypto.randomUUID(), input: { name: "available", reason: "correction", referenceDocumentUri: "woodstack-pos://stock-sync/" + Date.now(), quantities: batch.map(b => ({ inventoryItemId: b.inv, locationId: s.locationId, quantity: b.qty, changeFromQuantity: null })) } }, s);
      const errs = d.inventorySetQuantities.userErrors || [];
      if (errs.length) logError("Stock update", new Error(errs.map(e => e.message).join("; ")));
      const at = now(); for (const b of batch) pushedSet.run(b.sku, b.qty, at);
      sent += batch.length;
    }
    setState({ lastStockPush: now() });
    return { sent };
  }
  const dirty = new Set();
  hooks.afterWrite.push(results => {
    for (const r of results) {
      if (r.coll === "catalog") {
        const oldF = r.old?.fams || {}, newF = r.data?.fams || {};
        for (const [fid, f] of Object.entries(newF)) for (const [sku, v] of Object.entries(f?.v || {})) {
          const ov = oldF[fid]?.v?.[sku];
          if (!ov || JSON.stringify(ov.st || {}) !== JSON.stringify(v?.st || {}) || !!oldF[fid]?.x !== !!f.x) dirty.add(sku);
        }
      }
      if (r.coll === "orders") for (const l of [...(r.data?.lines || []), ...(r.old?.lines || [])]) if (l.sku) dirty.add(l.sku);
    }
  });
  let flushing = false;
  async function flush() {
    if (flushing || !dirty.size) return; flushing = true;
    const skus = [...dirty]; dirty.clear();
    try { await pushSkus(skus); } catch (e) { skus.forEach(x => dirty.add(x)); logError("Stock update", e); } finally { flushing = false; }
  }

  /* ---------- ship ---------- */
  async function ship(id, body, user) {
    const path = "orders/" + id, o = readJSON(path);
    if (!o) throw bad("That order isn’t in the POS.", 404);
    if (o.st !== "packed") throw bad("Pack the order before shipping it.");
    const tracking = { carrier: String(body.carrier || "").slice(0, 40), number: String(body.number || "").trim().slice(0, 80) };
    const pickup = !!body.pickup;
    if (!pickup && !tracking.number) throw bad("Scan or type the tracking number.");
    const s = settings();
    let shopifyDone = false;
    if (o.src === "shopify" && s.enabled) {
      const d = await gql(`query($id: ID!) { order(id: $id) { fulfillmentOrders(first: 10) { nodes { id status } } } }`, { id: o.sid }, s);
      const fos = (d.order?.fulfillmentOrders?.nodes || []).filter(f => ["OPEN", "IN_PROGRESS"].includes(f.status));
      if (fos.length) {
        const fulfillment = { lineItemsByFulfillmentOrder: fos.map(f => ({ fulfillmentOrderId: f.id })), notifyCustomer: s.notify !== false };
        if (!pickup) fulfillment.trackingInfo = { company: tracking.carrier || undefined, number: tracking.number };
        const r = await gql(`mutation($fulfillment: FulfillmentInput!) { fulfillmentCreate(fulfillment: $fulfillment) { fulfillment { id status } userErrors { field message } } }`, { fulfillment }, s);
        if (r.fulfillmentCreate.userErrors?.length) throw bad("Shopify didn’t accept the shipment: " + r.fulfillmentCreate.userErrors.map(e => e.message).join("; "), 502);
      }
      shopifyDone = true;
    }
    const docs = applyWrites([{ op: "merge", path, data: { st: "shipped", shippedAt: now(), shippedBy: user.id, tracking: pickup ? { carrier: "Picked up in store", number: "" } : tracking, shopifyUpdated: shopifyDone } }], null, user.id);
    return { docs, shopifyUpdated: shopifyDone };
  }

  /* ---------- settings + status routes ---------- */
  const mask = v => (v ? "••••" + String(v).slice(-4) : "");
  async function route(sub, method, body, user) {
    const lvl = ROLE[user.role];
    if (lvl < ROLE.manager) throw bad("Only managers and owners can see the Shopify connection.", 403);
    if (sub === "status") {
      const s = settings(), st = state();
      const skus = [...catalog.bySku.keys()];
      const matched = skus.filter(k => variantFor.get(k)).length;
      return { settings: { ...s, clientSecret: mask(s.clientSecret), accessToken: mask(s.accessToken), outlets: onlineOutlets(s) }, state: st, matched, posSkus: skus.length, shopifyVariants: db.prepare("SELECT COUNT(DISTINCT variant_id) n FROM shopify_variants").get().n, openOrders: openOrders().length };
    }
    if (sub === "sync-orders" && method === "POST") return await syncOrders();
    if (sub === "push-all" && method === "POST") return await pushSkus([...catalog.bySku.keys()], true);
    if (sub === "refresh-variants" && method === "POST") return await refreshVariants();
    if (lvl < ROLE.owner) throw bad("Only an owner can change the Shopify connection.", 403);
    if (sub === "settings" && method === "POST") {
      const cur = settings(), next = { ...cur };
      for (const k of ["shop", "clientId", "locationId", "locationName"]) if (typeof body[k] === "string") next[k] = body[k].trim();
      for (const k of ["clientSecret", "accessToken"]) if (typeof body[k] === "string" && !body[k].startsWith("••••")) next[k] = body[k].trim();
      for (const k of ["enabled", "syncOrders", "pushStock", "notify"]) if (typeof body[k] === "boolean") next[k] = body[k];
      if (Array.isArray(body.outlets)) next.outlets = body.outlets.filter(Number.isInteger);
      if (body.buffer !== undefined) next.buffer = Math.max(0, Math.min(20, Math.trunc(+body.buffer) || 0));
      if (next.shop !== cur.shop || next.clientId !== cur.clientId || next.clientSecret !== cur.clientSecret) cached.exp = 0;
      metaSet("shopify", next);
      if (next.enabled && next.pushStock && next.locationId) setTimeout(async () => {
        try {
          if (!db.prepare("SELECT COUNT(*) n FROM shopify_variants").get().n) await refreshVariants();
          await pushSkus([...catalog.bySku.keys()]);
        } catch (e) { logError("Stock update", e); }
      }, 100);
      return { ok: true };
    }
    if (sub === "test" && method === "POST") {
      const d = await gql(`{ shop { name myshopifyDomain } locations(first: 50) { nodes { id name isActive } } }`);
      setState({ shopName: d.shop.name });
      return { shop: d.shop, locations: d.locations.nodes.filter(l => l.isActive) };
    }
    throw bad("Unknown Shopify action", 404);
  }

  function start() {
    const safe = (name, fn) => async () => { try { await fn(); } catch (e) { logError(name, e); } };
    const ordersTick = safe("Order import", syncOrders);
    const variantsTick = safe("Product matching", async () => { const s = settings(); if (s.enabled && s.pushStock) await refreshVariants(); });
    const nightlyPush = safe("Nightly stock push", async () => { const s = settings(); if (s.enabled && s.pushStock && s.locationId) await pushSkus([...catalog.bySku.keys()], true); });
    setTimeout(async () => { await variantsTick(); await ordersTick(); }, 3000);
    setInterval(ordersTick, 120e3).unref();
    setInterval(flush, 20e3).unref();
    setInterval(variantsTick, 6 * 3600e3).unref();
    setInterval(nightlyPush, 24 * 3600e3).unref();
  }

  return { start, route, ship, syncOrders, pushSkus, refreshVariants, flush };
};
