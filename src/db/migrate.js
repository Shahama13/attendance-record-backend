// Applies schema.sql against DATABASE_URL. Idempotent enough for a fresh
// database; for a real production rollout, replace with a proper migration
// tool (node-pg-migrate, Knex migrations, Prisma Migrate, etc.) once the
// schema needs to evolve rather than be created once.
//
// NOTE: this version of schema.sql is a breaking change from the previous
// one (new "sites" parent table, old "sites" renamed to "campuses", every
// FK renamed site_id -> campus_id). Running this against an existing
// database with the old schema will fail — this is meant for a fresh
// database, or as the basis for a hand-written migration if you have
// production data to carry forward.
//
// Run with: npm run migrate

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const pool = require("./pool");

async function migrate() {
  const sql = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
  const client = await pool.connect();
  try {
    console.log("Applying schema.sql ...");
    await client.query(sql);
    console.log("Schema applied successfully.");
  } finally {
    client.release();
    await pool.end();
  }
}

migrate().catch((err) => {
  console.error("Migration failed:", err.message);
  process.exit(1);
});
