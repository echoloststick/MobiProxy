local Config = ...

local Rt = {}

local blockedServices = Config.blocked or {}
local programLabel = Config.label or "Program"

local GUARD_STRIDE = 256
local GUARD_BUDGET = 0.1
local MIN_INTERVAL = 0.03
local STOP_TIMEOUT = 2
local OBJECT_ROOTS = {
	"Workspace",
	"ReplicatedStorage",
	"ServerStorage",
	"ServerScriptService",
	"StarterGui",
	"StarterPack",
	"StarterPlayer",
	"Lighting",
	"SoundService",
	"Teams",
}

local state = {
	ready = false,
	stopping = false,
	stopped = false,
	threads = {},
	connections = {},
	starters = {},
	stoppers = {},
	timers = {},
	custom = {},
}

local objectCache = {}
local slices = setmetatable({}, { __mode = "k" })
local guardCount = 0

Rt.version = Config.lang
Rt.label = programLabel
Rt.debug = Config.debug == true

local function identity(value)
	return value
end

local function describe(err)
	if type(err) == "table" and err.mobi == true then
		return err.code, tostring(err.message), err.block
	end
	return nil, tostring(err), nil
end

local function report(err, rootId, name)
	local code, message, block = describe(err)
	if code == nil then
		code = "R3001"
		block = rootId
	end
	local where = ""
	if name ~= nil then
		where = string.format(" in \"%s\"", tostring(name))
	end
	local at = ""
	if block ~= nil then
		at = string.format(" (block %s)", tostring(block))
	end
	warn(string.format("[MOBI] Runtime error %s%s%s: %s", code, where, at, message))
end

local function note(code, block, message)
	local at = ""
	if block ~= nil then
		at = string.format(" (block %s)", tostring(block))
	end
	warn(string.format("[MOBI] Runtime error %s%s: %s", code, at, message))
end

local function fail(code, message, block)
	error({ mobi = true, code = code, message = message, block = block }, 0)
end

local function readIndex(target, key)
	return target[key]
end

local function writeIndex(target, key, value)
	target[key] = value
end

local function run(fn, rootId, name, onDone, ...)
	local thread = coroutine.running()
	state.threads[thread] = true
	local ok, err = xpcall(fn, identity, ...)
	state.threads[thread] = nil
	if not ok then
		report(err, rootId, name)
	end
	if onDone ~= nil then
		onDone()
	end
end

function Rt.log(level, value)
	local text = tostring(value)
	if level == "warn" then
		warn(text)
	elseif level == "error" then
		warn("Error: " .. text)
	else
		print(text)
	end
end

function Rt.fail(message, block)
	fail("R3001", tostring(message), block)
end

function Rt.errmsg(err)
	local _, message = describe(err)
	return message
end

function Rt.self()
	return script.Parent
end

local function findById(id)
	local cached = objectCache[id]
	if cached ~= nil and cached.Parent ~= nil then
		return cached
	end
	objectCache[id] = nil
	for _, serviceName in ipairs(OBJECT_ROOTS) do
		local ok, container = pcall(game.GetService, game, serviceName)
		if ok and container ~= nil then
			for _, item in ipairs(container:GetDescendants()) do
				if item:GetAttribute("ID") == id then
					objectCache[id] = item
					return item
				end
			end
		end
	end
	return nil
end

local function findByPath(path)
	if type(path) ~= "string" or path == "" then
		return nil
	end
	local current = game
	for segment in string.gmatch(path, "[^%.]+") do
		if not (segment == "game" and current == game) then
			current = current:FindFirstChild(segment)
			if current == nil then
				return nil
			end
		end
	end
	if current == game then
		return nil
	end
	return current
end

function Rt.obj(id, path, block, class)
	local found = findById(id)
	if found == nil then
		found = findByPath(path)
	end
	if found == nil then
		local shown = path
		if shown == nil or shown == "" then
			shown = id
		end
		fail("R2001", string.format("Object \"%s\" was not found by its identifier or by its path.", tostring(shown)), block)
	end
	if class ~= nil and not found:IsA(class) then
		fail("R1002", string.format("Object \"%s\" is a %s but a %s was expected.", tostring(found.Name), found.ClassName, class), block)
	end
	return found
end

function Rt.service(name, block)
	if blockedServices[name] == true then
		fail("R2003", string.format("Service '%s' is blocked and cannot be used.", tostring(name)), block)
	end
	local ok, service = pcall(game.GetService, game, name)
	if not ok or service == nil then
		fail("R2004", string.format("Service '%s' is not available.", tostring(name)), block)
	end
	return service
end

function Rt.create(class, parent, block)
	local ok, created = pcall(Instance.new, class)
	if not ok or created == nil then
		fail("R2005", string.format("An instance of class '%s' cannot be created.", tostring(class)), block)
	end
	if parent ~= nil then
		created.Parent = parent
	end
	return created
end

function Rt.cast(value, class, block)
	if value == nil then
		fail("R1002", string.format("A %s was expected but the value is nil.", class), block)
	end
	if typeof(value) ~= "Instance" then
		fail("R1002", string.format("A %s was expected but the value is of type %s.", class, typeof(value)), block)
	end
	if not value:IsA(class) then
		fail("R1002", string.format("A %s was expected but the object \"%s\" is a %s.", class, tostring(value.Name), value.ClassName), block)
	end
	return value
end

function Rt.get(target, key, block)
	if target == nil then
		fail("R1001", string.format("Cannot read property '%s' of nil.", tostring(key)), block)
	end
	local ok, value = pcall(readIndex, target, key)
	if not ok then
		fail("R1003", string.format("'%s' is not a valid member of %s.", tostring(key), typeof(target)), block)
	end
	return value
end

function Rt.set(target, key, value, block)
	if target == nil then
		fail("R1001", string.format("Cannot assign property '%s' of nil.", tostring(key)), block)
	end
	local ok, problem = pcall(writeIndex, target, key, value)
	if not ok then
		fail("R1004", string.format("Property '%s' could not be assigned: %s", tostring(key), tostring(problem)), block)
	end
end

function Rt.call(target, method, block, ...)
	if target == nil then
		fail("R1001", string.format("Cannot call method '%s' of nil.", tostring(method)), block)
	end
	local ok, fn = pcall(readIndex, target, method)
	if not ok or type(fn) ~= "function" then
		fail("R1003", string.format("'%s' is not a valid method of %s.", tostring(method), typeof(target)), block)
	end
	return fn(target, ...)
end

function Rt.sig(target, name, block)
	if target == nil then
		note("R2002", block, string.format("The target of signal '%s' is nil, so the handler was not connected.", tostring(name)))
		return nil
	end
	local ok, signal = pcall(readIndex, target, name)
	if not ok or signal == nil then
		note("R1003", block, string.format("'%s' is not a valid signal of %s, so the handler was not connected.", tostring(name), typeof(target)))
		return nil
	end
	return signal
end

function Rt.await(signal)
	if signal == nil then
		fail("R2002", "Cannot wait for a signal that is nil.", nil)
	end
	return signal:Wait()
end

function Rt.connect(signal, fn, rootId, name, reentry)
	if signal == nil then
		return nil
	end
	local busy = false
	local function finished()
		busy = false
	end
	local connection = signal:Connect(function(...)
		if state.stopping then
			return
		end
		if reentry == "ignore" and busy then
			return
		end
		busy = true
		task.spawn(run, fn, rootId, name, finished, ...)
	end)
	state.connections[#state.connections + 1] = connection
	return connection
end

function Rt.disconnect(connection)
	if connection ~= nil then
		connection:Disconnect()
	end
end

function Rt.on(key, fn, rootId)
	local list = state.custom[key]
	if list == nil then
		list = {}
		state.custom[key] = list
	end
	list[#list + 1] = { fn = fn, rootId = rootId }
end

function Rt.fire(key, ...)
	if state.stopping then
		return
	end
	local list = state.custom[key]
	if list == nil then
		return
	end
	local snapshot = {}
	for index, handler in ipairs(list) do
		snapshot[index] = handler
	end
	for _, handler in ipairs(snapshot) do
		task.spawn(run, handler.fn, handler.rootId, "Custom event", nil, ...)
	end
end

local function startTimer(timer)
	task.spawn(function()
		local thread = coroutine.running()
		state.threads[thread] = true
		while not state.stopping do
			task.wait(timer.interval)
			if state.stopping then
				break
			end
			local ok, err = xpcall(timer.fn, identity)
			if not ok then
				report(err, timer.rootId, "Timer")
			end
		end
		state.threads[thread] = nil
	end)
end

function Rt.every(seconds, fn, rootId)
	local interval = tonumber(seconds)
	if interval == nil or interval ~= interval or interval <= 0 then
		note("R3001", rootId, "The interval of a timer must be a positive number, so the timer was not started.")
		return
	end
	local timer = { interval = math.max(interval, MIN_INTERVAL), fn = fn, rootId = rootId }
	state.timers[#state.timers + 1] = timer
	if state.ready and not state.stopping then
		startTimer(timer)
	end
end

function Rt.onStart(fn, rootId)
	state.starters[#state.starters + 1] = { fn = fn, rootId = rootId }
end

function Rt.onStop(fn, rootId)
	state.stoppers[#state.stoppers + 1] = { fn = fn, rootId = rootId }
end

function Rt.root(rootId, fn)
	local ok, err = xpcall(fn, identity)
	if not ok then
		report(err, rootId, "Setup")
	end
end

function Rt.spawn(fn)
	if state.stopping then
		return
	end
	task.spawn(run, fn, nil, "Parallel block", nil)
end

function Rt.delay(seconds, fn)
	if state.stopping then
		return
	end
	task.spawn(run, function()
		task.wait(seconds)
		if state.stopping then
			return
		end
		fn()
	end, nil, "Delayed block", nil)
end

function Rt.guard(block)
	guardCount = guardCount + 1
	if guardCount < GUARD_STRIDE then
		return
	end
	guardCount = 0
	local thread = coroutine.running()
	local now = os.clock()
	local started = slices[thread]
	if started == nil then
		slices[thread] = now
		return
	end
	if now - started > GUARD_BUDGET then
		task.wait()
		slices[thread] = os.clock()
	end
end

function Rt.ready()
	if state.ready then
		return
	end
	state.ready = true
	for _, timer in ipairs(state.timers) do
		startTimer(timer)
	end
	for _, starter in ipairs(state.starters) do
		task.spawn(run, starter.fn, starter.rootId, "Start", nil)
	end
end

local function stopNow()
	if state.stopped then
		return
	end
	state.stopping = true
	local pending = 0
	local function done()
		pending = pending - 1
	end
	for _, stopper in ipairs(state.stoppers) do
		pending = pending + 1
		task.spawn(run, stopper.fn, stopper.rootId, "Stop", done)
	end
	local deadline = os.clock() + STOP_TIMEOUT
	while pending > 0 and os.clock() < deadline do
		task.wait()
	end
	state.stopped = true
	for _, connection in ipairs(state.connections) do
		connection:Disconnect()
	end
	local current = coroutine.running()
	for thread in pairs(state.threads) do
		if thread ~= current then
			task.cancel(thread)
		end
	end
	state.threads = {}
	state.connections = {}
	state.custom = {}
	state.timers = {}
	state.starters = {}
	state.stoppers = {}
	objectCache = {}
end

function Rt.stop()
	if state.stopping then
		return
	end
	task.defer(stopNow)
end

function Rt.isStopped()
	return state.stopping
end

return Rt
