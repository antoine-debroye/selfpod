/**
 * SelfPod — client-side behaviour.
 *
 * Everything here is an enhancement over markup that already works: forms post,
 * links navigate, and uploads submit without any of this running. What JavaScript
 * adds is what HTML cannot do on its own — per-file upload progress, drag-and-drop,
 * clipboard access, and dialog plumbing.
 */
(function () {
  'use strict';

  /* ------------------------------------------------------------------ htmx */

  document.addEventListener('htmx:configRequest', function (event) {
    // A 422 carries a re-rendered form with field errors, which must be swapped
    // in rather than treated as a failure.
    event.detail.headers['X-Requested-With'] = 'htmx';
  });

  document.addEventListener('htmx:beforeSwap', function (event) {
    if (event.detail.xhr && event.detail.xhr.status === 422) {
      event.detail.shouldSwap = true;
      event.detail.isError = false;
    }
  });

  document.addEventListener('htmx:responseError', function (event) {
    var xhr = event.detail.xhr;
    var message = 'Something went wrong.';
    try {
      var parsed = JSON.parse(xhr.responseText);
      if (parsed && parsed.error && parsed.error.message) message = parsed.error.message;
    } catch (err) {
      if (xhr.status === 413) {
        message = 'That request was rejected as too large — most likely by a proxy in front of SelfPod.';
      } else if (xhr.status === 0) {
        message = 'SelfPod could not be reached. Check that the container is still running.';
      }
    }
    toast(message, 'err');
  });

  /* ---------------------------------------------------------------- toasts */

  function toast(message, level) {
    var root = document.getElementById('toast-root');
    if (!root) return;
    var el = document.createElement('div');
    el.className = 'toast toast--' + (level || 'ok');
    el.setAttribute('role', 'status');
    var body = document.createElement('div');
    body.className = 'toast__body';
    body.textContent = message;
    var close = document.createElement('button');
    close.type = 'button';
    close.className = 'toast__close';
    close.setAttribute('aria-label', 'Dismiss');
    close.textContent = '×';
    el.appendChild(body);
    el.appendChild(close);
    root.appendChild(el);
    scheduleToastDismissal(el);
  }

  function scheduleToastDismissal(el) {
    var timer = setTimeout(function () {
      el.classList.add('toast--leaving');
      setTimeout(function () {
        el.remove();
      }, 240);
    }, 6000);
    el.addEventListener('mouseenter', function () {
      clearTimeout(timer);
    });
  }

  document.addEventListener('click', function (event) {
    var close = event.target.closest('[data-toast-close]');
    if (close) close.closest('.toast').remove();
  });

  // Toasts raised out-of-band by an htmx response need the same auto-dismiss.
  document.addEventListener('htmx:oobAfterSwap', function (event) {
    var toasts = event.detail.target.querySelectorAll('.toast:not([data-scheduled])');
    Array.prototype.forEach.call(toasts, function (el) {
      el.setAttribute('data-scheduled', '1');
      scheduleToastDismissal(el);
    });
  });

  /* ---------------------------------------------------------------- modals */

  function openModalIn(container) {
    var dialog = container.querySelector('dialog.modal');
    if (!dialog) return;
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
    var focusable = dialog.querySelector('[autofocus], input, select, textarea, button');
    if (focusable) focusable.focus();
  }

  document.addEventListener('htmx:afterSwap', function (event) {
    if (event.detail.target && event.detail.target.id === 'modal-root') {
      openModalIn(event.detail.target);
    }
  });

  document.addEventListener('click', function (event) {
    if (event.target.closest('[data-modal-close]')) {
      closeModal();
      return;
    }
    // Clicking the backdrop of a native dialog targets the dialog element itself.
    var dialog = event.target.closest('dialog.modal');
    if (dialog && event.target === dialog) closeModal();
  });

  document.body.addEventListener('selfpod:modal-close', closeModal);

  function closeModal() {
    var root = document.getElementById('modal-root');
    if (!root) return;
    var dialog = root.querySelector('dialog.modal');
    if (dialog && typeof dialog.close === 'function') dialog.close();
    root.innerHTML = '';
  }

  /* --------------------------------------------------- confirm gate helpers */

  /**
   * Confirmation gates: "type the show name", "tick to acknowledge" (spec §11.6).
   *
   * Every control pointing at the same button must be satisfied before it unlocks.
   * Evaluating them together is the whole point — when each control set `disabled`
   * from its own state alone, a modal asking for two confirmations was unlocked by
   * whichever one the user happened to touch last, which is not a double
   * confirmation at all.
   */
  function gateControlSatisfied(control) {
    if (control.hasAttribute('data-confirm-match')) {
      return control.value === control.getAttribute('data-confirm-match');
    }
    if (control.hasAttribute('data-confirm-check')) return control.checked;
    // Not a gate control; nothing to satisfy.
    return true;
  }

  function refreshConfirmGate(selector) {
    if (!selector) return;
    var target = document.querySelector(selector);
    if (!target) return;
    var controls = document.querySelectorAll('[data-confirm-target="' + selector + '"]');
    var unlocked = controls.length > 0;
    Array.prototype.forEach.call(controls, function (control) {
      if (!gateControlSatisfied(control)) unlocked = false;
    });
    target.disabled = !unlocked;
  }

  function onGateInteraction(event) {
    var control = event.target.closest('[data-confirm-target]');
    if (!control) return;
    refreshConfirmGate(control.getAttribute('data-confirm-target'));
  }

  document.addEventListener('input', onGateInteraction);
  document.addEventListener('change', onGateInteraction);

  /* ------------------------------------------------- ledger row selection */

  /**
   * Tick-and-queue on the subscription ledger.
   *
   * Everything here is an enhancement over checkboxes that already post: the boxes are
   * ordinary fields inside the form that queues a selection, and the button submits
   * them with or without this running. What script adds is the header box that ticks
   * the whole page at once, and a count so nobody has to work out how many they hit.
   *
   * Delegated from the document, because the table is swapped by htmx every time a
   * filter changes and listeners bound to the old rows would go with them.
   */
  function ledgerBoxes(form) {
    return form ? form.querySelectorAll('[data-select-item]') : [];
  }

  function refreshLedgerSelection(form) {
    if (!form) return;
    var boxes = ledgerBoxes(form);
    var picked = 0;
    Array.prototype.forEach.call(boxes, function (box) {
      if (box.checked) picked += 1;
    });

    var all = form.querySelector('[data-select-all]');
    if (all) {
      all.checked = picked > 0 && picked === boxes.length;
      // Neither ticked nor empty: some of the page is selected, and the box says so
      // rather than pretending the selection is all or nothing.
      all.indeterminate = picked > 0 && picked < boxes.length;
    }

    var count = form.querySelector('[data-select-count]');
    if (count) {
      count.textContent = picked
        ? picked + ' of ' + boxes.length + ' selected'
        : 'None selected';
    }
  }

  document.addEventListener('change', function (event) {
    var all = event.target.closest('[data-select-all]');
    if (all) {
      var form = all.closest('[data-ledger-select]');
      Array.prototype.forEach.call(ledgerBoxes(form), function (box) {
        box.checked = all.checked;
      });
      refreshLedgerSelection(form);
      return;
    }
    var item = event.target.closest('[data-select-item]');
    if (item) refreshLedgerSelection(item.closest('[data-ledger-select]'));
  });

  // A swap brings in new rows — an appended page, or a whole new filtered table — and
  // the count and header box have to describe what is on screen now.
  document.addEventListener('htmx:afterSettle', function () {
    Array.prototype.forEach.call(document.querySelectorAll('[data-ledger-select]'), refreshLedgerSelection);
  });

  /* ------------------------------------------------------ transcript edges */

  /**
   * Tap-to-set edges on a run of transcript words.
   *
   * The two selects under the words are the real edges and post with or without this
   * running. What script adds is the obvious gesture: tap the first word to remove,
   * tap the last, and the selects and the tint follow. Delegated from the document,
   * because the cards are swapped by htmx after every decision.
   */
  function txScope(node) {
    var form = node.closest('form') || node.closest('details') || document;
    return {
      form: form,
      words: node.closest('[data-tx-edit]') || form.querySelector('[data-tx-edit]'),
      start: form.querySelector('[data-tx-start]'),
      end: form.querySelector('[data-tx-end]'),
      range: form.querySelector('[data-tx-range]'),
    };
  }

  function txPaint(scope) {
    if (!scope.words || !scope.start || !scope.end) return;
    var from = Number(scope.start.value);
    var to = Number(scope.end.value);
    if (from > to) { var swap = from; from = to; to = swap; }
    var chosen = [];
    Array.prototype.forEach.call(scope.words.querySelectorAll('[data-tx-word]'), function (word) {
      var index = Number(word.getAttribute('data-tx-word'));
      var inside = index >= from && index <= to;
      word.classList.toggle('tx__w--cut', inside);
      word.classList.toggle('tx__w--start', index === from);
      word.classList.toggle('tx__w--end', index === to);
      word.setAttribute('aria-pressed', inside ? 'true' : 'false');
      if (inside) chosen.push(word.textContent);
    });
    if (scope.range) {
      var text = chosen.join(' ');
      if (text.length > 120) text = text.slice(0, 58) + ' … ' + text.slice(-58);
      scope.range.textContent = chosen.length ? 'Removing ' + chosen.length + ' words: “' + text + '”' : '';
    }
  }

  document.addEventListener('click', function (event) {
    var word = event.target.closest('[data-tx-word]');
    if (word) {
      var scope = txScope(word);
      if (!scope.start || !scope.end) return;
      var index = Number(word.getAttribute('data-tx-word'));
      var from = Number(scope.start.value);
      var to = Number(scope.end.value);
      // First tap below the current start moves the start; anything else moves the
      // end — two taps, first word then last, is the whole gesture.
      if (scope.words.getAttribute('data-tx-armed') !== '1' || index < from) {
        scope.start.value = String(index);
        scope.end.value = String(Math.max(index, to));
        scope.words.setAttribute('data-tx-armed', '1');
      } else {
        scope.end.value = String(index);
        scope.words.removeAttribute('data-tx-armed');
      }
      txPaint(scope);
      return;
    }
    var reset = event.target.closest('[data-tx-reset]');
    if (reset) {
      var scopeReset = txScope(reset);
      if (scopeReset.words && scopeReset.start && scopeReset.end) {
        scopeReset.start.value = scopeReset.words.getAttribute('data-tx-default-start') || scopeReset.start.value;
        scopeReset.end.value = scopeReset.words.getAttribute('data-tx-default-end') || scopeReset.end.value;
        scopeReset.words.removeAttribute('data-tx-armed');
        txPaint(scopeReset);
      }
    }
  });

  document.addEventListener('change', function (event) {
    var select = event.target.closest('[data-tx-start], [data-tx-end]');
    if (select) txPaint(txScope(select));
  });

  // A swap brings in new words; the range sentence describes what is on screen now.
  function txPaintAll() {
    Array.prototype.forEach.call(document.querySelectorAll('[data-tx-edit]'), function (words) {
      var scope = txScope(words);
      if (scope.start && scope.end && scope.start.value !== '' && words.hasAttribute('data-tx-default-start') && words.getAttribute('data-tx-default-start') !== '') txPaint(scope);
    });
  }
  document.addEventListener('htmx:afterSettle', txPaintAll);
  txPaintAll();

  /* --------------------------------------------------------------- toggles */

  document.addEventListener('change', function (event) {
    var input = event.target.closest('.switch-input');
    if (!input) return;
    var wrapper = input.closest('.toggle');
    if (!wrapper) return;
    wrapper.classList.toggle('on', input.checked);
    var label = wrapper.querySelector('[data-toggle-label]');
    if (label && (label.textContent === 'Yes' || label.textContent === 'No')) {
      label.textContent = input.checked ? 'Yes' : 'No';
    }

    /*
     * A switch that saves as soon as it is flipped says so with an attribute, and the
     * submitting happens here rather than in an `onchange` on the element.
     *
     * It used to be inline, and inline is unreachable: this app sends
     * `script-src 'self'` with no `unsafe-inline`, so the browser refuses to run an
     * `on*` attribute and refuses silently — no console error, no network request, a
     * switch that animates and then springs back. Both settings toggles were dead in
     * 1.6.0 for exactly this reason, which meant the feature whose master switch that
     * is could not be turned on at all.
     *
     * The attribute is opt-in because not every switch should save on its own: the
     * explicit-content one lives in a form with its own Save button, and submitting
     * that form early would save half-finished edits to a show.
     */
    if (input.form && input.hasAttribute('data-submit-on-change')) input.form.requestSubmit();
  });

  /* ------------------------------------------------------------- clipboard */

  document.addEventListener('click', function (event) {
    var button = event.target.closest('[data-copy-target]');
    if (!button) return;
    var source = document.querySelector(button.getAttribute('data-copy-target'));
    if (!source) return;
    var text = source.textContent.trim();

    // navigator.clipboard needs a secure context, and plenty of SelfPod instances
    // are reached over plain HTTP on a LAN — hence the execCommand fallback.
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(
        function () {
          toast('Feed URL copied.');
        },
        function () {
          legacyCopy(text, source);
        },
      );
    } else {
      legacyCopy(text, source);
    }
  });

  function legacyCopy(text, source) {
    var area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    var ok = false;
    try {
      ok = document.execCommand('copy');
    } catch (err) {
      ok = false;
    }
    area.remove();
    if (ok) {
      toast('Feed URL copied.');
    } else {
      // Last resort: select the text so a manual copy is one keystroke away.
      var range = document.createRange();
      range.selectNodeContents(source);
      var selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      toast('Press ' + (navigator.platform.indexOf('Mac') === 0 ? '⌘C' : 'Ctrl+C') + ' to copy the selected URL.', 'warn');
    }
  }

  /* -------------------------------------------------------- public URL test */

  /**
   * Tests the public address from two vantage points, because one is not enough to
   * reach a conclusion.
   *
   * The browser's own attempt is what a listener's device experiences, so it is worth
   * making. But a browser can refuse a request for reasons that have nothing to do
   * with the server — an extension, strict privacy mode, or HTTPS-only settings
   * blocking a cross-origin call from this plain-HTTP page — and this test used to
   * report every such refusal as "check DNS, your reverse proxy or tunnel", which was
   * simply false. So SelfPod is asked to try the same address itself, and the two
   * results together give a verdict that can distinguish the cases.
   */
  document.addEventListener('click', function (event) {
    var button = event.target.closest('[data-health-test]');
    if (!button) return;
    var url = button.getAttribute('data-url');
    var dot = button.querySelector('.d');
    var action = button.querySelector('.public-url__action');
    if (button.getAttribute('aria-busy') === 'true') return;
    button.setAttribute('aria-busy', 'true');
    if (action) action.textContent = '· testing…';

    function settle(state, message, level) {
      button.removeAttribute('aria-busy');
      if (dot) dot.classList.remove('d--warn', 'd--err');
      if (dot && state !== 'reachable') dot.classList.add(state === 'blocked' ? 'd--warn' : 'd--err');
      if (action) {
        // "wrong server" rather than "unreachable": the address answers perfectly,
        // it just is not this container, and calling that unreachable would send the
        // operator looking for the wrong fault.
        action.textContent =
          state === 'reachable'
            ? '· reachable'
            : state === 'blocked'
              ? '· blocked here'
              : state === 'wrong'
                ? '· wrong server'
                : '· unreachable';
      }
      toast(message, level);
    }

    fromBrowser(url)
      .then(function (browser) {
        return fromServer().then(function (server) {
          return verdict(browser, server, url);
        });
      })
      .then(function (result) {
        settle(result.state, result.message, result.level);
      });
  });

  /** The browser's own attempt, classified rather than collapsed into one failure. */
  function fromBrowser(url) {
    var controller = new AbortController();
    var timedOut = false;
    var timeout = setTimeout(function () {
      timedOut = true;
      controller.abort();
    }, 10000);

    return fetch(url, { signal: controller.signal, cache: 'no-store', mode: 'cors' })
      .then(function (response) {
        clearTimeout(timeout);
        return response.json().then(
          function (body) {
            return { ok: response.ok, status: response.status, body: body };
          },
          function () {
            return { ok: response.ok, status: response.status, body: null };
          },
        );
      })
      .catch(function () {
        clearTimeout(timeout);
        // A blocked, offline or CORS-refused request is indistinguishable here by
        // design — the browser deliberately withholds the reason. Which is exactly
        // why the server's attempt matters.
        return { ok: false, status: null, body: null, failed: true, timedOut: timedOut };
      });
  }

  /** Asks SelfPod to try its own public address. */
  function fromServer() {
    return fetch('/api/reachability', {
      method: 'POST',
      headers: { 'sec-fetch-site': 'same-origin' },
      cache: 'no-store',
    })
      .then(function (response) {
        return response.ok ? response.json() : null;
      })
      .catch(function () {
        return null;
      });
  }

  /** Combines both attempts into one honest sentence. */
  function verdict(browser, server, url) {
    var mixed = window.location.protocol === 'http:' && url.indexOf('https://') === 0;

    if (browser.ok && server && server.reachable && server.sameInstance) {
      var version = browser.body && browser.body.version ? ' (SelfPod ' + browser.body.version + ')' : '';
      return { state: 'reachable', message: 'That address reaches SelfPod' + version + '.', level: 'ok' };
    }

    // The server got somewhere but not here: the single most confusing misconfiguration,
    // because everything looks fine until subscribers get someone else's feed.
    if (server && server.checked && server.reachable && !server.sameInstance) {
      return { state: 'wrong', message: server.message, level: 'err' };
    }

    // The address works, the browser would not make the call. Previously reported as
    // a server fault, which sent people to check DNS for no reason.
    if (server && server.reachable && server.sameInstance && !browser.ok) {
      var causes = ['an extension', 'strict privacy mode'];
      if (mixed) causes.push('a rule against calling an https address from this plain-http page');
      return {
        state: 'blocked',
        message:
          'That address is fine — SelfPod reached itself through it. Your browser is what refused the request' +
          (browser.timedOut ? ', by timing out' : '') +
          '. That is usually ' + causes.slice(0, -1).join(', ') + ' or ' + causes[causes.length - 1] +
          '. Subscribers are unaffected.',
        level: 'warn',
      };
    }

    if (browser.ok && server && server.checked && !server.reachable) {
      return {
        state: 'failed',
        message: 'Your browser reached that address but SelfPod could not: ' + server.message,
        level: 'err',
      };
    }

    if (!browser.ok && browser.status) {
      return {
        state: 'failed',
        message:
          'That address answered with HTTP ' + browser.status +
          " instead of SelfPod's health check. Something else is serving that hostname, or your proxy points at the wrong container or port.",
        level: 'err',
      };
    }

    if (server && server.checked) {
      return { state: 'failed', message: server.message, level: 'err' };
    }

    if (server && server.checked === false) {
      return { state: 'failed', message: server.message, level: 'err' };
    }

    // Both attempts failed to produce a usable answer, including SelfPod's own — so
    // say exactly that rather than naming a cause neither test established.
    return {
      state: 'failed',
      message:
        'Neither your browser nor SelfPod itself could reach that address. Check DNS, your reverse proxy or tunnel, and that the public base URL matches the hostname you serve SelfPod on.',
      level: 'err',
    };
  }

  /* ---------------------------------------------------- category linking */

  // Keeps the subcategory list showing only the chosen category's options, while
  // the server still validates the pair (a bad pair produces an invalid feed).
  function syncSubcategories() {
    var category = document.querySelector('[data-category-select]');
    var subcategory = document.querySelector('[data-subcategory-select]');
    if (!category || !subcategory) return;
    var chosen = category.value;
    var groups = subcategory.querySelectorAll('optgroup');
    var anyVisible = false;
    Array.prototype.forEach.call(groups, function (group) {
      var matches = group.getAttribute('data-category') === chosen;
      group.hidden = !matches;
      group.disabled = !matches;
      if (matches) anyVisible = true;
    });
    var selected = subcategory.selectedOptions[0];
    if (selected && selected.parentElement && selected.parentElement.hidden) subcategory.value = '';
    subcategory.disabled = !anyVisible;
    if (!anyVisible) subcategory.value = '';
  }

  document.addEventListener('change', function (event) {
    if (event.target.closest('[data-category-select]')) syncSubcategories();
  });
  document.addEventListener('htmx:afterSettle', syncSubcategories);

  /* -------------------------------------------------------------- slug hint */

  document.addEventListener('input', function (event) {
    var source = event.target.closest('[data-slug-source]');
    if (!source) return;
    var target = source.form && source.form.querySelector('[data-slug-target]');
    if (!target || target.dataset.touched === '1') return;
    target.value = slugify(source.value);
  });

  document.addEventListener('input', function (event) {
    var target = event.target.closest('[data-slug-target]');
    if (target) target.dataset.touched = target.value ? '1' : '';
  });

  function slugify(value) {
    return String(value || '')
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/['‘’"]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80);
  }

  /* ------------------------------------------------------------ mobile nav */

  document.addEventListener('click', function (event) {
    if (event.target.closest('[data-nav-toggle]')) {
      var open = document.body.classList.toggle('nav-open');
      var toggle = document.querySelector('[data-nav-toggle]');
      if (toggle) toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      return;
    }
    if (event.target.closest('[data-nav-close]')) closeNav();
  });

  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') closeNav();
  });

  function closeNav() {
    if (!document.body.classList.contains('nav-open')) return;
    document.body.classList.remove('nav-open');
    var toggle = document.querySelector('[data-nav-toggle]');
    if (toggle) toggle.setAttribute('aria-expanded', 'false');
  }

  /* ------------------------------------------------------- cover drag/drop */

  var coverZone = document.querySelector('[data-cover-dropzone]');
  if (coverZone) initCoverDrop(coverZone);

  document.addEventListener('htmx:afterSettle', function () {
    var zone = document.querySelector('[data-cover-dropzone]');
    if (zone && !zone.dataset.bound) initCoverDrop(zone);
  });

  function initCoverDrop(zone) {
    zone.dataset.bound = '1';
    var input = zone.querySelector('[data-cover-input]');
    var showId = zone.getAttribute('data-show-id');
    var slug = zone.getAttribute('data-slug');

    ['dragenter', 'dragover'].forEach(function (name) {
      zone.addEventListener(name, function (event) {
        event.preventDefault();
        zone.classList.add('is-dragover');
      });
    });
    ['dragleave', 'drop'].forEach(function (name) {
      zone.addEventListener(name, function (event) {
        event.preventDefault();
        zone.classList.remove('is-dragover');
      });
    });

    zone.addEventListener('drop', function (event) {
      var file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
      if (file) uploadCover(file);
    });

    if (input) {
      input.addEventListener('change', function () {
        if (input.files && input.files[0]) uploadCover(input.files[0]);
      });
    }

    function uploadCover(file) {
      if (!/^image\//.test(file.type)) {
        toast('Cover art needs to be an image — JPEG, PNG or WebP.', 'err');
        return;
      }
      var progress = zone.querySelector('[data-cover-progress]');
      if (progress) {
        progress.hidden = false;
        progress.querySelector('i').style.width = '0%';
      }

      var form = new FormData();
      form.append('cover', file);
      var xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/shows/' + encodeURIComponent(showId) + '/cover');
      xhr.upload.addEventListener('progress', function (event) {
        if (!progress || !event.lengthComputable) return;
        progress.querySelector('i').style.width = Math.round((event.loaded / event.total) * 100) + '%';
      });
      xhr.addEventListener('load', function () {
        if (progress) progress.hidden = true;
        if (xhr.status >= 200 && xhr.status < 300) {
          toast('Cover art updated.');
          if (window.htmx) {
            window.htmx.ajax('GET', '/ui/shows/' + encodeURIComponent(slug) + '/cover-box', {
              target: '#cover-box',
              swap: 'outerHTML',
            });
          } else {
            window.location.reload();
          }
        } else {
          toast(describeUploadError(xhr), 'err');
        }
      });
      xhr.addEventListener('error', function () {
        if (progress) progress.hidden = true;
        toast('That upload could not be sent. Check your connection and try again.', 'err');
      });
      xhr.send(form);
    }
  }

  /* ------------------------------------------------------------ upload queue */

  var uploadForm = document.querySelector('[data-upload-form]');
  if (uploadForm) initUploadQueue(uploadForm);

  function initUploadQueue(form) {
    var dropzone = form.querySelector('[data-dropzone]');
    var fileInput = form.querySelector('[data-file-input]');
    var queue = document.getElementById('upload-queue');
    var queueItems = queue && queue.querySelector('[data-queue-items]');
    var template = document.getElementById('queue-item-template');
    var showId = form.getAttribute('data-show-id');
    var slug = form.getAttribute('data-slug');
    var pending = [];
    var active = 0;
    var CONCURRENCY = 2;

    var ALLOWED = ['mp3', 'm4a', 'aac', 'ogg', 'opus', 'wav', 'flac'];

    ['dragenter', 'dragover'].forEach(function (name) {
      dropzone.addEventListener(name, function (event) {
        event.preventDefault();
        dropzone.classList.add('is-dragover');
      });
    });
    ['dragleave', 'drop'].forEach(function (name) {
      dropzone.addEventListener(name, function (event) {
        event.preventDefault();
        dropzone.classList.remove('is-dragover');
      });
    });

    dropzone.addEventListener('drop', function (event) {
      if (event.dataTransfer && event.dataTransfer.files) enqueue(event.dataTransfer.files);
    });

    fileInput.addEventListener('change', function () {
      enqueue(fileInput.files);
      fileInput.value = '';
    });

    // JavaScript is present, so take over the form to add progress reporting.
    form.addEventListener('submit', function (event) {
      event.preventDefault();
      if (fileInput.files && fileInput.files.length) {
        enqueue(fileInput.files);
        fileInput.value = '';
      }
    });

    function enqueue(files) {
      Array.prototype.forEach.call(files, function (file) {
        var extension = (file.name.split('.').pop() || '').toLowerCase();
        var row = makeRow(file);
        if (ALLOWED.indexOf(extension) === -1) {
          fail(row, 'SelfPod doesn’t serve .' + extension + ' files. Supported: ' + ALLOWED.join(', ') + '.');
          return;
        }
        pending.push({ file: file, row: row });
      });
      pump();
    }

    function makeRow(file) {
      queue.hidden = false;
      var node = template.content.firstElementChild.cloneNode(true);
      node.querySelector('[data-name]').textContent = file.name;
      node.querySelector('[data-detail]').textContent = formatBytes(file.size);
      queueItems.appendChild(node);
      return node;
    }

    function pump() {
      while (active < CONCURRENCY && pending.length) {
        var job = pending.shift();
        active += 1;
        send(job.file, job.row);
      }
    }

    function send(file, row) {
      var bar = row.querySelector('[data-bar] i');
      var pct = row.querySelector('[data-pct]');
      var form2 = new FormData();
      form2.append('files', file, file.name);

      var xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/shows/' + encodeURIComponent(showId) + '/upload');
      xhr.upload.addEventListener('progress', function (event) {
        if (!event.lengthComputable) return;
        var percent = Math.round((event.loaded / event.total) * 100);
        bar.style.width = percent + '%';
        pct.textContent = percent + '%';
      });

      xhr.addEventListener('load', function () {
        active -= 1;
        if (xhr.status >= 200 && xhr.status < 300) {
          var rejected = null;
          try {
            var body = JSON.parse(xhr.responseText);
            if (body.rejected && body.rejected.length) rejected = body.rejected[0].message;
          } catch (err) {
            /* an opaque 2xx is still a success */
          }
          if (rejected) fail(row, rejected);
          else succeed(row);
        } else {
          fail(row, describeUploadError(xhr, file));
        }
        pump();
        if (!active && !pending.length && window.htmx) {
          window.htmx.ajax('GET', '/shows/' + encodeURIComponent(slug), { target: 'body', swap: 'none' });
        }
      });

      xhr.addEventListener('error', function () {
        active -= 1;
        fail(row, 'That upload could not be sent. Check your connection, or drop the file into the show folder instead.');
        pump();
      });

      xhr.send(form2);
    }

    function succeed(row) {
      row.classList.add('queue-item--done');
      row.querySelector('[data-bar]').hidden = true;
      row.querySelector('[data-pct]').textContent = 'done';
      var message = row.querySelector('[data-message]');
      message.hidden = false;
      message.textContent = 'Uploaded — scanning now.';
    }

    function fail(row, text) {
      row.classList.add('queue-item--err');
      var bar = row.querySelector('[data-bar]');
      if (bar) bar.hidden = true;
      row.querySelector('[data-pct]').textContent = 'failed';
      var message = row.querySelector('[data-message]');
      message.hidden = false;
      message.textContent = text;
    }

    function formatBytes(bytes) {
      var units = ['B', 'KB', 'MB', 'GB'];
      var value = bytes;
      var unit = 0;
      while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
      }
      return (unit === 0 ? value : value.toFixed(1)) + ' ' + units[unit];
    }
  }

  /**
   * A 413 from a proxy never reaches SelfPod's own handler, so its body is HTML
   * rather than the API's JSON error shape. Saying which limit was probably hit
   * saves the user from debugging a server that is behaving correctly.
   */
  function describeUploadError(xhr, file) {
    if (xhr.status === 413) {
      var size = file ? ' (' + Math.round(file.size / 1024 / 1024) + ' MB)' : '';
      return (
        'This file' +
        size +
        ' was rejected as too large before it reached SelfPod — that is a limit in your reverse proxy or tunnel, not in SelfPod. Cloudflare\'s free plan caps uploads at 100 MB. Try SelfPod\'s local address, or copy the file into the show folder directly.'
      );
    }
    try {
      var parsed = JSON.parse(xhr.responseText);
      if (parsed && parsed.error && parsed.error.message) return parsed.error.message;
    } catch (err) {
      /* fall through */
    }
    if (xhr.status === 0) return 'The connection dropped during upload. Large files often fail through a tunnel — try the local address instead.';
    return 'Upload failed (HTTP ' + xhr.status + ').';
  }

  /* ---------------------------------------------------------- flash message */

  var flashNode = document.getElementById('flash-data');
  if (flashNode) {
    try {
      var flash = JSON.parse(flashNode.textContent);
      if (flash && flash.message) toast(flash.message, flash.level);
    } catch (err) {
      /* ignore malformed flash payloads */
    }
  }

  /* -------------------------------------------------------- login /health */

  var healthInline = document.querySelector('[data-health-inline]');
  if (healthInline) {
    fetch('/health', { cache: 'no-store' })
      .then(function (response) {
        return response.json();
      })
      .then(function (body) {
        healthInline.textContent = '/health ' + body.status;
        healthInline.classList.add(body.status === 'ok' ? 'is-ok' : 'is-degraded');
      })
      .catch(function () {
        healthInline.textContent = '/health unreachable';
        healthInline.classList.add('is-degraded');
      });
  }

  syncSubcategories();
})();

/**
 * Subscribe-app switcher on the show page.
 *
 * Each app gets its own QR because each wants its own "subscribe to this feed" URL
 * scheme. The choice is remembered, since someone with one podcast app will want the
 * same one every time.
 */
(function () {
  'use strict';

  var STORAGE_KEY = 'selfpod.subscribeTarget';

  function apply(root, id) {
    var buttons = root.querySelectorAll('[data-subscribe-target]');
    var panes = root.querySelectorAll('[data-subscribe-pane]');
    var matched = false;
    Array.prototype.forEach.call(panes, function (pane) {
      var isMatch = pane.getAttribute('data-subscribe-pane') === id;
      pane.hidden = !isMatch;
      pane.classList.toggle('is-active', isMatch);
      if (isMatch) matched = true;
    });
    if (!matched) return false;
    Array.prototype.forEach.call(buttons, function (button) {
      var isMatch = button.getAttribute('data-subscribe-target') === id;
      button.classList.toggle('is-active', isMatch);
      button.setAttribute('aria-checked', isMatch ? 'true' : 'false');
    });
    return true;
  }

  function restore(root) {
    var saved = null;
    try {
      saved = window.localStorage.getItem(STORAGE_KEY);
    } catch (err) {
      saved = null;
    }
    if (saved) apply(root, saved);
  }

  document.addEventListener('click', function (event) {
    var button = event.target.closest('[data-subscribe-target]');
    if (!button) return;
    var root = button.closest('[data-subscribe]');
    var id = button.getAttribute('data-subscribe-target');
    if (!apply(root, id)) return;
    try {
      window.localStorage.setItem(STORAGE_KEY, id);
    } catch (err) {
      /* private browsing — the choice just won't persist */
    }
  });

  function init() {
    var root = document.querySelector('[data-subscribe]');
    if (root) restore(root);
  }

  document.addEventListener('htmx:afterSettle', init);
  init();
})();
