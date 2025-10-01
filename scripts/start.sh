#!/bin/bash

printf "### Starting ZeroTier interface for BalenaOS container\n"

# Start ZeroTier service directly (not using systemctl in container)
zerotier-one -d
sleep 5

# Check if ZeroTier is running
if ! pgrep -x "zerotier-one" > /dev/null; then
  printf "### ERROR: ZeroTier process not running, starting manually\n"
  nohup zerotier-one > /var/log/zerotier.log 2>&1 &
  sleep 5
fi

# Join the ZeroTier network
printf "### Joining ZeroTier network: $ZT_NETWORK
"
zerotier-cli join $ZT_NETWORK

# Run ZeroTier auto-authorization immediately after joining if API key is provided
if [ -n "$ZT_API_KEY" ]; then
    printf "### Running ZeroTier auto-authorization...\n"
    if [ -f "/scripts/zerotier-auto-authorize.sh" ]; then
        /scripts/zerotier-auto-authorize.sh
        if [ $? -eq 0 ]; then
            printf "### ZeroTier auto-authorization completed successfully\n"
        else
            printf "### WARNING: ZeroTier auto-authorization failed\n"
        fi
    else
        printf "### WARNING: ZeroTier auto-authorization script not found\n"
    fi
else
    printf "### Skipping auto-authorization (ZT_API_KEY not provided)\n"
fi

# Wait for network to be established and get assigned an IP
printf "### Waiting for ZeroTier network to be ready...\n"
COUNTER=0
MAX_TRIES=30
ZT_STATUS=""
ZT_CONNECTED=false

# First, wait for the network to appear in the list
while [ $COUNTER -lt $MAX_TRIES ] && [ "$ZT_CONNECTED" != "true" ]; do
  # Check if the network is listed
  if [ -z "$ZT_NETWORK" ]; then
    NETWORK_INFO=""
  else
    NETWORK_INFO=$(zerotier-cli listnetworks | grep "$ZT_NETWORK" || true)
  fi
  
  if [ -z "$NETWORK_INFO" ]; then
    printf "Network not found yet. Waiting... ($COUNTER/$MAX_TRIES)\n"
  else
    printf "Found network: $NETWORK_INFO\n"
    
    # Get the actual ZeroTier interface from ip link
    ZT_INTERFACES=$(ip link | grep -i zt | awk -F: '{print $2}' | tr -d ' ' || echo "")
    if [ ! -z "$ZT_INTERFACES" ]; then
      ZT_IFACE=$(echo "$ZT_INTERFACES" | head -n1)
      printf "Found ZeroTier interface from system: $ZT_IFACE\n"
      
      # Get the actual IP address from the interface
      ZT_IP=$(ip addr show $ZT_IFACE | grep -w inet | awk '{print $2}' | cut -d/ -f1)
      if [ ! -z "$ZT_IP" ]; then
        printf "ZeroTier connected with IP: $ZT_IP\n"
        ZT_CONNECTED=true
        break
      else
        printf "Waiting for IP assignment... ($COUNTER/$MAX_TRIES)\n"
      fi
    else
      printf "Waiting for ZeroTier interface... ($COUNTER/$MAX_TRIES)\n"
    fi
    
    # Also check status from zerotier-cli
    ZT_STATUS=$(echo "$NETWORK_INFO" | awk '{print $6}')
    printf "ZeroTier status: $ZT_STATUS\n"
  fi
  
  sleep 2
  COUNTER=$((COUNTER+1))
done

# If we've waited the maximum time and still don't have a connection
if [ "$ZT_CONNECTED" != "true" ]; then
  printf "### WARNING: ZeroTier connection may not be fully established\n"
  printf "### Checking if we can proceed anyway...\n"
  
  # Force a status update from ZeroTier
  printf "### Requesting network status update...\n"
  zerotier-cli -j info || true
  zerotier-cli listnetworks || true
  
  # Give it a moment to update
  sleep 5
  
  # Try again with more direct methods
  printf "### Checking for ZeroTier interfaces in system...\n"
  ZT_INTERFACES=$(ip link | grep -i zt | awk -F: '{print $2}' | tr -d ' ' || echo "")
  
  if [ ! -z "$ZT_INTERFACES" ]; then
    # Take the first ZeroTier interface found
    ZT_IFACE=$(echo "$ZT_INTERFACES" | head -n1)
    printf "### Found ZeroTier interface: $ZT_IFACE - proceeding\n"
    ZT_CONNECTED=true
    
    # Try to get the IP address for this interface
    ZT_IP=$(ip addr show $ZT_IFACE | grep -w inet | awk '{print $2}' || echo "")
    if [ ! -z "$ZT_IP" ]; then
      printf "### ZeroTier interface has IP: $ZT_IP\n"
    else
      printf "### WARNING: ZeroTier interface has no IP address\n"
    fi
  else
    printf "### ERROR: Could not find any ZeroTier interface\n"
    
    # Last resort - check if zerotier-one is running via process check
    if pgrep -x "zerotier-one" > /dev/null; then
      printf "### ZeroTier process is running, will proceed anyway\n"
      ZT_CONNECTED=true
      ZT_IFACE="zt0" # Use a default name as fallback
    else
      printf "### ERROR: ZeroTier process is not running\n"
      # Try to start it again
      printf "### Attempting to start ZeroTier again...\n"
      nohup zerotier-one > /var/log/zerotier.log 2>&1 &
      sleep 5
      ZT_IFACE="zt0" # Use a default name as fallback
    fi
  fi
fi

# Get physical interface(s) - BalenaOS typically uses eth0 or similar
PHY_IFACE="$(ip route | grep default | awk '{print $5}' | sort -u)"
if [ -z "$PHY_IFACE" ]; then
  # Fallback for BalenaOS
  PHY_IFACE="eth0"
  printf "### No default route found, using fallback interface: $PHY_IFACE
"
else
  printf "### Physical interface(s): $PHY_IFACE
"
fi

# If we don't already have the ZeroTier interface, find it now
if [ -z "$ZT_IFACE" ]; then
  printf "### Looking for ZeroTier interface in the system\n"
  
  # Look for any interface that starts with zt
  ZT_INTERFACES=$(ip link | grep -o -E "[[:space:]]zt[[:alnum:]]+" | tr -d ' ' || echo "")
  
  if [ ! -z "$ZT_INTERFACES" ]; then
    # Take the first ZeroTier interface found
    ZT_IFACE=$(echo "$ZT_INTERFACES" | head -n1)
    printf "### Found ZeroTier interface: $ZT_IFACE\n"
  else
    # Fallback - check routing table for ZeroTier networks (typically 10.144.x.x)
    ZT_ROUTE_INFO=$(ip route | grep "10.144" | head -n1 || echo "")
    
    if [ ! -z "$ZT_ROUTE_INFO" ]; then
      # Extract interface name from route
      ZT_IFACE=$(echo "$ZT_ROUTE_INFO" | awk '{for(i=1;i<=NF;i++) if($i=="dev") print $(i+1)}')
      printf "### Found ZeroTier interface from routing table: $ZT_IFACE\n"
    else
      # Default fallback
      ZT_IFACE="zt0"
      printf "### Using default interface name: $ZT_IFACE\n"
    fi
  fi
  
  # Get the IP address for the interface if it exists
  if ip link show $ZT_IFACE &>/dev/null; then
    ZT_IP=$(ip addr show $ZT_IFACE | grep -w inet | awk '{print $2}' | cut -d/ -f1)
    if [ ! -z "$ZT_IP" ]; then
      printf "### ZeroTier interface has IP: $ZT_IP\n"
    else
      printf "### WARNING: ZeroTier interface has no IP address yet\n"
    fi
  else
    printf "### WARNING: Interface $ZT_IFACE doesn't exist yet\n"
  fi
fi

# Get LAN subnet from physical interfaces - more robust for BalenaOS
LAN_SUBNETS=""
for IFACE in ${PHY_IFACE//\s/ }; do
  # Get all subnets for this interface
  SUBNETS=$(ip route | grep $IFACE | grep -v default | grep -v linkdown | awk '{print $1}' | grep -v "169.254")
  for SUBNET in $SUBNETS; do
    if [ ! -z "$SUBNET" ]; then
      LAN_SUBNETS="$LAN_SUBNETS $SUBNET"
    fi
  done
done

if [ -z "$LAN_SUBNETS" ]; then
  printf "### WARNING: No LAN subnets found, using default 192.168.0.0/16
"
  LAN_SUBNETS="192.168.0.0/16"
else
  printf "### LAN subnets: $LAN_SUBNETS
"
fi

# Enable IP forwarding - essential for routing
printf "### Enabling IP forwarding
"
sysctl -w net.ipv4.ip_forward=1

# Clear any existing rules that might conflict
printf "### Clearing existing iptables rules
"
iptables -F FORWARD
iptables -t nat -F POSTROUTING

# Configure routing for each physical interface
printf "### Setting up routing rules\n"

# Make sure we have a ZeroTier interface to work with
if [ -z "$ZT_IFACE" ]; then
  # Last attempt to find the interface
  ZT_IFACE=$(ip link | grep -i zt | head -n1 | awk -F: '{print $2}' | tr -d ' ' || echo "zt0")
  printf "### Using ZeroTier interface: $ZT_IFACE (fallback)\n"
fi

# Enable IP forwarding again to be sure
sysctl -w net.ipv4.ip_forward=1

# Set up routing for all physical interfaces
for IFACE in ${PHY_IFACE//\s/ }; do
  printf "### Setting up routing between $ZT_IFACE and $IFACE\n"
  
  # Allow traffic from ZeroTier to LAN (outbound)
  iptables -t nat -A POSTROUTING -o $IFACE -j MASQUERADE
  iptables -A FORWARD -i $ZT_IFACE -o $IFACE -j ACCEPT
  
  # Allow established connections from LAN to ZeroTier
  iptables -A FORWARD -i $IFACE -o $ZT_IFACE -m state --state RELATED,ESTABLISHED -j ACCEPT
  
  # Additionally allow all traffic from LAN to ZeroTier (for bidirectional access)
  iptables -A FORWARD -i $IFACE -o $ZT_IFACE -j ACCEPT
done

# Make sure the ZeroTier interface accepts traffic
iptables -A INPUT -i $ZT_IFACE -j ACCEPT

# Allow forwarding between all interfaces (may be needed for some setups)
printf "### Enabling forwarding between all interfaces\n"
iptables -P FORWARD ACCEPT

# Get the ZeroTier network subnet from the routing table
ZT_NETWORK_SUBNET=$(ip route | grep -v default | grep $ZT_IFACE | grep -v link | awk '{print $1}' | head -n1)

if [ -z "$ZT_NETWORK_SUBNET" ]; then
  # If we can't find it in the routing table, try to derive it from the IP
  if [ ! -z "$ZT_IP" ]; then
    ZT_NETWORK_SUBNET=$(echo $ZT_IP | cut -d/ -f1 | sed 's/\.[0-9]*$/.0\/24/')
  else
    # Default ZeroTier subnet if we can't determine it
    ZT_NETWORK_SUBNET="10.144.0.0/16"
  fi
fi

printf "### Using ZeroTier subnet: $ZT_NETWORK_SUBNET\n"

# Make sure the route exists
if ! ip route | grep -q "$ZT_NETWORK_SUBNET"; then
  printf "### Adding route for ZeroTier subnet $ZT_NETWORK_SUBNET\n"
  ip route add $ZT_NETWORK_SUBNET dev $ZT_IFACE 2>/dev/null || true
fi

# Display routing table
printf "### Current routing table:
"
ip route

# Display iptables rules
printf "### Current iptables rules:
"
iptables -L FORWARD -v
iptables -t nat -L POSTROUTING -v

printf "### ZeroTier routing setup complete
"


# Keep the container running and monitor ZeroTier
while true; do
  sleep 60
  
  # Check if ZeroTier process is still running
  if ! pgrep -x "zerotier-one" > /dev/null; then
    printf "### WARNING: ZeroTier process died, restarting...\n"
    nohup zerotier-one > /var/log/zerotier.log 2>&1 &
    sleep 5
    
    # Re-join network if needed
    zerotier-cli join $ZT_NETWORK || true
  fi
  
  # Periodically check ZeroTier status
  ZT_STATUS=$(zerotier-cli status 2>&1 || echo "Error getting status")
  printf "### ZeroTier status: $ZT_STATUS\n"
  
  ZT_NETWORKS=$(zerotier-cli listnetworks 2>&1 || echo "Error listing networks")
  printf "### ZeroTier networks: $ZT_NETWORKS\n"
  
  # Check if routes are still in place
  printf "### Verifying routing is still active\n"
  if ! iptables -L FORWARD -v | grep -q $ZT_IFACE; then
    printf "### WARNING: Forward rules for ZeroTier interface missing, restoring...\n"
    
    # Re-enable IP forwarding
    sysctl -w net.ipv4.ip_forward=1
    
    # Restore routing rules if they've disappeared
    for IFACE in ${PHY_IFACE//\s/ }; do
      if [ ! -z "$ZT_IFACE" ]; then
        printf "### Restoring routes between $ZT_IFACE and $IFACE\n"
        iptables -t nat -A POSTROUTING -o $IFACE -j MASQUERADE
        iptables -A FORWARD -i $ZT_IFACE -o $IFACE -j ACCEPT
        iptables -A FORWARD -i $IFACE -o $ZT_IFACE -m state --state RELATED,ESTABLISHED -j ACCEPT
        iptables -A FORWARD -i $IFACE -o $ZT_IFACE -j ACCEPT
        iptables -A INPUT -i $ZT_IFACE -j ACCEPT
      fi
    done
    
    # Ensure forwarding is enabled
    iptables -P FORWARD ACCEPT
  fi
  
  # Verify ZeroTier interface has an IP
  if [ ! -z "$ZT_IFACE" ]; then
    ZT_CURRENT_IP=$(ip addr show $ZT_IFACE 2>/dev/null | grep -w inet | awk '{print $2}' || echo "")
    if [ -z "$ZT_CURRENT_IP" ]; then
      printf "### WARNING: ZeroTier interface has no IP address\n"
    else
      printf "### ZeroTier interface $ZT_IFACE has IP: $ZT_CURRENT_IP\n"
    fi
  fi
done
