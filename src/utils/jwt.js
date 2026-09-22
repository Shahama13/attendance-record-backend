const jwt = require("jsonwebtoken");

const SECRET = process.env.JWT_SECRET;
const EXPIRES_IN = process.env.JWT_EXPIRES_IN || "12h";

if (!SECRET) {
  throw new Error("JWT_SECRET is not set. Add it to your .env file.");
}

function signToken(user) {
  return jwt.sign(
    { sub: user.id, username: user.username, role: user.role, campusId: user.campus_id },
    SECRET,
    { expiresIn: EXPIRES_IN }
  );
}

function verifyToken(token) {
  return jwt.verify(token, SECRET);
}

module.exports = { signToken, verifyToken };
