#!/usr/bin/env bash
# Install txcat as a systemd service inside a Debian/Ubuntu LXC. Run as root from the repo checkout.
set -euo pipefail

SRC="$(cd "$(dirname "$0")/.." && pwd)"

apt-get install -y python3 python3-venv >/dev/null
id txcat >/dev/null 2>&1 || useradd --system --home /var/lib/txcat --shell /usr/sbin/nologin txcat

install -d -m 755 /opt/txcat
python3 -m venv /opt/txcat/venv
/opt/txcat/venv/bin/pip install --quiet --upgrade pip
/opt/txcat/venv/bin/pip install --quiet "$SRC[anthropic]"
ln -sf /opt/txcat/venv/bin/txcat /usr/local/bin/txcat

install -d -m 750 -o root -g txcat /etc/txcat
install -d -m 750 -o txcat -g txcat /var/lib/txcat
[ -f /etc/txcat/config.toml ] || install -m 640 -o root -g txcat "$SRC/config.example.toml" /etc/txcat/config.toml
if [ ! -f /etc/txcat/txcat.env ]; then
  umask 077
  printf 'ANTHROPIC_API_KEY=\nTXCAT_API_TOKEN=%s\n' "$(python3 -c 'import secrets; print(secrets.token_urlsafe(24))')" > /etc/txcat/txcat.env
  chown root:txcat /etc/txcat/txcat.env && chmod 640 /etc/txcat/txcat.env
fi

install -m 644 "$SRC/deploy/txcat.service" /etc/systemd/system/txcat.service
systemctl daemon-reload
systemctl enable txcat >/dev/null

echo "Installed. Next:"
echo "  1. edit /etc/txcat/txcat.env (ANTHROPIC_API_KEY) and /etc/txcat/config.toml (categories, provider)"
echo "  2. systemctl start txcat && curl -s localhost:8765/health"
