const express = require("express");
const cors = require("cors");
const morgan = require("morgan");

const authRoutes = require("./routes/auth.routes");
const sitesRoutes = require("./routes/sites.routes");
const campusesRoutes = require("./routes/campuses.routes");
const usersRoutes = require("./routes/users.routes");
const employeesRoutes = require("./routes/employees.routes");
const attendanceRoutes = require("./routes/attendance.routes");
const reportsRoutes = require("./routes/reports.routes");
const ocrRoutes = require("./routes/ocr.routes");

const app = express();

app.use(cors({ origin: process.env.CORS_ORIGIN || "*", credentials: true }));
app.use(express.json({ limit: "5mb" })); // generous limit: attendance sheet images may be base64-uploaded via this API in a simple deployment
app.use(morgan(process.env.NODE_ENV === "production" ? "combined" : "dev"));

app.get("/health", (req, res) => res.json({ status: "ok", time: new Date().toISOString() }));

app.use("/api/auth", authRoutes);
app.use("/api/sites", sitesRoutes);
app.use("/api/campuses", campusesRoutes);
app.use("/api/users", usersRoutes);
app.use("/api/employees", employeesRoutes);
app.use("/api/attendance", attendanceRoutes);
app.use("/api/reports", reportsRoutes);
app.use("/api/ocr", ocrRoutes);

app.use((req, res) => res.status(404).json({ error: "Not found." }));

// Centralized error handler — every asyncHandler-wrapped route lands here on failure.
app.use((err, req, res, next) => {
  console.error(err);
  if (err.code === "23505") { // Postgres unique_violation
    return res.status(409).json({ error: "A record with these unique values already exists." });
  }
  res.status(err.status || 500).json({ error: err.message || "Internal server error." });
});

module.exports = app;
