import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
	and,
	column,
	compare,
	compileQuery,
	identifier,
	isNotNull,
	isNull,
	or,
	selectQuery,
} from "../../src/query/index.ts";
import { parameter } from "../../src/sql/index.ts";
import type { SqlDialect } from "../../src/sql/index.ts";
import type { SelectQuery } from "../../src/query/index.ts";

const users = identifier("users");
const id = column(identifier("id"));
const name = column(identifier("name"));

test.each(["postgresql", "mysql", "mariadb", "sqlite"] as const)(
	"keeps hostile values separate from generated SQL for %s",
	(dialect) => {
		const hostile = "Robert'); DROP TABLE users; --";
		const query = selectQuery({
			from: { name: users },
			columns: [{ expression: name }],
			where: compare("eq", name, parameter("text", hostile)),
		});
		const compiled = compileQuery(query, dialect);

		expect(compiled.text).not.toContain(hostile);
		expect(compiled.text).not.toContain("DROP TABLE");
		expect(compiled.params).toEqual([parameter("text", hostile)]);
		expect(compiled.text).toContain(dialect === "postgresql" ? "$1" : "?");
	},
);

test.each([
	"users.name",
	"users; DROP TABLE users",
	'x" OR 1=1 --',
	"x` OR 1=1 --",
	"",
	"with space",
	"\u0000",
	"1column",
])("rejects unsafe or ambiguous identifiers: %s", (value) => {
	expect(() => identifier(value)).toThrow();
});

test.each(["postgresql", "mysql", "mariadb", "sqlite"] as const)(
	"quotes table, schema, column, and alias identifiers for %s",
	(dialect) => {
		const alias = identifier("u");
		const compiled = compileQuery(
			selectQuery({
				from: { schema: identifier("app"), name: users, alias },
				columns: [
					{ expression: column(identifier("name"), alias), alias: identifier("label") },
				],
			}),
			dialect,
		);
		const quote = dialect === "mysql" || dialect === "mariadb" ? "`" : '"';

		expect(compiled.text).toContain(`${quote}app${quote}.${quote}users${quote}`);
		expect(compiled.text).toContain(`${quote}u${quote}.${quote}name${quote}`);
		expect(compiled.text).toContain(`AS ${quote}label${quote}`);
		expect(compiled.params).toEqual([]);
	},
);

test("binds parameters in SQL traversal order, including pagination", () => {
	const query = selectQuery({
		from: { name: users },
		columns: [{ expression: parameter("text", "projection") }],
		where: and(
			compare("gte", id, parameter("integer", 18)),
			or(
				compare("eq", name, parameter("text", "Ana")),
				compare("eq", name, parameter("text", "Ben")),
			),
		),
		orderBy: [{ expression: parameter("text", "sort"), direction: "desc" }],
		limit: 10,
		offset: 20,
	});
	const compiled = compileQuery(query, "postgresql");

	expect(compiled.params.map(({ value }) => value)).toEqual([
		"projection",
		18,
		"Ana",
		"Ben",
		"sort",
		10,
		20,
	]);
	expect(compiled.text.match(/\$\d+/g)).toEqual(["$1", "$2", "$3", "$4", "$5", "$6", "$7"]);
	expect(compiled.text).toContain(" DESC");
	expect(compiled.text).toContain("LIMIT $6");
	expect(compiled.text).toContain("OFFSET $7");
	expect(Object.isFrozen(compiled)).toBe(true);
	expect(Object.isFrozen(compiled.params)).toBe(true);
	expect(compileQuery(query, "postgresql")).toEqual(compiled);
	const mysql = compileQuery(query, "mysql");
	expect(mysql.params).toEqual(compiled.params);
	expect(mysql.text.match(/\?/g)).toHaveLength(7);
});

test("normalizes equality with null without emitting SQL '= NULL'", () => {
	const query = selectQuery({
		from: { name: users },
		columns: [{ expression: id }],
		where: and(
			compare("eq", name, parameter("null", null)),
			compare("ne", parameter("null", null), name),
			isNull(name),
			isNotNull(id),
		),
	});
	const compiled = compileQuery(query, "postgresql");

	expect(compiled.text).toContain("IS NULL");
	expect(compiled.text).toContain("IS NOT NULL");
	expect(compiled.text.match(/IS(?: NOT)? NULL/g)).toHaveLength(4);
	expect(compiled.text).not.toContain("= NULL");
	expect(compiled.params).toEqual([]);
	expect(() =>
		compileQuery(
			selectQuery({
				from: { name: users },
				columns: [{ expression: id }],
				where: compare("gt", id, parameter("null", null)),
			}),
			"postgresql",
		),
	).toThrow();
});

test("executes generated SQLite SQL with separately bound values", () => {
	const database = new Database(":memory:");
	try {
		database.exec("CREATE TABLE users (id INTEGER, name TEXT, deleted_at TEXT)");
		const insert = database.query("INSERT INTO users VALUES (?, ?, ?)");
		insert.run(1, "Ana", null);
		insert.run(2, "Robert'); DROP TABLE users; --", null);
		insert.run(3, "Ben", "2026-11-01");
		const compiled = compileQuery(
			selectQuery({
				from: { name: users },
				columns: [{ expression: id }, { expression: name }],
				where: and(
					compare("gte", id, parameter("integer", 1)),
					isNull(column(identifier("deleted_at"))),
				),
				orderBy: [{ expression: id, direction: "asc" }],
				limit: 1,
				offset: 1,
			}),
			"sqlite",
		);
		const bindings = compiled.params.map((value) => {
			if (value.type !== "integer") {
				throw new Error("This integration query expects integer bindings only");
			}

			return value.value;
		});

		expect(database.query(compiled.text).all(...bindings)).toEqual([
			{ id: 2, name: "Robert'); DROP TABLE users; --" },
		]);
		expect(database.query("SELECT count(*) AS total FROM users").get()).toEqual({ total: 3 });
	} finally {
		database.close();
	}
});

test("rejects unsupported dialects and malformed JavaScript AST nodes", () => {
	const valid = selectQuery({ from: { name: users }, columns: [{ expression: id }] });
	expect(() => compileQuery(valid, "oracle" as SqlDialect)).toThrow();
	for (const query of [
		{ ...valid, kind: "raw", text: "DROP TABLE users" },
		{ ...valid, from: { name: { kind: "identifier", name: "users; DROP TABLE users" } } },
		{ ...valid, columns: [] },
		{
			...valid,
			where: {
				kind: "comparison",
				operator: "= 1; --",
				left: id,
				right: parameter("integer", 1),
			},
		},
		{
			...valid,
			columns: [{ expression: { kind: "parameter", type: "integer", value: "1; --" } }],
		},
		{ ...valid, orderBy: [{ expression: id, direction: "ASC; DROP TABLE users" }] },
		{ ...valid, limit: -1 },
		{ ...valid, offset: 1.5 },
	]) {
		expect(() => compileQuery(query as typeof valid, "sqlite")).toThrow();
	}
});

test("snapshots caller-owned AST objects and arrays before compilation", () => {
	const tableName = { kind: "identifier" as const, name: "users" };
	const columnName = { kind: "identifier" as const, name: "id" };
	const projections = [{ expression: { kind: "column" as const, name: columnName } }];
	const options = { from: { name: tableName }, columns: projections };
	const query = selectQuery(options);
	const original = compileQuery(query, "sqlite");
	tableName.name = "replaced";
	columnName.name = "replaced";
	projections.length = 0;

	expect(compileQuery(query, "sqlite")).toEqual(original);
	expect(original.text).toContain('"users"');
	expect(original.text).toContain('"id"');
	expect(Object.isFrozen(query)).toBe(true);
	expect(Object.isFrozen(query.from)).toBe(true);
	expect(Object.isFrozen(query.from.name)).toBe(true);
	expect(Object.isFrozen(query.columns)).toBe(true);
	expect(Object.isFrozen(query.columns[0])).toBe(true);
});

test("supports zero pagination values and rejects offset without a portable limit", () => {
	const compiled = compileQuery(
		selectQuery({
			from: { name: users },
			columns: [{ expression: id }],
			limit: 0,
			offset: 0,
		}),
		"sqlite",
	);

	expect(compiled.params.map(({ value }) => value)).toEqual([0, 0]);
	expect(compiled.text).toContain("LIMIT ?");
	expect(compiled.text).toContain("OFFSET ?");
	expect(() =>
		selectQuery({
			from: { name: users },
			columns: [{ expression: id }],
			offset: 1,
		}),
	).toThrow();
	expect(() => and()).toThrow();
	expect(() => or()).toThrow();
});

test("rejects cyclic and excessively nested predicates without overflowing the stack", () => {
	const valid = selectQuery({ from: { name: users }, columns: [{ expression: id }] });
	const cyclic: { kind: "and"; predicates: unknown[] } = { kind: "and", predicates: [] };
	cyclic.predicates.push(cyclic);
	let deep: unknown = { kind: "is-null", expression: id };
	for (let index = 0; index < 150; index++) {
		deep = { kind: "and", predicates: [deep] };
	}
	for (const predicate of [cyclic, deep]) {
		let failure: unknown;
		try {
			compileQuery({ ...valid, where: predicate } as SelectQuery, "sqlite");
		} catch (error) {
			failure = error;
		}

		expect(failure).toBeInstanceOf(Error);
		expect(failure).not.toBeInstanceOf(RangeError);
	}
});

test("rejects sparse JavaScript arrays instead of emitting incomplete SQL", () => {
	const valid = selectQuery({ from: { name: users }, columns: [{ expression: id }] });
	const malformed = [
		{ ...valid, columns: new Array(1) },
		{ ...valid, where: { kind: "and", predicates: new Array(1) } },
		{ ...valid, orderBy: new Array(1) },
	];
	for (const query of malformed) {
		expect(() => compileQuery(query as SelectQuery, "sqlite")).toThrow();
	}
});

test("rejects identifiers that would be truncated by a target dialect", () => {
	const query = (length: number) =>
		selectQuery({
			from: { name: identifier("t".repeat(length)) },
			columns: [{ expression: id }],
		});

	expect(() => compileQuery(query(63), "postgresql")).not.toThrow();
	expect(() => compileQuery(query(64), "postgresql")).toThrow();
	expect(() => compileQuery(query(64), "mysql")).not.toThrow();
	expect(() => compileQuery(query(65), "mysql")).toThrow();
	expect(() => compileQuery(query(65), "mariadb")).toThrow();
	expect(() => compileQuery(query(65), "sqlite")).not.toThrow();
});

test("snapshots a JavaScript identifier getter once before validating and emitting it", () => {
	let reads = 0;
	const table = {
		kind: "identifier" as const,
		get name(): string {
			reads++;

			return reads === 1 ? "users" : "users; DROP TABLE users; --";
		},
	};
	const query = selectQuery({ from: { name: table }, columns: [{ expression: id }] });
	const compiled = compileQuery(query, "sqlite");

	expect(reads).toBe(1);
	expect(compiled.text).toContain('FROM "users"');
	expect(compiled.text).not.toContain("DROP TABLE");
});

test.each(["columns", "orderBy", "predicates"] as const)(
	"captures the first valid %s array from a stateful JavaScript getter",
	(property) => {
		let reads = 0;
		const projection = { expression: id };
		const ordering = { expression: id, direction: "desc" as const };
		const predicate = compare("eq", id, parameter("integer", 42));
		const entries = {
			columns: [projection],
			orderBy: [ordering],
			predicates: [predicate],
		};
		const raw: Record<string, unknown> = {
			kind: "select",
			from: { name: users },
			columns: [projection],
		};
		const target = property === "predicates" ? { kind: "and" } : raw;
		if (property === "predicates") {
			raw.where = target;
		}
		Object.defineProperty(target, property, {
			enumerable: true,
			get() {
				reads++;

				return reads === 1 ? entries[property] : new Array(1);
			},
		});
		const compiled = compileQuery(raw as unknown as SelectQuery, "sqlite");

		expect(reads).toBe(1);
		expect(compiled.text).toContain('SELECT "id" FROM "users"');
		if (property === "orderBy") {
			expect(compiled.text).toContain('ORDER BY "id" DESC');
		}
		if (property === "predicates") {
			expect(compiled.text).toContain('"id" = ?');
			expect(compiled.params).toEqual([parameter("integer", 42)]);
		}
	},
);

test.each(["columns", "orderBy", "predicates"] as const)(
	"rejects the first invalid %s array even when a later getter read would be valid",
	(property) => {
		let reads = 0;
		const projection = { expression: id };
		const ordering = { expression: id, direction: "asc" as const };
		const predicate = isNull(name);
		const validEntries = {
			columns: [projection],
			orderBy: [ordering],
			predicates: [predicate],
		};
		const invalidEntries = property === "orderBy" ? Array(10001).fill(ordering) : [];
		const raw: Record<string, unknown> = {
			kind: "select",
			from: { name: users },
			columns: [projection],
		};
		const target = property === "predicates" ? { kind: "and" } : raw;
		if (property === "predicates") {
			raw.where = target;
		}
		Object.defineProperty(target, property, {
			enumerable: true,
			get() {
				reads++;

				return reads === 1 ? invalidEntries : validEntries[property];
			},
		});

		expect(() => compileQuery(raw as unknown as SelectQuery, "sqlite")).toThrow();
		expect(reads).toBe(1);
	},
);

test.each(["columns", "orderBy", "predicates"] as const)(
	"snapshots indexed %s entries without consuming a custom array iterator",
	(property) => {
		let iteratorReads = 0;
		const entry = {
			columns: { expression: id },
			orderBy: { expression: id, direction: "desc" },
			predicates: isNull(name),
		}[property];
		const entries = [entry];
		Object.defineProperty(entries, Symbol.iterator, {
			get() {
				iteratorReads++;

				throw new Error("Caller-owned array iterators must not execute");
			},
		});
		const raw: Record<string, unknown> = {
			kind: "select",
			from: { name: users },
			columns: [{ expression: id }],
		};
		const target = property === "predicates" ? { kind: "and" } : raw;
		if (property === "predicates") {
			raw.where = target;
		}
		Object.defineProperty(target, property, { value: entries, configurable: true });
		const compiled = compileQuery(raw as unknown as SelectQuery, "sqlite");

		expect(iteratorReads).toBe(0);
		expect(compiled.text).toContain('SELECT "id" FROM "users"');
		const sparse = new Array(1);
		Object.defineProperty(sparse, Symbol.iterator, {
			get() {
				iteratorReads++;

				return function* () {
					yield entry;
				};
			},
		});
		Object.defineProperty(target, property, { value: sparse });

		expect(() => compileQuery(raw as unknown as SelectQuery, "sqlite")).toThrow();
		expect(iteratorReads).toBe(0);
	},
);

test.each(["columns", "orderBy", "predicates"] as const)(
	"bounds %s traversal to the length captured before index getters run",
	(property) => {
		let indexReads = 0;
		const entry = {
			columns: { expression: id },
			orderBy: { expression: id, direction: "asc" },
			predicates: isNull(name),
		}[property];
		const entries: unknown[] = [];
		Object.defineProperty(entries, 0, {
			get() {
				indexReads++;
				entries.length = 10001;
				Object.defineProperty(entries, 1, {
					get() {
						throw new Error("Traversal must not reach newly added entries");
					},
				});

				return entry;
			},
		});
		const raw: Record<string, unknown> = {
			kind: "select",
			from: { name: users },
			columns: [{ expression: id }],
		};
		if (property === "predicates") {
			raw.where = { kind: "and", predicates: entries };
		} else {
			raw[property] = entries;
		}
		const compiled = compileQuery(raw as unknown as SelectQuery, "sqlite");

		expect(indexReads).toBe(1);
		expect(entries.length).toBe(10001);
		expect(compiled.text).toContain('SELECT "id" FROM "users"');
		if (property === "orderBy") {
			expect(compiled.text).toContain('ORDER BY "id" ASC');
		}
		if (property === "predicates") {
			expect(compiled.text).toContain('"name" IS NULL');
		}
	},
);

test("captures an ordering direction getter once before validation and emission", () => {
	let reads = 0;
	const ordering = {
		expression: id,
		get direction() {
			reads++;

			return reads === 1 ? "asc" : "DESC; DROP TABLE users";
		},
	};
	const raw = {
		kind: "select",
		from: { name: users },
		columns: [{ expression: id }],
		orderBy: [ordering],
	};
	const compiled = compileQuery(raw as unknown as SelectQuery, "sqlite");

	expect(reads).toBe(1);
	expect(compiled.text).toContain('ORDER BY "id" ASC');
	expect(compiled.text).not.toContain("DROP TABLE");
});
