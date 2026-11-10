#!/usr/bin/env bash
# Woodstack POS installer for a fresh Ubuntu 22.04 or 24.04 server.
# Run from inside the unzipped folder:   sudo bash install.sh pos.yourdomain.com
# Safe to run again later to install an update: your data is kept.
set -euo pipefail

DOMAIN="${1:-}"
APP_DIR=/opt/woodstack-pos
SRC_DIR="$(cd "$(dirname "$0")" && pwd)"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
if [ "$(id -u)" -ne 0 ]; then echo "Run this with sudo:  sudo bash install.sh $DOMAIN"; exit 1; fi
if [ -z "$DOMAIN" ]; then echo "Tell me the web address. Example:  sudo bash install.sh pos.woodstack.com"; exit 1; fi

say "1/6  Installing system updates and tools"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y curl ca-certificates gnupg debian-keyring debian-archive-keyring apt-transport-https ufw

say "2/6  Installing Node.js 24"
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
  apt-get install -y nodejs
fi
node --version

say "3/6  Installing Caddy (handles HTTPS certificates automatically)"
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y
  apt-get install -y caddy
fi

say "4/6  Copying the POS to $APP_DIR"
id woodstack >/dev/null 2>&1 || useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin woodstack
mkdir -p "$APP_DIR/data/backups"
cp "$SRC_DIR"/*.js "$APP_DIR/"
rm -rf "$APP_DIR/public" && cp -r "$SRC_DIR/public" "$APP_DIR/public"
# Starting data is only used the very first time; existing data is never overwritten.
[ -f "$APP_DIR/data/pos.db" ] || cp "$SRC_DIR/data/seed.json" "$APP_DIR/data/seed.json"
chown -R woodstack:woodstack "$APP_DIR"
chmod 700 "$APP_DIR/data"

cat > /etc/systemd/system/woodstack-pos.service <<EOF
[Unit]
Description=Woodstack POS
After=network.target

[Service]
User=woodstack
WorkingDirectory=$APP_DIR
Environment=NODE_ENV=production
Environment=PORT=8080
Environment=HOST=127.0.0.1
Environment=NODE_NO_WARNINGS=1
ExecStart=$(command -v node) $APP_DIR/server.js
Restart=always
RestartSec=3
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=$APP_DIR/data
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable woodstack-pos >/dev/null
systemctl restart woodstack-pos

say "5/6  Setting up the web address $DOMAIN with HTTPS"
cat > /etc/caddy/Caddyfile <<EOF
$DOMAIN {
	encode gzip
	reverse_proxy 127.0.0.1:8080 {
		flush_interval -1
	}
}
EOF
systemctl reload caddy || systemctl restart caddy

ufw allow OpenSSH >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null

say "6/6  Owner login"
sleep 2
if sudo -u woodstack env NODE_NO_WARNINGS=1 node -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('$APP_DIR/data/pos.db');process.exit(d.prepare('select count(*) n from users').get().n?0:1)" 2>/dev/null; then
  echo "Logins already exist. Skipping."
else
  read -rp "Your full name: " ONAME
  read -rp "Choose a login (for example your first name): " OLOGIN
  while true; do
    read -rsp "Choose a password (8+ characters): " OPW; echo
    read -rsp "Type it again: " OPW2; echo
    [ "$OPW" = "$OPW2" ] && [ ${#OPW} -ge 8 ] && break
    echo "Passwords didn't match or were shorter than 8 characters. Try again."
  done
  cd "$APP_DIR" && sudo -u woodstack env NODE_NO_WARNINGS=1 node server.js add-user "$ONAME" "$OLOGIN" "$OPW" owner
fi

sleep 2
if systemctl is-active --quiet woodstack-pos; then
  say "Done. Open https://$DOMAIN and log in."
  echo "If the page doesn't load yet, the web address may still be pointing elsewhere. DNS changes can take up to an hour."
else
  say "The POS didn't start. Send this to whoever is helping you:"
  journalctl -u woodstack-pos -n 30 --no-pager
fi
