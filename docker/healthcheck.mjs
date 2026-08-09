/**
 * Docker HEALTHCHECK probe. Written in Node so the image needs no curl or wget.
 *
 * Any HTTP 200 counts as healthy, including `{"status":"degraded"}`: a degraded
 * SelfPod is still serving the page that explains what is wrong, and marking the
 * container unhealthy would get it restarted or hidden by the host's UI — taking
 * away the only diagnosis the user has without SSH.
 */
import { get } from 'node:http';

const port = Number.parseInt(process.env.PORT ?? '8080', 10);

const request = get(
  { host: '127.0.0.1', port, path: '/health', timeout: 4000 },
  (response) => {
    response.resume();
    process.exit(response.statusCode === 200 ? 0 : 1);
  },
);

request.on('timeout', () => {
  request.destroy();
  process.exit(1);
});

request.on('error', () => process.exit(1));
