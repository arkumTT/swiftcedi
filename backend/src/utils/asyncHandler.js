'use strict';

/** Wraps an async Express handler so a rejected promise reaches next(err) instead of crashing the process. */
function asyncHandler(fn) {
  return function wrapped(req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

module.exports = { asyncHandler };
