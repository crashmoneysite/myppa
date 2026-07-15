#!/bin/bash
# =========================================================================
# Ultimate Node Setup: Optimization & Anti-Abuse Firewall
# Designed for high-concurrency VPN infrastructure on Hetzner
# =========================================================================

# Ensure the script is run as root
if [ "$EUID" -ne 0 ]; then
  echo "Please run this script as root."
  exit 1
fi

echo "========================================================================="
echo "Phase 1: High-Performance Kernel & Network Optimization"
echo "========================================================================="

echo "Backing up current sysctl configuration..."
cp /etc/sysctl.conf /etc/sysctl.conf.bak

echo "Applying kernel optimizations..."
cat > /etc/sysctl.d/99-vpn-optimization.conf << EOF
# 1. BBR Congestion Control
net.core.default_qdisc = fq
net.ipv4.tcp_congestion_control = bbr

# 2. File Descriptors Limits (High Concurrency)
fs.file-max = 1048576
fs.nr_open = 1048576

# 3. TCP Buffer and Network Stack Tuning
net.core.rmem_max = 16777216
net.core.wmem_max = 16777216
net.core.rmem_default = 1048576
net.core.wmem_default = 1048576
net.ipv4.tcp_rmem = 4096 1048576 16777216
net.ipv4.tcp_wmem = 4096 1048576 16777216
net.core.netdev_max_backlog = 16384
net.core.somaxconn = 32768
net.ipv4.tcp_max_syn_backlog = 32768

# 4. Connection Management & Time-Wait Optimization
net.ipv4.tcp_tw_reuse = 1
net.ipv4.tcp_fin_timeout = 15
net.ipv4.tcp_keepalive_time = 600
net.ipv4.tcp_keepalive_intvl = 30
net.ipv4.tcp_keepalive_probes = 5
net.ipv4.ip_local_port_range = 1024 65535
net.ipv4.tcp_syncookies = 1
EOF

echo "Applying System Security Limits for File Descriptors..."
cat > /etc/security/limits.d/99-vpn-limits.conf << EOF
* soft nofile 1048576
* hard nofile 1048576
root soft nofile 1048576
root hard nofile 1048576
EOF

echo "Loading new sysctl rules..."
sysctl --system > /dev/null

echo "========================================================================="
echo "Phase 2: Professional Anti-Abuse Firewall Setup"
echo "========================================================================="

echo "Installing iptables-persistent to save rules..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -y -q iptables-persistent netfilter-persistent

echo "Flushing existing rules..."
iptables -F
iptables -X
iptables -t nat -F
iptables -t nat -X
iptables -t mangle -F
iptables -t mangle -X

ip6tables -F
ip6tables -X
ip6tables -t mangle -F
ip6tables -t mangle -X

# Default Policies
iptables -P INPUT DROP
iptables -P FORWARD ACCEPT
iptables -P OUTPUT ACCEPT
ip6tables -P INPUT DROP
ip6tables -P FORWARD ACCEPT
ip6tables -P OUTPUT ACCEPT

# Allow Loopback & Established connections
iptables -A INPUT -i lo -j ACCEPT
iptables -A INPUT -m state --state ESTABLISHED,RELATED -j ACCEPT
ip6tables -A INPUT -i lo -j ACCEPT
ip6tables -A INPUT -m state --state ESTABLISHED,RELATED -j ACCEPT

# Allow Specific Inbound Ports
ALLOWED_PORTS="80 443 22 2087 8080 8443 60000"
for port in $ALLOWED_PORTS; do
    iptables -A INPUT -p tcp --dport $port -j ACCEPT
    iptables -A INPUT -p udp --dport $port -j ACCEPT
    ip6tables -A INPUT -p tcp --dport $port -j ACCEPT
    ip6tables -A INPUT -p udp --dport $port -j ACCEPT
done

# Allow ICMP (Ping)
iptables -A INPUT -p icmp -j ACCEPT
ip6tables -A INPUT -p ipv6-icmp -j ACCEPT

# Anti-Abuse: Block Outbound SMTP (Spamhaus)
SMTP_PORTS="25 465 587"
for port in $SMTP_PORTS; do
    iptables -A OUTPUT -p tcp --dport $port -j REJECT
    iptables -A FORWARD -p tcp --dport $port -j REJECT
    ip6tables -A OUTPUT -p tcp --dport $port -j REJECT
    ip6tables -A FORWARD -p tcp --dport $port -j REJECT
done

# Anti-Abuse: Block Malware/Worms Ports
MALWARE_PORTS="135 137 138 139 445"
for port in $MALWARE_PORTS; do
    iptables -A OUTPUT -p tcp --dport $port -j REJECT
    iptables -A FORWARD -p tcp --dport $port -j REJECT
    ip6tables -A OUTPUT -p tcp --dport $port -j REJECT
    ip6tables -A FORWARD -p tcp --dport $port -j REJECT
done

# Anti-Abuse: Rate Limit TCP SYN (Scan Detected)
iptables -A FORWARD -p tcp --syn -m limit --limit 5/s --limit-burst 10 -j ACCEPT
iptables -A FORWARD -p tcp --syn -j DROP
ip6tables -A FORWARD -p tcp --syn -m limit --limit 5/s --limit-burst 10 -j ACCEPT
ip6tables -A FORWARD -p tcp --syn -j DROP

# Anti-Abuse: Block Internal Hetzner Networks
PRIVATE_NETWORKS="10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 100.64.0.0/10 169.254.0.0/16"
for net in $PRIVATE_NETWORKS; do
    iptables -A OUTPUT -d $net -j REJECT
    iptables -A FORWARD -d $net -j REJECT
done

# Save Rules
echo "Saving firewall rules..."
netfilter-persistent save > /dev/null
netfilter-persistent reload > /dev/null

echo "========================================================================="
echo "Node Setup Completed Successfully!"
echo "- BBR Status:" $(sysctl -n net.ipv4.tcp_congestion_control)
echo "- Server is now optimized for high concurrency."
echo "- Firewall is active (Spam, Malware, and Scanning blocked)."
echo "========================================================================="
