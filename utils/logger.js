/**
 * Logger Utility
 * Structured logging for production
 */

const fs = require('fs');
const path = require('path');

// Ensure logs directory exists
const logsDir = path.join(__dirname, '../logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir);
}

const LOG_LEVELS = {
  ERROR: 0,
  WARN: 1,
  INFO: 2,
  DEBUG: 3
};

const currentLogLevel = LOG_LEVELS[process.env.LOG_LEVEL || 'INFO'];

class Logger {
  constructor(namespace = 'App') {
    this.namespace = namespace;
  }

  _formatMessage(level, message, meta = {}) {
    return {
      timestamp: new Date().toISOString(),
      level,
      namespace: this.namespace,
      message,
      ...meta,
      pid: process.pid,
      env: process.env.NODE_ENV || 'development'
    };
  }

  _writeLog(logData) {
    const timestamp = new Date();
    const date = timestamp.toISOString().split('T')[0];
    const logFile = path.join(logsDir, `${date}.log`);

    const logLine = JSON.stringify(logData) + '\n';
    fs.appendFileSync(logFile, logLine);
  }

  _consoleLog(logData) {
    const level = logData.level;
    const prefix = `[${logData.timestamp}] [${level}] [${logData.namespace}]`;
    
    const colors = {
      ERROR: '\x1b[31m', // Red
      WARN: '\x1b[33m',  // Yellow
      INFO: '\x1b[36m',  // Cyan
      DEBUG: '\x1b[35m'  // Magenta
    };

    const reset = '\x1b[0m';
    const color = colors[level] || '';

    console.log(`${color}${prefix}${reset}`, logData.message, 
      Object.keys(logData).length > 5 ? JSON.stringify(logData, null, 2) : '');
  }

  error(message, meta = {}) {
    if (currentLogLevel >= LOG_LEVELS.ERROR) {
      const logData = this._formatMessage('ERROR', message, meta);
      this._consoleLog(logData);
      this._writeLog(logData);
    }
  }

  warn(message, meta = {}) {
    if (currentLogLevel >= LOG_LEVELS.WARN) {
      const logData = this._formatMessage('WARN', message, meta);
      this._consoleLog(logData);
      this._writeLog(logData);
    }
  }

  info(message, meta = {}) {
    if (currentLogLevel >= LOG_LEVELS.INFO) {
      const logData = this._formatMessage('INFO', message, meta);
      this._consoleLog(logData);
      this._writeLog(logData);
    }
  }

  debug(message, meta = {}) {
    if (currentLogLevel >= LOG_LEVELS.DEBUG) {
      const logData = this._formatMessage('DEBUG', message, meta);
      this._consoleLog(logData);
      this._writeLog(logData);
    }
  }

  http(method, path, status, duration, meta = {}) {
    const logData = this._formatMessage('HTTP', `${method} ${path}`, {
      status,
      duration: `${duration}ms`,
      ...meta
    });
    this._writeLog(logData);
  }
}

module.exports = Logger;
