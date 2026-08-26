import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ITEM_DECISION,
  REMOTE_AUDIO_TYPE_EXTENSIONS,
  SCAN_TRIGGER,
  SCAN_TRIGGER_LABELS,
  SUPPORTED_EXTENSIONS,
  TERMINAL_DECISIONS,
  contentTypeEssence,
  remoteAudioExtension,
} from '../../src/constants.js';
import { loadConfig } from '../../src/config.js';

describe('the activity filter cannot fall behind the triggers', () => {
  it('labels every scan trigger, and invents none', () => {
    assert.deepEqual(
      Object.keys(SCAN_TRIGGER_LABELS).sort(),
      Object.values(SCAN_TRIGGER).sort(),
      'a trigger with no label is recorded and then unfilterable; a label with no trigger is a dead dropdown entry',
    );
    for (const [value, label] of Object.entries(SCAN_TRIGGER_LABELS)) {
      assert.ok(label && label !== value, `"${value}" needs wording a user would recognise`);
    }
  });
});

describe('remote content types never choose a path', () => {
  it('maps the spellings real podcast hosts actually send', () => {
    // Positive control for the refusals below: the table is reached and does work.
    assert.equal(remoteAudioExtension('audio/mpeg'), '.mp3');
    assert.equal(remoteAudioExtension('audio/mp4'), '.m4a');
    assert.equal(remoteAudioExtension('audio/x-m4a'), '.m4a');
    assert.equal(remoteAudioExtension('AUDIO/MPEG; charset=utf-8'), '.mp3');
    assert.equal(remoteAudioExtension('  audio/flac  '), '.flac');
  });

  it('returns nothing for inherited properties', () => {
    // A bare TABLE[contentType] lookup returns a function for 'constructor' and an
    // object for '__proto__', and the result of this call becomes a filename on the
    // user's SMB share.
    for (const hostile of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']) {
      assert.equal(
        remoteAudioExtension(hostile),
        null,
        `"${hostile}" must not resolve to anything`,
      );
    }
  });

  it('refuses types SelfPod cannot serve, and malformed headers', () => {
    assert.equal(remoteAudioExtension('video/mp4'), null);
    assert.equal(remoteAudioExtension('text/html'), null);
    assert.equal(remoteAudioExtension(''), null);
    assert.equal(remoteAudioExtension(undefined), null);
    // Node joins duplicate Content-Type headers with a comma. Guessing which one the
    // server meant would be worse than refusing.
    assert.equal(remoteAudioExtension('audio/mpeg, text/html'), null);
  });

  it('can only ever produce an extension the rest of the app already serves', () => {
    for (const extension of Object.values(REMOTE_AUDIO_TYPE_EXTENSIONS)) {
      assert.ok(
        SUPPORTED_EXTENSIONS.includes(extension),
        `${extension} is not in SUPPORTED_EXTENSIONS, so this table would widen what SelfPod accepts`,
      );
    }
  });

  it('strips parameters without losing the essence', () => {
    assert.equal(contentTypeEssence('application/rss+xml; charset="utf-8"'), 'application/rss+xml');
    assert.equal(contentTypeEssence('TEXT/XML'), 'text/xml');
    assert.equal(contentTypeEssence('audio/mpeg ;x'), 'audio/mpeg');
    assert.equal(contentTypeEssence(';'), null);
  });
});

describe('item decisions', () => {
  it('marks as terminal exactly the decisions a poll must never revisit', () => {
    for (const decision of TERMINAL_DECISIONS) {
      assert.ok(
        Object.values(ITEM_DECISION).includes(decision),
        `${decision} is not a real decision`,
      );
    }
    // A blocked address that stayed retryable would be a probe that re-fires for ever.
    assert.ok(TERMINAL_DECISIONS.includes(ITEM_DECISION.REJECTED_BLOCKED));
    // The user's own deletion must outrank any rule that would download it again.
    assert.ok(TERMINAL_DECISIONS.includes(ITEM_DECISION.DELETED_BY_USER));
    // But a rule-based refusal must stay revisitable, or loosening a keyword does nothing.
    assert.ok(!TERMINAL_DECISIONS.includes(ITEM_DECISION.REJECTED_DECLARED));
    assert.ok(!TERMINAL_DECISIONS.includes(ITEM_DECISION.SKIPPED_BACKFILL));
  });
});

describe('ALLOW_PRIVATE_FEED_HOSTS is a list, not a switch', () => {
  const base = { DATA_DIR: '/tmp/selfpod-config-test' };

  it('is empty unless asked, so the guard is on by default', () => {
    const config = loadConfig(base);
    assert.equal(config.allowedPrivateFeedHosts.size, 0);
    assert.equal(config.subscriptionsEnabled, false, 'the whole feature is opt-in');
  });

  it('accepts literal addresses, including bracketed IPv6', () => {
    const config = loadConfig({ ...base, ALLOW_PRIVATE_FEED_HOSTS: '127.0.0.1, [::1] ,10.0.0.5' });
    assert.deepEqual([...config.allowedPrivateFeedHosts], ['127.0.0.1', '::1', '10.0.0.5']);
    assert.equal(config.warnings.length, 0, 'valid entries must not warn');
  });

  it('refuses hostnames, and says why rather than ignoring them', () => {
    const config = loadConfig({ ...base, ALLOW_PRIVATE_FEED_HOSTS: 'localhost,my-nas.local' });

    assert.equal(
      config.allowedPrivateFeedHosts.size,
      0,
      'a name cannot be exempted: the exemption is checked against the address it resolved to',
    );
    assert.equal(config.warnings.length, 2, 'each ignored entry gets its own sentence');
    for (const warning of config.warnings) {
      assert.match(warning, /ALLOW_PRIVATE_FEED_HOSTS/);
      assert.match(warning, /not an IP address/);
    }
  });

  it('clamps a poll interval that would hammer someone else\'s server', () => {
    const tooFast = loadConfig({ ...base, REMOTE_POLL_INTERVAL_SECONDS: '5' });
    assert.equal(tooFast.remotePollIntervalSeconds, 15 * 60);
    assert.match(tooFast.warnings.join(' '), /REMOTE_POLL_INTERVAL_SECONDS was 5/);

    const tooSlow = loadConfig({ ...base, REMOTE_POLL_INTERVAL_SECONDS: '999999' });
    assert.equal(tooSlow.remotePollIntervalSeconds, 24 * 60 * 60);
  });

  it('defaults the download cap to the upload cap the operator already chose', () => {
    const config = loadConfig({ ...base, MAX_UPLOAD_SIZE_MB: '250' });
    assert.equal(config.maxDownloadSizeMb, 250);
    assert.equal(config.maxDownloadBytes, 250 * 1024 * 1024);

    const split = loadConfig({ ...base, MAX_UPLOAD_SIZE_MB: '250', MAX_DOWNLOAD_SIZE_MB: '80' });
    assert.equal(split.maxDownloadSizeMb, 80, 'but it can be set apart when they differ');
    assert.equal(split.maxUploadSizeMb, 250);
  });
});
