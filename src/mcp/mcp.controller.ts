import { Controller, Delete, Get, Post, Req, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { FastifyReply, FastifyRequest } from 'fastify';

import type { AuthContext } from '../auth/api-keys';
import { Auth } from '../auth/request-auth';
import { McpTools } from './mcp.tools';

/**
 * `/mcp` (SPEC §6): Streamable HTTP in stateless mode. The API key guard and rate limit run as
 * for REST; the request is then handed to the SDK transport, which answers with JSON.
 */
@ApiExcludeController()
@Controller('mcp')
export class McpController {
  constructor(private readonly tools: McpTools) {}

  @Post()
  async handle(
    @Auth() auth: AuthContext,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const server = this.tools.server(auth);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    reply.hijack();
    reply.raw.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(request.raw, reply.raw, request.body);
  }

  /** Stateless: no server-initiated streams and no sessions to end. */
  @Get()
  @Delete()
  notAllowed(@Res() reply: FastifyReply): void {
    void reply
      .status(405)
      .header('allow', 'POST')
      .send({
        jsonrpc: '2.0',
        error: {
          code: -32000,
          message: 'Method not allowed: this MCP server is stateless (POST only)',
        },
        id: null,
      });
  }
}
