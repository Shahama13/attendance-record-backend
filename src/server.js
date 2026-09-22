require("dotenv").config();
const http = require("http");
const app = require("./app");
const { initWebsocket } = require("./websocket");

const PORT = process.env.PORT || 4000;
const server = http.createServer(app);

initWebsocket(server, process.env.CORS_ORIGIN || "*");

server.listen(PORT, () => {
  console.log(`Attendance API listening on port ${PORT}`);
});
