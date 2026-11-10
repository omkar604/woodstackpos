/*
 * WhatsApp alerts for the Woodstack POS.
 * Watches every stock change; when an item drops below zero at a store, it collects the
 * items for a minute and sends one message per store to the people who watch that store.
 *
 * Two ways to send:
 *  - "meta": WhatsApp Business Cloud API (official). Needs a phone number ID, an access token
 *    and an approved template with two body variables: {{1}} = store, {{2}} = details.
 *  - "callmebot": free personal gateway. Each recipient activates their own API key.
 */
"use strict";

module.exports = function alertsModule(ctx) {
  const { db, metaGet, metaSet, readJSON, runQuery, catalog, hooks, bad, now } = ctx;
  const ROLE = { viewer: 0, cashier: 1, manager: 2, owner: 3 };
  const settings = () => ({ enabled: false, provider: "callmebot", negative: true, meta: { phoneId: "", token: "", template: "stock_alert", lang: "en_US", version: "v26.0" }, recipients: [], ...(metaGet("alerts") || {}) });
  const log = () => metaGet("alerts_log") || [];
  const addLog = e => metaSet("alerts_log", [{ at: now(), ...e }, ...log()].slice(0, 60));
  const outlets = () => readJSON("config/main")?.outlets || [];
  const userName = id => (id && db.prepare("SELECT name FROM users WHERE id = ?").get(id)?.name) || (id === "shopify" ? "Shopify order" : "");
  const oneLine = s => String(s).replace(/[\r\n\t]+/g, " ").replace(/ {4,}/g, "   ").trim();

  /* ---------- sending ---------- */
  const base = (kind) => process.env[kind === "meta" ? "WHATSAPP_TEST_BASE" : "CALLMEBOT_TEST_BASE"];
  async function sendOne(s, r, store, details) {
    const phone = String(r.phone || "").replace(/[^\d]/g, "");
    if (!phone) throw new Error(`${r.name || "Recipient"} has no phone number`);
    if (s.provider === "meta") {
      const m = s.meta;
      if (!m.phoneId || !m.token || !m.template) throw new Error("WhatsApp Business isn’t set up: add the phone number ID, access token and template name.");
      const url = `${base("meta") || "https://graph.facebook.com"}/${m.version || "v26.0"}/${encodeURIComponent(m.phoneId)}/messages`;
      const res = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${m.token}`, "Content-Type": "application/json" }, body: JSON.stringify({
        messaging_product: "whatsapp", to: phone, type: "template",
        template: { name: m.template, language: { code: m.lang || "en_US" }, components: [{ type: "body", parameters: [{ type: "text", text: oneLine(store).slice(0, 200) }, { type: "text", text: oneLine(details).slice(0, 900) }] }] }
      }) });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error?.message || `WhatsApp returned ${res.status}`);
      return;
    }
    if (!r.key) throw new Error(`${r.name || phone} has no CallMeBot key yet`);
    const text = store === "Test" ? `Woodstack POS: ${details}` : details;
    const url = `${base("callmebot") || "https://api.callmebot.com"}/whatsapp.php?phone=${encodeURIComponent("+" + phone)}&text=${encodeURIComponent(text)}&apikey=${encodeURIComponent(r.key)}`;
    const res = await fetch(url);
    const body = await res.text().catch(() => "");
    if (!res.ok || /error|invalid|not (allowed|active)/i.test(body.slice(0, 400))) throw new Error(`CallMeBot didn’t send to ${r.name || phone}: ${body.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 140) || res.status}`);
  }
  async function deliver(oi, store, details, kind = "Negative stock") {
    const s = settings();
    const who = s.recipients.filter(r => r.active !== false && (r.all || (r.outlets || []).includes(oi)));
    if (!who.length) { addLog({ kind, store, details, sent: 0, note: "Nobody watches this store" }); return; }
    let sent = 0; const errs = [];
    for (const r of who) { try { await sendOne(s, r, store, details); sent++; } catch (e) { errs.push(e.message); } await new Promise(r => setTimeout(r, 400)); }
    addLog({ kind, store, details, sent, to: who.map(r => r.name || r.phone), errors: errs });
  }

  /* ---------- watching stock ---------- */
  const queue = new Map(); // oi -> Map(sku -> entry)
  hooks.afterWrite.push((results, by) => {
    const s = settings(); if (!s.enabled || !s.negative) return;
    for (const r of results) {
      if (r.coll !== "catalog" || !r.exists) continue;
      const oldF = r.old?.fams || {};
      for (const [fid, f] of Object.entries(r.data?.fams || {})) for (const [sku, v] of Object.entries(f?.v || {})) {
        for (const [oi, n] of Object.entries(v?.st || {})) {
          const was = +(oldF[fid]?.v?.[sku]?.st?.[oi] ?? 0);
          if (+n < 0 && was >= 0) {
            const q = queue.get(+oi) || queue.set(+oi, new Map()).get(+oi);
            q.set(sku, { name: f.n || sku, opt: v.o || "", qty: +n, by: userName(by) });
          }
        }
      }
    }
  });
  let flushing = false;
  async function flush() {
    if (flushing || !queue.size) return; flushing = true;
    try {
      const batch = [...queue.entries()]; queue.clear();
      for (const [oi, items] of batch) {
        const store = outlets()[oi]?.name || `Store ${oi}`;
        const list = [...items.values()];
        const onClock = runQuery({ coll: "punches", where: [["open", "==", true], ["oi", "==", oi]] }).map(d => userName(d.data.uid)).filter(Boolean);
        const lines = [
          `NEGATIVE STOCK at ${store}`,
          ...list.slice(0, 12).map(x => `• ${x.name}${x.opt ? ", size " + x.opt : ""}: now ${x.qty}${x.by ? `, changed by ${x.by}` : ""}`),
          ...(list.length > 12 ? [`• and ${list.length - 12} more`] : []),
          `On the clock at ${store}: ${onClock.length ? onClock.join(", ") : "nobody clocked in"}`,
          `Please recount, or check for a missed transfer.`
        ];
        await deliver(oi, store, lines.join("\n"));
      }
    } catch (e) { console.error("[alerts]", e.message); } finally { flushing = false; }
  }

  /* ---------- settings routes (owners change, managers view) ---------- */
  const mask = v => (v ? "••••" + String(v).slice(-4) : "");
  async function route(sub, method, body, user) {
    const lvl = ROLE[user.role];
    if (lvl < ROLE.manager) throw bad("Only managers and owners can see alert settings.", 403);
    if (sub === "status") {
      const s = settings();
      return { settings: { ...s, meta: { ...s.meta, token: mask(s.meta.token) }, recipients: s.recipients.map(r => ({ ...r, key: mask(r.key) })) }, log: log().slice(0, 25) };
    }
    if (lvl < ROLE.owner) throw bad("Only an owner can change alerts.", 403);
    if (sub === "settings" && method === "POST") {
      const cur = settings(), next = { ...cur };
      for (const k of ["enabled", "negative"]) if (typeof body[k] === "boolean") next[k] = body[k];
      if (["meta", "callmebot"].includes(body.provider)) next.provider = body.provider;
      if (body.meta) { next.meta = { ...cur.meta }; for (const k of ["phoneId", "template", "lang", "version"]) if (typeof body.meta[k] === "string") next.meta[k] = body.meta[k].trim(); if (typeof body.meta.token === "string" && !body.meta.token.startsWith("••••")) next.meta.token = body.meta.token.trim(); }
      if (Array.isArray(body.recipients)) {
        next.recipients = body.recipients.slice(0, 50).map((r, i) => {
          const old = cur.recipients.find(x => x.id === r.id);
          return { id: r.id || ("r" + Date.now().toString(36) + i), name: String(r.name || "").slice(0, 60), phone: String(r.phone || "").slice(0, 30), key: typeof r.key === "string" && !r.key.startsWith("••••") ? r.key.trim() : (old?.key || ""), all: !!r.all, outlets: Array.isArray(r.outlets) ? r.outlets.filter(Number.isInteger) : [], active: r.active !== false };
        });
      }
      metaSet("alerts", next);
      return { ok: true };
    }
    if (sub === "test" && method === "POST") {
      const s = settings(); const r = s.recipients.find(x => x.id === body.id);
      if (!r) throw bad("Save the recipient first, then send a test.");
      try { await sendOne(s, r, "Test", `This is a test alert from the Woodstack POS for ${r.name || r.phone}. Alerts are working.`); addLog({ kind: "Test", store: "Test", details: "Test message", sent: 1, to: [r.name || r.phone], errors: [] }); return { ok: true }; }
      catch (e) { addLog({ kind: "Test", store: "Test", details: "Test message", sent: 0, to: [r.name || r.phone], errors: [e.message] }); throw bad(e.message, 502); }
    }
    throw bad("Unknown alerts action", 404);
  }

  function start() { setInterval(flush, +process.env.ALERT_FLUSH_MS || 60e3).unref(); }
  return { start, route, flush };
};
