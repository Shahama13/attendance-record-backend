// Seeds one parent site, its two campuses, the real employee rosters
// from the two campus sheets, and one user per role so the API is
// usable immediately after setup.
//
// Run with: npm run seed

require("dotenv").config();
const bcrypt = require("bcrypt");
const pool = require("./pool");

const SITE_NAME = "UTAS Nizwa";

const CAMPUSES = [
  { code: "north", name: "North Campus" },
  { code: "south", name: "South Campus" },
];

const EMPLOYEES = {
  north: [
    ["N01", "Husam Bin Hilal Bin Mohammed Al-Abri", "حسام بن هلال بن محمد العبري"],
    ["N02", "Juma Bin Sayeed Bin Nasser Al-Hinai", "جمعة بن سعيد بن ناصر الهنائي"],
    ["N03", "Khalil Bin Sayeed Bin Saud Al-Sulaimani", "خليل بن سعيد بن سعود السليماني"],
    ["N04", "Mohammed Bin Salim Bin Juma Al-Kendi", "محمد بن سالم بن جمعة الكندي"],
    ["N05", "Ahmed Bin Salim Bin Saif Al-Abri", "أحمد بن سالم بن سيف العبري"],
    ["N06", "Mouyad Bin Ibrahim Bin Saleh Al-Hattali", "مؤيد بن إبراهيم بن صالح الحطالي"],
    ["N07", "Al-Jalanda Bin Salim Bin Haris Al-Fahdi", "الجلندى بن سالم بن حارث الفهدي"],
    ["N08", "Abdul Rahman Bin Hamad Al-Shamakhi", "عبدالرحمن بن حمد الشماخي"],
    ["N09", "Mahmod Bin Abdullah Bin Mohammed Al-Mahrouqi", "محمود بن عبدالله بن محمد المحروقي"],
    ["N10", "Mohammed Bin Khamis Bin Misbah Al-Jamoodi", "محمد بن خميس بن مصباح الجمودي"],
    ["N11", "Hamza Hamdan Bin Matar Salim Al-Sabari", "حمزة حمدان بن مطر سالم الصباري"],
    ["N12", "Hani Bin Khalaf Bin Mohammed Al-Mofaddali", "هاني بن خلف بن محمد المفضلي"],
  ],
  south: [
    ["S01", "Ahmed Bin Khalaf Said Al-Abri", "أحمد بن خلف سعيد العبري"],
    ["S02", "Nasser Bin Sulaiman Al-Afifi", "ناصر بن سليمان العفيفي"],
    ["S03", "Muhanad Bin Mohammed Harith Al-Fahdi", "مهند بن محمد حارث الفهدي"],
    ["S04", "Hatem Bin Salem Bin Saeed Al-Shukaily", "حاتم بن سالم بن سعيد الشكيلي"],
    ["S05", "Zeyad Bin Thabith Bin Abdullah Al-Abri", "زياد بن ثابت بن عبدالله العبري"],
    ["S06", "Mohammed Khalfan Salim Al-Hashami", "محمد خلفان سالم الهاشمي"],
    ["S07", "Al-Qaqa Said Al-Hattali", "القعقاع سعيد الحطالي"],
    ["S08", "Hamza Bin Khalaf Bin Said Al-Abri", "حمزة بن خلف بن سعيد العبري"],
    ["S09", "Azan Mohammed Hamid Al-Subhi", "عزان محمد حامد الصبحي"],
    ["S10", "Salim Issa Salim Al-Abri", "سالم عيسى سالم العبري"],
    ["S11", "Mohammed Mahmood Mohammed Al-Azri", "محمد محمود محمد العزري"],
    ["S12", "Shihab Bin Mahmood Bin Abdullah Al-Rahsdi", "شهاب بن محمود بن عبدالله الراشدي"],
    ["S13", "Zakariya Ahmed Zayid Khalifa Al-Aamri", "زكريا أحمد زايد خليفة العامري"],
  ],
};

// Default seed users — CHANGE THESE PASSWORDS before any real deployment.
// Two supervisors per campus now, matching the "min 2 supervisors" rule.
const USERS = [
  { username: "admin", password: "123456", full_name: "Muscat Admin", role: "admin", campus: null },
  { username: "hr", password: "123456", full_name: "HR Officer", role: "hr", campus: null },
  { username: "sup.north", password: "123456", full_name: "North Campus Supervisor", role: "supervisor", campus: "north" },
  { username: "sup.north2", password: "123456", full_name: "North Campus Supervisor 2", role: "supervisor", campus: "north" },
  { username: "sup.south", password: "123456", full_name: "South Campus Supervisor", role: "supervisor", campus: "south" },
  { username: "sup.south2", password: "123456", full_name: "South Campus Supervisor 2", role: "supervisor", campus: "south" },
];

async function seed() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows: siteRows } = await client.query(
      `INSERT INTO sites (name) VALUES ($1) RETURNING id`,
      [SITE_NAME]
    );
    const siteId = siteRows[0].id;

    const campusIds = {};
    for (const c of CAMPUSES) {
      const res = await client.query(
        `INSERT INTO campuses (site_id, code, name) VALUES ($1, $2, $3)
         ON CONFLICT (site_id, code) DO UPDATE SET name = EXCLUDED.name
         RETURNING id, code`,
        [siteId, c.code, c.name]
      );
      campusIds[res.rows[0].code] = res.rows[0].id;
    }

    for (const [campusCode, employees] of Object.entries(EMPLOYEES)) {
      for (const [code, en, ar] of employees) {
        await client.query(
          `INSERT INTO employees (employee_code, name_en, name_ar, campus_id)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (employee_code) DO UPDATE
             SET name_en = EXCLUDED.name_en, name_ar = EXCLUDED.name_ar`,
          [code, en, ar, campusIds[campusCode]]
        );
      }
    }

    for (const u of USERS) {
      const hash = await bcrypt.hash(u.password, 10);
      await client.query(
        `INSERT INTO users (username, password_hash, full_name, role, campus_id)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (username) DO UPDATE
           SET password_hash = EXCLUDED.password_hash, full_name = EXCLUDED.full_name`,
        [u.username, hash, u.full_name, u.role, u.campus ? campusIds[u.campus] : null]
      );
    }

    await client.query("COMMIT");
    console.log("Seed complete:");
    console.log(`  1 site, ${CAMPUSES.length} campuses, ${EMPLOYEES.north.length + EMPLOYEES.south.length} employees, ${USERS.length} users`);
    console.log("  Login with any of:", USERS.map((u) => u.username).join(", "), "(password: 123456)");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

seed().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});