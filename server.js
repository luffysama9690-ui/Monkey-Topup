// server.js
// Entry point for the Monkey Topup backend API.
require("dotenv").config();
const express = require("express");
const cors = require("cors");

const usersRouter = require("./routes/users");
const depositsRouter = require("./routes/deposits");
const ordersRouter = require("./routes/orders");
const messagesRouter = require("./routes/messages");

const app = express();

app.use(cors()); // allow the Mini App's frontend to call this API
app.use(express.json());

// Simple health check — visiting this URL should show "ok"
app.get("/", (req, res) => {
  res.send("Monkey Topup backend is running ✅");
});

app.use("/api/users", usersRouter);
app.use("/api/deposits", depositsRouter);
app.use("/api/orders", ordersRouter);
app.use("/api/messages", messagesRouter);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Monkey Topup backend listening on port ${PORT}`);
});
