#!/bin/bash
# =============================================================================
# Realtime Gateway — Droplet Setup Script
# Run as root on the chat.amaterky.com Droplet (replaces chat-service)
#
# Usage: bash setup.sh
# =============================================================================

set -euo pipefail

echo "=== Realtime Gateway Droplet Setup ==="
echo ""

# -------------------------------------------------------------------
# 1. System update
# -------------------------------------------------------------------
echo "[1/8] Updating system packages..."
apt update && apt upgrade -y

# -------------------------------------------------------------------
# 2. Node.js 22 via NodeSource
# -------------------------------------------------------------------
echo "[2/8] Installing Node.js 22..."
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs
echo "Node.js $(node -v) installed"
echo "npm $(npm -v) installed"

# -------------------------------------------------------------------
# 3. PostgreSQL 15
# -------------------------------------------------------------------
echo "[3/8] Installing PostgreSQL..."
apt install -y postgresql postgresql-contrib
systemctl enable postgresql

# -------------------------------------------------------------------
# 4. Redis
# -------------------------------------------------------------------
echo "[4/8] Installing Redis..."
apt install -y redis-server
systemctl enable redis-server

# Harden Redis config
sed -i 's/^# maxmemory .*/maxmemory 128mb/' /etc/redis/redis.conf
sed -i 's/^maxmemory .*/maxmemory 128mb/' /etc/redis/redis.conf
grep -q '^maxmemory ' /etc/redis/redis.conf || echo 'maxmemory 128mb' >> /etc/redis/redis.conf

sed -i 's/^# maxmemory-policy .*/maxmemory-policy allkeys-lru/' /etc/redis/redis.conf
sed -i 's/^maxmemory-policy .*/maxmemory-policy allkeys-lru/' /etc/redis/redis.conf
grep -q '^maxmemory-policy ' /etc/redis/redis.conf || echo 'maxmemory-policy allkeys-lru' >> /etc/redis/redis.conf

systemctl restart redis-server
echo "Redis configured (128mb, allkeys-lru)"

# -------------------------------------------------------------------
# 5. PostgreSQL — create DB and user
# -------------------------------------------------------------------
echo "[5/8] Setting up PostgreSQL database..."
read -sp "Enter a password for the chat_user DB user: " DB_PASSWORD
echo ""

sudo -u postgres psql <<SQL
CREATE USER chat_user WITH PASSWORD '${DB_PASSWORD}';
CREATE DATABASE chat_service OWNER chat_user;
SQL
echo "Database 'chat_service' created with user 'chat_user'"

# -------------------------------------------------------------------
# 6. Clone and build the app
# -------------------------------------------------------------------
echo "[6/8] Cloning and building realtime-gateway..."
mkdir -p /var/www
cd /var/www

if [ -d "realtime-gateway" ]; then
    echo "Directory /var/www/realtime-gateway already exists — pulling latest..."
    cd realtime-gateway
    git pull origin main
else
    git clone https://github.com/Jaroslav001/realtime-gateway.git
    cd realtime-gateway
fi

npm ci --production=false
npx prisma generate
npm run build
echo "Build complete"

# -------------------------------------------------------------------
# 7. Create .env (interactive)
# -------------------------------------------------------------------
echo "[7/8] Creating .env file..."
read -sp "Enter JWT_SECRET (must match Laravel api/.env): " JWT_SECRET
echo ""
read -p "Enter CORS_ORIGINS (e.g. https://amaterky.com): " CORS_ORIGINS

cat > /var/www/realtime-gateway/.env <<EOF
PORT=3002
NODE_ENV=production

DATABASE_URL="postgresql://chat_user:${DB_PASSWORD}@localhost:5432/chat_service"

REDIS_HOST=127.0.0.1
REDIS_PORT=6379
REDIS_DB=1

JWT_SECRET=${JWT_SECRET}

CORS_ORIGINS=${CORS_ORIGINS}
EOF
echo ".env created"

# -------------------------------------------------------------------
# 8. Run Prisma migrations
# -------------------------------------------------------------------
echo "[8/8] Running Prisma migrations..."
cd /var/www/realtime-gateway
npx prisma migrate deploy
echo "Migrations complete"

# -------------------------------------------------------------------
# PM2 setup
# -------------------------------------------------------------------
echo ""
echo "=== Setting up PM2 ==="
npm install -g pm2
mkdir -p /var/log/pm2

# Stop old chat-service if running
pm2 delete chat-service 2>/dev/null || true

pm2 start ecosystem.config.js
pm2 save
pm2 startup | tail -1 | bash
echo "PM2 configured — realtime-gateway is running"

# -------------------------------------------------------------------
# Nginx setup
# -------------------------------------------------------------------
echo ""
echo "=== Setting up Nginx ==="
apt install -y nginx

cp /var/www/realtime-gateway/deploy/nginx.conf /etc/nginx/sites-available/realtime-gateway
ln -sf /etc/nginx/sites-available/realtime-gateway /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
rm -f /etc/nginx/sites-enabled/chat-service

nginx -t && systemctl restart nginx
systemctl enable nginx
echo "Nginx configured"

# -------------------------------------------------------------------
# Firewall
# -------------------------------------------------------------------
echo ""
echo "=== Configuring firewall ==="
ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw --force enable
echo "Firewall enabled (SSH + Nginx)"

# -------------------------------------------------------------------
# Done
# -------------------------------------------------------------------
echo ""
echo "============================================"
echo "  Realtime Gateway deployment complete!"
echo "============================================"
echo ""
echo "Next steps:"
echo "  1. DNS: chat.amaterky.com should already point here"
echo "  2. SSL: certbot --nginx -d chat.amaterky.com"
echo "     (apt install -y certbot python3-certbot-nginx)"
echo "  3. Verify: curl http://localhost:3002/api/v1/health"
echo "  4. Logs: pm2 logs realtime-gateway"
echo ""
