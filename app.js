// Import Express.js
const express = require('express');

// Create an Express app
const app = express();

// Middleware to parse JSON bodies
app.use(express.json());

// Set port and verify_token
const port = process.env.PORT || 3000;
const verifyToken = process.env.VERIFY_TOKEN;

// Route for GET requests
app.get('/', (req, res) => {
  const { 'hub.mode': mode, 'hub.challenge': challenge, 'hub.verify_token': token } = req.query;

  if (mode === 'subscribe' && token === EAAJentl02WEBP5wVFg4zV3MlZCIZBA86rmhWBE1BCRiENod5vT7jzlne5ipjdnodcsdgZAtm57ZApR2leEHnHR8pWVGGVDovvvXHma6HCRoHmqjyocsP1PcxF4S2FO6yLXDbC5tFYrHZCUVvjWcp5Gw1wWBKHRz238jUwAvevaZCFXEKiijkwiJr7kRk3EMsGgLumzjSZCgWtVZBaeiudBwlffevzFW6CmAG4Lmpb4CMqZCDldk1DBgTUrtnePGJkwOfGtPZBeZBZByZB7Pu3irZB8017QIZBVZCLnq4hcUnBl2UPwZDZD) {
    console.log('WEBHOOK VERIFIED');
    res.status(200).send(challenge);
  } else {
    res.status(403).end();
  }
});

// Route for POST requests
app.post('/', (req, res) => {
  const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`\n\nWebhook received ${timestamp}\n`);
  console.log(JSON.stringify(req.body, null, 2));
  res.status(200).end();
});

// Start the server
app.listen(port, () => {
  console.log(`\nListening on port ${port}\n`);
});
