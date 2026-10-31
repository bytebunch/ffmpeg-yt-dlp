import type { FastifyReply } from 'fastify';

/**
 * Aborts when the client goes away before the response is written, so a synchronous yt-dlp
 * run for a request nobody waits for is killed instead of running to its timeout.
 */
export function abortOnDisconnect(reply: Pick<FastifyReply, 'raw'>): AbortSignal {
  const controller = new AbortController();
  reply.raw.once('close', () => {
    if (!reply.raw.writableFinished) controller.abort();
  });
  return controller.signal;
}
