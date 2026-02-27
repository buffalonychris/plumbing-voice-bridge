function formatContext(context = {}) {
  try {
    return JSON.stringify(context);
  } catch {
    return JSON.stringify({ contextError: 'Unable to serialize log context.' });
  }
}

function info(message, context = {}) {
  console.info(message, formatContext(context));
}

function warn(message, context = {}) {
  console.warn(message, formatContext(context));
}

function error(message, context = {}) {
  console.error(message, formatContext(context));
}

module.exports = {
  info,
  warn,
  error
};
