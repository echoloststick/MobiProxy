const LUA_RESERVED = new Set(['and', 'elseif', 'end', 'function', 'local', 'nil', 'not', 'or', 'repeat', 'then', 'until', 'goto', 'self']);

const INT_TYPES = new Set(['int', 'long', 'short', 'byte', 'uint', 'ulong', 'ushort', 'sbyte']);
const FLOAT_TYPES = new Set(['float', 'double', 'decimal']);
const LIST_TYPES = new Set(['List', 'IList', 'IEnumerable', 'ICollection', 'Queue', 'Stack', 'HashSet', 'LinkedList', 'IReadOnlyList', 'ReadOnlyCollection']);
const DICT_TYPES = new Set(['Dictionary', 'IDictionary', 'SortedDictionary', 'IReadOnlyDictionary']);

const STATIC_LIBS = new Set([
	'Mathf', 'Time', 'Debug', 'Input', 'Application', 'Physics', 'GameObject', 'Object', 'Color', 'Quaternion',
	'KeyCode', 'Screen', 'Cursor', 'Math', 'Console', 'Convert', 'Environment', 'Enumerable', 'SceneManager', 'Space',
]);

const VALUE_TYPES = new Set([
	'Vector3', 'Vector2', 'CFrame', 'Color3', 'UDim', 'UDim2', 'Rect', 'Ray', 'Region3', 'TweenInfo', 'NumberRange',
	'NumberSequence', 'ColorSequence', 'BrickColor', 'Random', 'NumberSequenceKeypoint', 'ColorSequenceKeypoint',
	'Vector3int16', 'Vector2int16', 'PhysicalProperties', 'OverlapParams', 'RaycastParams', 'Font',
]);

const LIB_TYPES = new Set([
	'Exception', 'ArgumentException', 'ArgumentNullException', 'InvalidOperationException', 'NullReferenceException',
	'NotImplementedException', 'InvalidCastException', 'StackOverflowException', 'MissingMemberException', 'MissingMethodException', 'UnauthorizedAccessException', 'TimeoutException', 'IndexOutOfRangeException', 'KeyNotFoundException', 'FormatException', 'OverflowException', 'DivideByZeroException', 'OperationCanceledException', 'WaitForSeconds', 'WaitForEndOfFrame', 'WaitForFixedUpdate', 'WaitUntil', 'WaitWhile',
	'Quaternion', 'Color', 'Stopwatch', 'StringBuilder', 'Event', 'Action',
]);

const LIB_BASES = new Set(['MonoBehaviour', 'Object', 'ScriptableObject', 'Attribute', 'Behaviour', 'Component']);
const EXCEPTION_BASES = new Set(['Exception', 'ArgumentException', 'InvalidOperationException', 'ApplicationException']);

const DYNAMIC_METHODS = new Set([
	'Add', 'AddRange', 'Remove', 'RemoveAt', 'RemoveAll', 'Insert', 'Clear', 'Contains', 'ContainsKey', 'ContainsValue', 'IndexOf',
	'LastIndexOf', 'Reverse', 'Sort', 'ToString', 'ToArray', 'ToList', 'Substring', 'ToUpper', 'ToLower', 'Trim', 'TrimStart',
	'TrimEnd', 'Split', 'Replace', 'StartsWith', 'EndsWith', 'PadLeft', 'PadRight', 'Push', 'Pop', 'Peek', 'Enqueue', 'Dequeue',
	'Where', 'Select', 'Any', 'All', 'First', 'FirstOrDefault', 'Last', 'LastOrDefault', 'Sum', 'Count', 'Max', 'Min', 'OrderBy',
	'OrderByDescending', 'Take', 'Skip', 'Distinct', 'Equals', 'ToCharArray', 'GetValueOrDefault', 'Append', 'AppendLine', 'Invoke',
]);

const MEMBER_RENAMES = {
	x: 'X', y: 'Y', z: 'Z', w: 'W', r: 'R', g: 'G', b: 'B',
	magnitude: 'Magnitude', normalized: 'Unit',
};

const IGNORED_USINGS = new Set(['Roblox', 'System', 'System.Collections', 'System.Collections.Generic', 'System.Linq', 'System.Text', 'UnityEngine', 'System.Collections.ObjectModel']);

const LIFECYCLE = ['Awake', 'OnEnable', 'Start', 'Update', 'FixedUpdate', 'LateUpdate', 'OnDisable', 'OnDestroy'];

function luaName(n) {
	return LUA_RESERVED.has(n) && n !== 'self' ? `${n}_` : n;
}

function typeKind(ty) {
	if (!ty) {
		return { k: 'any' };
	}
	if (ty.arr > 0) {
		const elem = { n: ty.n, a: ty.a, arr: ty.arr - 1, nul: false };
		return { k: 'list', elem: typeKind(elem) };
	}
	if (INT_TYPES.has(ty.n)) {
		return { k: 'int' };
	}
	if (FLOAT_TYPES.has(ty.n)) {
		return { k: 'float' };
	}
	if (ty.n === 'string') {
		return { k: 'string' };
	}
	if (ty.n === 'char') {
		return { k: 'char' };
	}
	if (ty.n === 'bool') {
		return { k: 'bool' };
	}
	if (LIST_TYPES.has(ty.n)) {
		return { k: 'list', elem: ty.a[0] ? typeKind(ty.a[0]) : { k: 'any' } };
	}
	if (DICT_TYPES.has(ty.n)) {
		return { k: 'dict', key: ty.a[0] ? typeKind(ty.a[0]) : { k: 'any' }, val: ty.a[1] ? typeKind(ty.a[1]) : { k: 'any' } };
	}
	if (ty.n === 'var' || ty.n === 'object' || ty.n === 'dynamic') {
		return { k: 'any' };
	}
	return { k: 'class', name: ty.n };
}

module.exports = {
	LUA_RESERVED, INT_TYPES, FLOAT_TYPES, LIST_TYPES, DICT_TYPES, STATIC_LIBS, VALUE_TYPES, LIB_TYPES, LIB_BASES,
	EXCEPTION_BASES, DYNAMIC_METHODS, MEMBER_RENAMES, IGNORED_USINGS, LIFECYCLE, luaName, typeKind,
};
