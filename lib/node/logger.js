/*!
 * logger.js - basic logger for bcoin
 * Copyright (c) 2014-2017, Christopher Jeffrey (MIT License).
 * https://github.com/bcoin-org/bcoin
 */

'use strict';

var assert = require('assert');
var fs = require('../utils/fs');
var util = require('../utils/util');
var co = require('../utils/co');
var Lock = require('../utils/lock');

/**
 * Basic stdout and file logger.
 * @alias module:node.Logger
 * @constructor
 * @param {(String|Object)?} options/level
 * @param {String?} options.level
 * @param {Boolean} [options.colors=true]
 */

function Logger(options) {
  if (!(this instanceof Logger))
    return new Logger(options);

  this.level = Logger.levels.NONE;
  this.colors = Logger.HAS_TTY;
  this.console = true;
  this.shrink = true;
  this.closed = true;
  this.closing = false;
  this.filename = null;
  this.stream = null;
  this.contexts = {};
  this.locker = new Lock();

  if (options)
    this.set(options);
}

/**
 * Whether stdout is a tty FD.
 * @const {Boolean}
 */

Logger.HAS_TTY = !!(process.stdout && process.stdout.isTTY);

/**
 * Maximum file size.
 * @const {Number}
 * @default
 */

Logger.MAX_FILE_SIZE = 20 << 20;

/**
 * Available log levels.
 * @enum {Number}
 */

Logger.levels = {
  NONE: 0,
  ERROR: 1,
  WARNING: 2,
  INFO: 3,
  DEBUG: 4,
  SPAM: 5
};

/**
 * Available log levels.
 * @const {String[]}
 * @default
 */

Logger.levelsByVal = [
  'none',
  'error',
  'warning',
  'info',
  'debug',
  'spam'
];

/**
 * Available log levels.
 * @const {String[]}
 * @default
 */

Logger.prefixByVal = [
  'N',
  'E',
  'W',
  'I',
  'D',
  'S'
];

/**
 * Default CSI colors.
 * @const {String[]}
 * @default
 */

Logger.styles = [
  '0',
  '1;31',
  '1;33',
  '94',
  '90',
  '90'
];

/**
 * Set logger options.
 * @param {Object} options
 */

Logger.prototype.set = function set(options) {
  assert(options);
  assert(this.closed);

  if (typeof options === 'string') {
    this.setLevel(options);
    return;
  }

  if (options.level != null) {
    assert(typeof options.level === 'string');
    this.setLevel(options.level);
  }

  if (options.colors != null && Logger.HAS_TTY) {
    assert(typeof options.colors === 'boolean');
    this.colors = options.colors;
  }

  if (options.console != null) {
    assert(typeof options.console === 'boolean');
    this.console = options.console;
  }

  if (options.shrink != null) {
    assert(typeof options.shrink === 'boolean');
    this.shrink = options.shrink;
  }

  if (options.filename != null) {
    assert(typeof options.filename === 'string', 'Bad file.');
    this.filename = options.filename;
  }
};

/**
 * Open the logger.
 * @method
 * @returns {Promise}
 */

Logger.prototype.open = co(function* open() {
  var unlock = yield this.locker.lock();
  try {
    return yield this._open();
  } finally {
    unlock();
  }
});

/**
 * Open the logger (no lock).
 * @method
 * @returns {Promise}
 */

Logger.prototype._open = co(function* open() {
  if (!this.filename) {
    this.closed = false;
    return;
  }

  if (this.stream) {
    this.closed = false;
    return;
  }

  if (fs.unsupported) {
    this.closed = false;
    return;
  }

  if (this.shrink)
    yield this.truncate();

  this.stream = yield openStream(this.filename);
  this.stream.once('error', this.handleError.bind(this));
  this.closed = false;
});

/**
 * Destroy the write stream.
 * @method
 * @returns {Promise}
 */

Logger.prototype.close = co(function* close() {
  var unlock = yield this.locker.lock();
  try {
    return yield this._close();
  } finally {
    unlock();
  }
});

/**
 * Destroy the write stream (no lock).
 * @method
 * @returns {Promise}
 */

Logger.prototype._close = co(function* close() {
  if (this.timer != null) {
    co.clearTimeout(this.timer);
    this.timer = null;
  }

  if (fs.unsupported) {
    this.closed = true;
    this.stream = null;
    return;
  }

  if (this.stream) {
    try {
      this.closing = true;
      yield closeStream(this.stream);
    } finally {
      this.closing = false;
    }
    this.stream = null;
  }

  this.closed = true;
});

/**
 * Truncate the log file to the last 20mb.
 * @method
 * @private
 * @returns {Promise}
 */

Logger.prototype.truncate = co(function* truncate() {
  var maxSize = Logger.MAX_FILE_SIZE;
  var stat, data, fd;

  if (!this.filename)
    return;

  if (fs.unsupported)
    return;

  assert(!this.stream);

  try {
    stat = yield fs.stat(this.filename);
  } catch (e) {
    if (e.code === 'ENOENT')
      return;
    throw e;
  }

  if (stat.size <= maxSize + (maxSize / 10))
    return;

  this.debug('Truncating log file to %d bytes.', maxSize);

  fd = yield fs.open(this.filename, 'r+');

  data = new Buffer(maxSize);
  yield fs.read(fd, data, 0, maxSize, stat.size - maxSize);
  yield fs.ftruncate(fd, maxSize);
  yield fs.write(fd, data, 0, maxSize, 0);
  yield fs.close(fd);
});

/**
 * Handle write stream error.
 * @param {Error} err
 */

Logger.prototype.handleError = function handleError(err) {
  try {
    this.stream.close();
  } catch (e) {
    ;
  }

  this.stream = null;
  this.retry();
};

/**
 * Try to reopen the logger.
 * @method
 * @private
 * @returns {Promise}
 */

Logger.prototype.reopen = co(function* reopen() {
  var unlock = yield this.locker.lock();
  try {
    return yield this._reopen();
  } finally {
    unlock();
  }
});

/**
 * Try to reopen the logger (no lock).
 * @method
 * @private
 * @returns {Promise}
 */

Logger.prototype._reopen = co(function* reopen() {
  if (this.stream)
    return;

  if (this.closed)
    return;

  if (fs.unsupported)
    return;

  try {
    this.stream = yield openStream(this.filename);
  } catch (e) {
    this.retry();
    return;
  }

  this.stream.once('error', this.handleError.bind(this));
});

/**
 * Try to reopen the logger after a timeout.
 * @method
 * @private
 * @returns {Promise}
 */

Logger.prototype.retry = function* retry() {
  assert(this.timer == null);
  this.timer = co.setTimeout(function() {
    this.timer = null;
    this.reopen();
  }, 10000, this);
};

/**
 * Set the log file location.
 * @param {String} filename
 */

Logger.prototype.setFile = function setFile(filename) {
  assert(typeof filename === 'string');
  assert(!this.stream, 'Log stream has already been created.');
  this.filename = filename;
};

/**
 * Set or reset the log level.
 * @param {String} level
 */

Logger.prototype.setLevel = function setLevel(name) {
  var level = Logger.levels[name.toUpperCase()];
  assert(level != null, 'Invalid log level.');
  this.level = level;
};

/**
 * Output a log to the `error` log level.
 * @param {String|Object|Error} err
 * @param {...Object} args
 */

Logger.prototype.error = function error(err) {
  var i, args;

  if (this.level < Logger.levels.ERROR)
    return;

  if (err instanceof Error)
    return this.logError(Logger.levels.ERROR, null, err);

  args = new Array(arguments.length);

  for (i = 0; i < args.length; i++)
    args[i] = arguments[i];

  this.log(Logger.levels.ERROR, null, args);
};

/**
 * Output a log to the `warning` log level.
 * @param {String|Object} obj
 * @param {...Object} args
 */

Logger.prototype.warning = function warning(err) {
  var i, args;

  if (this.level < Logger.levels.WARNING)
    return;

  if (err instanceof Error)
    return this.logError(Logger.levels.WARNING, null, err);

  args = new Array(arguments.length);

  for (i = 0; i < args.length; i++)
    args[i] = arguments[i];

  this.log(Logger.levels.WARNING, null, args);
};

/**
 * Output a log to the `info` log level.
 * @param {String|Object} obj
 * @param {...Object} args
 */

Logger.prototype.info = function info(err) {
  var i, args;

  if (this.level < Logger.levels.INFO)
    return;

  if (err instanceof Error)
    return this.logError(Logger.levels.INFO, null, err);

  args = new Array(arguments.length);

  for (i = 0; i < args.length; i++)
    args[i] = arguments[i];

  this.log(Logger.levels.INFO, null, args);
};

/**
 * Output a log to the `debug` log level.
 * @param {String|Object} obj
 * @param {...Object} args
 */

Logger.prototype.debug = function debug(err) {
  var i, args;

  if (this.level < Logger.levels.DEBUG)
    return;

  if (err instanceof Error)
    return this.logError(Logger.levels.DEBUG, null, err);

  args = new Array(arguments.length);

  for (i = 0; i < args.length; i++)
    args[i] = arguments[i];

  this.log(Logger.levels.DEBUG, null, args);
};

/**
 * Output a log to the `spam` log level.
 * @param {String|Object} obj
 * @param {...Object} args
 */

Logger.prototype.spam = function spam(err) {
  var i, args;

  if (this.level < Logger.levels.SPAM)
    return;

  if (err instanceof Error)
    return this.logError(Logger.levels.SPAM, null, err);

  args = new Array(arguments.length);

  for (i = 0; i < args.length; i++)
    args[i] = arguments[i];

  this.log(Logger.levels.SPAM, null, args);
};

/**
 * Output a log to the desired log level.
 * Note that this bypasses the level check.
 * @param {String} level
 * @param {String|null} module
 * @param {Object[]} args
 */

Logger.prototype.log = function log(level, module, args) {
  if (this.closed)
    return;

  if (this.level < level)
    return;

  this.writeConsole(level, module, args);
  this.writeStream(level, module, args);
};

/**
 * Create logger context.
 * @param {String} module
 * @returns {LoggerContext}
 */

Logger.prototype.context = function context(module) {
  var context = this.contexts[module];

  if (!context) {
    context = new LoggerContext(this, module);
    this.contexts[module] = context;
  }

  return context;
};

/**
 * Write log to the console.
 * @param {String} level
 * @param {String|null} module
 * @param {Object[]} args
 */

Logger.prototype.writeConsole = function writeConsole(level, module, args) {
  var name = Logger.levelsByVal[level];
  var msg = '';
  var color;

  assert(name, 'Invalid log level.');

  if (!this.console)
    return;

  if (util.isBrowser) {
    msg += '[' + name + '] ';

    if (module)
      msg += '(' + module + ') ';

    if (typeof args[0] === 'object') {
      return level === Logger.levels.ERROR
        ? console.error(msg, args[0])
        : console.log(msg, args[0]);
    }

    msg += util.format(args, false);

    return level === Logger.levels.ERROR
      ? console.error(msg)
      : console.log(msg);
  }

  if (this.colors) {
    color = Logger.styles[level];
    assert(color);

    msg += '\x1b[' + color + 'm';
    msg += '[' + name + ']';
    msg += '\x1b[m ';
  } else {
    msg += '[' + name + '] ';
  }

  if (module)
    msg += '(' + module + ') ';

  msg += util.format(args, this.colors);
  msg += '\n';

  return level === Logger.levels.ERROR
    ? process.stderr.write(msg)
    : process.stdout.write(msg);
};

/**
 * Write a string to the output stream (usually a file).
 * @param {String} level
 * @param {String|null} module
 * @param {Object[]} args
 */

Logger.prototype.writeStream = function writeStream(level, module, args) {
  var name = Logger.prefixByVal[level];
  var msg = '';

  assert(name, 'Invalid log level.');

  if (!this.stream)
    return;

  if (this.closing)
    return;

  msg += '[';
  msg += name;
  msg += ':' + util.date();
  msg += '] ';

  if (module)
    msg += '(' + module + ') ';

  msg += util.format(args, false);
  msg += '\n';

  this.stream.write(msg);
};

/**
 * Helper to parse an error into a nicer
 * format. Call's `log` internally.
 * @private
 * @param {Number} level
 * @param {String|null} module
 * @param {Error} err
 */

Logger.prototype.logError = function logError(level, module, err) {
  var msg;

  if (this.closed)
    return;

  if (util.isBrowser && this.console) {
    if (level <= Logger.levels.WARNING)
      console.error(err);
  }

  msg = (err.message + '').replace(/^ *Error: */, '');

  if (level !== Logger.levels.ERROR)
    msg = 'Error: ' + msg;

  this.log(level, module, [msg]);

  if (level <= Logger.levels.WARNING) {
    if (this.stream)
      this.stream.write(err.stack + '\n');
  }
};

/**
 * Log the current memory usage.
 * @param {String|null} module
 */

Logger.prototype.memory = function memory(module) {
  var mem = util.memoryUsage();

  this.log(Logger.levels.DEBUG, module, [
    'Memory: rss=%dmb, js-heap=%d/%dmb native-heap=%dmb',
    mem.total,
    mem.jsHeap,
    mem.jsHeapTotal,
    mem.nativeHeap
  ]);
};

/**
 * Basic stdout and file logger.
 * @constructor
 * @ignore
 * @param {Logger} logger
 * @param {String} module
 */

function LoggerContext(logger, module) {
  if (!(this instanceof LoggerContext))
    return new LoggerContext(logger, module);

  assert(typeof module === 'string');

  this.logger = logger;
  this.module = module;
}

/**
 * Open the logger.
 * @returns {Promise}
 */

LoggerContext.prototype.open = function open() {
  return this.logger.open();
};

/**
 * Destroy the write stream.
 * @returns {Promise}
 */

LoggerContext.prototype.close = function close() {
  return this.logger.close();
};

/**
 * Set the log file location.
 * @param {String} filename
 */

LoggerContext.prototype.setFile = function setFile(filename) {
  this.logger.setFile(filename);
};

/**
 * Set or reset the log level.
 * @param {String} level
 */

LoggerContext.prototype.setLevel = function setLevel(name) {
  this.logger.setLevel(name);
};


/**
 * Output a log to the `error` log level.
 * @param {String|Object|Error} err
 * @param {...Object} args
 */

LoggerContext.prototype.error = function error(err) {
  var i, args;

  if (this.logger.level < Logger.levels.ERROR)
    return;

  if (err instanceof Error)
    return this.logError(Logger.levels.ERROR, err);

  args = new Array(arguments.length);

  for (i = 0; i < args.length; i++)
    args[i] = arguments[i];

  this.log(Logger.levels.ERROR, args);
};

/**
 * Helper to parse an error into a nicer
 * format. Call's `log` internally.
 * @private
 * @param {Number} level
 * @param {Error} err
 */

LoggerContext.prototype.logError = function logError(level, err) {
  this.logger.logError(level, this.module, err);
};

/**
 * Output a log to the `warning` log level.
 * @param {String|Object} obj
 * @param {...Object} args
 */

LoggerContext.prototype.warning = function warning(err) {
  var i, args;

  if (this.logger.level < Logger.levels.WARNING)
    return;

  if (err instanceof Error)
    return this.logError(Logger.levels.WARNING, err);

  args = new Array(arguments.length);

  for (i = 0; i < args.length; i++)
    args[i] = arguments[i];

  this.log(Logger.levels.WARNING, args);
};

/**
 * Output a log to the `info` log level.
 * @param {String|Object} obj
 * @param {...Object} args
 */

LoggerContext.prototype.info = function info(err) {
  var i, args;

  if (this.logger.level < Logger.levels.INFO)
    return;

  if (err instanceof Error)
    return this.logError(Logger.levels.INFO, err);

  args = new Array(arguments.length);

  for (i = 0; i < args.length; i++)
    args[i] = arguments[i];

  this.log(Logger.levels.INFO, args);
};

/**
 * Output a log to the `debug` log level.
 * @param {String|Object} obj
 * @param {...Object} args
 */

LoggerContext.prototype.debug = function debug(err) {
  var i, args;

  if (this.logger.level < Logger.levels.DEBUG)
    return;

  if (err instanceof Error)
    return this.logError(Logger.levels.DEBUG, err);

  args = new Array(arguments.length);

  for (i = 0; i < args.length; i++)
    args[i] = arguments[i];

  this.log(Logger.levels.DEBUG, args);
};

/**
 * Output a log to the `spam` log level.
 * @param {String|Object} obj
 * @param {...Object} args
 */

LoggerContext.prototype.spam = function spam(err) {
  var i, args;

  if (this.logger.level < Logger.levels.SPAM)
    return;

  if (err instanceof Error)
    return this.logError(Logger.levels.SPAM, err);

  args = new Array(arguments.length);

  for (i = 0; i < args.length; i++)
    args[i] = arguments[i];

  this.log(Logger.levels.SPAM, args);
};

/**
 * Output a log to the desired log level.
 * Note that this bypasses the level check.
 * @param {String} level
 * @param {Object[]} args
 */

LoggerContext.prototype.log = function log(level, args) {
  this.logger.log(level, this.module, args);
};

/**
 * Create logger context.
 * @param {String} module
 * @returns {LoggerContext}
 */

LoggerContext.prototype.context = function context(module) {
  return new LoggerContext(this.logger, module);
};

/**
 * Log the current memory usage.
 */

LoggerContext.prototype.memory = function memory() {
  this.logger.memory(this.module);
};

/*
 * Default
 */

Logger.global = new Logger();

/*
 * Helpers
 */

function openStream(filename) {
  return new Promise(function(resolve, reject) {
    var stream = fs.createWriteStream(filename, { flags: 'a' });

    function onError(err) {
      try {
        stream.close();
      } catch (e) {
        ;
      }
      cleanup();
      reject(err);
    }

    function onOpen() {
      cleanup();
      resolve(stream);
    }

    function cleanup() {
      stream.removeListener('error', onError);
      stream.removeListener('open', onOpen);
    }

    stream.once('error', onError);
    stream.once('open', onOpen);
  });
}

function closeStream(stream) {
  return new Promise(function(resolve, reject) {
    function onError(err) {
      cleanup();
      reject(err);
    }

    function onClose() {
      cleanup();
      resolve(stream);
    }

    function cleanup() {
      stream.removeListener('error', onError);
      stream.removeListener('close', onClose);
    }

    stream.removeAllListeners('error');
    stream.removeAllListeners('close');
    stream.once('error', onError);
    stream.once('close', onClose);

    stream.close();
  });
}

/*
 * Expose
 */

module.exports = Logger;
