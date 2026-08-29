import pino from 'pino';

const level = process.env.LOG_LEVEL || 'info';

// In development we want pretty-printed output; in production, structured JSON.
const isProd = process.env.NODE_ENV === 'production';

// OB1: distinct per profile. Two services logging the same `service` value
// would merge their AF-T `mcp_initialize` client counts into one number that
// belongs to neither.
const service = process.env.MCP_PROFILE === 'observatory'
  ? 'bitcoin-credit-stack-mcp'
  : 'aletheia-mcp';

export const logger = pino({
  level,
  base: { service },
  ...(isProd
    ? {}
    : {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'HH:MM:ss.l' },
        },
      }),
});
