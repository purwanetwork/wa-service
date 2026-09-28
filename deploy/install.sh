#!/usr/bin/env bash
# Pasang wa-service dari nol di mesin baru (atau periksa pemasangan yang ada).
# Bisa diulang (idempoten); setiap langkah = satu tugas Ansible kelak.
#
# Dijalankan pemilik sebagai root, dari salinan repo wa-service:
#   sudo deploy/install.sh --check              # hanya periksa, tidak mengubah apa pun
#   sudo deploy/install.sh                      # pasang/perbarui, TIDAK start
#
# Variabel (bawaan = VM baru dengan user khusus):
#   WA_USER=wa-service  WA_GROUP=wa-service  APP_DIR=/opt/wa-service  LOG_DIR=/var/log/wa-service
# Server lama (sekarang): WA_USER=oyod WA_GROUP=oyod APP_DIR=/var/www/wa-service
#
# Tidak pernah: membuat/menulis nilai rahasia, mencetak isi .env, menyentuh
# folder sessions yang sudah ada, atau menjalankan layanan.
set -euo pipefail

WA_USER="${WA_USER:-wa-service}"
WA_GROUP="${WA_GROUP:-$WA_USER}"
APP_DIR="${APP_DIR:-/opt/wa-service}"
LOG_DIR="${LOG_DIR:-/var/log/wa-service}"
NODE_MIN_MAJOR=22
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHECK_ONLY=0

[[ "${1:-}" == "--check" ]] && CHECK_ONLY=1

ok() { printf 'OK    %s\n' "$*"; }
todo() { printf 'UBAH  %s\n' "$*"; }
fail() { printf 'GAGAL %s\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || fail "jalankan sebagai root (sudo)."

# 1. Node >= 22 (dipasang pemilik lewat paket distro/NodeSource; skrip tidak mengunduh apa pun).
if ! command -v node >/dev/null; then
  fail "node belum terpasang. Pasang Node ${NODE_MIN_MAJOR} LTS dulu (mis. paket nodejs dari NodeSource), lalu ulangi."
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
(( NODE_MAJOR >= NODE_MIN_MAJOR )) || fail "node ${NODE_MAJOR} terlalu lama; butuh >= ${NODE_MIN_MAJOR}."
ok "node $(node -v) di $(command -v node)"

# 2. User layanan (tanpa login).
if id "$WA_USER" >/dev/null 2>&1; then
  ok "user $WA_USER ada"
elif (( CHECK_ONLY )); then
  todo "user $WA_USER belum ada"
else
  useradd --system --home-dir "$APP_DIR" --shell /usr/sbin/nologin --user-group "$WA_USER"
  ok "user $WA_USER dibuat"
fi

# 3. Folder dan izin: kode milik root (tidak bisa diubah proses), data milik user layanan.
ensure_dir() { # path owner:group mode
  local path="$1" owner="$2" mode="$3"
  if [[ -d "$path" && "$(stat -c '%U:%G %a' "$path")" == "$owner $mode" ]]; then
    ok "$path $owner $mode"
  elif (( CHECK_ONLY )); then
    todo "$path harus $owner $mode (sekarang: $(stat -c '%U:%G %a' "$path" 2>/dev/null || echo 'tidak ada'))"
  else
    install -d -o "${owner%%:*}" -g "${owner##*:}" -m "$mode" "$path"
    ok "$path $owner $mode"
  fi
}
ensure_dir "$APP_DIR" "root:$WA_GROUP" 750
ensure_dir "$APP_DIR/sessions" "$WA_USER:$WA_GROUP" 700
ensure_dir "$APP_DIR/state" "$WA_USER:$WA_GROUP" 700
ensure_dir "$LOG_DIR" "$WA_USER:adm" 2750

# 4. Kode (tanpa node_modules/.env/sessions/state/log/tes) lalu dependensi persis dari lockfile.
if (( CHECK_ONLY )); then
  [[ -f "$APP_DIR/index.js" ]] && ok "kode ada di $APP_DIR" || todo "kode belum disalin ke $APP_DIR"
else
  rsync -a --delete \
    --exclude node_modules --exclude .env --exclude sessions --exclude state --exclude auth_session \
    --exclude logs --exclude '*.log' --exclude '*.log.*' --exclude .git --exclude test \
    "$SRC_DIR/" "$APP_DIR/"
  chown -R "root:$WA_GROUP" "$APP_DIR"
  chown "$WA_USER:$WA_GROUP" "$APP_DIR/sessions" "$APP_DIR/state"
  find "$APP_DIR" -path "$APP_DIR/sessions" -prune -o -path "$APP_DIR/state" -prune -o -type d -exec chmod 750 {} +
  find "$APP_DIR" -path "$APP_DIR/sessions" -prune -o -path "$APP_DIR/state" -prune -o -type f -exec chmod 640 {} +
  chmod 750 "$APP_DIR/deploy/install.sh"
  (cd "$APP_DIR" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund)
  chown -R "root:$WA_GROUP" "$APP_DIR/node_modules"
  ok "kode + node_modules (npm ci) di $APP_DIR"
fi

# 5. .env: hanya dibuat dari templat bila belum ada (0600 milik user layanan); isi TIDAK dicetak.
if [[ -f "$APP_DIR/.env" ]]; then
  [[ "$(stat -c '%U %a' "$APP_DIR/.env")" == "$WA_USER 600" ]] && ok ".env ada ($WA_USER 600)" || todo ".env harus milik $WA_USER mode 600"
  for key in WA_SERVICE_TOKEN WA_CALLBACK_URL WA_CALLBACK_SECRET LOG_DIR; do
    grep -Eq "^${key}=.+" "$APP_DIR/.env" && ok ".env: $key terisi" || todo ".env: $key kosong"
  done
elif (( CHECK_ONLY )); then
  todo ".env belum ada"
else
  install -o "$WA_USER" -g "$WA_GROUP" -m 600 "$SRC_DIR/.env.example" "$APP_DIR/.env"
  sed -i "s#^LOG_DIR=.*#LOG_DIR=$LOG_DIR#" "$APP_DIR/.env"
  todo ".env dibuat dari templat: isi WA_SERVICE_TOKEN, WA_CALLBACK_*, HOST/WA_ALLOWED_IPS (sudoedit $APP_DIR/.env)"
fi

# 6. Unit systemd dan logrotate dirender dari deploy/ untuk user/folder mesin ini.
render() { sed -e "s#/var/www/wa-service#$APP_DIR#g" -e "s#^User=oyod#User=$WA_USER#" -e "s#^Group=oyod#Group=$WA_GROUP#" \
  -e "s#/var/log/wa-service#$LOG_DIR#g" -e "s#su oyod adm#su $WA_USER adm#" -e "s#^ExecStart=/usr/bin/node#ExecStart=$(command -v node)#" "$1"; }
install_rendered() { # sumber tujuan
  if [[ -f "$2" ]] && diff -q <(render "$1") "$2" >/dev/null; then
    ok "$2 sesuai"
  elif (( CHECK_ONLY )); then
    todo "$2 berbeda/tidak ada"
  else
    render "$1" > "$2.tmp" && chmod 644 "$2.tmp" && mv "$2.tmp" "$2"
    ok "$2 dipasang"
  fi
}
install_rendered "$SRC_DIR/deploy/wa-service.service" /etc/systemd/system/wa-service.service
install_rendered "$SRC_DIR/deploy/logrotate-wa-service" /etc/logrotate.d/wa-service

if (( ! CHECK_ONLY )); then
  systemctl daemon-reload
  systemctl enable wa-service >/dev/null
  logrotate --debug /etc/logrotate.d/wa-service >/dev/null 2>&1 && ok "logrotate valid" || todo "logrotate --debug gagal: periksa /etc/logrotate.d/wa-service"
  ok "unit di-enable, BELUM di-start. Isi .env, pindahkan sessions (bila ada), lalu: systemctl start wa-service"
fi
