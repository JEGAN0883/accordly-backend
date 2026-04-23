// These thin wrappers let server.js import routes cleanly
// Each delegates to the implementation in remaining.js

// src/routes/calendar.js
module.exports = require('./remaining').calendar;
