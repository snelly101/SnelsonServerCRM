#!/bin/bash
# One-time hardening + Docker install for a fresh Debian 12 VPS.
# Run as root:  bash server-setup.sh <deploy-username> "<your ssh public key>"
set -euo pipefail
DEPLOY_USER=${1:?deploy username}
SSH_KEY=${2:?ssh public key}

apt-get update && apt-get -y upgrade
apt-get -y install ca-certificates curl gnupg ufw fail2ban unattended-upgrades git

# Docker (official repo)
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian bookworm stable" > /etc/apt/sources.list.d/docker.list
apt-get update && apt-get -y install docker-ce docker-ce-cli containerd.io docker-compose-plugin

# Deploy user with SSH key, no password login, docker group
id -u "$DEPLOY_USER" >/dev/null 2>&1 || adduser --disabled-password --gecos "" "$DEPLOY_USER"
usermod -aG docker "$DEPLOY_USER"
mkdir -p /home/$DEPLOY_USER/.ssh && echo "$SSH_KEY" >> /home/$DEPLOY_USER/.ssh/authorized_keys
chown -R $DEPLOY_USER:$DEPLOY_USER /home/$DEPLOY_USER/.ssh && chmod 700 /home/$DEPLOY_USER/.ssh && chmod 600 /home/$DEPLOY_USER/.ssh/authorized_keys
sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/; s/^#\?PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config
systemctl restart ssh

# Firewall: SSH, HTTP, HTTPS only
ufw default deny incoming && ufw default allow outgoing
ufw allow 22/tcp && ufw allow 80/tcp && ufw allow 443/tcp
ufw --force enable

# Automatic security updates + SSH brute-force protection
dpkg-reconfigure -f noninteractive unattended-upgrades
systemctl enable --now fail2ban

echo "Done. Log in as $DEPLOY_USER and follow docs/deployment.md."
