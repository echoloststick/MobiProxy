local CS = {}
CS.RET = {}

local QueueMT = { kind = "queue" }
local StackMT = { kind = "stack" }
local SetMT = { kind = "set" }

function CS.class(name, base)
	local cls = {}
	cls.__name = name
	cls.__base = base
	local baseGet = nil
	local baseSet = nil
	if base then
		baseGet = base.__get
		baseSet = base.__set
		setmetatable(cls, { __index = base })
	end
	cls.__get = setmetatable({}, { __index = baseGet })
	cls.__set = setmetatable({}, { __index = baseSet })
	cls.__index = function(o, k)
		local g = cls.__get[k]
		if g then
			return g(o)
		end
		return cls[k]
	end
	cls.__newindex = function(o, k, v)
		local s = cls.__set[k]
		if s then
			s(o, v)
		else
			rawset(o, k, v)
		end
	end
	cls.__tostring = function(o)
		return o:ToString()
	end
	if not base then
		cls.ToString = function()
			return name
		end
		cls.Equals = function(a, b)
			return a == b
		end
	end
	cls.new = function(...)
		local o = setmetatable({}, cls)
		cls.__ctor(o, ...)
		return o
	end
	if not cls.__ctor then
		cls.__ctor = function()
		end
	end
	return cls
end

function CS.is(o, cls)
	if type(o) ~= "table" then
		return false
	end
	local mt = getmetatable(o)
	while mt do
		if mt == cls then
			return true
		end
		mt = mt.__base
	end
	return false
end

CS.Exception = CS.class("Exception", nil)

function CS.Exception.__ctor(self, message, inner)
	self.Message = message or "An error occurred."
	self.InnerException = inner
	self.StackTrace = ""
end

function CS.Exception.ToString(self)
	return self.__name_override or getmetatable(self).__name .. ": " .. tostring(self.Message)
end

for _, n in ipairs({ "ArgumentException", "ArgumentNullException", "InvalidOperationException", "NullReferenceException", "NotImplementedException", "ApplicationException" }) do
	CS[n] = CS.class(n, CS.Exception)
end

function CS.ex(err)
	if type(err) == "table" and getmetatable(err) and CS.is(err, CS.Exception) then
		return err
	end
	return CS.Exception.new(tostring(err))
end

function CS.invoke(f, ...)
	local t = type(f)
	if t == "function" or t == "table" then
		return f(...)
	end
	if t == "userdata" and typeof(f) == "Instance" then
		return f:Invoke(...)
	end
	return nil
end

local EventMT = {}
EventMT.__index = EventMT
EventMT.__call = function(self, ...)
	local list = {}
	for i, f in ipairs(self.handlers) do
		list[i] = f
	end
	for _, f in ipairs(list) do
		f(...)
	end
end

CS.Event = {}

function CS.Event.new()
	return setmetatable({ handlers = {} }, EventMT)
end

function EventMT.Connect(self, f)
	table.insert(self.handlers, f)
	return {
		Disconnect = function()
			EventMT.Disconnect(self, f)
		end,
	}
end

function EventMT.Disconnect(self, f)
	for i, h in ipairs(self.handlers) do
		if h == f then
			table.remove(self.handlers, i)
			return
		end
	end
end

function EventMT.Invoke(self, ...)
	return self(...)
end

CS.Action = {
	new = function(f)
		return f
	end,
}

function CS.idiv(a, b)
	if b == 0 then
		error(CS.Exception.new("Attempted to divide by zero."), 0)
	end
	local q = a / b
	if q >= 0 then
		return math.floor(q)
	end
	return math.ceil(q)
end

function CS.toInt(x)
	if type(x) == "string" then
		x = tonumber(x) or 0
	end
	if x >= 0 then
		return math.floor(x)
	end
	return math.ceil(x)
end

function CS.chr(n)
	if utf8 and utf8.char then
		return utf8.char(n)
	end
	return string.char(n)
end

function CS.sqrMag(v)
	local m = v.Magnitude
	return m * m
end

function CS.newArray(n, def)
	local t = {}
	if def ~= nil then
		for i = 1, n do
			t[i] = def
		end
	end
	return t
end

function CS.newQueue(t)
	return setmetatable(t or {}, QueueMT)
end

function CS.newStack(t)
	return setmetatable(t or {}, StackMT)
end

function CS.newSet(t)
	local s = setmetatable({}, SetMT)
	for _, v in ipairs(t or {}) do
		if not CS.m.Contains(s, v) then
			table.insert(s, v)
		end
	end
	return s
end

function CS.copy(t)
	local c = {}
	for k, v in pairs(t) do
		c[k] = v
	end
	local mt = getmetatable(t)
	if mt == QueueMT or mt == StackMT or mt == SetMT then
		setmetatable(c, mt)
	end
	return c
end

local function isArray(t)
	return #t > 0 or next(t) == nil
end

function CS.idx(t, i)
	if type(t) == "string" then
		return string.sub(t, i + 1, i + 1)
	end
	if #t > 0 then
		return t[i + 1]
	end
	return t[i]
end

function CS.setidx(t, i, v)
	if #t > 0 then
		t[i + 1] = v
	else
		t[i] = v
	end
end

function CS.len(x)
	if type(x) == "string" then
		return #x
	end
	local n = #x
	if n > 0 then
		return n
	end
	local c = 0
	for _ in pairs(x) do
		c = c + 1
	end
	return c
end

function CS.keys(t)
	local r = {}
	for k in pairs(t) do
		table.insert(r, k)
	end
	return r
end

function CS.values(t)
	local r = {}
	for _, v in pairs(t) do
		table.insert(r, v)
	end
	return r
end

function CS.chars(s)
	local t = {}
	for i = 1, #s do
		t[i] = string.sub(s, i, i)
	end
	return ipairs(t)
end

function CS.enumerator(fn)
	return { __enumerator = fn }
end

local function drain(e)
	local list = {}
	local co = coroutine.create(function()
		e.__enumerator(coroutine.yield)
	end)
	while true do
		local ok, v = coroutine.resume(co)
		if not ok then
			error(v, 0)
		end
		if coroutine.status(co) == "dead" then
			break
		end
		table.insert(list, v)
	end
	return list
end

function CS.each(x)
	if type(x) == "table" then
		if x.__enumerator then
			return ipairs(drain(x))
		end
		if isArray(x) then
			return ipairs(x)
		end
		local list = {}
		for k, v in pairs(x) do
			table.insert(list, { Key = k, Value = v })
		end
		return ipairs(list)
	end
	if type(x) == "string" then
		return CS.chars(x)
	end
	return ipairs({})
end

function CS.format(v, fmt)
	local kind = string.sub(fmt, 1, 1)
	local digits = tonumber(string.sub(fmt, 2))
	if type(v) ~= "number" then
		return tostring(v)
	end
	local up = string.upper(kind)
	if up == "F" or up == "N" then
		local s = string.format("%." .. (digits or 2) .. "f", v)
		if up == "N" then
			local int, frac = string.match(s, "^(-?%d+)(.*)$")
			int = string.reverse(string.gsub(string.reverse(int), "(%d%d%d)", "%1,"))
			int = string.gsub(int, "^(-?),", "%1")
			s = int .. frac
		end
		return s
	end
	if up == "D" then
		return string.format("%0" .. (digits or 1) .. "d", math.floor(v))
	end
	if up == "X" then
		return string.format("%0" .. (digits or 1) .. (kind == "x" and "x" or "X"), math.floor(v))
	end
	if up == "P" then
		return string.format("%." .. (digits or 2) .. "f%%", v * 100)
	end
	local int, frac = string.match(fmt, "^([#0,]*)%.?([#0]*)$")
	if int then
		local places = #frac
		local s = string.format("%." .. places .. "f", v)
		local ip, fp = string.match(s, "^(-?%d+)%.?(%d*)$")
		local pad = #string.gsub(int, "[^0]", "")
		if #string.gsub(ip, "-", "") < pad then
			ip = string.rep("0", pad - #string.gsub(ip, "-", "")) .. ip
		end
		while #fp > 0 and string.sub(fp, -1) == "0" and string.sub(frac, #fp, #fp) == "#" do
			fp = string.sub(fp, 1, -2)
		end
		if ip == "0" and pad == 0 and #fp > 0 then
			ip = ""
		end
		return fp ~= "" and (ip .. "." .. fp) or ip
	end
	return tostring(v)
end

local m = {}
CS.m = m

local function find(t, v)
	for i, x in ipairs(t) do
		if x == v then
			return i
		end
	end
	return nil
end

local function plainFind(s, x, init)
	return string.find(s, x, init, true)
end

function m.Add(t, ...)
	if select("#", ...) >= 2 then
		local k, v = ...
		t[k] = v
		return nil
	end
	local v = ...
	if getmetatable(t) == SetMT then
		if find(t, v) then
			return false
		end
		table.insert(t, v)
		return true
	end
	table.insert(t, v)
	return nil
end

function m.AddRange(t, other)
	for _, v in CS.each(other) do
		table.insert(t, v)
	end
end

function m.Remove(t, x)
	if #t > 0 then
		local i = find(t, x)
		if i then
			table.remove(t, i)
			return true
		end
		return false
	end
	local had = t[x] ~= nil
	t[x] = nil
	return had
end

function m.RemoveAt(t, i)
	table.remove(t, i + 1)
end

function m.RemoveAll(t, pred)
	local n = 0
	for i = #t, 1, -1 do
		if pred(t[i]) then
			table.remove(t, i)
			n = n + 1
		end
	end
	return n
end

function m.Insert(t, i, v)
	table.insert(t, i + 1, v)
end

function m.Clear(t)
	for k in pairs(t) do
		t[k] = nil
	end
end

function m.Contains(t, v)
	if type(t) == "string" then
		return plainFind(t, v) ~= nil
	end
	return find(t, v) ~= nil
end

function m.ContainsKey(t, k)
	return t[k] ~= nil
end

function m.ContainsValue(t, v)
	for _, x in pairs(t) do
		if x == v then
			return true
		end
	end
	return false
end

function m.IndexOf(t, v)
	if type(t) == "string" then
		local i = plainFind(t, v)
		return i and (i - 1) or -1
	end
	local i = find(t, v)
	return i and (i - 1) or -1
end

function m.LastIndexOf(t, v)
	if type(t) == "string" then
		local last = -1
		local init = 1
		while true do
			local i = plainFind(t, v, init)
			if not i then
				return last
			end
			last = i - 1
			init = i + 1
		end
	end
	for i = #t, 1, -1 do
		if t[i] == v then
			return i - 1
		end
	end
	return -1
end

function m.Reverse(t)
	local n = #t
	for i = 1, math.floor(n / 2) do
		t[i], t[n - i + 1] = t[n - i + 1], t[i]
	end
end

local function stableSort(t, less)
	local idx = {}
	for i, v in ipairs(t) do
		idx[i] = { v = v, i = i }
	end
	table.sort(idx, function(a, b)
		if less(a.v, b.v) then
			return true
		end
		if less(b.v, a.v) then
			return false
		end
		return a.i < b.i
	end)
	for i, e in ipairs(idx) do
		t[i] = e.v
	end
end

function m.Sort(t, cmp)
	if cmp then
		stableSort(t, function(a, b)
			return cmp(a, b) < 0
		end)
	else
		stableSort(t, function(a, b)
			return a < b
		end)
	end
end

function m.ToString(x, fmt)
	if x == nil then
		return ""
	end
	if type(x) == "boolean" then
		return x and "True" or "False"
	end
	if fmt then
		return CS.format(x, fmt)
	end
	return tostring(x)
end

function m.Equals(a, b)
	return a == b
end

function m.Substring(s, a, len)
	if len then
		return string.sub(s, a + 1, a + len)
	end
	return string.sub(s, a + 1)
end

function m.ToUpper(s)
	return string.upper(s)
end

function m.ToLower(s)
	return string.lower(s)
end

function m.Trim(s)
	return (string.gsub(s, "^%s*(.-)%s*$", "%1"))
end

function m.TrimStart(s)
	return (string.gsub(s, "^%s+", ""))
end

function m.TrimEnd(s)
	return (string.gsub(s, "%s+$", ""))
end

function m.Split(s, sep)
	local out = {}
	if sep == nil then
		for w in string.gmatch(s, "%S+") do
			table.insert(out, w)
		end
		return out
	end
	if type(sep) == "table" then
		sep = sep[1]
	end
	if sep == "" then
		return CS.copy(out)
	end
	local init = 1
	while true do
		local a, b = plainFind(s, sep, init)
		if not a then
			table.insert(out, string.sub(s, init))
			return out
		end
		table.insert(out, string.sub(s, init, a - 1))
		init = b + 1
	end
end

function m.Replace(s, a, b)
	local pattern = string.gsub(a, "%p", "%%%0")
	local repl = string.gsub(b or "", "%%", "%%%%")
	return (string.gsub(s, pattern, repl))
end

function m.StartsWith(s, p)
	return string.sub(s, 1, #p) == p
end

function m.EndsWith(s, p)
	return p == "" or string.sub(s, -#p) == p
end

function m.PadLeft(s, n, ch)
	return string.rep(ch or " ", n - #s) .. s
end

function m.PadRight(s, n, ch)
	return s .. string.rep(ch or " ", n - #s)
end

function m.ToCharArray(s)
	local t = {}
	for i = 1, #s do
		t[i] = string.sub(s, i, i)
	end
	return t
end

function m.Push(t, v)
	table.insert(t, v)
end

function m.Pop(t)
	return table.remove(t)
end

function m.Peek(t)
	if getmetatable(t) == QueueMT then
		return t[1]
	end
	return t[#t]
end

function m.Enqueue(t, v)
	table.insert(t, v)
end

function m.Dequeue(t)
	return table.remove(t, 1)
end

function m.Where(t, f)
	local r = {}
	for _, v in CS.each(t) do
		if f(v) then
			table.insert(r, v)
		end
	end
	return r
end

function m.Select(t, f)
	local r = {}
	for i, v in CS.each(t) do
		r[i] = f(v)
	end
	return r
end

function m.Any(t, f)
	for _, v in CS.each(t) do
		if f == nil or f(v) then
			return true
		end
	end
	return false
end

function m.All(t, f)
	for _, v in CS.each(t) do
		if not f(v) then
			return false
		end
	end
	return true
end

function m.FirstOrDefault(t, f)
	for _, v in CS.each(t) do
		if f == nil or f(v) then
			return v
		end
	end
	return nil
end

function m.First(t, f)
	for _, v in CS.each(t) do
		if f == nil or f(v) then
			return v
		end
	end
	error(CS.InvalidOperationException.new("Sequence contains no matching element."), 0)
end

function m.LastOrDefault(t, f)
	for i = #t, 1, -1 do
		if f == nil or f(t[i]) then
			return t[i]
		end
	end
	return nil
end

function m.Last(t, f)
	local v = m.LastOrDefault(t, f)
	if v == nil then
		error(CS.InvalidOperationException.new("Sequence contains no matching element."), 0)
	end
	return v
end

function m.Sum(t, f)
	local s = 0
	for _, v in CS.each(t) do
		s = s + (f and f(v) or v)
	end
	return s
end

function m.Count(t, f)
	if f == nil then
		return CS.len(t)
	end
	return #m.Where(t, f)
end

function m.Max(t, f)
	local best = nil
	for _, v in CS.each(t) do
		local x = f and f(v) or v
		if best == nil or x > best then
			best = x
		end
	end
	return best
end

function m.Min(t, f)
	local best = nil
	for _, v in CS.each(t) do
		local x = f and f(v) or v
		if best == nil or x < best then
			best = x
		end
	end
	return best
end

function m.OrderBy(t, key)
	local r = CS.copy(t)
	stableSort(r, function(a, b)
		return key(a) < key(b)
	end)
	return r
end

function m.OrderByDescending(t, key)
	local r = CS.copy(t)
	stableSort(r, function(a, b)
		return key(a) > key(b)
	end)
	return r
end

function m.Take(t, n)
	local r = {}
	for i = 1, math.min(n, #t) do
		r[i] = t[i]
	end
	return r
end

function m.Skip(t, n)
	local r = {}
	for i = n + 1, #t do
		table.insert(r, t[i])
	end
	return r
end

function m.Distinct(t)
	local r = {}
	for _, v in CS.each(t) do
		if not find(r, v) then
			table.insert(r, v)
		end
	end
	return r
end

function m.ToArray(t)
	local r = {}
	for _, v in CS.each(t) do
		table.insert(r, v)
	end
	return r
end

m.ToList = m.ToArray

function m.GetValueOrDefault(t, k, d)
	local v = t[k]
	if v == nil then
		return d
	end
	return v
end

function m.Append(sb, x)
	return sb:Append(x)
end

function m.AppendLine(sb, x)
	return sb:AppendLine(x)
end

function m.Invoke(f, ...)
	return CS.invoke(f, ...)
end
