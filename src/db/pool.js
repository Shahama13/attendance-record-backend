const { Pool, types } = require("pg");

// By default, node-postgres parses a SQL DATE column (OID 1082, e.g.
// attendance_sheets.sheet_date) into a JS Date object. A DATE has no time
// or timezone component, but a JS Date always does -- so pg has to invent
// one (midnight UTC), and once that Date is JSON.stringify'd by res.json(),
// it comes back out as a full timestamp like "2026-09-22T00:00:00.000Z"
// instead of the plain "2026-09-22" the column actually holds. The web and
// mobile apps' fmtDate() both do `iso + "T00:00:00"`, which turns that
// timestamp string into "2026-09-22T00:00:00.000ZT00:00:00" -- not a valid
// date -- hence "Invalid Date" in the Logs tab and "recent submissions".
// Returning the raw string instead sidesteps the round-trip entirely: what
// the column stores is exactly what the API returns.
types.setTypeParser(1082, (val) => val);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // e.g. postgres://user:password@localhost:5432/daryas
});

pool.on("error", (err) => {
  console.error("Unexpected error on idle Postgres client", err);
  process.exit(1);
});

module.exports = pool;