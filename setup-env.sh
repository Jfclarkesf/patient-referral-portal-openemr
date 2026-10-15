#!/bin/sh
# Fills in POSTGRES_PASSWORD and SESSION_SECRET in .env with random values.
# Run once, before the first "docker compose up".
cd "$(dirname "$0")"
[ -f .env ] || cp .env.example .env
grep -q '^POSTGRES_PASSWORD=your_secure_password_here' .env &&
  sed -i "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$(openssl rand -hex 16)|" .env
grep -q '^SESSION_SECRET=your_random_session_secret_here' .env &&
  sed -i "s|^SESSION_SECRET=.*|SESSION_SECRET=$(openssl rand -hex 32)|" .env
grep -q '^APP_PORT=' .env || printf '\nAPP_PORT=3001\n' >> .env
# 5434 was taken on our Synology; move the database to 15432
sed -i 's/^DB_PORT=5434$/DB_PORT=15432/' .env
grep -q '^DB_PORT=' .env || printf 'DB_PORT=15432\n' >> .env
echo "Done. Settings:"
grep -E '^(APP_PORT|DB_PORT)=' .env
grep -qE '^POSTGRES_PASSWORD=your_' .env && echo "POSTGRES_PASSWORD not set!" || echo "POSTGRES_PASSWORD set"
grep -qE '^SESSION_SECRET=your_' .env && echo "SESSION_SECRET not set!" || echo "SESSION_SECRET set"
