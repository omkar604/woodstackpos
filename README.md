# WOODstack POS

Self-hosted point of sale for WOODstack's stores, warehouses and website. One small server you own runs every register, the back office and online fulfilment, with no per-register fees and no outside app company holding your data.

![Sell screen](docs/screenshots/sell-light.png)

## What it does

| Area | Highlights |
|---|---|
| **Selling** | Barcode scan and search, quick buttons, size picker, discount chips, split payments, fast cash amounts, hold and resume, returns, voids, receipts, NY and NJ tax rules (clothing and footwear exemptions) |
| **Discounts** | Limits per role and per person; over-limit discounts approved on the register by someone whose limit covers it; Gold SKUs only an owner can discount |
| **Customers** | Types (Customer, Reseller, VIP, Employee, Friends & family linked to an employee), purchase history, **store credit** with full history |
| **Catalog** | Sizes per product, seven prices (cost, net cost, MSRP, first and second markdown, close-out, internal), price levels and bulk markdowns |
| **Inventory** | Stock per store, counts, transfers, **RFID counts** (reads factory SGTIN-96 tags, pairs others), WhatsApp alerts when stock goes below zero |
| **Online** | Shopify orders in every 2 minutes, scan-to-pick, pack, ship with tracking; stock sent back to Shopify with store buffers |
| **Staff** | Logins and roles, time clock with breaks (shared registers), weekly schedule, timesheets against schedule |
| **Reports** | Overview dashboard plus an open-ended report builder for owners and managers: 7 datasets, any grouping, filters, CSV, saved reports |
| **Admin** | CSV import and export for everything, nightly backups, one-command install and updates |

## Quick start (on your own computer)

Requires **Node.js 22.13 or newer**. There's nothing to install from npm.

```bash
git clone <this repo> woodstack-pos && cd woodstack-pos
node server.js add-user "Your Name" yourlogin yourpassword owner
node server.js            # → http://127.0.0.1:8080
```

On first start the server loads `data/seed.json` (outlets, registers, taxes, starter products) into `data/pos.db`.

## Deploying to a server

On a fresh Ubuntu 24.04 server (for example a $6/month DigitalOcean Droplet):

```bash
bash install.sh pos.yourdomain.com
```

This installs Node 24 and Caddy (automatic HTTPS), runs the POS as a locked-down system service, opens the firewall, and asks for the owner login. Running it again later installs an update and keeps all data. The step-by-step guide for non-technical owners, covering DNS, uploading, Shopify, WhatsApp, RFID readers and backups, is in **[docs/SETUP.md](docs/SETUP.md)**.

## Tests

```bash
npm test
```

68 endpoint tests start real servers with stand-in Shopify and WhatsApp services. They check every API endpoint and every permission and business rule, in about 5 seconds. GitHub Actions runs them on Node 22 and 24 on every push. See **[docs/TESTING.md](docs/TESTING.md)**.

## Documentation

| Doc | For |
|---|---|
| [docs/SETUP.md](docs/SETUP.md) | Installing, updating, and using every feature: the owner's guide |
| [docs/API.md](docs/API.md) | Every endpoint: request, response, errors, who can call it |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | How it fits together, the data model, business rules, background jobs, security, configuration |
| [docs/PERMISSIONS.md](docs/PERMISSIONS.md) | What viewers, cashiers, managers and owners can each do |
| [docs/TESTING.md](docs/TESTING.md) | Running and writing tests |
| [CHANGELOG.md](CHANGELOG.md) | Version history |

## Project layout

```
server.js            API, rules, sessions, document store, time clock, backups, CLI
shopify.js           Shopify orders in, stock out, fulfillment
alerts.js            WhatsApp negative-stock alerts
reports.js           Report builder engine
public/index.html    The app (all screens)
public/ws-client.js  Browser ↔ server connection and login
install.sh           Ubuntu installer / updater
data/seed.json       First-start data (live data lives in data/pos.db, never committed)
test/                Endpoint tests and stand-in services
docs/                Documentation
```

## Command line

```bash
node server.js                                   # start
node server.js add-user "Name" login pass role   # create or reset a login (owner|manager|cashier|viewer)
node server.js import file.json                  # load documents from a seed or export file
node server.js backup                            # write a backup now
```

## Data and privacy

The live database (`data/pos.db`) and backups contain sales, customers and staff logins. `.gitignore` keeps them out of this repository, so **never commit them**. Keep this repository **private**: `data/seed.json` includes store addresses and setup.
