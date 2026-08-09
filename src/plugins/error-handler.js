import fp from 'fastify-plugin';

import { AppError } from '../lib/errors.js';

/**
 * One error shape for the whole API (spec §14):
 * `{"error": {"message": "...", "code": "..."}}`, where `message` is always
 * something the UI can show a user verbatim. Raw exception text never reaches it.
 */
async function errorHandlerPlugin(fastify) {
  fastify.setErrorHandler((error, request, reply) => {
    const status = resolveStatus(error);
    const expose = error instanceof AppError || (status >= 400 && status < 500 && error.expose !== false);

    if (status >= 500) {
      request.log.error({ err: error }, 'request failed');
    } else {
      request.log.debug({ err: error, status }, 'request rejected');
    }

    const payload = {
      error: {
        message: expose ? error.message : 'Something went wrong on the server. The container logs have the details.',
        code: error.code ?? (status >= 500 ? 'internal_error' : 'request_failed'),
      },
    };
    if (error.fields) payload.error.fields = error.fields;

    // Browser navigations get an HTML page rather than JSON, so a mistyped URL
    // doesn't dump an API payload into the viewport.
    if (wantsHtml(request) && !request.url.startsWith('/api/')) {
      reply.status(status);
      return reply.view(
        'pages/error.eta',
        {
          title: status === 404 ? 'Not found' : 'Something went wrong',
          status,
          message: payload.error.message,
          // The bare layout is used because the app shell needs context this
          // handler cannot safely gather — the request may have failed while
          // gathering exactly that. The permission banner still renders.
          issues: request.server.services?.health?.list?.() ?? [],
        },
        { layout: 'layouts/bare.eta' },
      );
    }

    return reply.status(status).send(payload);
  });

  fastify.setNotFoundHandler((request, reply) => {
    if (wantsHtml(request) && !request.url.startsWith('/api/')) {
      reply.status(404);
      return reply.view('pages/error.eta', {
        title: 'Not found',
        status: 404,
        message: "That page doesn't exist.",
      });
    }
    return reply.status(404).send({
      error: { message: 'That endpoint does not exist.', code: 'not_found' },
    });
  });
}

function resolveStatus(error) {
  if (error.status && Number.isInteger(error.status)) return error.status;
  if (error.statusCode && Number.isInteger(error.statusCode)) return error.statusCode;
  return 500;
}

function wantsHtml(request) {
  const accept = request.headers.accept ?? '';
  if (request.headers['hx-request']) return true;
  return accept.includes('text/html');
}

export default fp(errorHandlerPlugin, { name: 'selfpod-error-handler' });
