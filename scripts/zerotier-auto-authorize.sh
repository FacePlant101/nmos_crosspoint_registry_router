#!/bin/bash

# ZeroTier Auto-Authorization Script
# This script automatically authorizes a ZeroTier device and assigns a specific IP address
# using the ZeroTier Central API when a container is redeployed.

set -e  # Exit on any error

printf "### ZeroTier Auto-Authorization Script Starting\n"

# Required environment variables
if [ -z "$ZT_API_KEY" ]; then
    printf "ERROR: ZT_API_KEY environment variable is required\n"
    exit 1
fi

if [ -z "$ZT_NETWORK" ]; then
    printf "ERROR: ZT_NETWORK environment variable is required\n"
    exit 1
fi

# Optional environment variable for specific IP assignment
# If not set, the device will use auto-assigned IP
ZT_ASSIGN_IP="${ZT_ASSIGN_IP:-}"

# Optional environment variable for device name
# If not set, the device will keep its default name
ZT_NAME="${ZT_NAME:-}"

# Optional environment variable to control deletion of conflicting devices
# If set to "true", conflicting devices will be deleted from the network
# If not set or "false", conflicting devices will only be deauthorized (safer)
ZT_DELETE_CONFLICTS="${ZT_DELETE_CONFLICTS:-false}"

# ZeroTier API base URL
ZT_API_BASE="https://api.zerotier.com/api/v1"

# Function to make API calls to ZeroTier Central
call_zt_api() {
    local method="$1"
    local endpoint="$2"
    local data="$3"
    
    if [ -n "$data" ]; then
        curl -s -X "$method" \
            -H "Authorization: token $ZT_API_KEY" \
            -H "Content-Type: application/json" \
            -d "$data" \
            "$ZT_API_BASE$endpoint"
    else
        curl -s -X "$method" \
            -H "Authorization: token $ZT_API_KEY" \
            "$ZT_API_BASE$endpoint"
    fi
}

# Wait for ZeroTier to be ready and get node ID
printf "### Waiting for ZeroTier node ID...\n"
COUNTER=0
MAX_TRIES=30
NODE_ID=""

while [ $COUNTER -lt $MAX_TRIES ] && [ -z "$NODE_ID" ]; do
    # Try to get node ID from zerotier-cli
    NODE_ID=$(zerotier-cli info 2>/dev/null | awk '{print $3}' | head -n1 || echo "")
    
    if [ -z "$NODE_ID" ] || [ "$NODE_ID" = "OFFLINE" ]; then
        printf "Waiting for ZeroTier node ID... ($COUNTER/$MAX_TRIES)\n"
        NODE_ID=""
        sleep 2
        COUNTER=$((COUNTER+1))
    else
        printf "Found ZeroTier Node ID: $NODE_ID\n"
        break
    fi
done

if [ -z "$NODE_ID" ]; then
    printf "ERROR: Could not obtain ZeroTier node ID after $MAX_TRIES attempts\n"
    exit 1
fi

# Function to find and cleanup devices with conflicting IP addresses
cleanup_ip_conflicts() {
    local target_ip="$1"
    
    if [ -z "$target_ip" ]; then
        printf "No specific IP to assign - skipping conflict cleanup\n"
        return 0
    fi
    
    printf "### Checking for existing devices with IP: $target_ip\n"
    
    # Get list of all network members
    ALL_MEMBERS=$(call_zt_api "GET" "/network/$ZT_NETWORK/member" "")
    
    if [ $? -ne 0 ]; then
        printf "WARNING: Could not retrieve network member list\n"
        return 1
    fi
    
    # Extract member information and find conflicting IPs
    # Use proper JSON parsing to avoid the catastrophic regex bug that matched ALL members
    CONFLICTING_MEMBERS=""
    
    # Try to use jq for proper JSON parsing if available
    if command -v jq >/dev/null 2>&1; then
        # Use jq for reliable JSON parsing - only matches members with exact IP
        CONFLICTING_MEMBERS=$(echo "$ALL_MEMBERS" | jq -r --arg ip "$target_ip" '.[] | select(.config.ipAssignments[]? == $ip) | .nodeId' 2>/dev/null | sort -u | tr '\n' ' ')
    else
        # Fallback: Use safer manual parsing by splitting JSON members
        printf "WARNING: jq not available, using fallback JSON parsing\n"
        
        # Split the JSON array into individual member objects
        echo "$ALL_MEMBERS" | sed 's/},{/}\n{/g' | sed 's/^\[//' | sed 's/\]$//' | while read -r member; do
            # Only process non-empty lines
            if [ -n "$member" ]; then
                # Extract nodeId from this specific member
                node_id=$(echo "$member" | grep -o '"nodeId":"[^"]*"' | cut -d'"' -f4)
                
                # Check if this specific member contains the target IP (exact match)
                if echo "$member" | grep -q "\"$target_ip\""; then
                    echo "$node_id"
                fi
            fi
        done | sort -u > /tmp/conflicting_members_$$
        
        CONFLICTING_MEMBERS=$(cat /tmp/conflicting_members_$$ | tr '\n' ' ')
        rm -f /tmp/conflicting_members_$$
    fi
    
    if [ -n "$CONFLICTING_MEMBERS" ]; then
        printf "Found devices with conflicting IP $target_ip:\n"
        
        for CONFLICT_NODE_ID in $CONFLICTING_MEMBERS; do
            # Skip if this is the current device
            if [ "$CONFLICT_NODE_ID" = "$NODE_ID" ]; then
                printf "  - $CONFLICT_NODE_ID (current device - skipping)\n"
                continue
            fi
            
            printf "  - $CONFLICT_NODE_ID (will be deauthorized)\n"
            
            # Deauthorize the conflicting device
            DEAUTH_PAYLOAD='{"config": {"authorized": false}}'
            DEAUTH_RESULT=$(call_zt_api "POST" "/network/$ZT_NETWORK/member/$CONFLICT_NODE_ID" "$DEAUTH_PAYLOAD")
            
            if [ $? -eq 0 ]; then
                printf "    Deauthorized conflicting device: $CONFLICT_NODE_ID\n"
                
                # Only delete if explicitly requested via environment variable
                if [ "$ZT_DELETE_CONFLICTS" = "true" ]; then
                    printf "    ZT_DELETE_CONFLICTS=true, deleting device: $CONFLICT_NODE_ID\n"
                    DELETE_RESULT=$(call_zt_api "DELETE" "/network/$ZT_NETWORK/member/$CONFLICT_NODE_ID" "")
                    if [ $? -eq 0 ]; then
                        printf "    Deleted conflicting device: $CONFLICT_NODE_ID\n"
                    else
                        printf "    WARNING: Failed to delete conflicting device: $CONFLICT_NODE_ID\n"
                    fi
                else
                    printf "    Device deauthorized but not deleted (set ZT_DELETE_CONFLICTS=true to delete)\n"
                fi
            else
                printf "    WARNING: Failed to deauthorize conflicting device: $CONFLICT_NODE_ID\n"
            fi
        done
        
        printf "Finished cleaning up IP conflicts\n"
        # Wait a moment for the changes to propagate
        sleep 3
    else
        printf "No existing devices found with IP: $target_ip\n"
    fi
}

# Clean up any IP conflicts before proceeding
if [ -n "$ZT_ASSIGN_IP" ]; then
    cleanup_ip_conflicts "$ZT_ASSIGN_IP"
fi

# Check if device is already authorized
printf "### Checking current device status...\n"
MEMBER_INFO=$(call_zt_api "GET" "/network/$ZT_NETWORK/member/$NODE_ID" "")

if [ $? -eq 0 ]; then
    # Parse the current authorization status
    CURRENT_AUTH=$(echo "$MEMBER_INFO" | grep -o '"authorized":[^,}]*' | cut -d':' -f2 | tr -d ' "')
    CURRENT_IP=$(echo "$MEMBER_INFO" | grep -o '"ipAssignments":\[[^]]*\]' | grep -o '"[0-9.]*"' | head -n1 | tr -d '"')
    
    printf "Current authorization status: $CURRENT_AUTH\n"
    if [ -n "$CURRENT_IP" ]; then
        printf "Current IP assignment: $CURRENT_IP\n"
    else
        printf "No current IP assignment\n"
    fi
    
    # Check if we need to make changes
    NEEDS_AUTH_UPDATE=false
    NEEDS_IP_UPDATE=false
    
    if [ "$CURRENT_AUTH" != "true" ]; then
        printf "Device is not authorized - will authorize\n"
        NEEDS_AUTH_UPDATE=true
    fi
    
    if [ -n "$ZT_ASSIGN_IP" ] && [ "$CURRENT_IP" != "$ZT_ASSIGN_IP" ]; then
        printf "IP assignment needs update: $CURRENT_IP -> $ZT_ASSIGN_IP\n"
        NEEDS_IP_UPDATE=true
    fi
    
    if [ "$NEEDS_AUTH_UPDATE" = "false" ] && [ "$NEEDS_IP_UPDATE" = "false" ]; then
        printf "### Device is already properly configured\n"
        exit 0
    fi
else
    printf "Device not found in network - will authorize\n"
    NEEDS_AUTH_UPDATE=true
    NEEDS_IP_UPDATE=true
fi

# Prepare the API payload
printf "### Preparing authorization update...\n"

# Build the config object
CONFIG_PARTS='"authorized": true'

if [ -n "$ZT_ASSIGN_IP" ]; then
    CONFIG_PARTS="$CONFIG_PARTS, \"ipAssignments\": [\"$ZT_ASSIGN_IP\"]"
    printf "Will assign specific IP: $ZT_ASSIGN_IP\n"
else
    printf "Will use auto-assigned IP\n"
fi

# Prepare the payload with config and optional name
if [ -n "$ZT_NAME" ]; then
    PAYLOAD="{\"config\": {$CONFIG_PARTS}, \"name\": \"$ZT_NAME\"}"
    printf "Will set device name: $ZT_NAME\n"
else
    PAYLOAD="{\"config\": {$CONFIG_PARTS}}"
    printf "Will use default device name\n"
fi

printf "API Payload: $PAYLOAD\n"

# Make the API call to authorize and configure the device
printf "### Authorizing device via ZeroTier API...\n"
API_RESPONSE=$(call_zt_api "POST" "/network/$ZT_NETWORK/member/$NODE_ID" "$PAYLOAD")

if [ $? -eq 0 ]; then
    printf "### SUCCESS: Device authorized successfully\n"
    
    # Parse and display the response
    NEW_AUTH=$(echo "$API_RESPONSE" | grep -o '"authorized":[^,}]*' | cut -d':' -f2 | tr -d ' "')
    NEW_IP=$(echo "$API_RESPONSE" | grep -o '"ipAssignments":\[[^]]*\]' | grep -o '"[0-9.]*"' | head -n1 | tr -d '"')
    
    printf "Authorization status: $NEW_AUTH\n"
    if [ -n "$NEW_IP" ]; then
        printf "Assigned IP: $NEW_IP\n"
    fi
    
    printf "### ZeroTier auto-authorization completed successfully\n"
else
    printf "ERROR: Failed to authorize device via API\n"
    printf "API Response: $API_RESPONSE\n"
    exit 1
fi

# Optional: Wait a moment for the changes to propagate
sleep 5

# Verify the changes took effect
printf "### Verifying configuration...\n"
VERIFICATION=$(call_zt_api "GET" "/network/$ZT_NETWORK/member/$NODE_ID" "")
FINAL_AUTH=$(echo "$VERIFICATION" | grep -o '"authorized":[^,}]*' | cut -d':' -f2 | tr -d ' "')
FINAL_IP=$(echo "$VERIFICATION" | grep -o '"ipAssignments":\[[^]]*\]' | grep -o '"[0-9.]*"' | head -n1 | tr -d '"')

printf "Final authorization status: $FINAL_AUTH\n"
if [ -n "$FINAL_IP" ]; then
    printf "Final IP assignment: $FINAL_IP\n"
fi

if [ "$FINAL_AUTH" = "true" ]; then
    printf "### ZeroTier device successfully configured!\n"
else
    printf "WARNING: Authorization may not have taken effect immediately\n"
fi
