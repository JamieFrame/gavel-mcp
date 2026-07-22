import pino from 'pino';

const level = process.env.LOG_LEVEL || 'info';

// In development we want pretty-printed output; in production, structured JSON.
const isProd = process.env.NODE_ENV === 'production';

export const logger = pino({
  level,
  base: { service: 'aletheia-mcp' },
  ...(isProd
    ? {}
    : {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'HH:MM:ss.l' },
        },
      }),
});
