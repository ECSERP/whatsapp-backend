const express = require("express");
const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode");
const http = require("http");
const socketIo = require("socket.io");
const cors = require("cors");
const { VALID_NUMBERS } = require("./valid");

const app = express();
const server = http.createServer(app);

// Enable CORS
app.use(cors({ origin: "*", methods: ["GET", "POST"], credentials: true }));
app.use(express.json());
app.use(express.static("public"));

// Configure Socket.IO
const io = socketIo(server, {
  cors: { origin: "*", methods: ["GET", "POST"], credentials: true },
});

const clients = {};
const qrCodes = {};
const authStatus = {};

const initializeClient = (userId) => {
  if (clients[userId]) return clients[userId];

  clients[userId] = new Client({
    authStrategy: new LocalAuth({ clientId: userId }),
    puppeteer: { headless: true },
  });

  const client = clients[userId];

  client.on("qr", (qr) => {
    qrcode.toDataURL(qr, (err, url) => {
      if (!err) {
        qrCodes[userId] = url;
        io.to(userId).emit("qrCode", url);
      }
    });
  });

  client.on("authenticated", () => {
    authStatus[userId] = true;
    io.to(userId).emit("authenticated", true);
  });

  client.on("ready", () => {
    console.log(`Client ready for user: ${userId}`);
  });

  client.on("disconnected", () => {
    authStatus[userId] = false;
    delete clients[userId];
    delete qrCodes[userId];
    io.to(userId).emit("authenticated", false);
    setTimeout(() => initializeClient(userId), 2000);
  });

  client.initialize();
  return client;
};

// API to check authentication status
app.get("/check-auth/:userId", (req, res) => {
  res.json({ authenticated: authStatus[req.params.userId] || false });
});

// Logout API for a specific user
app.post("/logout", async (req, res) => {
  const { userId } = req.body;

  if (!clients[userId]) {
    return res.status(400).json({ success: false, message: "User not found" });
  }

  try {
    await clients[userId].logout();
    await clients[userId].destroy();
    delete clients[userId];
    delete qrCodes[userId];
    delete authStatus[userId];
    io.to(userId).emit("authenticated", false);

    setTimeout(() => initializeClient(userId), 2000);
    res.json({ success: true, message: "Logged out successfully" });
  } catch (error) {
    res
      .status(500)
      .json({ success: false, message: "Logout failed", error: error.message });
  }
});

// API to send bulk messages
app.post("/send-bulk-messages", async (req, res) => {
  const { userId, message } = req.body;
  const client = clients[userId];

  if (!client || !authStatus[userId]) {
    return res
      .status(400)
      .json({ success: false, message: "User not authenticated" });
  }

  const numbersList = VALID_NUMBERS.map((num) => num.replace(/\D/g, "")); // Remove non-numeric characters
  const batchSize = 100;
  const delay = 5 * 60 * 1000;

  const sendBatch = async (batch) => {
    for (const number of batch) {
      try {
        // Validate if the number exists on WhatsApp
        const numberId = await client.getNumberId(number);
        if (!numberId) {
          io.to(userId).emit("log", `Invalid WhatsApp number: ${number}`);
          continue;
        }

        await client.sendMessage(numberId._serialized, message);
        io.to(userId).emit("log", `✅ Message sent to ${number}`);
      } catch (error) {
        io.to(userId).emit(
          "log",
          `❌ Failed to send to ${number}: ${error.message}`
        );
      }
    }
  };

  const processQueue = async () => {
    let messageQueue = [...numbersList];

    while (messageQueue.length > 0) {
      await sendBatch(messageQueue.splice(0, batchSize));

      if (messageQueue.length > 0) {
        io.to(userId).emit("log", "⏳ Waiting before next batch...");
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
    io.to(userId).emit("log", "🎉 All messages sent!");
  };

  processQueue();
  res.json({ success: true, message: "Bulk messaging started" });
});

// WebSocket connection handling
io.on("connection", (socket) => {
  let userId = socket.id;
  console.log(`New client connected: ${userId}`);
  socket.emit("userId", userId);
  initializeClient(userId);

  socket.on("registerUser", (userId) => {
    socket.join(userId);
    if (qrCodes[userId]) socket.emit("qrCode", qrCodes[userId]);
    socket.emit("authenticated", authStatus[userId] || false);
  });
});

const PORT = 8001;
server.listen(PORT, () =>
  console.log(`Server running on http://localhost:${PORT}`)
);
