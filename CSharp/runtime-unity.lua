local RunService = game:GetService("RunService")
local UserInputService = game:GetService("UserInputService")
local CollectionService = game:GetService("CollectionService")

CS.Space = { World = 0, Self = 1 }
CS.SceneManager = {
	LoadScene = function()
		warn("[CSharp] SceneManager.LoadScene is not supported in this environment.")
	end,
}

local state = { dt = 0, time = 0, frame = 0, fixedDt = 0.02 }

CS.Time = setmetatable({ timeScale = 1 }, {
	__index = function(_, k)
		if k == "deltaTime" or k == "unscaledDeltaTime" or k == "smoothDeltaTime" then
			return state.dt
		end
		if k == "time" or k == "realtimeSinceStartup" or k == "unscaledTime" then
			return state.time
		end
		if k == "fixedDeltaTime" then
			return state.fixedDt
		end
		if k == "frameCount" then
			return state.frame
		end
		return nil
	end,
})

CS.Application = { isPlaying = true, targetFrameRate = 60, platform = "Roblox", productName = "Studio Mobi" }

function CS.Application.Quit()
end

CS.Cursor = { visible = true, lockState = 0 }
CS.Screen = setmetatable({}, {
	__index = function(_, k)
		local cam = workspace.CurrentCamera
		if cam and (k == "width" or k == "height") then
			return k == "width" and cam.ViewportSize.X or cam.ViewportSize.Y
		end
		return nil
	end,
})

local function unwrap(o)
	if type(o) == "table" and rawget(o, "__inst") then
		return rawget(o, "__inst")
	end
	return o
end

CS.Unwrap = unwrap

local function getCF(i)
	if i:IsA("BasePart") then
		return i.CFrame
	end
	if i:IsA("Model") then
		return i:GetPivot()
	end
	return CFrame.new()
end

local function setCF(i, cf)
	if i:IsA("BasePart") then
		i.CFrame = cf
	elseif i:IsA("Model") then
		i:PivotTo(cf)
	end
end

local goCache = setmetatable({}, { __mode = "k" })
local trCache = setmetatable({}, { __mode = "k" })
local GO = {}
local TR = {}

function CS.GO(inst)
	inst = unwrap(inst)
	if inst == nil then
		return nil
	end
	local p = goCache[inst]
	if not p then
		p = setmetatable({ __inst = inst }, GO)
		goCache[inst] = p
	end
	return p
end

local function TRof(inst)
	if inst == nil then
		return nil
	end
	local p = trCache[inst]
	if not p then
		p = setmetatable({ __inst = inst }, TR)
		trCache[inst] = p
	end
	return p
end

local behaviours = {}
local byInstance = {}

local function setActive(inst, on)
	if inst:IsA("BasePart") then
		if on then
			inst.Transparency = inst:GetAttribute("__csT") or inst.Transparency
			inst.CanCollide = inst:GetAttribute("__csC") ~= false
		else
			inst:SetAttribute("__csT", inst.Transparency)
			inst:SetAttribute("__csC", inst.CanCollide)
			inst.Transparency = 1
			inst.CanCollide = false
		end
	end
	for _, d in ipairs(inst:GetChildren()) do
		setActive(d, on)
	end
	inst:SetAttribute("__csActive", on)
end

GO.__index = function(p, k)
	local inst = rawget(p, "__inst")
	if k == "gameObject" then
		return p
	end
	if k == "transform" then
		return TRof(inst)
	end
	if k == "name" then
		return inst.Name
	end
	if k == "tag" then
		return CollectionService:GetTags(inst)[1] or "Untagged"
	end
	if k == "activeSelf" or k == "activeInHierarchy" then
		return inst:GetAttribute("__csActive") ~= false
	end
	if k == "Instance" then
		return inst
	end
	if k == "SetActive" then
		return function(_, on)
			setActive(inst, on)
			for _, b in ipairs(byInstance[inst] or {}) do
				b.enabled = on
				local f = on and b.OnEnable or b.OnDisable
				if f then
					f(b)
				end
			end
		end
	end
	if k == "CompareTag" then
		return function(_, t)
			return CollectionService:HasTag(inst, t)
		end
	end
	local v = inst[k]
	if type(v) == "function" then
		return function(self, ...)
			return v(inst, ...)
		end
	end
	return v
end

GO.__newindex = function(p, k, v)
	local inst = rawget(p, "__inst")
	if k == "name" then
		inst.Name = v
	elseif k == "tag" then
		CollectionService:AddTag(inst, v)
	else
		inst[k] = unwrap(v)
	end
end

GO.__eq = function(a, b)
	return unwrap(a) == unwrap(b)
end

GO.__tostring = function(p)
	return rawget(p, "__inst").Name
end

local function rotOnly(cf)
	return cf - cf.Position
end

TR.__index = function(p, k)
	local inst = rawget(p, "__inst")
	if k == "gameObject" then
		return CS.GO(inst)
	end
	if k == "position" or k == "localPosition" then
		return getCF(inst).Position
	end
	if k == "rotation" or k == "localRotation" then
		return rotOnly(getCF(inst))
	end
	if k == "eulerAngles" or k == "localEulerAngles" then
		local x, y, z = getCF(inst):ToEulerAnglesYXZ()
		return Vector3.new(math.deg(x), math.deg(y), math.deg(z))
	end
	if k == "localScale" or k == "lossyScale" then
		return inst:IsA("BasePart") and inst.Size or Vector3.one
	end
	if k == "forward" then
		return getCF(inst).LookVector
	end
	if k == "right" then
		return getCF(inst).RightVector
	end
	if k == "up" then
		return getCF(inst).UpVector
	end
	if k == "parent" then
		return inst.Parent and inst.Parent ~= workspace and TRof(inst.Parent) or nil
	end
	if k == "root" then
		local r = inst
		while r.Parent and r.Parent ~= workspace do
			r = r.Parent
		end
		return TRof(r)
	end
	if k == "childCount" then
		return #inst:GetChildren()
	end
	if k == "Translate" then
		return function(_, v, space)
			local cf = getCF(inst)
			if space == CS.Space.World then
				setCF(inst, cf + v)
			else
				setCF(inst, cf * CFrame.new(v))
			end
		end
	end
	if k == "Rotate" then
		return function(_, e, space)
			local r = CFrame.fromEulerAnglesYXZ(math.rad(e.X), math.rad(e.Y), math.rad(e.Z))
			local cf = getCF(inst)
			if space == CS.Space.World then
				setCF(inst, CFrame.new(cf.Position) * r * rotOnly(cf))
			else
				setCF(inst, cf * r)
			end
		end
	end
	if k == "RotateAround" then
		return function(_, point, axis, angle)
			local cf = getCF(inst)
			local rot = CFrame.fromAxisAngle(axis, math.rad(angle))
			local pos = point + rot * (cf.Position - point)
			setCF(inst, CFrame.new(pos) * rot * rotOnly(cf))
		end
	end
	if k == "LookAt" then
		return function(_, target, up)
			local t = unwrap(target)
			local pos = typeof(t) == "Vector3" and t or getCF(t).Position
			setCF(inst, CFrame.lookAt(getCF(inst).Position, pos, up))
		end
	end
	if k == "GetChild" then
		return function(_, i)
			return TRof(inst:GetChildren()[i + 1])
		end
	end
	if k == "Find" then
		return function(_, name)
			local c = inst:FindFirstChild(name, true)
			return c and TRof(c) or nil
		end
	end
	if k == "SetParent" then
		return function(_, np)
			inst.Parent = np and unwrap(np) or workspace
		end
	end
	if k == "TransformPoint" then
		return function(_, v)
			return getCF(inst) * v
		end
	end
	if k == "TransformDirection" then
		return function(_, v)
			return rotOnly(getCF(inst)) * v
		end
	end
	if k == "InverseTransformPoint" then
		return function(_, v)
			return getCF(inst):PointToObjectSpace(v)
		end
	end
	return nil
end

TR.__newindex = function(p, k, v)
	local inst = rawget(p, "__inst")
	if k == "position" or k == "localPosition" then
		setCF(inst, rotOnly(getCF(inst)) + v)
	elseif k == "rotation" or k == "localRotation" then
		setCF(inst, CFrame.new(getCF(inst).Position) * rotOnly(v))
	elseif k == "eulerAngles" or k == "localEulerAngles" then
		setCF(inst, CFrame.new(getCF(inst).Position) * CFrame.fromEulerAnglesYXZ(math.rad(v.X), math.rad(v.Y), math.rad(v.Z)))
	elseif k == "localScale" then
		if inst:IsA("BasePart") then
			inst.Size = v
		end
	elseif k == "forward" then
		setCF(inst, CFrame.lookAt(getCF(inst).Position, getCF(inst).Position + v))
	elseif k == "parent" then
		inst.Parent = v and unwrap(v) or workspace
	end
end

TR.__eq = GO.__eq

CS.Vector3 = {
	up = Vector3.new(0, 1, 0),
	down = Vector3.new(0, -1, 0),
	forward = Vector3.new(0, 0, -1),
	back = Vector3.new(0, 0, 1),
	left = Vector3.new(-1, 0, 0),
	right = Vector3.new(1, 0, 0),
	zero = Vector3.new(0, 0, 0),
	one = Vector3.new(1, 1, 1),
}

function CS.Vector3.Distance(a, b)
	return (a - b).Magnitude
end

function CS.Vector3.Dot(a, b)
	return a:Dot(b)
end

function CS.Vector3.Cross(a, b)
	return a:Cross(b)
end

function CS.Vector3.Lerp(a, b, t)
	return a:Lerp(b, math.max(0, math.min(1, t)))
end

function CS.Vector3.LerpUnclamped(a, b, t)
	return a:Lerp(b, t)
end

function CS.Vector3.Normalize(v)
	return v.Magnitude > 0 and v.Unit or v
end

function CS.Vector3.Angle(a, b)
	local d = a.Unit:Dot(b.Unit)
	return math.deg(math.acos(math.max(-1, math.min(1, d))))
end

function CS.Vector3.SignedAngle(a, b, axis)
	local ang = CS.Vector3.Angle(a, b)
	return axis:Dot(a:Cross(b)) < 0 and -ang or ang
end

function CS.Vector3.Scale(a, b)
	return a * b
end

function CS.Vector3.Project(v, n)
	return n * (v:Dot(n) / n:Dot(n))
end

function CS.Vector3.Reflect(d, n)
	return d - 2 * d:Dot(n) * n
end

function CS.Vector3.MoveTowards(cur, target, maxDelta)
	local d = target - cur
	if d.Magnitude <= maxDelta then
		return target
	end
	return cur + d.Unit * maxDelta
end

function CS.Vector3.Max(a, b)
	return a:Max(b)
end

function CS.Vector3.Min(a, b)
	return a:Min(b)
end

function CS.Vector3.ClampMagnitude(v, max)
	if v.Magnitude > max then
		return v.Unit * max
	end
	return v
end

CS.Quaternion = { identity = CFrame.new() }

function CS.Quaternion.new(x, y, z, w)
	return CFrame.new(0, 0, 0, x, y, z, w)
end

function CS.Quaternion.Euler(x, y, z)
	if typeof(x) == "Vector3" then
		x, y, z = x.X, x.Y, x.Z
	end
	return CFrame.fromEulerAnglesYXZ(math.rad(x), math.rad(y), math.rad(z))
end

function CS.Quaternion.AngleAxis(angle, axis)
	return CFrame.fromAxisAngle(axis, math.rad(angle))
end

function CS.Quaternion.LookRotation(fwd, up)
	return CFrame.lookAt(Vector3.zero, fwd, up or Vector3.yAxis)
end

function CS.Quaternion.Slerp(a, b, t)
	return a:Lerp(b, math.max(0, math.min(1, t)))
end

CS.Quaternion.Lerp = CS.Quaternion.Slerp

function CS.Quaternion.Inverse(q)
	return q:Inverse()
end

function CS.Quaternion.Angle(a, b)
	local r = a:Inverse() * b
	local _, angle = r:ToAxisAngle()
	return math.deg(math.abs(angle))
end

local COLORS = {
	red = { 1, 0, 0 }, green = { 0, 1, 0 }, blue = { 0, 0, 1 }, white = { 1, 1, 1 }, black = { 0, 0, 0 },
	yellow = { 1, 0.92, 0.016 }, cyan = { 0, 1, 1 }, magenta = { 1, 0, 1 }, gray = { 0.5, 0.5, 0.5 },
	grey = { 0.5, 0.5, 0.5 }, clear = { 0, 0, 0 }, orange = { 1, 0.5, 0 },
}

CS.Color = setmetatable({}, {
	__index = function(_, k)
		local c = COLORS[k]
		if c then
			return Color3.new(c[1], c[2], c[3])
		end
		return nil
	end,
})

function CS.Color.new(r, g, b)
	return Color3.new(r, g, b)
end

function CS.Color.Lerp(a, b, t)
	return a:Lerp(b, math.max(0, math.min(1, t)))
end

function CS.Color.HSVToRGB(h, s, v)
	return Color3.fromHSV(h, s, v)
end

local KEY_ALIASES = {
	Alpha0 = "Zero", Alpha1 = "One", Alpha2 = "Two", Alpha3 = "Three", Alpha4 = "Four", Alpha5 = "Five",
	Alpha6 = "Six", Alpha7 = "Seven", Alpha8 = "Eight", Alpha9 = "Nine", UpArrow = "Up", DownArrow = "Down",
	LeftArrow = "Left", RightArrow = "Right", Return = "Return", Escape = "Escape",
}

CS.KeyCode = setmetatable({}, {
	__index = function(_, k)
		local ok, v = pcall(function()
			return Enum.KeyCode[KEY_ALIASES[k] or k]
		end)
		return ok and v or nil
	end,
})

local downSet = {}
local upSet = {}
local mouseDown = {}
local mouseUp = {}

local function mouseIndex(t)
	if t == Enum.UserInputType.MouseButton1 then
		return 0
	end
	if t == Enum.UserInputType.MouseButton2 then
		return 1
	end
	if t == Enum.UserInputType.MouseButton3 then
		return 2
	end
	return nil
end

UserInputService.InputBegan:Connect(function(input)
	downSet[input.KeyCode] = true
	local mi = mouseIndex(input.UserInputType)
	if mi then
		mouseDown[mi] = true
	end
end)

UserInputService.InputEnded:Connect(function(input)
	upSet[input.KeyCode] = true
	local mi = mouseIndex(input.UserInputType)
	if mi then
		mouseUp[mi] = true
	end
end)

local MOUSE_ENUMS = { [0] = "MouseButton1", [1] = "MouseButton2", [2] = "MouseButton3" }

local function axisKeys(name)
	if name == "Horizontal" then
		return { Enum.KeyCode.D, Enum.KeyCode.Right }, { Enum.KeyCode.A, Enum.KeyCode.Left }
	end
	if name == "Vertical" then
		return { Enum.KeyCode.W, Enum.KeyCode.Up }, { Enum.KeyCode.S, Enum.KeyCode.Down }
	end
	return {}, {}
end

CS.Input = setmetatable({}, {
	__index = function(_, k)
		if k == "mousePosition" then
			local p = UserInputService:GetMouseLocation()
			return Vector3.new(p.X, p.Y, 0)
		end
		if k == "anyKey" then
			return next(downSet) ~= nil
		end
		return nil
	end,
})

function CS.Input.GetKey(key)
	return key ~= nil and UserInputService:IsKeyDown(key)
end

function CS.Input.GetKeyDown(key)
	return downSet[key] == true
end

function CS.Input.GetKeyUp(key)
	return upSet[key] == true
end

function CS.Input.GetMouseButton(i)
	return UserInputService:IsMouseButtonPressed(Enum.UserInputType[MOUSE_ENUMS[i] or "MouseButton1"])
end

function CS.Input.GetMouseButtonDown(i)
	return mouseDown[i] == true
end

function CS.Input.GetMouseButtonUp(i)
	return mouseUp[i] == true
end

function CS.Input.GetAxis(name)
	local pos, neg = axisKeys(name)
	local v = 0
	for _, k in ipairs(pos) do
		if UserInputService:IsKeyDown(k) then
			v = 1
		end
	end
	for _, k in ipairs(neg) do
		if UserInputService:IsKeyDown(k) then
			v = v - 1
		end
	end
	return v
end

CS.Input.GetAxisRaw = CS.Input.GetAxis

function CS.Input.GetButton(name)
	if name == "Jump" then
		return UserInputService:IsKeyDown(Enum.KeyCode.Space)
	end
	if name == "Fire1" then
		return CS.Input.GetMouseButton(0)
	end
	return false
end

function CS.Input.GetButtonDown(name)
	if name == "Jump" then
		return downSet[Enum.KeyCode.Space] == true
	end
	if name == "Fire1" then
		return mouseDown[0] == true
	end
	return false
end

CS.Random = setmetatable({}, {
	__index = function(_, k)
		if k == "value" then
			return math.random()
		end
		if k == "insideUnitSphere" then
			local v
			repeat
				v = Vector3.new(math.random() * 2 - 1, math.random() * 2 - 1, math.random() * 2 - 1)
			until v.Magnitude <= 1
			return v
		end
		if k == "onUnitSphere" then
			return CS.Random.insideUnitSphere.Unit
		end
		if k == "insideUnitCircle" then
			local v
			repeat
				v = Vector2.new(math.random() * 2 - 1, math.random() * 2 - 1)
			until v.Magnitude <= 1
			return v
		end
		if k == "rotation" then
			return CFrame.Angles(math.random() * 6.2832, math.random() * 6.2832, math.random() * 6.2832)
		end
		return nil
	end,
})

function CS.Random.Range(a, b)
	if a == math.floor(a) and b == math.floor(b) then
		return math.random(a, b - 1)
	end
	return a + math.random() * (b - a)
end

local rayParams = RaycastParams.new()

CS.Physics = setmetatable({}, {
	__index = function(_, k)
		if k == "gravity" then
			return Vector3.new(0, -workspace.Gravity, 0)
		end
		return nil
	end,
})

function CS.Physics.RaycastHit(origin, dir, dist)
	local d = dir.Unit * (dist or 1000)
	return workspace:Raycast(origin, d, rayParams)
end

function CS.Physics.Raycast(origin, dir, dist)
	return CS.Physics.RaycastHit(origin, dir, dist) ~= nil
end

function CS.Physics.OverlapSphere(center, radius)
	return workspace:GetPartBoundsInRadius(center, radius)
end

CS.WaitForSeconds = {}

function CS.WaitForSeconds.new(s)
	return { __wait = "seconds", seconds = s }
end

CS.WaitForEndOfFrame = {}

function CS.WaitForEndOfFrame.new()
	return { __wait = "frame" }
end

CS.WaitForFixedUpdate = CS.WaitForEndOfFrame
CS.WaitUntil = {}

function CS.WaitUntil.new(pred)
	return { __wait = "until", pred = pred }
end

CS.WaitWhile = {}

function CS.WaitWhile.new(pred)
	return { __wait = "while", pred = pred }
end

local runtimeWarned = {}

local function guarded(label, owner, fn, ...)
	local ok, err = pcall(fn, ...)
	if not ok then
		local key = label .. tostring(type(err) == "table" and err.Message or err)
		if not runtimeWarned[key] then
			runtimeWarned[key] = true
			if CS.report then
				CS.report(label, err, owner)
			else
				warn(string.format("[CSharp] Runtime error in %s: %s", label, tostring(type(err) == "table" and err.Message or err)))
			end
		end
	end
	return ok
end

local function runEnumerator(e, handle)
	local co = coroutine.create(function()
		e.__enumerator(coroutine.yield)
	end)
	while not handle.cancelled do
		local ok, y = coroutine.resume(co)
		if not ok then
			if CS.report then
				CS.report("coroutine", y, handle.owner)
			else
				warn("[CSharp] Runtime error in coroutine: " .. tostring(type(y) == "table" and y.Message or y))
			end
			break
		end
		if coroutine.status(co) == "dead" then
			break
		end
		if y == nil then
			task.wait()
		elseif type(y) == "number" then
			task.wait(y)
		elseif type(y) == "table" and y.__wait == "seconds" then
			task.wait(y.seconds)
		elseif type(y) == "table" and y.__wait == "until" then
			repeat
				task.wait()
			until handle.cancelled or y.pred()
		elseif type(y) == "table" and y.__wait == "while" then
			while not handle.cancelled and y.pred() do
				task.wait()
			end
		elseif type(y) == "table" and y.__enumerator then
			runEnumerator(y, handle)
		elseif type(y) == "table" and y.__coroutine then
			while not y.done and not handle.cancelled do
				task.wait()
			end
		else
			task.wait()
		end
	end
	handle.done = true
end

function CS.startCoroutine(e, owner)
	if type(e) ~= "table" or not e.__enumerator then
		return nil
	end
	local handle = { __coroutine = true, done = false, cancelled = false, source = e, owner = owner }
	task.spawn(runEnumerator, e, handle)
	return handle
end

CS.MonoBehaviour = CS.class("MonoBehaviour", nil)
CS.MonoBehaviour.__get.name = function(self)
	return self.gameObject.name
end
CS.MonoBehaviour.__get.tag = function(self)
	return self.gameObject.tag
end

function CS.MonoBehaviour.StartCoroutine(self, e)
	local h = CS.startCoroutine(e, self)
	self.__co = self.__co or {}
	table.insert(self.__co, h)
	return h
end

function CS.MonoBehaviour.StopCoroutine(self, h)
	if type(h) == "table" then
		h.cancelled = true
	end
end

function CS.MonoBehaviour.StopAllCoroutines(self)
	for _, h in ipairs(self.__co or {}) do
		h.cancelled = true
	end
end

function CS.MonoBehaviour.Invoke(self, name, delay)
	task.delay(delay, function()
		if self.enabled ~= false and not self.__destroyed then
			guarded(getmetatable(self).__name .. "." .. name, self, self[name], self)
		end
	end)
end

function CS.MonoBehaviour.InvokeRepeating(self, name, delay, rate)
	self.__rep = self.__rep or {}
	local token = {}
	self.__rep[name] = token
	task.delay(delay, function()
		while self.__rep[name] == token and not self.__destroyed do
			if self.enabled ~= false then
				guarded(getmetatable(self).__name .. "." .. name, self, self[name], self)
			end
			task.wait(rate)
		end
	end)
end

function CS.MonoBehaviour.CancelInvoke(self, name)
	if name then
		(self.__rep or {})[name] = nil
	else
		self.__rep = {}
	end
end

function CS.MonoBehaviour.IsInvoking(self, name)
	return (self.__rep or {})[name] ~= nil
end

function CS.MonoBehaviour.SendMessage(self, name, ...)
	if self[name] then
		self[name](self, ...)
	end
end

local function register(inst, b)
	byInstance[inst] = byInstance[inst] or {}
	table.insert(byInstance[inst], b)
	table.insert(behaviours, b)
end

local function callLife(b, name, ...)
	local f = b[name]
	if f then
		local ok = guarded(getmetatable(b).__name .. "." .. name, b, function(...)
			local r = f(b, ...)
			if type(r) == "table" and r.__enumerator then
				b:StartCoroutine(r)
			end
		end, ...)
		return ok
	end
	return true
end

local function collisionArg(hit)
	return { gameObject = CS.GO(hit), collider = hit, transform = TRof(hit), tag = CS.GO(hit).tag, name = hit.Name }
end

local function hook(b, inst)
	if inst:IsA("BasePart") then
		inst.Touched:Connect(function(hit)
			if b.enabled == false then
				return
			end
			if inst.CanCollide then
				callLife(b, "OnCollisionEnter", collisionArg(hit))
			else
				callLife(b, "OnTriggerEnter", CS.GO(hit))
			end
		end)
		inst.TouchEnded:Connect(function(hit)
			if b.enabled == false then
				return
			end
			if inst.CanCollide then
				callLife(b, "OnCollisionExit", collisionArg(hit))
			else
				callLife(b, "OnTriggerExit", CS.GO(hit))
			end
		end)
		if b.OnMouseDown then
			local cd = inst:FindFirstChildOfClass("ClickDetector") or Instance.new("ClickDetector", inst)
			cd.MouseClick:Connect(function()
				callLife(b, "OnMouseDown")
			end)
		end
	end
	inst.Destroying:Connect(function()
		if b.__stopped then
			return
		end
		b.__destroyed = true
		callLife(b, "OnDestroy")
	end)
end

function CS.attach(cls, inst)
	local b = cls.new()
	b.__run = CS.run
	b.gameObject = CS.GO(inst)
	b.transform = TRof(inst)
	if b.enabled == nil then
		b.enabled = true
	end
	register(inst, b)
	hook(b, inst)
	task.spawn(function()
		callLife(b, "Awake")
		callLife(b, "OnEnable")
		callLife(b, "Start")
		b.__started = true
	end)
	return b
end

function CS.start(cls)
	return CS.attach(cls, CS.host or script.Parent)
end

function CS.stop(run)
	for i = #behaviours, 1, -1 do
		local b = behaviours[i]
		if b.__run == run then
			if not b.__destroyed then
				callLife(b, "OnDisable")
				callLife(b, "OnDestroy")
			end
			b.__destroyed = true
			b.__stopped = true
			b.enabled = false
			for _, h in ipairs(b.__co or {}) do
				h.cancelled = true
			end
			b.__rep = {}
			table.remove(behaviours, i)
			for inst, list in pairs(byInstance) do
				for j = #list, 1, -1 do
					if list[j] == b then
						table.remove(list, j)
					end
				end
			end
		end
	end
end

local fixedAcc = 0

RunService.Heartbeat:Connect(function(dt)
	state.dt = dt
	state.time = state.time + dt
	state.frame = state.frame + 1
	fixedAcc = fixedAcc + dt
	local steps = 0
	while fixedAcc >= state.fixedDt and steps < 5 do
		fixedAcc = fixedAcc - state.fixedDt
		steps = steps + 1
		for _, b in ipairs(behaviours) do
			if b.__started and b.enabled ~= false and not b.__destroyed then
				callLife(b, "FixedUpdate")
			end
		end
	end
	for _, b in ipairs(behaviours) do
		if b.__started and b.enabled ~= false and not b.__destroyed then
			callLife(b, "Update")
		end
	end
	for _, b in ipairs(behaviours) do
		if b.__started and b.enabled ~= false and not b.__destroyed then
			callLife(b, "LateUpdate")
		end
	end
	downSet = {}
	upSet = {}
	mouseDown = {}
	mouseUp = {}
end)

local COMPONENT_CLASS = {
	Rigidbody = "BasePart", Collider = "BasePart", BoxCollider = "BasePart", SphereCollider = "BasePart", MeshCollider = "BasePart",
	Renderer = "BasePart", MeshRenderer = "BasePart", AudioSource = "Sound", Light = "Light", Animator = "Humanoid", Camera = "Camera",
}

local function findComponent(inst, t, deep)
	if type(t) == "table" then
		for _, b in ipairs(byInstance[inst] or {}) do
			if CS.is(b, t) then
				return b
			end
		end
		if deep then
			for _, d in ipairs(inst:GetDescendants()) do
				for _, b in ipairs(byInstance[d] or {}) do
					if CS.is(b, t) then
						return b
					end
				end
			end
		end
		return nil
	end
	if t == "Transform" then
		return TRof(inst)
	end
	local class = COMPONENT_CLASS[t] or t
	if inst:IsA(class) then
		return inst
	end
	return inst:FindFirstChildWhichIsA(class, deep)
end

function CS.GetComponent(o, t)
	return findComponent(unwrap(o), t, false)
end

function CS.GetComponentInChildren(o, t)
	return findComponent(unwrap(o), t, true)
end

function CS.GetComponentInParent(o, t)
	local i = unwrap(o)
	while i and i ~= workspace do
		local c = findComponent(i, t, false)
		if c then
			return c
		end
		i = i.Parent
	end
	return nil
end

function CS.GetComponents(o, t)
	local r = {}
	local c = findComponent(unwrap(o), t, false)
	if c then
		table.insert(r, c)
	end
	return r
end

function CS.GetComponentsInChildren(o, t)
	local r = {}
	local inst = unwrap(o)
	local list = { inst }
	for _, d in ipairs(inst:GetDescendants()) do
		table.insert(list, d)
	end
	for _, i in ipairs(list) do
		local c = findComponent(i, t, false)
		if c then
			table.insert(r, c)
		end
	end
	return r
end

function CS.AddComponent(o, t)
	local inst = unwrap(o)
	if type(t) == "table" then
		return CS.attach(t, inst)
	end
	return Instance.new(COMPONENT_CLASS[t] or t, inst)
end

CS.Object = {}

function CS.Object.Instantiate(original, a, b, c)
	local src = unwrap(original)
	local clone = src:Clone()
	local pos = nil
	local rot = nil
	local parent = nil
	if typeof(a) == "Vector3" then
		pos = a
		rot = b
		parent = c
	else
		parent = a
	end
	clone.Parent = parent and unwrap(parent) or src.Parent or workspace
	if pos then
		setCF(clone, CFrame.new(pos) * (rot and rotOnly(rot) or rotOnly(getCF(clone))))
	end
	return CS.GO(clone)
end

function CS.Object.Destroy(o, delay)
	local function kill()
		local u = unwrap(o)
		if typeof(u) == "Instance" then
			u:Destroy()
		elseif type(u) == "table" then
			u.__destroyed = true
			u.enabled = false
		end
	end
	if delay and delay > 0 then
		task.delay(delay, kill)
	else
		kill()
	end
end

CS.Object.DestroyImmediate = CS.Object.Destroy

function CS.Object.DontDestroyOnLoad()
end

function CS.Object.FindObjectOfType(t)
	if type(t) == "table" then
		for _, b in ipairs(behaviours) do
			if CS.is(b, t) and not b.__destroyed then
				return b
			end
		end
		return nil
	end
	return workspace:FindFirstChildWhichIsA(COMPONENT_CLASS[t] or t, true)
end

function CS.Object.FindObjectsOfType(t)
	local r = {}
	if type(t) == "table" then
		for _, b in ipairs(behaviours) do
			if CS.is(b, t) and not b.__destroyed then
				table.insert(r, b)
			end
		end
		return r
	end
	for _, d in ipairs(workspace:GetDescendants()) do
		if d:IsA(COMPONENT_CLASS[t] or t) then
			table.insert(r, d)
		end
	end
	return r
end

CS.GameObject = {}

function CS.GameObject.Find(name)
	local i = workspace:FindFirstChild(name, true)
	return i and CS.GO(i) or nil
end

function CS.GameObject.FindWithTag(tag)
	local t = CollectionService:GetTagged(tag)[1]
	return t and CS.GO(t) or nil
end

function CS.GameObject.FindGameObjectsWithTag(tag)
	local r = {}
	for _, i in ipairs(CollectionService:GetTagged(tag)) do
		table.insert(r, CS.GO(i))
	end
	return r
end

function CS.GameObject.CreatePrimitive(kind)
	local p = Instance.new("Part")
	p.Anchored = true
	if kind == "Sphere" then
		p.Shape = Enum.PartType.Ball
	elseif kind == "Cylinder" then
		p.Shape = Enum.PartType.Cylinder
	end
	p.Parent = workspace
	return CS.GO(p)
end

return CS
