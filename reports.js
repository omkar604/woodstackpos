/*
 * Open-ended reports for owners and managers.
 * A report = one dataset + date range + filters + up to three "group by" columns + any metrics.
 * Everything is calculated on the server from the saved data, so long date ranges work.
 */
"use strict";

module.exports = function reportsModule(ctx) {
  const { db, runQuery, readJSON, catalog, bad } = ctx;
  const TZ = process.env.STORE_TZ || "America/New_York";
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23", weekday: "short" });
  function when(iso) {
    const d = new Date(iso); if (Number.isNaN(+d)) return { date: "", hour: "", weekday: "", week: "", month: "" };
    const p = Object.fromEntries(fmt.formatToParts(d).map(x => [x.type, x.value]));
    const date = `${p.year}-${p.month}-${p.day}`;
    const dt = new Date(date + "T12:00:00Z"), dow = (dt.getUTCDay() + 6) % 7; dt.setUTCDate(dt.getUTCDate() - dow);
    return { date, hour: `${p.hour}:00`, weekday: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][dow], week: "Week of " + dt.toISOString().slice(0, 10), month: date.slice(0, 7) };
  }
  const r2 = x => Math.round((+x || 0) * 100) / 100;
  const outletName = i => readJSON("config/main")?.outlets?.[i]?.name ?? (i === -1 ? "Imported" : "—");
  const regName = i => i === -1 ? "Imported" : (readJSON("config/main")?.registers?.[i]?.name || "—");
  let names = null; const userName = id => { names ||= new Map(db.prepare("SELECT id, name FROM users").all().map(u => [u.id, u.name])); return names.get(id) || (id === "shopify" ? "Shopify" : id ? "Former staff" : "—"); };
  let custs = null; const cust = id => { custs ||= new Map(runQuery({ coll: "customers" }).map(d => [d.id, d.data])); return custs.get(id) || null; };
  const custName = id => id ? (cust(id)?.name || "Unknown customer") : "No customer";
  const CAT = { customer: "Customer", reseller: "Reseller", vip: "VIP", employee: "Employee", fnf: "Friends & family" };
  const custCat = id => id ? (CAT[cust(id)?.cat || "customer"] || "Customer") : "No customer";
  const custLink = id => { const c = id && cust(id); return c?.link ? userName(c.link) : "—"; };
  const LEVEL = { msrp: "MSRP", md1: "First markdown", md2: "Second markdown", co: "Close-out" };
  function famOf(sku) { const c = catalog.bySku.get(String(sku)); if (!c) return null; return readJSONCached("catalog/" + c.chunk)?.fams?.[c.fid] || null; }
  let chunkCache = new Map(); const readJSONCached = p => chunkCache.has(p) ? chunkCache.get(p) : (chunkCache.set(p, readJSON(p)), chunkCache.get(p));

  const TIME_DIMS = { date: "Date", week: "Week", month: "Month", weekday: "Day of week", hour: "Hour" };
  const salesInRange = (from, to) => runQuery({ coll: "sales", where: [["date", ">=", from], ["date", "<=", to]] }).flatMap(d => d.data.sales || []);

  const DATASETS = {
    lines: {
      label: "Items sold", dated: true,
      dims: { ...TIME_DIMS, outlet: "Store", register: "Register", staff: "Staff", customer: "Customer", customer_type: "Customer type", linked_employee: "Linked employee (friends & family)", brand: "Brand", type: "Type", product: "Product", size: "Size", sku: "SKU", gold: "Gold SKU", price_level: "Current price level", kind: "Sale or return", status: "Status" },
      metrics: { units: "Units", revenue: "Revenue (ex tax)", discount: "Discount given", cost: "Cost", profit: "Gross profit", margin: "Margin %", tax: "Tax", sales: "Number of sales", avg_price: "Average price" },
      rows(from, to) {
        const out = [];
        for (const s of salesInRange(from, to)) {
          const w = when(s.t);
          for (const l of s.lines || []) {
            const c = catalog.bySku.get(String(l.sku)), f = c ? famOf(l.sku) : null;
            out.push({ ...w, outlet: outletName(s.oi), register: regName(s.ri), staff: userName(s.by), customer: custName(s.cust), customer_type: custCat(s.cust), linked_employee: custLink(s.cust), brand: l.b || f?.b || "—", type: f?.t || "—", product: l.n, size: l.o || "—", sku: l.sku, gold: c?.gold ? "Gold" : "Not gold", price_level: LEVEL[f?.stage || "msrp"], kind: s.imp ? "Imported" : l.q < 0 ? "Return" : "Sale", status: s.st === "void" ? "Voided" : "Completed",
              _void: s.st === "void", units: l.q, revenue: l.net, discount: r2(Math.max(0, (l.p || 0) * l.q - l.net)), cost: r2((l.c || 0) * l.q), tax: l.tax || 0, _sale: s.id });
          }
        }
        return out;
      }
    },
    sales: {
      label: "Sales (receipts)", dated: true,
      dims: { ...TIME_DIMS, outlet: "Store", register: "Register", staff: "Staff", customer: "Customer", customer_type: "Customer type", linked_employee: "Linked employee (friends & family)", kind: "Sale or return", status: "Status" },
      metrics: { sales: "Number of sales", revenue: "Revenue (ex tax)", tax: "Tax", total: "Total with tax", units: "Units", avg_sale: "Average sale", items_per_sale: "Items per sale", discount: "Discount given", cost: "Cost", profit: "Gross profit", margin: "Margin %" },
      rows(from, to) {
        return salesInRange(from, to).map(s => ({ ...when(s.t), outlet: outletName(s.oi), register: regName(s.ri), staff: userName(s.by), customer: custName(s.cust), customer_type: custCat(s.cust), linked_employee: custLink(s.cust), kind: s.imp ? "Imported" : s.tot < 0 ? "Return" : "Sale", status: s.st === "void" ? "Voided" : "Completed",
          _void: s.st === "void", _sale: s.id, revenue: s.sub, tax: s.tax, total: s.tot, units: s.items, cost: s.cost || 0, discount: r2((s.lines || []).reduce((a, l) => a + Math.max(0, (l.p || 0) * l.q - l.net), 0)) }));
      }
    },
    payments: {
      label: "Payments", dated: true,
      dims: { ...TIME_DIMS, outlet: "Store", register: "Register", staff: "Staff", payment: "Payment type" },
      metrics: { amount: "Amount", count: "Number of payments" },
      rows(from, to) { return salesInRange(from, to).filter(s => s.st !== "void").flatMap(s => (s.pays || []).map(p => ({ ...when(s.t), outlet: outletName(s.oi), register: regName(s.ri), staff: userName(s.by), payment: p.t, amount: p.a, count: 1 }))); }
    },
    hours: {
      label: "Hours worked vs scheduled", dated: true,
      dims: { date: "Date", week: "Week", month: "Month", weekday: "Day of week", staff: "Staff", outlet: "Store" },
      metrics: { hours: "Hours worked", scheduled: "Hours scheduled", difference: "Worked minus scheduled", shifts: "Shifts worked", late: "Late arrivals" },
      rows(from, to) {
        const shifts = runQuery({ coll: "shifts", where: [["date", ">=", from], ["date", "<=", to]] }).map(d => d.data);
        const byDay = new Map(shifts.map(x => [x.uid + "|" + x.date, x]));
        const rows = [];
        for (const d of runQuery({ coll: "punches", where: [["date", ">=", from], ["date", "<=", to]] })) {
          const p = d.data, end = p.out ? Date.parse(p.out) : Date.now();
          const brk = (p.breaks || []).reduce((a, b) => a + ((b.e ? Date.parse(b.e) : end) - Date.parse(b.s)), 0);
          const sh = byDay.get(p.uid + "|" + p.date), w = when(p.in);
          const late = sh ? (Date.parse(p.in) - Date.parse(zonedIso(p.date, sh.start))) > 5 * 60e3 : false;
          rows.push({ date: p.date, week: w.week, month: p.date.slice(0, 7), weekday: w.weekday, staff: userName(p.uid), outlet: outletName(p.oi), hours: r2(Math.max(0, end - Date.parse(p.in) - brk) / 3600e3), shifts: 1, late: late ? 1 : 0, scheduled: 0 });
        }
        for (const x of shifts) { const w = when(x.date + "T12:00:00Z"); rows.push({ date: x.date, week: w.week, month: x.date.slice(0, 7), weekday: w.weekday, staff: userName(x.uid), outlet: outletName(x.oi), hours: 0, shifts: 0, late: 0, scheduled: shiftHours(x) }); }
        return rows;
      }
    },
    credit: {
      label: "Store credit", dated: true,
      dims: { ...TIME_DIMS, customer: "Customer", customer_type: "Customer type", type: "What happened", staff: "Staff", outlet: "Store" },
      metrics: { issued: "Credit added", used: "Credit used or removed", net: "Net change", entries: "Entries" },
      rows(from, to) {
        return runQuery({ coll: "credit" }).map(d => d.data).filter(e => { const dd = when(e.at).date; return dd >= from && dd <= to; }).map(e => ({ ...when(e.at), customer: custName(e.cust), customer_type: custCat(e.cust), type: e.type, staff: userName(e.by), outlet: e.oi != null ? outletName(e.oi) : "—", issued: Math.max(0, e.amt), used: Math.max(0, -e.amt), net: e.amt, entries: 1 }));
      }
    },
    stock: {
      label: "Stock on hand (now)", dated: false,
      dims: { outlet: "Store", brand: "Brand", type: "Type", product: "Product", size: "Size", sku: "SKU", gold: "Gold SKU", price_level: "Price level" },
      metrics: { units: "Units on hand", skus: "Sizes in stock", cost_value: "Value at cost", net_cost_value: "Value at net cost", retail_value: "Value at selling price", msrp_value: "Value at MSRP", internal_value: "Value at internal price", negative: "Sizes below zero" },
      rows() {
        const outs = readJSON("config/main")?.outlets || [], rows = [];
        for (const d of runQuery({ coll: "catalog" })) for (const f of Object.values(d.data.fams || {})) {
          if (!f || f.x) continue;
          for (const [sku, v] of Object.entries(f.v || {})) {
            if (!v || v.x) continue;
            for (const [oi, n] of Object.entries(v.st || {})) {
              const q = +n || 0; if (!q) continue;
              const pr = v.pr ?? f.pr ?? 0, c = v.c ?? f.c ?? 0, pos = Math.max(0, q);
              rows.push({ outlet: outs[oi]?.name || "—", brand: f.b || "—", type: f.t || "—", product: f.n, size: v.o || "—", sku, gold: f.gold ? "Gold" : "Not gold", price_level: LEVEL[f.stage || "msrp"],
                units: q, skus: q > 0 ? 1 : 0, negative: q < 0 ? 1 : 0, cost_value: r2(pos * c), net_cost_value: r2(pos * (f.cn ?? c)), retail_value: r2(pos * pr), msrp_value: r2(pos * (f.msrp ?? f.pr ?? 0)), internal_value: r2(pos * (f.ip ?? 0)) });
            }
          }
        }
        return rows;
      }
    },
    orders: {
      label: "Online orders", dated: true,
      dims: { date: "Date", week: "Week", month: "Month", weekday: "Day of week", status: "Status", ship_from: "Ships from", method: "Shipping method" },
      metrics: { orders: "Orders", units: "Units", value: "Order value" },
      rows(from, to) {
        const st = { new: "To pick", picking: "Picking", packed: "Packed", shipped: "Shipped", done: "Fulfilled in Shopify", cancelled: "Cancelled" };
        return runQuery({ coll: "orders", where: [["date", ">=", from], ["date", "<=", to]] }).map(d => { const o = d.data, w = when(o.placed); return { ...w, date: o.date, status: st[o.st] || o.st, ship_from: outletName(o.loc), method: o.method || "—", orders: 1, units: (o.lines || []).reduce((a, l) => a + l.q, 0), value: o.total || 0 }; });
      }
    }
  };
  function shiftHours(x) { const [a, b] = [x.start, x.end].map(t => { const [h, m] = String(t || "0:0").split(":").map(Number); return h * 60 + (m || 0); }); let mins = b - a; if (mins < 0) mins += 1440; return r2((mins - (+x.breakMin || 0)) / 60); }
  function zonedIso(date, hhmm) { // local store time -> ISO (handles EST/EDT)
    const guess = new Date(`${date}T${hhmm || "00:00"}:00Z`);
    const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: TZ, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(guess).map(x => [x.type, x.value]));
    const asLocal = Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:00Z`);
    return new Date(+guess + (+guess - asLocal)).toISOString();
  }

  function catalogOfDatasets() { return Object.fromEntries(Object.entries(DATASETS).map(([k, d]) => [k, { label: d.label, dated: d.dated, dims: d.dims, metrics: d.metrics }])); }

  function run(spec) {
    names = null; custs = null; chunkCache = new Map();
    const ds = DATASETS[spec.dataset]; if (!ds) throw bad("Choose what to report on.");
    const from = String(spec.from || "0000-01-01").slice(0, 10), to = String(spec.to || "9999-12-31").slice(0, 10);
    const group = (spec.group || []).filter(g => ds.dims[g]).slice(0, 3);
    const metrics = (spec.metrics || []).filter(m => ds.metrics[m]);
    if (!metrics.length) throw bad("Pick at least one number to show.");
    const filters = (spec.filters || []).filter(f => ds.dims[f.dim] && String(f.value ?? "").trim() !== "");
    const includeVoid = !!spec.includeVoid;
    let rows = ds.rows(from, to).filter(r => includeVoid || !r._void);
    for (const f of filters) {
      const vals = String(f.value).split(",").map(x => x.trim().toLowerCase()).filter(Boolean);
      rows = rows.filter(r => { const v = String(r[f.dim] ?? "").toLowerCase(); const hit = f.op === "contains" ? vals.some(x => v.includes(x)) : vals.includes(v); return f.op === "not" ? !hit : hit; });
    }
    const groups = new Map();
    const blank = () => ({ _n: 0, _sales: new Set(), issued: 0, used: 0, net: 0, entries: 0, units: 0, revenue: 0, discount: 0, cost: 0, tax: 0, total: 0, amount: 0, count: 0, hours: 0, scheduled: 0, shifts: 0, late: 0, orders: 0, value: 0, skus: 0, negative: 0, cost_value: 0, net_cost_value: 0, retail_value: 0, msrp_value: 0, internal_value: 0 });
    const add = (g, r) => { g._n++; if (r._sale) g._sales.add(r._sale); for (const k of Object.keys(g)) if (k[0] !== "_" && typeof r[k] === "number") g[k] += r[k]; };
    const all = blank();
    for (const r of rows) { const key = group.map(g => r[g] ?? "—").join("\u0001"); const g = groups.get(key) || groups.set(key, Object.assign(blank(), { _key: group.map(x => r[x] ?? "—") })).get(key); add(g, r); add(all, r); }
    const finish = g => {
      const sales = g._sales.size || (spec.dataset === "sales" ? g._n : 0);
      const v = { units: r2(g.units), revenue: r2(g.revenue), discount: r2(g.discount), cost: r2(g.cost), profit: r2(g.revenue - g.cost), margin: g.revenue ? r2((g.revenue - g.cost) / g.revenue * 100) : null, tax: r2(g.tax), sales, avg_price: g.units ? r2(g.revenue / g.units) : null,
        total: r2(g.total), avg_sale: sales ? r2(g.revenue / sales) : null, items_per_sale: sales ? r2(g.units / sales) : null, amount: r2(g.amount), count: g.count,
        hours: r2(g.hours), scheduled: r2(g.scheduled), difference: r2(g.hours - g.scheduled), shifts: g.shifts, late: g.late, orders: g.orders, value: r2(g.value),
        issued: r2(g.issued), used: r2(g.used), net: r2(g.net), entries: g.entries,
        skus: g.skus, negative: g.negative, cost_value: r2(g.cost_value), net_cost_value: r2(g.net_cost_value), retail_value: r2(g.retail_value), msrp_value: r2(g.msrp_value), internal_value: r2(g.internal_value) };
      return metrics.map(m => v[m]);
    };
    let out = [...groups.values()].map(g => [...g._key, ...finish(g)]);
    const sortIdx = spec.sort && metrics.includes(spec.sort) ? group.length + metrics.indexOf(spec.sort) : spec.sort && group.includes(spec.sort) ? group.indexOf(spec.sort) : -1;
    const dir = spec.dir === "asc" ? 1 : -1;
    if (sortIdx >= 0) out.sort((a, b) => { const x = a[sortIdx], y = b[sortIdx]; if (x === y) return 0; if (x == null) return 1; if (y == null) return -1; return (x < y ? -1 : 1) * dir; });
    else if (group.length && Object.keys(TIME_DIMS).includes(group[0])) out.sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    else out.sort((a, b) => (b[group.length] ?? 0) - (a[group.length] ?? 0));
    const limit = Math.min(5000, Math.max(1, +spec.limit || 500));
    return { columns: [...group.map(g => ({ key: g, label: ds.dims[g], kind: "dim" })), ...metrics.map(m => ({ key: m, label: ds.metrics[m], kind: "metric" }))], rows: out.slice(0, limit), total: rows.length ? finish(all) : metrics.map(() => null), groups: out.length, sourceRows: rows.length };
  }

  return { run, datasets: catalogOfDatasets, zonedIso, when, shiftHours };
};
