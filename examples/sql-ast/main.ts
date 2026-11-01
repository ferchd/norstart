import { parameter } from "norstar/sql";
import { column, compare, identifier, selectQuery, compileQuery } from "norstar/query";

const query = selectQuery({
	from: { name: identifier("users") },
	columns: [{ expression: column("id") }, { expression: column("name") }],
	where: compare("eq", column("name"), parameter("text", "Ana' OR 1=1 --")),
	orderBy: [{ expression: column("id"), direction: "asc" }],
	limit: 10,
});

for (const dialect of ["postgresql", "mysql", "mariadb", "sqlite"] as const) {
	const compiled = compileQuery(query, dialect);
	console.log(dialect);
	console.log(compiled.text);
	console.log(compiled.params);
}
