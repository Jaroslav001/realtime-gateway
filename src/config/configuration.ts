export default () => ({
  port: parseInt(process.env.PORT ?? '3002', 10) || 3002,
  nodeEnv: process.env.NODE_ENV || 'development',
  database: {
    url: process.env.DATABASE_URL,
  },
  redis: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT ?? '6379', 10) || 6379,
    db: parseInt(process.env.REDIS_DB ?? '1', 10) || 1,
  },
  jwt: {
    secret: process.env.JWT_SECRET,
  },
  cors: {
    origins: (process.env.CORS_ORIGINS || '').split(','),
  },
});
