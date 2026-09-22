// reset-password.js — break-glass password reset, run directly against
// the database from the server. Bypasses the web app and its auth
// entirely, so it works even when no admin account can log in.
//
// This is the LAST resort. If any admin account can still log in, use
// that instead — the in-app "Reset password" button (Administration ->
// Users) works on any user including another admin, and it's audited
// (this script isn't). Only reach for this when NO admin can get in at
// all — e.g. the sole admin account forgot its password.
//
// This file lives next to seed.js and shares its conventions (same
// pool import, same dotenv setup) — run it the same way you already
// run `npm run seed`, e.g. from the api container:
//
//   docker compose exec api node db/reset-password.js <username> <newPassword>
//
// (adjust the path if seed.js lives somewhere other than db/ in your
// checkout — this script must sit in that same folder so `require("./pool")`
// resolves.)

require("dotenv").config();
const bcrypt = require("bcrypt");
const pool = require("./pool");

async function main() {
  const [username, newPassword] = process.argv.slice(2);
  if (!username || !newPassword) {
    console.error("Usage: node reset-password.js <username> <newPassword>");
    process.exitCode = 1;
    return;
  }
  if (newPassword.length < 6) {
    console.error("Password must be at least 6 characters.");
    process.exitCode = 1;
    return;
  }

  const { rows } = await pool.query(`SELECT id, username, role, active FROM users WHERE username = $1`, [username]);
  const user = rows[0];
  if (!user) {
    console.error(`No user found with username "${username}".`);
    process.exitCode = 1;
    return;
  }

  const hash = await bcrypt.hash(newPassword, 10);
  await pool.query(`UPDATE users SET password_hash = $1, updated_at = now() WHERE id = $2`, [hash, user.id]);

  console.log(
    `Password reset for "${user.username}" (role: ${user.role}, id: ${user.id}${user.active ? "" : ", currently inactive"}).`
  );
  console.log("No audit log entry is created for this — it runs outside the app. Log in with the new password now.");
}

main()
  .catch((err) => {
    console.error("Failed:", err.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());

// docker compose exec api node <same-folder>/reset-password.js <username> <newPassword>