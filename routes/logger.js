function ts() {
  return new Date().toISOString();
}

function log(level, scope, ...args) {
  const prefix = `[${ts()}] [${level}] [${scope}]`;
  if (level === 'ERROR') console.error(prefix, ...args);
  else if (level === 'WARN') console.warn(prefix, ...args);
  else console.log(prefix, ...args);
}

module.exports = {
  info: (scope, ...args) => log('INFO', scope, ...args),
  warn: (scope, ...args) => log('WARN', scope, ...args),
  error: (scope, ...args) => log('ERROR', scope, ...args),
};
