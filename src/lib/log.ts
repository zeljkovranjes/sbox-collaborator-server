type Level = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let threshold: Level = 'info';
export const setLogLevel = (level: Level) => (threshold = level);

function write(level: Level, message: string, fields?: Record<string, unknown>) {
  if (ORDER[level] < ORDER[threshold]) return;
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg: message, ...fields });
  (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(line + '\n');
}

export const log = {
  debug: (m: string, f?: Record<string, unknown>) => write('debug', m, f),
  info: (m: string, f?: Record<string, unknown>) => write('info', m, f),
  warn: (m: string, f?: Record<string, unknown>) => write('warn', m, f),
  error: (m: string, f?: Record<string, unknown>) => write('error', m, f),
};

export const errorFields = (error: unknown) =>
  error instanceof Error ? { error: error.message, stack: error.stack?.split('\n').slice(0, 6).join('\n') } : { error: String(error) };
