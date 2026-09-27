import { createServer } from 'node:http';
import { loadConfig } from './config.js';
import { openDatabase } from './db/index.js';
import { createApp } from './http/app.js';
import { Sweeper } from './jobs/sweeper.js';
import { errorFields, log, setLogLevel } from './lib/log.js';
import { McpGateway } from './mcp/server.js';
import { createServices } from './services/index.js';
import { VERSION } from './version.js';

async function main() {
  const config = loadConfig();
  setLogLevel(config.logLevel);
  if (!config.publicUrl.startsWith('https://') && !/\/\/(localhost|127\.0\.0\.1)/.test(config.publicUrl)) {
    log.warn('PUBLIC_URL is not https – access keys would travel in clear text. Put the server behind HTTPS (see docs/deployment.md).');
  }

  const database = await openDatabase(config.database);
  const services = createServices({ config, database });
  const mcp = new McpGateway(services, VERSION);
  const app = createApp({ services, mcp, version: VERSION, startedAt: Date.now() });
  const sweeper = new Sweeper(services, mcp);
  services.discord.start();

  const server = createServer(app);
  server.keepAliveTimeout = 65_000; // longer than typical proxy idle timeouts
  server.headersTimeout = 70_000;
  server.requestTimeout = 0; // SSE and MCP streams stay open
  server.listen(config.port, config.host, () => {
    log.info('collaborator server listening', {
      url: config.publicUrl,
      port: config.port,
      database: config.database.kind,
      githubToken: !!config.github.token,
      githubOAuth: !!config.github.oauthClientId,
      webhooks: !!config.github.webhookSecret,
      version: VERSION,
    });
  });
  sweeper.start();
  void sweeper.runOnce();

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info('shutting down', { signal });
    sweeper.stop();
    server.close();
    server.closeAllConnections();
    await mcp.closeAll();
    await database.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((error) => {
  log.error('failed to start', errorFields(error));
  process.exit(1);
});
