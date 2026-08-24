--[[ 
  NMOS Crosspoint Router Control for Q-Sys (WebSocket API)
  
  Description:
  This script provides a direct interface to control an NMOS Crosspoint Router via its WebSocket API.
  It uses the native Q-Sys WebSocket and rapidjson modules.

  WebSocket API Commands Used:
  - POST /makeconnection

  Q-Sys Setup:
  1. Add this script to a "Control Script" component in Q-Sys Designer.
  2. Create the following controls in the script's parent component:
     - `Controls["IP Address"]` (Type: String) - Set this to the IP of the crosspoint router.
     - `Controls["Device State"]` (Type: String) - Stores the current state of devices.
]]--

-- Required modules
rapidjson = require("rapidjson")

-- Configuration flags - set to true to enable verbose debug logging
-- You can change this to true for debugging, or use Controls["Debug Mode"] if available
local DEBUG_ENABLED = false
local ENABLE_PATCH_STATS = false -- Set to true to enable patch statistics

-- Debug logging helper
local function debug_print(...)
  if DEBUG_ENABLED then
    print(...)
  end
end

-- Core global variables
isAuthenticated = false
isConnecting = false
authTimeoutOccurred = false
receive_buffer = ""

-- Reconnect state variables
current_reconnect_interval = RECONNECT_INTERVAL
last_connection_failure_type = nil
ip_address_empty_count = 0
last_ip_check_time = 0

-- Router configuration variables
ROUTER_USER = "admin"
ROUTER_PASSWORD = "password"

-- WebSocket object and timer variables
ws = nil
ping_timer = nil
auth_timeout_timer = nil
wait_for_data_timer = nil
stored_device_data = { devices = {} }

-- UI update throttling
last_ui_update_time = 0
UI_UPDATE_INTERVAL = 0.5

-- Statistics for monitoring (only if enabled)
local patch_stats = ENABLE_PATCH_STATS and {
  replace_count = 0,
  add_count = 0,
  remove_count = 0,
  total_count = 0,
  last_reset_time = 0
} or nil

-- Helper function to initialize device entry
local function ensure_device_exists(device_id)
  if not stored_device_data.devices[device_id] then
    stored_device_data.devices[device_id] = {}
    debug_print("Created new device entry for " .. device_id)
  end
end

function New_ProcessMessage(json_string)
  debug_print("Processing message: " .. json_string)
  local ok, response = pcall(rapidjson.decode, json_string)

  if not ok then
    print("ERROR: Failed to decode JSON from server: " .. tostring(response))
    -- Log the problematic string for troubleshooting, but limit output to avoid console spam
    local preview = json_string
    if #json_string > 100 then preview = json_string:sub(1, 100) .. "..." end
    print("ERROR: Problematic JSON: '" .. preview .. "'")
    return
  end
  
  -- For debug visibility, when needed
  -- local pretty_json = rapidjson.encode(response, {pretty=true, sort_keys=true})
  -- print("DEBUG: Decoded JSON object: " .. pretty_json)
  
  debug_print("DEBUG: Processing message of type: " .. response.type)
  
  if response.type == "auth" and response.user then
    -- This is likely an echo or acknowledgment of our auth request
    -- We can safely ignore it as we're waiting for authok
    debug_print("DEBUG: Received auth echo for user '" .. response.user .. "'. Waiting for auth confirmation...")
    
    -- After receiving echo, proactively check for authentication issues
    if response.error then
      print("ERROR: Authentication error: " .. tostring(response.error))
      if reconnectTimer then reconnectTimer:Stop() end
      Controls["Connection status"].String = "Auth Error: " .. tostring(response.error)
    end
    
  elseif response.type == "authseed" then
    debug_print("DEBUG: Authentication seed received: " .. response.seed)
    
    -- Generate auth response using SHA256(PASSWORD + SEED)
    local password_hash_status, password_hash_or_err = pcall(Crypto.Digest, 'sha256', ROUTER_PASSWORD)
    if not password_hash_status then
      print("FATAL: Could not hash password. Error: " .. tostring(password_hash_or_err))
      if reconnectTimer then reconnectTimer:Stop() end
      Controls["Connection status"].String = "Crypto Error"
      return
    end
    
    debug_print("DEBUG: First hash successful")
    local password_hex_hash = toHex(password_hash_or_err)
    local password_seed = password_hex_hash .. response.seed
    debug_print("DEBUG: Combined hash with seed: " .. #password_seed .. " bytes")
    
    local status, hash_or_err = pcall(Crypto.Digest, 'sha256', password_seed)
    if not status then
      print("FATAL: Crypto.Digest failed. Error: " .. tostring(hash_or_err))
      if reconnectTimer then reconnectTimer:Stop() end
      Controls["Connection status"].String = "Crypto Error"
      return
    end
    
    local hex_hash = toHex(hash_or_err)
    debug_print("DEBUG: Generated final auth hash from password and seed")
    
    local json_command = string.format('{"type":"auth","user":"%s","password":"%s"}', ROUTER_USER, hex_hash)
    debug_print("DEBUG: Sending authentication response: " .. json_command)
    ws:Write(json_command)
    
    -- Set up a timer to proceed with subscriptions if no explicit authok is received
    -- Some servers might not send an explicit authok response
    debug_print("DEBUG: Setting up authentication timeout to proceed with subscriptions in 3 seconds")
    -- Create a timeout timer in case we don't receive explicit 'authok'
    if authTimeoutTimer then authTimeoutTimer:Stop() end
    
    -- Initialize or reuse the global timer
    if not authTimeoutTimer then
      authTimeoutTimer = Timer.New()
      authTimeoutTimer.EventHandler = function(timer)
        debug_print("DEBUG: Auth timeout reached - proceeding with subscription")
        authTimeoutTimer:Stop()
        if not isAuthenticated then
          debug_print("DEBUG: No explicit authok received, assuming success and proceeding")
          isAuthenticated = true
          -- Proceed with subscriptions
          Controls["Connection status"].String = "Connected and Authenticated"
          SubscribeToData("mediadevices")
          Timer.CallAfter(function() SubscribeToData("mediadevmatroxcip") end, 1)
        end
      end
    end
    
    authTimeoutTimer:Start(3) -- 3 second timeout
    
  elseif response.type == "authok" then
    debug_print("DEBUG: Authentication successful!")
    isAuthenticated = true
    
    -- Update UI
    Component.Status = "OK"
    Controls["Connection status"].String = "Connected & Authenticated"
    
    -- Subscribe to mediadevices
    print("DEBUG: Subscribing to 'mediadevices'...")
    SubscribeToData("mediadevices")
    
    -- Schedule second subscription with a delay
    print("DEBUG: Scheduling 'mediadevmatroxcip' subscription in 1 second")
    Timer.CallAfter(DoSecondSubscription, 1)
    
  elseif response.type == "sync" then
    debug_print("Received sync message for channel: " .. (response.channel or "<unknown>") .. ", objectId: " .. (response.objectId or "<unknown>"))
    
    if not response.channel then
      print("ERROR: Received sync message with no channel")
      return
    end
    
    if response.channel == "mediadevices" then
      debug_print("DEBUG: Received mediadevices sync data")
      -- If this is the first sync message for mediadevices, it means the subscription was successful
      if response.first then
        debug_print("DEBUG: Successfully subscribed to mediadevices channel")
      end
    elseif response.channel == "mediadevmatroxcip" then
      debug_print("DEBUG: Processing Matrox CIP data")
      if response.first then
        debug_print("DEBUG: Successfully subscribed to mediadevmatroxcip channel")
      end
      
      -- Process the data if it exists
      if response.data then
        debug_print("DEBUG: Updating CIP status with received data")
        -- Pass both the data and the action type to UpdateCipStatus
        UpdateCipStatus(response.data, response.action)
      else
        debug_print("DEBUG: No data in sync message for mediadevmatroxcip")
      end
    else
      debug_print("DEBUG: Received sync message for unhandled channel: " .. (response.channel or "<unknown>"))
    end

  elseif response.type == "authfailed" or response.type == "autherror" then
    print("ERROR: Authentication failed: " .. (response.error or "Unknown reason"))
    Component.Status = "Error"
    Controls["Connection status"].String = "Auth Failed: " .. (response.error or "Unknown error")
    
    -- Stop reconnection attempts
    if reconnectTimer then reconnectTimer:Stop() end

  elseif response.type == "response" then
    print("DEBUG: Response to request ID " .. tostring(response.id) .. ": " .. response.message)

  elseif response.type == "permissionDenied" then
    print("ERROR: Permission denied for '" .. tostring(response.data and response.data.name) .. "'. Reason: " .. tostring(response.data and response.data.reason))
    Component.Status = "Fault"
    Controls["Connection status"].String = "Permission Denied"
    
  elseif response.type == "ping" or response.type == "pong" then
    print("DEBUG: Received " .. response.type .. " message")
    

  else
    -- Dump the full message for unexpected types to aid debugging
    print("Received unhandled message type: '" .. response.type .. "'")
    local pretty_json = rapidjson.encode(response, {pretty=true, sort_keys=true})
    print("DEBUG: Full message contents: " .. pretty_json)
    
    -- Try to continue processing even with unknown message types
    -- Some servers may use non-standard message types
    if not isAuthenticated and response.user == ROUTER_USER then
      print("DEBUG: Server responded to authentication but didn't send explicit authok")
      print("DEBUG: Assuming authentication successful based on received message")
      isAuthenticated = true
      Component.Status = "OK"
      Controls["Connection status"].String = "Connected & Authenticated"
      
      -- Subscribe to mediadevices
      print("DEBUG: Subscribing to 'mediadevices'...")
      SubscribeToData("mediadevices")
      
      -- Schedule second subscription with a delay
      print("DEBUG: Scheduling 'mediadevmatroxcip' subscription in 1 second")
      Timer.CallAfter(DoSecondSubscription, 1)
    end
  end
end

function New_OnDataReceived(w, data)
  if not data or data == "" then return end
  debug_print("Adding data to buffer (" .. #data .. " bytes)")
  receive_buffer = receive_buffer .. data
  
  debug_print("Buffer now contains " .. #receive_buffer .. " bytes")
  
  -- Look for newline characters to find complete messages
  local pos = 1
  local found_complete_message = false
  
  while true do
    local start_pos, end_pos = receive_buffer:find("\n", pos)
    if not start_pos then
      debug_print("No more complete messages in buffer")
      break -- No more complete lines
    end

    local line = receive_buffer:sub(pos, start_pos - 1)
    if line and line ~= "" then
      debug_print("Found complete message: " .. #line .. " bytes")
      found_complete_message = true
      New_ProcessMessage(line)
    else
      debug_print("Found empty line, skipping")
    end

    pos = end_pos + 1
  end

  -- Trim the processed part from the buffer
  if pos > 1 then
    receive_buffer = receive_buffer:sub(pos)
    debug_print("Buffer trimmed, now contains " .. #receive_buffer .. " bytes")
  end
  
  if not found_complete_message then
    debug_print("No complete messages found, waiting for more data")
    -- If no newline was found, try processing what we have if it looks like a complete JSON object
    if receive_buffer:match("^%s*{.+}%s*$") then
      debug_print("Buffer contains what looks like a complete JSON object, processing it anyway")
      New_ProcessMessage(receive_buffer)
      receive_buffer = ""
    end
  end
end

-- End of message handling logic

-- *********************
-- *   Dependencies    *
-- *********************
-- rapidjson already loaded globally at the top of the script

-- *********************
-- *   Configuration   *
-- *********************

local ROUTER_PORT = 80 -- WebSocket port
local RECONNECT_INTERVAL = 5 -- seconds
local MAX_RECONNECT_INTERVAL = 60 -- maximum seconds between reconnect attempts
local RECONNECT_BACKOFF_MULTIPLIER = 1.5 -- exponential backoff multiplier
local CONFIG_CHECK_INTERVAL = 30 -- seconds to check for config changes when IP is empty
local DISCONNECT_CHOICE = "-- DISCONNECT --"

-- Function to get encoder names from Controls["Encoder"]
function GetEncoderNames()
  local encoderNames = {}
  
  if Controls["Encoder"] then
    local encoderControl = Controls["Encoder"]
    
    if type(encoderControl) == "table" then
      -- Handle array-like table of encoder controls
      for _, control in pairs(encoderControl) do
        if control and control.String and control.String ~= "" then
          table.insert(encoderNames, control.String)
        end
      end
    elseif encoderControl.String then
      -- Handle single encoder control with comma-separated values
      local encoderList = encoderControl.String
      if encoderList and encoderList ~= "" then
        for encoderName in string.gmatch(encoderList, "[^,]+") do
          local trimmedName = encoderName:match("^%s*(.-)%s*$") -- trim whitespace
          if trimmedName ~= "" then
            table.insert(encoderNames, trimmedName)
          end
        end
      end
    end
  end
  
  -- If no encoders found in control, return empty list
  if #encoderNames == 0 then
    print("WARNING: No encoder names found in Controls['Encoder']. Please configure encoder list.")
  else
    debug_print("Found " .. #encoderNames .. " encoders: " .. table.concat(encoderNames, ", "))
  end
  
  return encoderNames
end

-- Router credentials are defined globally at the top of the script
-- DO NOT redefine them here

-- *********************
-- *   Global Vars     *
-- *********************

-- Global variables are already defined at top of script
local format = string.format
local request_id = 1

-- *********************
-- *   Functions       *
-- *********************

-- Helper function to convert a raw string to a hex-encoded string
function toHex(str)
  if type(str) ~= "string" then return "" end
  return (str:gsub('.', function (c)
    return string.format('%02x', string.byte(c))
  end))
end

-- Function to send multiviewer command via crosspoint router API
function SendMultiviewerCommand(deviceSN, enabled)
  if not deviceSN or deviceSN == "" then
    print("ERROR: Cannot send multiviewer command - device serial number not provided")
    return
  end
  
  if not ws or not isSocketConnected or not isAuthenticated then
    print("ERROR: Cannot send multiviewer command - not connected to crosspoint router")
    return
  end
  
  -- Strip channel suffix (.1, .2, .v1, .v2, etc.) from device serial number
  -- NMOS backend expects base device serial number without channel identifiers
  local baseDeviceSN = deviceSN:match("^([^%.]+)") or deviceSN
  
  print("Sending multiviewer command via crosspoint router for device " .. deviceSN .. " (base: " .. baseDeviceSN .. "): " .. (enabled and "ENABLE" or "DISABLE"))
  
  local command = {
    type = "request",
    method = "POST",
    route = "matroxcip_togglemultiviewer",
    id = tostring(request_id),
    data = {
      sn = baseDeviceSN,
      enabled = enabled
    }
  }
  request_id = request_id + 1

  local json_command, err = rapidjson.encode(command)
  if json_command then
    print("Sending multiviewer command: " .. json_command)
    ws:Write(json_command)
  else
    print(format("Failed to encode multiviewer JSON command: %s", err))
  end
end

-- Enhanced multiviewer functions supporting both postfix and flow type notation

-- Connect multiple encoders to a multiviewer decoder using postfix channel numbers
-- Example: ConnectToMultiviewer({"Encoder1", "Encoder2"}, "CIP-DEC-740", 1)
-- Result: Encoder1→CIP-DEC-740.1, Encoder2→CIP-DEC-740.2
function ConnectToMultiviewer(encoderList, decoderName, startChannel)
  if not encoderList or #encoderList == 0 then
    print("ERROR: No encoders specified for multiviewer connection")
    return
  end
  
  if not decoderName or decoderName == "" then
    print("ERROR: No decoder specified for multiviewer connection")
    return
  end
  
  startChannel = startChannel or 1
  print("Connecting " .. #encoderList .. " encoders to multiviewer decoder " .. decoderName .. " starting at channel " .. startChannel)
  
  local connections = {}
  for i, encoderName in ipairs(encoderList) do
    local channelNum = startChannel + i - 1
    local destination = decoderName .. ".v" .. channelNum
    table.insert(connections, {
      source = encoderName,
      destination = destination
    })
    print("  " .. encoderName .. " → " .. destination)
  end
  
  local payload = { multiple = connections }
  SendCommand(payload)
end

-- Connect multiple encoders to a multiviewer decoder using flow type notation
-- Example: ConnectToMultiviewerFlows({"Encoder1", "Encoder2"}, "CIP-DEC-740", "v", 1)
-- Result: Encoder1→CIP-DEC-740.v1, Encoder2→CIP-DEC-740.v2
function ConnectToMultiviewerFlows(encoderList, decoderName, flowType, startFlow)
  if not encoderList or #encoderList == 0 then
    print("ERROR: No encoders specified for multiviewer flow connection")
    return
  end
  
  if not decoderName or decoderName == "" then
    print("ERROR: No decoder specified for multiviewer flow connection")
    return
  end
  
  flowType = flowType or "v"  -- Default to video
  startFlow = startFlow or 1
  print("Connecting " .. #encoderList .. " encoders to multiviewer decoder " .. decoderName .. " using flow type '" .. flowType .. "' starting at flow " .. startFlow)
  
  local connections = {}
  for i, encoderName in ipairs(encoderList) do
    local flowNum = startFlow + i - 1
    local destination = decoderName .. "." .. flowType .. flowNum
    table.insert(connections, {
      source = encoderName,
      destination = destination
    })
    print("  " .. encoderName .. " → " .. destination)
  end
  
  local payload = { multiple = connections }
  SendCommand(payload)
end

-- Batch multiviewer setup: enable multiviewer mode and connect encoders
-- Supports both notation types via 'useFlowType' parameter
function SetupMultiviewer(decoderName, encoderList, options)
  options = options or {}
  local startChannel = options.startChannel or 1
  local useFlowType = options.useFlowType or false
  local flowType = options.flowType or "v"
  local enableFirst = options.enableFirst ~= false  -- Default to true
  
  print("Setting up multiviewer for " .. decoderName .. " with " .. #encoderList .. " encoders")
  
  -- Step 1: Enable multiviewer mode if requested
  if enableFirst then
    print("Step 1: Enabling multiviewer mode for " .. decoderName)
    SendMultiviewerCommand(decoderName, true)
    
    -- Add a small delay to allow multiviewer to initialize
    Timer.CallAfter(function()
      print("Step 2: Connecting encoders to multiviewer channels")
      if useFlowType then
        ConnectToMultiviewerFlows(encoderList, decoderName, flowType, startChannel)
      else
        ConnectToMultiviewer(encoderList, decoderName, startChannel)
      end
    end, 2)
  else
    -- Connect immediately without enabling multiviewer first
    if useFlowType then
      ConnectToMultiviewerFlows(encoderList, decoderName, flowType, startChannel)
    else
      ConnectToMultiviewer(encoderList, decoderName, startChannel)
    end
  end
end

-- Function to handle individual multiviewer control events (per decoder)
function OnIndividualMultiviewerChanged(control, decoderControl)
  print("🔥 DEBUG: OnIndividualMultiviewerChanged() called for specific decoder!")
  
  if not control then
    print("❌ ERROR: Multiviewer control is nil")
    return
  end
  
  if not decoderControl then
    print("❌ ERROR: Decoder control is nil")
    return
  end
  
  print("📊 DEBUG: Decoder control index: " .. tostring(decoderControl.Index or "unknown"))
  print("📊 DEBUG: Control object type: " .. type(control))
  
  -- Try to access the Boolean property
  local enabled
  if control.Boolean ~= nil then
    enabled = control.Boolean
    print("📊 DEBUG: control.Boolean = " .. tostring(enabled))
  else
    print("❌ ERROR: control.Boolean is nil")
    -- Try alternative property names
    if control.Value ~= nil then
      enabled = control.Value > 0
      print("📊 DEBUG: Using control.Value = " .. tostring(control.Value) .. ", treating as " .. tostring(enabled))
    else
      print("❌ ERROR: Neither control.Boolean nor control.Value available")
      return
    end
  end
  
  print("🎯 Multiviewer control changed to: " .. (enabled and "ON" or "OFF") .. " for decoder index: " .. tostring(decoderControl.Index or "unknown"))
  
  -- Check WebSocket connection
  print("🔌 DEBUG: WebSocket connected: " .. tostring(ws and isSocketConnected))
  print("🔐 DEBUG: Authenticated: " .. tostring(isAuthenticated))
  
  -- Find the specific decoder device serial number from the decoder control
  local deviceSN = decoderControl.String
  if not deviceSN or deviceSN == "" then
    print("❌ ERROR: Decoder control has no device serial number")
    return
  end
  
  print("✅ Sending multiviewer command for single decoder: " .. deviceSN)
  SendMultiviewerCommand(deviceSN, enabled)
end

-- Function to handle multiviewer control events (legacy/global version - kept for compatibility)
function OnMultiviewerChanged(control)
  print("🔥 DEBUG: OnMultiviewerChanged() called!")
  
  if not control then
    print("❌ ERROR: Multiviewer control is nil")
    return
  end
  
  if type(control) ~= "table" then
    print("❌ ERROR: Multiviewer control is not a table, type: " .. type(control))
    return
  end
  
  print("📊 DEBUG: Control object type: " .. type(control))
  
  -- Try to access the Boolean property
  local enabled
  if control.Boolean ~= nil then
    enabled = control.Boolean
    print("📊 DEBUG: control.Boolean = " .. tostring(enabled))
  else
    print("❌ ERROR: control.Boolean is nil")
    -- Try alternative property names
    if control.Value ~= nil then
      enabled = control.Value > 0
      print("📊 DEBUG: Using control.Value = " .. tostring(control.Value) .. ", treating as " .. tostring(enabled))
    else
      print("❌ ERROR: Neither control.Boolean nor control.Value available")
      return
    end
  end
  
  print("🎯 Multiviewer control changed to: " .. (enabled and "ON" or "OFF"))
  
  -- Check WebSocket connection
  print("🔌 DEBUG: WebSocket connected: " .. tostring(ws and isSocketConnected))
  print("🔐 DEBUG: Authenticated: " .. tostring(isAuthenticated))
  
  -- Check device data availability
  if not stored_device_data then
    print("❌ ERROR: stored_device_data is nil")
    return
  end
  
  if not stored_device_data.devices then
    print("❌ ERROR: stored_device_data.devices is nil")
    return
  end
  
  print("📊 DEBUG: Total devices in stored data: " .. tostring(#stored_device_data.devices or 0))
  
  -- Get the list of decoder devices from stored data
  local decoderCount = 0
  local totalDevices = 0
  
  for deviceId, device in pairs(stored_device_data.devices) do
    totalDevices = totalDevices + 1
    print("📊 DEBUG: Device " .. deviceId .. ", direction: " .. tostring(device.direction))
    
    -- Check if this is a decoder device (RX)
    if device.direction == "rx" then
      print("✅ Found decoder " .. deviceId .. " - sending multiviewer command")
      SendMultiviewerCommand(deviceId, enabled)
      decoderCount = decoderCount + 1
    end
  end
  
  print("📊 DEBUG: Processed " .. totalDevices .. " total devices")
  
  if decoderCount == 0 then
    print("⚠️ WARNING: No decoder devices found")
  else
    print("✅ SUCCESS: Sent multiviewer commands to " .. decoderCount .. " decoder devices")
  end
end

-- Helper to subscribe to a sync object
function SubscribeToData(objectName)
  if ws and isSocketConnected and isAuthenticated then
    -- The server expects 'type: "sync"', the object name in 'channel', and the default data under objectId 0.
    local subscribe_msg = {
      type = "sync",
      channel = objectName,
      objectId = 0
    }
    
    local json_command = rapidjson.encode(subscribe_msg)
    debug_print("Sending subscribe request for '" .. objectName .. "': " .. json_command)
    ws:Write(json_command)
  else
    debug_print("Cannot subscribe to '" .. objectName .. "' - not connected or not authenticated")
    debug_print("Socket connected: " .. tostring(isSocketConnected) .. ", Authenticated: " .. tostring(isAuthenticated))
  end
end

-- Function to be called after a delay to perform the second subscription
function DoSecondSubscription()
  debug_print("Subscribing to 'mediadevmatroxcip'...")
  SubscribeToData("mediadevmatroxcip")
end

-- Helper function to determine a device's status from its state object
function GetDeviceStatus(device)
  if not device then return "Unknown" end
  if device.unreachable then return "Unreachable" end
  if device.failed then return "Failed: " .. (device.error or "Unknown") end
  if device.sessionConflict then return "Session Conflict" end
  if device.loading then return "Loading..." end
  return "OK"
end

-- Reset statistics counters
function ResetPatchStats()
  if ENABLE_PATCH_STATS and patch_stats then
    patch_stats.replace_count = 0
    patch_stats.add_count = 0
    patch_stats.remove_count = 0
    patch_stats.total_count = 0
    patch_stats.last_reset_time = os.time()
    debug_print("Reset patch operation counters")
  end
end

-- Log current statistics
local function log_patch_stats()
  if not ENABLE_PATCH_STATS or not patch_stats then return end
  
  local duration = os.time() - patch_stats.last_reset_time
  if duration <= 0 then duration = 1 end
  
  debug_print(string.format("Patch statistics - Total: %d (%d/min), Replace: %d, Add: %d, Remove: %d", 
    patch_stats.total_count, 
    math.floor(patch_stats.total_count * 60 / duration),
    patch_stats.replace_count, 
    patch_stats.add_count, 
    patch_stats.remove_count))
end

-- Processes mediadevmatroxcip data and updates the CIP-Status control
function UpdateCipStatus(data, action)
  if not Controls["CIP-Status"] then 
    debug_print("CIP-Status control not found")
    return 
  end
  
  if DEBUG_ENABLED and data then
    if type(data) == "table" and #data > 0 then
      debug_print("UpdateCipStatus received array with " .. #data .. " items")
    elseif type(data) == "table" then
      local keys = GetTableKeys(data)
      debug_print("UpdateCipStatus data keys: " .. table.concat(keys, ", "))
    end
    
    local raw_json_data, json_err = rapidjson.encode(data)
    if raw_json_data then
      debug_print("UpdateCipStatus received data (first 200 chars): " .. raw_json_data:sub(1, 200) .. "...")
    end
  end
  
  -- Handle different action types
  if action == "init" and data and data.devices then
    debug_print("Received full device data init")
    stored_device_data = data
    debug_print("Stored full device data with " .. TableCount(data.devices) .. " devices")
  elseif action == "patch" and type(data) == "table" then
    debug_print("Applying " .. #data .. " patch operations to stored device data")
    for i, patch in ipairs(data) do
      if not patch.op or not patch.path then
        print("ERROR: Malformed patch operation at index " .. i .. ", missing op or path")
        goto continue
      end
      
      local path_parts = SplitPath(patch.path)
      
      if #path_parts < 2 then
        print("WARNING: Invalid patch path: " .. patch.path)
        goto continue
      end
      
      -- Handle different operations
      if patch.op == "replace" then
        if #path_parts >= 3 and path_parts[1] == "devices" then
          local device_id = path_parts[2]
          local property = path_parts[3]
          
          ensure_device_exists(device_id)
          
          -- Handle nested properties like linkStatus[1].ip
          if #path_parts > 3 then
            debug_print("Handling nested property update: " .. patch.path)
            goto continue
          end
          
          -- Update the property
          local old_value = stored_device_data.devices[device_id][property]
          stored_device_data.devices[device_id][property] = patch.value
          
          -- Only log if the value actually changed
          if tostring(old_value) ~= tostring(patch.value) then
            -- All property change logging is now conditional on debug mode
            if DEBUG_ENABLED then
              if property == "name" or property == "temperature" or property == "firmwareVersion" or 
                 property == "unreachable" or property == "failed" or property == "error" or 
                 property == "inputResolution" then
                -- Important properties: use debug_print instead of always printing
                debug_print("NOTICE: Device " .. device_id .. " " .. property .. 
                      " changed from '" .. tostring(old_value) .. "' to '" .. tostring(patch.value) .. "')")
              else
                debug_print("Updated " .. device_id .. "." .. property .. 
                      " from '" .. tostring(old_value) .. "' to '" .. tostring(patch.value) .. "')")
              end
            end
          end
          
          -- Update statistics
          if ENABLE_PATCH_STATS and patch_stats then
            patch_stats.replace_count = patch_stats.replace_count + 1
            patch_stats.total_count = patch_stats.total_count + 1
          end
        end
      elseif patch.op == "add" then
        if #path_parts >= 3 and path_parts[1] == "devices" then
          local device_id = path_parts[2]
          local property = path_parts[3]
          
          ensure_device_exists(device_id)
          
          stored_device_data.devices[device_id][property] = patch.value
          debug_print("Added " .. device_id .. "." .. property .. " = " .. tostring(patch.value))
          
          if ENABLE_PATCH_STATS and patch_stats then
            patch_stats.add_count = patch_stats.add_count + 1
            patch_stats.total_count = patch_stats.total_count + 1
          end
        end
      elseif patch.op == "remove" then
        if #path_parts >= 3 and path_parts[1] == "devices" then
          local device_id = path_parts[2]
          
          if #path_parts == 3 then
            local property = path_parts[3]
            if stored_device_data.devices[device_id] then
              stored_device_data.devices[device_id][property] = nil
              debug_print("Removed property " .. property .. " from device " .. device_id)
              
              if ENABLE_PATCH_STATS and patch_stats then
                patch_stats.remove_count = patch_stats.remove_count + 1
                patch_stats.total_count = patch_stats.total_count + 1
              end
            end
          elseif #path_parts == 2 then
            if stored_device_data.devices[device_id] then
              stored_device_data.devices[device_id] = nil
              debug_print("Removed device: " .. device_id)
              
              if ENABLE_PATCH_STATS and patch_stats then
                patch_stats.remove_count = patch_stats.remove_count + 1
                patch_stats.total_count = patch_stats.total_count + 1
              end
            end
          end
        end
      else
        print("WARNING: Unsupported patch operation: " .. patch.op)
      end
      
      ::continue::
    end
  else
    debug_print("Unhandled action or data format")
  end
  
  -- Check if we should update the UI (throttling to prevent excessive updates)
  local current_time = os.clock()
  local time_since_last_update = current_time - last_ui_update_time
  
  -- Skip UI update if it's too soon after the last one (unless it's an initialization)
  if action ~= "init" and time_since_last_update < UI_UPDATE_INTERVAL then
    debug_print("Skipping UI update due to throttling (" .. string.format("%.2f", time_since_last_update) .. "s since last update)")
    return
  end
  
  -- Log patch statistics every 50 operations
  if ENABLE_PATCH_STATS and patch_stats and patch_stats.total_count % 50 == 0 and patch_stats.total_count > 0 then
    log_patch_stats()
  end
  
  -- Format the device data for CIP-Status output
  local formatted_devices = {}
  
  if stored_device_data and stored_device_data.devices then
    for id, device in pairs(stored_device_data.devices) do
      -- Skip devices that are completely missing essential data
      if device.name or device.ipList or device.firmwareVersion then
        table.insert(formatted_devices, {
          sn = id,
          name = device.name or "Unknown",
          ip = (device.ipList and device.ipList[1]) or "Unknown",
          firmware = device.firmwareVersion or "Unknown",
          temperature = device.temperature or "Unknown",
          inputResolution = device.inputResolution or "Unknown",
          inputPresent = device.inputPresent or false,
          status = GetDeviceStatus(device)
        })
      end
    end
  end
  
  -- Update the last update time
  last_ui_update_time = current_time
  
  local output_table = { devices = formatted_devices }
  local json_output, err = rapidjson.encode(output_table)
  
  if json_output then
    debug_print("Updating CIP-Status with: " .. json_output:sub(1, 100) .. "...")
    Controls["CIP-Status"].String = json_output
  else
    local error_msg = "Error encoding CIP status to JSON: " .. (err or "unknown error")
    print("ERROR: " .. error_msg)
    Controls["CIP-Status"].String = '{"error": "' .. error_msg .. '"}'
  end
end

-- Split a path string into parts (e.g. "/devices/dev1/prop" -> {"devices", "dev1", "prop"})
function SplitPath(path)
  local result = {}
  for part in string.gmatch(path, "[^/]+") do
    table.insert(result, part)
  end
  return result
end

-- Helper function to get keys from a table
function GetTableKeys(tbl)
  local keys = {}
  if tbl then
    for k, _ in pairs(tbl) do
      table.insert(keys, k)
    end
  end
  return keys
end

-- Helper function to count entries in a table
function TableCount(tbl)
  if not tbl or type(tbl) ~= "table" then
    return 0
  end
  
  local count = 0
  for _ in pairs(tbl) do
    count = count + 1
  end
  return count
end

function ConnectToServer()
  local ip = Controls["IP Address"].String
  
  -- Handle empty IP address case with different logic
  if not ip or ip == "" then
    local current_time = os.time()
    ip_address_empty_count = ip_address_empty_count + 1
    last_connection_failure_type = "config"
    
    -- Only print error message periodically to avoid spam
    if ip_address_empty_count == 1 or (current_time - last_ip_check_time) >= CONFIG_CHECK_INTERVAL then
      print("Connection failed: IP Address control is empty. (Attempt #" .. ip_address_empty_count .. ")")
      last_ip_check_time = current_time
    end
    
    Component.Status = "Fault"
    Controls["Connection status"].String = "Configuration Error - No IP Address Set"
    
    -- Reset connection state
    isConnecting = false
    
    -- Schedule next check with longer interval for config issues
    if reconnectTimer then
      reconnectTimer:Stop()
      reconnectTimer:Start(CONFIG_CHECK_INTERVAL)
    end
    return
  end
  
  -- Reset IP address error count on successful IP validation
  if ip_address_empty_count > 0 then
    print("IP Address now configured: " .. ip .. ". Resuming normal connection attempts.")
    ip_address_empty_count = 0
    current_reconnect_interval = RECONNECT_INTERVAL -- Reset backoff
  end
  
  if not isConnecting and ROUTER_PORT > 0 then
    isConnecting = true
    last_connection_failure_type = "network"
    Controls["Connection status"].String = "Connecting..."
    print("Attempting to connect to ws://" .. ip .. ":" .. ROUTER_PORT .. "/")

    -- Create a new WebSocket client
    ws = WebSocket.New()
    
    -- Ensure ping timer is properly set up (only create if it doesn't exist)
    if not pingTimer then
      print("DEBUG: Creating new ping timer")
      pingTimer = Timer.New() -- Use the global variable
      
      -- Define the event handler directly with the timer
      -- This ensures the timer isn't garbage collected
      pingTimer.EventHandler = function(timer)
        print("DEBUG: Sending ping to keep connection alive")
        if ws then
          ws:Ping()
          print("DEBUG: Ping sent successfully")
        else
          print("WARNING: Cannot send ping, ws object is nil")
        end
      end
    else
      print("DEBUG: Using existing ping timer")
      pingTimer:Stop() -- Ensure it's stopped before connecting
    end
    isSocketConnected = false -- Reset on new connection attempt

    -- WebSocket event handlers are defined below


    debug_print("DEBUG: Setting up WebSocket event handlers...")
    
    -- Connected event handler
    debug_print("DEBUG: Registering ws.Connected callback...")
    ws.Connected = function()
      debug_print("DEBUG: ws.Connected event fired. WebSocket is now CONNECTED.")
      -- Update connection state
      isSocketConnected = true
      Component.Status = "OK"
      Controls["Connection status"].String = "Connected, authenticating..."
      
      -- Reset reconnect backoff on successful connection
      current_reconnect_interval = RECONNECT_INTERVAL
      print("DEBUG: Connection successful, reset reconnect interval to " .. RECONNECT_INTERVAL .. " seconds")
      
      -- Stop reconnect timer if it was running
      if reconnectTimer then reconnectTimer:Stop() end
      
      -- Start the ping timer (every 30 seconds)
      print("DEBUG: Starting ping timer to keep connection alive")
      if pingTimer then pingTimer:Start(30) end
      
      print("DEBUG: Should now start receiving data if server sends any...")
      -- Send a dummy message to potentially trigger the server to respond
      print("DEBUG: Sending a dummy ping message to server...")
      ws:Write("{\"type\":\"ping\"}")
    end
    
    -- Closed event handler
    print("DEBUG: Registering ws.Closed callback...")
    ws.Closed = function()
      print("DEBUG: ws.Closed event fired. WebSocket connection CLOSED.")
      
      -- Update connection state
      isSocketConnected = false
      isAuthenticated = false
      Component.Status = "Compromised"
      Controls["Connection status"].String = "Disconnected. Reconnecting..."
      
      -- Stop ping timer
      print("DEBUG: Stopping ping timer")
      if pingTimer then pingTimer:Stop() end
      
      -- Start reconnect timer with exponential backoff for network failures
      if last_connection_failure_type == "network" then
        current_reconnect_interval = math.min(current_reconnect_interval * RECONNECT_BACKOFF_MULTIPLIER, MAX_RECONNECT_INTERVAL)
      end
      
      print("DEBUG: Attempting reconnect in " .. current_reconnect_interval .. " seconds...")
      if reconnectTimer then 
        reconnectTimer:Stop() 
        reconnectTimer:Start(current_reconnect_interval)
      end
    end
    
    -- Data event handler
    debug_print("Registering custom data handler function...")
    ws.Data = function(w, data)
      if DEBUG_ENABLED then
        debug_print("ws.Data event fired! Received data of type: " .. type(data))
        if type(data) == "string" then
          debug_print("Data is a string. Length: " .. #data .. ".")
          local preview = data
          if #data > 50 then preview = data:sub(1, 50) .. "..." end
          debug_print("Data preview: '" .. preview .. "'")
        else
          debug_print("Data is of unexpected type: " .. type(data))
        end
      end
      
      New_OnDataReceived(w, data)
    end
    
    -- Error event handler
    debug_print("Registering ws.Error callback...")
    ws.Error = function(w, err)
      print("WebSocket ERROR: " .. tostring(err))  -- Always log errors
      
      -- Update connection state
      isSocketConnected = false
      Component.Status = "Fault"
      Controls["Connection status"].String = "WebSocket Error: " .. tostring(err)
      
      -- Stop ping timer
      if pingTimer then pingTimer:Stop() end
      
      -- Try to reconnect after error with exponential backoff
      if last_connection_failure_type == "network" then
        current_reconnect_interval = math.min(current_reconnect_interval * RECONNECT_BACKOFF_MULTIPLIER, MAX_RECONNECT_INTERVAL)
      end
      
      print("DEBUG: Scheduling reconnect after error in " .. current_reconnect_interval .. " seconds...")
      if reconnectTimer then 
        reconnectTimer:Stop()
        reconnectTimer:Start(current_reconnect_interval)
      end
    end
    
    -- Pong event handler
    debug_print("Adding ws.Pong callback...")
    ws.Pong = function()
      debug_print("Received pong response from server")
    end

    debug_print("About to call ws:Connect('ws', '" .. ip .. "', '/', " .. ROUTER_PORT .. ")")
    ws:Connect("ws", ip, "/", ROUTER_PORT)
    debug_print("Connect called. Connection attempt in progress...")
  else
    -- This else block should not be reached with the new logic above
    print("WARNING: ConnectToServer reached unexpected else condition")
    isConnecting = false
  end
end

function SendCommand(payload)
  if ws and isSocketConnected and isAuthenticated then
    local command = {
      type = "request",
      method = "POST",
      route = "makeconnection",
      id = tostring(request_id),
      data = payload
    }
    request_id = request_id + 1

    local json_command, err = rapidjson.encode(command)
    if json_command then
      print("Sending command: " .. json_command)
      ws:Write(json_command)
    else
      print(format("Failed to encode JSON command: %s", err))
    end
  else
    print("Command not sent. Not connected.")
    Controls["Connection status"].String = "Error: Not Connected"
    Component.Status = "Fault"
  end
end

function OnDecoderSourceChanged(sourceControl, decoderControl)
  -- Defensive check: Q-Sys may fire the handler with invalid arguments on initialization
  -- We only proceed if we get valid control objects (table or userdata)
  if (type(sourceControl) ~= "table" and type(sourceControl) ~= "userdata") or 
     (type(decoderControl) ~= "table" and type(decoderControl) ~= "userdata") then
    return
  end

  local sourceName = sourceControl.String
  local decoderName = decoderControl.String
  
  debug_print("DEBUG: OnDecoderSourceChanged triggered")
  debug_print("DEBUG: Source control value: " .. tostring(sourceName))
  debug_print("DEBUG: Decoder control value: " .. tostring(decoderName))
  
  if decoderName and decoderName ~= "" then
    local payload
    if sourceName == DISCONNECT_CHOICE then
      -- To disconnect, we send an empty source for the given destination.
      payload = {
        destination = decoderName,
        source = "",
        preview = false
      }
      debug_print("DEBUG: Disconnecting decoder: " .. decoderName)
    else
      -- To connect, we send the source and destination.
      payload = {
        source = sourceName,
        destination = decoderName,
        preview = false
      }
      debug_print("DEBUG: Connecting encoder '" .. tostring(sourceName) .. "' to decoder '" .. tostring(decoderName) .. "'")
    end
    debug_print("DEBUG: Sending payload: " .. rapidjson.encode(payload))
    SendCommand(payload)
  else
    print(format("WARNING: Decoder control (original index %d) is empty. Cannot send command.", decoderControl.Index))
  end
end

-- *************************
-- * Initialization Logic  *
-- *************************

function Initialize()
  print("Initializing Crosspoint Router Script (WebSocket API)...")

  if not Controls["CIP-Status"] then
    print("WARNING: Control 'CIP-Status' not found. Matrox CIP status will not be displayed.")
  end

  if not Controls["Connection status"] then 
    print("FATAL: Control 'Connection status' not found.")
    Component.Status = "Fault"
    return 
  end

  Component.Status = "Initializing"
  Controls["Connection status"].String = "Initializing Script..."

  if not Controls["IP Address"] then 
    print("FATAL: Control 'IP Address' not found.")
    Component.Status = "Fault"
    Controls["Connection status"].String = "FATAL: Control 'IP Address' not found."
    return 
  end

  -- Setup reconnect timer once during initialization
  if not reconnectTimer then
    reconnectTimer = Timer.New()
    reconnectTimer.EventHandler = function()
      ConnectToServer()
    end
    print("DEBUG: Created reconnect timer")
  end

  -- Set up event handler for the IP Address control.
  Controls["IP Address"].EventHandler = function()
    if ws then ws:Close() end
    if reconnectTimer then reconnectTimer:Stop() end
    ConnectToServer()
  end

  -- Add handler for preset JSON input
  if Controls.Code and type(Controls.Code) == "table" then
    Controls.Code.EventHandler = function(control)
      -- Defensively check if the argument is the control object (a table) or just its initial value (a string)
      if type(control) ~= "table" then
        return
      end

      local json_string = control.String
      if json_string == nil or json_string == "" then
        return -- Ignore empty input
      end

      print("Received new JSON preset. Processing...")
      local ok, payload = pcall(rapidjson.decode, json_string)

      if not ok then
        print(format("ERROR: Invalid JSON in preset control: %s", tostring(payload)))
        return
      end

      SendCommand(payload)
    end
    print("Initialized JSON preset handler for 'Controls.Code'.")
  end

  -- Multiviewer initialization will be moved after sortedDecoders is declared

  -- Create the list of choices for the source dropdowns
  local sourceChoices = { DISCONNECT_CHOICE }
  local encoderNames = GetEncoderNames()
  for _, encoderName in ipairs(encoderNames) do
    table.insert(sourceChoices, encoderName)
  end
  
  -- To handle sparse tables from Q-Sys, we will collect all controls and sort them
  local sortedDecoderSources = {}
  if Controls.DecoderSource and type(Controls.DecoderSource) == "table" then
    for _, control in pairs(Controls.DecoderSource) do
      table.insert(sortedDecoderSources, control)
    end
    table.sort(sortedDecoderSources, function(a, b) return a.Index < b.Index end)
  end

  local sortedDecoders = {}
  if Controls.Decoder and type(Controls.Decoder) == "table" then
    for _, control in pairs(Controls.Decoder) do
      table.insert(sortedDecoders, control)
    end
    table.sort(sortedDecoders, function(a, b) return a.Index < b.Index end)
  end

  -- Handle multiviewer controls as an array (like DecoderSource controls)
  -- Must be after sortedDecoders is populated
  local sortedMultiviewer = {}
  if Controls.Multiviewer and type(Controls.Multiviewer) == "table" then
    for _, control in pairs(Controls.Multiviewer) do
      table.insert(sortedMultiviewer, control)
    end
    table.sort(sortedMultiviewer, function(a, b) return a.Index < b.Index end)
    
    -- Register event handlers for each multiviewer control
    for i = 1, #sortedMultiviewer do
      local multiviewerControl = sortedMultiviewer[i]
      local decoderControl = sortedDecoders[i]  -- Get corresponding decoder
      
      if decoderControl then
        -- Create a closure that captures the specific decoder information
        multiviewerControl.EventHandler = function(control)
          OnIndividualMultiviewerChanged(control, decoderControl)
        end
      else
        print("WARNING: No corresponding decoder found for multiviewer control at index " .. i)
      end
    end
    
    print(format("Initialized %d multiviewer control handlers.", #sortedMultiviewer))
  else
    print("WARNING: 'Controls.Multiviewer' not found or is not a table. Multiviewer functionality will not be available.")
  end

  if #sortedDecoderSources == 0 then
    print("WARNING: 'Controls.DecoderSource' not found or is empty.")
  else
    if #sortedDecoderSources ~= #sortedDecoders then
      print(format("WARNING: Mismatch in control counts. Found %d 'DecoderSource' controls and %d 'Decoder' controls. Only the first %d will be mapped.", #sortedDecoderSources, #sortedDecoders, math.min(#sortedDecoderSources, #sortedDecoders)))
    end

    -- Register event handlers using the new sorted tables
    for i = 1, math.min(#sortedDecoderSources, #sortedDecoders) do
      local sourceControl = sortedDecoderSources[i]
      local decoderControl = sortedDecoders[i]

      sourceControl.Choices = sourceChoices

      -- The event handler function closes over the correct source and decoder controls
      sourceControl.EventHandler = function(ctrl)
        OnDecoderSourceChanged(ctrl, decoderControl)
      end
    end
    print(format("Initialized %d decoder source controls.", #sortedDecoderSources))
  end

  -- Attempt the initial connection on script start
  ConnectToServer()
  
  print("Initialization complete.")
end

Initialize()