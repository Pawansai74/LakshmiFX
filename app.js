// Import Express.js
const express = require("express");

// Create an Express app
const app = express();

// Middleware to parse JSON bodies
app.use(express.json());

// Set port and verify_token
const port = process.env.PORT || 3000;

// Use env var if set, otherwise fall back to hard-coded token
// IMPORTANT: Use this same string in Meta "Verify token" field
const verifyToken = process.env.VERIFY_TOKEN || "MySuperSecretToken123";

// Route for GET requests (Meta verification)
app.get("/", (req, res) => {
  const mode = req.query["hub.mode"];
  const challenge = req.query["hub.challenge"];
  const token = req.query["hub.verify_token"];

  console.log("Verification request:", { mode, token, challenge });

  if (mode === "subscribe" && token === verifyToken) {
    console.log("✅ WEBHOOK VERIFIED");
    res.status(200).send(challenge);
  } else {
    console.log("❌ Verification failed");
    res.status(403).end("Verification failed");
  }
});

// Route for POST requests (actual webhooks)
app.post("/", (req, res) => {
  const timestamp = new Date().toISOString().replace("T", " ").slice(0, 19);
  console.log(`\n\n📩 Webhook received ${timestamp}\n`);
  console.log(JSON.stringify(req.body, null, 2));
  res.status(200).end();
});

// Start the server
app.listen(port, () => {
  console.log(`\n🚀 Listening on port ${port}\n`);
});
