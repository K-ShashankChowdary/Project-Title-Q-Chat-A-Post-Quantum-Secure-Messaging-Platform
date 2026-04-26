/**
 * Logger utility — coloured, timestamped, levelled output.
 * Uses no external deps beyond built-ins so it works everywhere.
 */

const RESET  = '\x1b[0m';
const BOLD   = '\x1b[1m';
const DIM    = '\x1b[2m';

const LEVELS = {
  debug: { label: 'DEBUG', color: '\x1b[36m' },   // cyan
  info:  { label: 'INFO ', color: '\x1b[32m' },   // green
  warn:  { label: 'WARN ', color: '\x1b[33m' },   // yellow
  error: { label: 'ERROR', color: '\x1b[31m' },   // red
  event: { label: 'EVENT', color: '\x1b[35m' },   // magenta (socket events)
  db:    { label: 'DB   ', color: '\x1b[34m' },   // blue
};

function stamp() {
  return new Date().toISOString().replace('T', ' ').slice(0, 23);
}

function log(level, prefix, message, meta) {
  const { label, color } = LEVELS[level];
  const ts = `${DIM}${stamp()}${RESET}`;
  const lv = `${BOLD}${color}${label}${RESET}`;
  const pfx = prefix ? ` ${DIM}[${prefix}]${RESET}` : '';
  const msg = `${message}`;
  const extra = meta ? ` ${DIM}${JSON.stringify(meta)}${RESET}` : '';
  console.log(`${ts} ${lv}${pfx} ${msg}${extra}`);
}

export const logger = {
  debug: (msg, meta, ctx) => log('debug', ctx, msg, meta),
  info:  (msg, meta, ctx) => log('info',  ctx, msg, meta),
  warn:  (msg, meta, ctx) => log('warn',  ctx, msg, meta),
  error: (msg, meta, ctx) => log('error', ctx, msg, meta),
  event: (msg, meta, ctx) => log('event', ctx, msg, meta),
  db:    (msg, meta, ctx) => log('db',    ctx, msg, meta),

  // Shorthand: logger.http(req, status, ms)
  http: (req, status, ms) => {
    const color = status >= 500 ? '\x1b[31m' : status >= 400 ? '\x1b[33m' : '\x1b[32m';
    const ts    = `${DIM}${stamp()}${RESET}`;
    const label = `${BOLD}${color}HTTP ${status}${RESET}`;
    console.log(`${ts} ${label} ${DIM}${req.method}${RESET} ${req.originalUrl} ${DIM}${ms}ms${RESET}`);
  },
};
