CS.String = {}
CS.String.Empty = ""

function CS.String.IsNullOrEmpty(s)
	return s == nil or s == ""
end

function CS.String.IsNullOrWhiteSpace(s)
	return s == nil or string.match(s, "^%s*$") ~= nil
end

function CS.String.Join(sep, ...)
	local first = ...
	local list = first
	if type(first) ~= "table" or select("#", ...) > 1 then
		list = { ... }
	end
	local parts = {}
	for i, v in CS.each(list) do
		parts[i] = tostring(v)
	end
	return table.concat(parts, sep)
end

function CS.String.Concat(...)
	local parts = {}
	for i = 1, select("#", ...) do
		parts[i] = tostring((select(i, ...)))
	end
	return table.concat(parts)
end

function CS.String.Format(fmt, ...)
	local args = { ... }
	return (string.gsub(fmt, "{(%d+):?([^}]*)}", function(i, f)
		local v = args[tonumber(i) + 1]
		if f ~= "" then
			return CS.format(v, f)
		end
		return CS.m.ToString(v)
	end))
end

CS.Int = { MaxValue = 2147483647, MinValue = -2147483648 }

function CS.Int.Parse(s)
	local n = tonumber(s)
	if n == nil or n ~= math.floor(n) then
		error(CS.Exception.new("Input string was not in a correct format."), 0)
	end
	return n
end

CS.Float = { MaxValue = 3.4028235e38, MinValue = -3.4028235e38, Epsilon = 1.4e-45, PositiveInfinity = math.huge, NegativeInfinity = -math.huge, NaN = 0 / 0 }

function CS.Float.Parse(s)
	local n = tonumber(s)
	if n == nil then
		error(CS.Exception.new("Input string was not in a correct format."), 0)
	end
	return n
end

CS.Bool = {}

function CS.Bool.Parse(s)
	return string.lower(tostring(s)) == "true"
end

CS.Char = {}

function CS.Char.IsDigit(c)
	return string.match(c, "^%d$") ~= nil
end

function CS.Char.IsLetter(c)
	return string.match(c, "^%a$") ~= nil
end

function CS.Char.IsLetterOrDigit(c)
	return string.match(c, "^%w$") ~= nil
end

function CS.Char.IsWhiteSpace(c)
	return string.match(c, "^%s$") ~= nil
end

function CS.Char.IsUpper(c)
	return string.match(c, "^%u$") ~= nil
end

function CS.Char.IsLower(c)
	return string.match(c, "^%l$") ~= nil
end

function CS.Char.ToUpper(c)
	return string.upper(c)
end

function CS.Char.ToLower(c)
	return string.lower(c)
end

function CS.Char.GetNumericValue(c)
	return tonumber(c) or -1
end

CS.Math = { PI = math.pi, E = math.exp(1) }

function CS.Math.Abs(x)
	return math.abs(x)
end

function CS.Math.Max(a, b)
	return math.max(a, b)
end

function CS.Math.Min(a, b)
	return math.min(a, b)
end

function CS.Math.Floor(x)
	return math.floor(x)
end

function CS.Math.Ceiling(x)
	return math.ceil(x)
end

function CS.Math.Truncate(x)
	return CS.toInt(x)
end

function CS.Math.Round(x, digits)
	local p = 10 ^ (digits or 0)
	local v = x * p
	local f = math.floor(v)
	local diff = v - f
	local r
	if diff > 0.5 or (diff == 0.5 and f % 2 == 1) then
		r = f + 1
	else
		r = f
	end
	return r / p
end

function CS.Math.Sqrt(x)
	return math.sqrt(x)
end

function CS.Math.Pow(a, b)
	return a ^ b
end

function CS.Math.Sin(x)
	return math.sin(x)
end

function CS.Math.Cos(x)
	return math.cos(x)
end

function CS.Math.Tan(x)
	return math.tan(x)
end

function CS.Math.Atan2(y, x)
	return math.atan2 and math.atan2(y, x) or math.atan(y, x)
end

function CS.Math.Log(x, base)
	if base then
		return math.log(x) / math.log(base)
	end
	return math.log(x)
end

function CS.Math.Exp(x)
	return math.exp(x)
end

function CS.Math.Sign(x)
	if x > 0 then
		return 1
	end
	if x < 0 then
		return -1
	end
	return 0
end

function CS.Math.Clamp(x, a, b)
	return math.max(a, math.min(b, x))
end

CS.Convert = {}

function CS.Convert.ToInt32(x)
	if type(x) == "string" then
		return CS.Int.Parse(x)
	end
	return CS.Math.Round(x)
end

CS.Convert.ToInt64 = CS.Convert.ToInt32

function CS.Convert.ToDouble(x)
	return tonumber(x) or 0
end

CS.Convert.ToSingle = CS.Convert.ToDouble

function CS.Convert.ToString(x)
	return CS.m.ToString(x)
end

function CS.Convert.ToBoolean(x)
	if type(x) == "string" then
		return string.lower(x) == "true"
	end
	return x ~= nil and x ~= 0 and x ~= false
end

CS.Console = {}

function CS.Console.WriteLine(x)
	CS.out("log", CS.m.ToString(x))
end

CS.Console.Write = CS.Console.WriteLine

function CS.Console.ReadLine()
	return nil
end

CS.Environment = { NewLine = "\n" }

CS.Enumerable = {}

function CS.Enumerable.Range(start, count)
	local t = {}
	for i = 1, count do
		t[i] = start + i - 1
	end
	return t
end

function CS.Enumerable.Repeat(v, count)
	return CS.newArray(count, v)
end

CS.StringBuilder = {}
CS.StringBuilder.__index = CS.StringBuilder

function CS.StringBuilder.new(initial)
	return setmetatable({ parts = { initial or "" } }, CS.StringBuilder)
end

function CS.StringBuilder.Append(self, x)
	table.insert(self.parts, CS.m.ToString(x))
	return self
end

function CS.StringBuilder.AppendLine(self, x)
	table.insert(self.parts, CS.m.ToString(x) .. "\n")
	return self
end

function CS.StringBuilder.Clear(self)
	self.parts = {}
	return self
end

function CS.StringBuilder.ToString(self)
	local s = table.concat(self.parts)
	self.parts = { s }
	return s
end

CS.StringBuilder.__tostring = CS.StringBuilder.ToString
CS.StringBuilder.__index = function(t, k)
	if k == "Length" then
		return #CS.StringBuilder.ToString(t)
	end
	return CS.StringBuilder[k]
end

CS.Stopwatch = {}
CS.Stopwatch.__index = CS.Stopwatch

function CS.Stopwatch.new()
	return setmetatable({ t0 = nil, acc = 0 }, CS.Stopwatch)
end

function CS.Stopwatch.StartNew()
	local s = CS.Stopwatch.new()
	s:Start()
	return s
end

function CS.Stopwatch.Start(self)
	self.t0 = os.clock()
end

function CS.Stopwatch.Stop(self)
	if self.t0 then
		self.acc = self.acc + os.clock() - self.t0
		self.t0 = nil
	end
end

function CS.Stopwatch.Reset(self)
	self.acc = 0
	self.t0 = nil
end

function CS.Stopwatch.ElapsedSeconds(self)
	return self.acc + (self.t0 and os.clock() - self.t0 or 0)
end

CS.Debug = {}

function CS.Debug.Log(x)
	CS.out("log", CS.m.ToString(x))
end

function CS.Debug.LogWarning(x)
	CS.out("warn", CS.m.ToString(x))
end

function CS.Debug.LogError(x)
	CS.out("error", CS.m.ToString(x))
end

function CS.Debug.Assert(cond, msg)
	if not cond then
		CS.out("warn", "Assertion failed: " .. CS.m.ToString(msg))
	end
end

function CS.Debug.DrawLine()
end

CS.Mathf = { PI = math.pi, Infinity = math.huge, NegativeInfinity = -math.huge, Epsilon = 1.4e-45, Deg2Rad = math.pi / 180, Rad2Deg = 180 / math.pi }

function CS.Mathf.Abs(x)
	return math.abs(x)
end

function CS.Mathf.Sqrt(x)
	return math.sqrt(x)
end

function CS.Mathf.Pow(a, b)
	return a ^ b
end

function CS.Mathf.Min(...)
	return math.min(...)
end

function CS.Mathf.Max(...)
	return math.max(...)
end

function CS.Mathf.Clamp(x, a, b)
	return math.max(a, math.min(b, x))
end

function CS.Mathf.Clamp01(x)
	return math.max(0, math.min(1, x))
end

function CS.Mathf.Lerp(a, b, t)
	return a + (b - a) * CS.Mathf.Clamp01(t)
end

function CS.Mathf.LerpUnclamped(a, b, t)
	return a + (b - a) * t
end

function CS.Mathf.InverseLerp(a, b, v)
	if a == b then
		return 0
	end
	return CS.Mathf.Clamp01((v - a) / (b - a))
end

function CS.Mathf.Floor(x)
	return math.floor(x)
end

function CS.Mathf.Ceil(x)
	return math.ceil(x)
end

function CS.Mathf.Round(x)
	return CS.Math.Round(x)
end

function CS.Mathf.FloorToInt(x)
	return math.floor(x)
end

function CS.Mathf.CeilToInt(x)
	return math.ceil(x)
end

function CS.Mathf.RoundToInt(x)
	return CS.Math.Round(x)
end

function CS.Mathf.Sin(x)
	return math.sin(x)
end

function CS.Mathf.Cos(x)
	return math.cos(x)
end

function CS.Mathf.Tan(x)
	return math.tan(x)
end

function CS.Mathf.Asin(x)
	return math.asin(x)
end

function CS.Mathf.Acos(x)
	return math.acos(x)
end

function CS.Mathf.Atan(x)
	return math.atan(x)
end

function CS.Mathf.Atan2(y, x)
	return CS.Math.Atan2(y, x)
end

function CS.Mathf.Exp(x)
	return math.exp(x)
end

function CS.Mathf.Log(x, base)
	return CS.Math.Log(x, base)
end

function CS.Mathf.Log10(x)
	return math.log(x) / math.log(10)
end

function CS.Mathf.Sign(x)
	return x >= 0 and 1 or -1
end

function CS.Mathf.MoveTowards(cur, target, maxDelta)
	if math.abs(target - cur) <= maxDelta then
		return target
	end
	return cur + CS.Mathf.Sign(target - cur) * maxDelta
end

function CS.Mathf.Repeat(t, length)
	return t - math.floor(t / length) * length
end

function CS.Mathf.PingPong(t, length)
	t = CS.Mathf.Repeat(t, length * 2)
	return length - math.abs(t - length)
end

function CS.Mathf.SmoothStep(a, b, t)
	t = CS.Mathf.Clamp01(t)
	return a + (b - a) * (t * t * (3 - 2 * t))
end

function CS.Mathf.DeltaAngle(a, b)
	local d = CS.Mathf.Repeat(b - a, 360)
	if d > 180 then
		d = d - 360
	end
	return d
end

function CS.Mathf.LerpAngle(a, b, t)
	return a + CS.Mathf.DeltaAngle(a, b) * CS.Mathf.Clamp01(t)
end

function CS.Mathf.Approximately(a, b)
	return math.abs(a - b) < 1e-6
end
