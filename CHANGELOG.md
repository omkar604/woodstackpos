# Changelog

## 1.6.0 (2026-11-06), server version 2026.11.06-6
- New design system: dark navigation, light work surfaces, one brand colour, sentence-case type (IBM Plex), full dark mode.
- Sell screen quick buttons (managers arrange them), discount chips, fast cash amounts, hold and resume sales.
- Packing an order without scanning every item now requires a manager on the server, not just in the screen.
- Fonts load without blocking start-up.
- Endpoint test suite (68 tests), GitHub Actions CI, full documentation.

## 1.5.0, server version 2026.11.06-5
- Negative-stock WhatsApp alerts name the store, item, new count, who made the change, and who is on the clock there.
- Alerts fire once when an item first drops below zero, not on every further drop.

## 1.4.0, server version 2026.11.06-4
- Store credit with full history: pay with it, refund to it, void returns it, managers issue it with a reason.
- Customer types: Customer, Reseller, VIP, Employee, Friends & family (linked to an employee).
- Version number shown in the menu and Setup.

## 1.3.0
- WhatsApp alerts (CallMeBot or WhatsApp Business) when stock goes below zero.
- Time clock with breaks, shared-register clock-in by staff login.
- Staff schedule, timesheets against schedule, late flags, manager fixes with reasons.
- Report builder: 7 datasets, any grouping, filters, totals, chart, CSV export, saved reports.

## 1.2.0
- CSV import and export for products, staff, sales history, customers and stock counts.
- Discount limits per role and per person, with approvals from someone whose limit covers it.
- Seven prices per product (cost, net cost, MSRP, two markdowns, close-out, internal) and price levels with bulk markdowns.

## 1.1.0
- Shopify: orders in, stock out (2026 API), fulfillment with tracking.
- Online orders pick and pack with barcode scanning, packing slips and pick lists.
- Gold SKUs (owner-only discounts).
- RFID stock counts (SGTIN-96 decoding, tag pairing).

## 1.0.0
- Self-hosted server (Node + SQLite), staff logins and roles, live updates, nightly backups, one-command installer.
- Sell, sales history, catalog, inventory, transfers, customers, registers, reports, Lightspeed import.
