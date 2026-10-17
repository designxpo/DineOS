#!/bin/sh
# Mezmitra print agent installer for macOS, Linux and Raspberry Pi.
#
# Copy the command from Mezmitra > Settings > Printers > Add print computer:
#   Linux / Raspberry Pi:  curl -fsSL https://<site>/agent/install.sh | sudo sh -s -- --web ... --api ... --token dv_...
#   Mac (no sudo):         curl -fsSL https://<site>/agent/install.sh | sh -s -- --web ... --api ... --token dv_...
#
# It installs Node.js if needed (apt on Debian, Ubuntu and Raspberry Pi OS; Homebrew on a Mac),
# puts the agent in /opt/dineos (Mac: ~/Library/Application Support/DineOS) and runs it as a
# service that starts with the computer and restarts if it stops. Run it again to update.
# To remove:  Linux: sudo systemctl disable --now dineos-print-agent
#             Mac:   launchctl unload ~/Library/LaunchAgents/in.dineos.print-agent.plist
set -eu

WEB=""
API=""
TOKEN=""
HUB=0
SERVICE=1
DIR=""
while [ $# -gt 0 ]; do
  case "$1" in
    --web) WEB="$2"; shift 2 ;;
    --api) API="$2"; shift 2 ;;
    --token) TOKEN="$2"; shift 2 ;;
    --hub) HUB=1; shift ;;
    --dir) DIR="$2"; shift 2 ;;
    --no-service) SERVICE=0; shift ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done
case "$TOKEN" in
  dv_*) ;;
  *) echo "Copy the full command from Mezmitra (Settings > Printers) and run it again." >&2; exit 1 ;;
esac
if [ -z "$WEB" ] || [ -z "$API" ]; then
  echo "Copy the full command from Mezmitra (Settings > Printers) and run it again." >&2
  exit 1
fi
# The agent and its key travel over these addresses: HTTPS only (plain HTTP just for local tests).
for url in "$WEB" "$API"; do
  case "$url" in
    https://* | http://localhost* | http://127.0.0.1*) ;;
    *) echo "The Mezmitra address must start with https:// ($url)" >&2; exit 1 ;;
  esac
done

OS=$(uname -s)
say() { printf '\n==> %s\n' "$1"; }
node_ok() { command -v node >/dev/null 2>&1 && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 20 ]; }

if ! node_ok; then
  if [ "$OS" = "Linux" ] && command -v apt-get >/dev/null 2>&1; then
    if [ "$(id -u)" -ne 0 ]; then echo "Run the command with sudo so Node.js can be installed." >&2; exit 1; fi
    say "Installing Node.js 22"
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt-get install -y nodejs
  elif [ "$OS" = "Darwin" ] && command -v brew >/dev/null 2>&1; then
    say "Installing Node.js with Homebrew"
    brew install node
  else
    echo "Install Node.js 22 (LTS) from https://nodejs.org, then run the command again." >&2
    exit 1
  fi
fi
NODE=$(command -v node)

if [ -z "$DIR" ]; then
  # The folder and service names keep the product's earlier name (DineOS), so print computers
  # that already run the agent upgrade in place instead of getting a second copy.
  if [ "$OS" = "Darwin" ]; then DIR="$HOME/Library/Application Support/DineOS"; else DIR=/opt/dineos; fi
fi
say "Installing the Mezmitra print agent in $DIR"
mkdir -p "$DIR"
curl -fsSL "$WEB/agent/dineos-agent.mjs" -o "$DIR/dineos-agent.mjs.new"
# Install only the exact file published with the site (a damaged, cut-off or stale download is
# refused, and the running agent is left as it was).
EXPECTED=$(curl -fsSL "$WEB/agent/dineos-agent.mjs.sha256" | cut -d' ' -f1)
ACTUAL=$( (sha256sum "$DIR/dineos-agent.mjs.new" 2>/dev/null || shasum -a 256 "$DIR/dineos-agent.mjs.new") | cut -d' ' -f1)
if [ -z "$EXPECTED" ] || [ "$EXPECTED" != "$ACTUAL" ]; then
  rm -f "$DIR/dineos-agent.mjs.new"
  echo "The downloaded agent does not match its published checksum, so nothing was installed. Run the command again." >&2
  exit 1
fi
mv "$DIR/dineos-agent.mjs.new" "$DIR/dineos-agent.mjs"
HUBJSON=""
if [ "$HUB" -eq 1 ]; then HUBJSON=', "hub": true'; fi
# The file holds the outlet's printing key: readable by its owner only.
(umask 077 && printf '{ "api_url": "%s", "token": "%s", "log_file": "agent.log"%s }\n' "$API" "$TOKEN" "$HUBJSON" > "$DIR/dineos-agent.json")

if [ "$SERVICE" -eq 1 ]; then
  if [ "$OS" = "Darwin" ]; then
    say "Starting it when you log in"
    PLIST="$HOME/Library/LaunchAgents/in.dineos.print-agent.plist"
    mkdir -p "$HOME/Library/LaunchAgents"
    cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>in.dineos.print-agent</string>
  <key>ProgramArguments</key>
  <array><string>$NODE</string><string>$DIR/dineos-agent.mjs</string></array>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardErrorPath</key><string>$DIR/agent-error.log</string>
</dict>
</plist>
EOF
    launchctl unload "$PLIST" 2>/dev/null || true
    launchctl load -w "$PLIST"
  elif command -v systemctl >/dev/null 2>&1; then
    if [ "$(id -u)" -ne 0 ]; then echo "Run the command with sudo to install the service." >&2; exit 1; fi
    say "Starting it with the computer"
    cat > /etc/systemd/system/dineos-print-agent.service <<EOF
[Unit]
Description=DineOS print agent
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=$NODE $DIR/dineos-agent.mjs
WorkingDirectory=$DIR
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
    systemctl daemon-reload
    systemctl enable dineos-print-agent >/dev/null 2>&1
    systemctl restart dineos-print-agent
  else
    echo "No service manager found. Start it with: node \"$DIR/dineos-agent.mjs\""
  fi
fi

say "Done. In Mezmitra (Settings > Printers) this computer shows as Online within a minute; choose its printers there."
echo "Log: $DIR/agent.log"
