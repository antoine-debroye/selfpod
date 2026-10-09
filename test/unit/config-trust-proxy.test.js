import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import Fastify from 'fastify';

import { loadConfig } from '../../src/config.js';

/**
 * TRUST_PROXY decides whose word is taken on where a request came from and whether it
 * arrived over HTTPS. The parsing is proved here, and then the parsed value is handed
 * to a real Fastify instance, because what matters is not the shape of the value but
 * whether Fastify believes a forwarded header from a given address.
 */
const base = { DATA_DIR: '/tmp/selfpod-config-test' };

describe('TRUST_PROXY parsing', () => {
  it('trusts every hop unless told otherwise, which is what SelfPod always did', () => {
    assert.equal(loadConfig(base).trustProxy, true);
    assert.equal(loadConfig({ ...base, TRUST_PROXY: '' }).trustProxy, true);
    assert.equal(loadConfig({ ...base, TRUST_PROXY: ' TRUE ' }).trustProxy, true);
    assert.equal(loadConfig(base).warnings.length, 0, 'the default must not nag');
  });

  it('can be switched off', () => {
    const config = loadConfig({ ...base, TRUST_PROXY: 'false' });
    assert.equal(config.trustProxy, false);
    assert.equal(config.warnings.length, 0);
  });

  it('accepts addresses, CIDR ranges, bracketed IPv6 and the named ranges, as a list', () => {
    const config = loadConfig({
      ...base,
      TRUST_PROXY: '172.18.0.5, 10.0.0.0/8 ,[fd00::1], fe80::/10,Loopback',
    });
    assert.deepEqual([...config.trustProxy], ['172.18.0.5', '10.0.0.0/8', 'fd00::1', 'fe80::/10', 'loopback']);
    assert.equal(config.warnings.length, 0, 'valid entries must not warn');
  });

  it('drops an entry that is not an address and says which one', () => {
    const config = loadConfig({ ...base, TRUST_PROXY: '10.0.0.0/8, cloudflared, 192.168.1.300, 10.0.0.1/33' });
    assert.deepEqual([...config.trustProxy], ['10.0.0.0/8'], 'the good entry survives the bad ones');
    assert.equal(config.warnings.length, 3, 'each ignored entry gets its own sentence');
    assert.match(config.warnings[0], /TRUST_PROXY entry "cloudflared"/);
    assert.match(config.warnings[1], /TRUST_PROXY entry "192\.168\.1\.300"/);
    assert.match(config.warnings[2], /TRUST_PROXY entry "10\.0\.0\.1\/33"/);
  });

  it('trusts nobody, not everybody, when nothing in the list is usable', () => {
    const config = loadConfig({ ...base, TRUST_PROXY: 'yes' });
    assert.equal(
      config.trustProxy,
      false,
      'the operator set out to stop trusting every hop; a typo must not quietly put that back',
    );
    assert.equal(config.warnings.length, 2, 'the bad entry, then what was done about it');
    assert.match(config.warnings[1], /no proxy is trusted/);
    assert.match(config.warnings[1], /TRUST_PROXY=true/);
  });
});

describe('what Fastify does with the parsed value', () => {
  async function seenBy(trustProxy, { remoteAddress, headers }) {
    const app = Fastify({ trustProxy });
    app.get('/', async (request) => ({ ip: request.ip, protocol: request.protocol }));
    const response = await app.inject({ method: 'GET', url: '/', remoteAddress, headers });
    await app.close();
    return response.json();
  }
  const forged = { 'x-forwarded-for': '203.0.113.9', 'x-forwarded-proto': 'https' };

  it('believes a forwarded header only from a listed address', async () => {
    const trustProxy = loadConfig({ ...base, TRUST_PROXY: '172.18.0.0/16' }).trustProxy;

    const fromProxy = await seenBy(trustProxy, { remoteAddress: '172.18.0.5', headers: forged });
    assert.deepEqual(fromProxy, { ip: '203.0.113.9', protocol: 'https' }, 'the proxy is believed');

    const fromLan = await seenBy(trustProxy, { remoteAddress: '192.168.1.20', headers: forged });
    assert.deepEqual(fromLan, { ip: '192.168.1.20', protocol: 'http' }, 'a LAN client setting the same headers is not');
  });

  it('believes everyone by default, and no one when switched off', async () => {
    const everyone = await seenBy(loadConfig(base).trustProxy, { remoteAddress: '192.168.1.20', headers: forged });
    assert.equal(everyone.ip, '203.0.113.9');

    const nobody = await seenBy(loadConfig({ ...base, TRUST_PROXY: 'false' }).trustProxy, {
      remoteAddress: '172.18.0.5',
      headers: forged,
    });
    assert.deepEqual(nobody, { ip: '172.18.0.5', protocol: 'http' });
  });
});
