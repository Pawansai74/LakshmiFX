// Import Express.js
const express = require("express");
const mongoose = require("mongoose");
require("dotenv").config();

// Create Express app
const app = express();
app.use(express.json());

// PORT + VERIFY TOKEN
const port = process.env.PORT || 3000;

// Use env var or fallback to vibecode
const verifyToken = process.env.VERIFY_TOKEN || "vibecode";

// ---------------------------------------------
// 🔗 MONGODB CONNECTION
// ---------------------------------------------
const mongoURI =
  process.env.MONGODB_URI ||
  "mongodb+srv://prestart_india:%401208Pavan@cluster0.iormwgk.mongodb.net/whatsappdb?retryWrites=true&w=majority&appName=Cluster0";

// Connect to MongoDB
mongoose
  .connect(mongoURI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => console.log("✅ MongoDB connected"))
  .catch((err) => console.log("❌ MongoDB error: ", err));

// Message Schema
const WhatsAppMessage = mongoose.model("messages", {
  message_id: String,
  from: String,
  to: String,
  timestamp: String,
  type: String,
  text: String,
  raw: Object,
});

// ---------------------------------------------
// 🔥 GET Route → META VERIFICATION
// ---------------------------------------------
app.get("/", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  console.log("Verification request:", { mode, token, challenge });

  if (mode === "subscribe" && token === verifyToken) {
    console.log("✅ WEBHOOK VERIFIED");
    res.status(200).send(challenge);
  } else {
    console.log("❌ Verification failed");
    res.status(403).send("Verification failed");
  }
});

// ---------------------------------------------
// 🔥 POST Route → Webhook Messages
// ---------------------------------------------
app.post("/", async (req, res) => {
  const timestamp = new Date().toISOString().replace("T", " ").slice(0, 19);
  console.log(`\n📩 Webhook received at ${timestamp}\n`);
  console.log(JSON.stringify(req.body, null, 2));

  try {
    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0];
    const message = changes?.value?.messages?.[0];

    if (message) {
      await WhatsAppMessage.create({
        message_id: message.id,
        from: message.from,
        to: changes.value.metadata.display_phone_number,
        timestamp: message.timestamp,
        type: message.type,
        text: message.text?.body || "",
        raw: req.body,
      });

      console.log("💾 Message saved to MongoDB");
    }
  } catch (err) {
    console.log("❌ Error saving message:", err);
  }

  res.sendStatus(200);
});

// ---------------------------------------------
// 🚀 Start Server
// ---------------------------------------------
app.listen(port, () => {
  console.log(`\n🚀 Server running on port ${port}\n`);
});
