--[[
  Q-SYS multiviewer buttons — regression tests.

  The Multiviewer buttons used to be send-only: they never showed the decoder's
  real state, stayed wrong when a toggle failed or was never sent, and
  SetupMultiviewer patched encoders after a fixed 2s whether or not the decoder
  had switched. Device state was also never stored without a CIP-Status
  control, and decoders discovered after subscribing were dropped.

  Loads the REAL script with mocked Q-SYS globals (Controls, Timer, WebSocket,
  rapidjson) and drives it with router messages.

    lua test/unit/qsys-multiviewer-feedback.test.lua
]]

local SCRIPT = os.getenv("QSYS_SCRIPT")
  or (arg and arg[0] or ""):gsub("[^/]*$", "") .. "../../scripts/q-sys-crosspoint-control.lua"

-- The script logs heavily; keep it quiet and report through out().
local out = print
print = function() end

local pass, fail = 0, 0
local function check(name, cond, extra)
  if cond then pass = pass + 1; out("PASS  " .. name)
  else fail = fail + 1; out("FAIL  " .. name .. (extra and ("  " .. tostring(extra)) or "")) end
end

-- rapidjson stand-in: messages travel as Lua tables behind opaque string handles.
local wire, handles = {}, 0
package.preload["rapidjson"] = function()
  return {
    encode = function(t) handles = handles + 1; local h = "#msg" .. handles; wire[h] = t; return h end,
    decode = function(h) return assert(wire[h], "unknown message handle") end,
  }
end

local function control(index, value)
  return { Index = index, String = value or "", Boolean = false, Value = 0 }
end
local function timer()
  return { Start = function() end, Stop = function() end }
end

Component = { Status = "" }
Timer = { New = timer, CallAfter = function() end }
WebSocket = { New = function() return { Connect = function() end, Close = function() end, Ping = function() end } end }
Crypto = { Digest = function() return "" end }
Controls = {
  ["IP Address"] = control(0, ""),
  ["Connection status"] = control(0),
  -- No CIP-Status control: state must still be stored and the buttons still updated.
  Decoder = { control(1, "CIP-DEC-740"), control(2, "Studio Quad.v1"), control(3, "Unknown Dec") },
  Multiviewer = { control(1), control(2), control(3) },
}
local mv, dec = Controls.Multiviewer, Controls.Decoder

dofile(SCRIPT)

-- Connected and authenticated, with a socket that records what is written.
local sent = {}
ws = { Write = function(_, h) table.insert(sent, wire[h]) end, Close = function() end }
isSocketConnected, isAuthenticated = true, true

local function receive(msg) local h = "#in" .. tostring(msg); wire[h] = msg; New_ProcessMessage(h) end
local function sync(action, data) receive({ type = "sync", channel = "mediadevmatroxcip", action = action, data = data }) end
local function respond(id, status, message) receive({ type = "response", id = id, status = status, message = message }) end
local function press(button, value)
  button.Boolean = value
  button.Value = value and 1 or 0
  button.EventHandler(button)
end
local function last() return sent[#sent] end

-- Initial state from the router.
sync("init", { devices = {
  ["cip-dec-740"] = { name = "Lobby", isMultiviewEnabled = true },
  ["ya00634"] = { name = "Studio Quad", isMultiviewEnabled = false },
} })
check("button follows the decoder on init (by serial, any case)", mv[1].Boolean == true)
check("button follows the decoder on init (by name, flow suffix ignored)", mv[2].Boolean == false)
check("button for a decoder the router does not know is left alone", mv[3].Boolean == false)

-- A change made elsewhere (web UI, another controller) shows up.
sync("patch", { { op = "replace", path = "/devices/ya00634/isMultiviewEnabled", value = true } })
check("patch from the router updates the button", mv[2].Boolean == true)

-- Successful toggle.
press(mv[1], false)
local req = last()
check("toggle addresses the decoder by its serial", req.route == "matroxcip_togglemultiviewer"
  and req.data.sn == "cip-dec-740" and req.data.enabled == false, req.data and req.data.sn)
sync("patch", { { op = "replace", path = "/devices/ya00634/temperature", value = 50 } })
check("pending toggle is not snapped back by unrelated state", mv[1].Boolean == false)
respond(req.id, 200, "ok")
check("confirmed toggle keeps the new value", mv[1].Boolean == false)
check("confirmed toggle updates the stored state", stored_device_data.devices["cip-dec-740"].isMultiviewEnabled == false)

-- Rejected toggle.
press(mv[2], false)
req = last()
respond(req.id, 400, "Device kept multiviewer enabled")
check("rejected toggle shows the decoder's real state again", mv[2].Boolean == true)

-- Rejected toggle on a decoder the state does not report.
dec[3].String = "Unknown Dec"
press(mv[3], true)
req = last()
check("unknown decoder is addressed by the name given", req.data.sn == "Unknown Dec", req.data.sn)
respond(req.id, 400, "Device not found.")
check("rejected toggle without device state reverts the button", mv[3].Boolean == false)

-- Not connected: nothing is sent and the button reverts.
isSocketConnected = false
local count = #sent
press(mv[1], true)
check("nothing is sent while disconnected", #sent == count)
check("button reverts when the toggle could not be sent", mv[1].Boolean == false)
isSocketConnected = true

-- No answer: after the timeout the device state wins again.
press(mv[1], true)
req = last()
local realTime = os.time
os.time = function() return realTime() + 31 end
sync("patch", { { op = "replace", path = "/devices/ya00634/temperature", value = 51 } })
os.time = realTime
check("unanswered toggle gives way to the device state after the timeout", mv[1].Boolean == false)
respond(req.id, 200, "ok") -- late answer for a forgotten request is ignored safely

-- A decoder discovered after subscribing.
dec[3].String = "New Dec"
sync("patch", { { op = "add", path = "/devices/newdec1", value = { name = "New Dec", isMultiviewEnabled = true } } })
check("decoder added after subscribing is stored", stored_device_data.devices["newdec1"] ~= nil)
check("...and its button follows it", mv[3].Boolean == true)

-- Re-pointing a slot at another decoder shows that decoder's state.
dec[3].String = "Lobby"
dec[3].EventHandler(dec[3])
check("changing a slot's decoder updates its button", mv[3].Boolean == false)

-- SetupMultiviewer patches only after the router confirms.
count = #sent
SetupMultiviewer("Studio Quad", { "Enc1", "Enc2" })
req = last()
check("setup sends the enable first", #sent == count + 1 and req.route == "matroxcip_togglemultiviewer")
respond(req.id, 400, "Master mode not enabled after 3 attempts")
check("setup does not patch when enabling fails", #sent == count + 1)

SetupMultiviewer("Studio Quad", { "Enc1", "Enc2" })
req = last()
respond(req.id, 200, "ok")
local patch = last()
check("setup patches once enabling is confirmed", patch.route == "makeconnection")
check("...quadrant by quadrant", patch.data and patch.data.multiple
  and patch.data.multiple[1].destination == "Studio Quad.1"
  and patch.data.multiple[2].destination == "Studio Quad.2")

out(string.format("\n%d passed, %d failed", pass, fail))
os.exit(fail == 0 and 0 or 1)
