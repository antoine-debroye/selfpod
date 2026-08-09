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

  // "Type the show name to confirm" — enables the destructive button only on an
  // exact match (spec §11.6).
  document.addEventListener('input', function (event) {
    var input = event.target.closest('[data-confirm-match]');
    if (!input) return;
    var expected = input.getAttribute('data-confirm-match');
    var target = document.querySelector(input.getAttribute('data-confirm-target'));
    if (target) target.disabled = input.value !== expected;
  });

  document.addEventListener('change', function (event) {
    var check = event.target.closest('[data-confirm-check]');
    if (!check) return;
    var target = document.querySelector(check.getAttribute('data-confirm-target'));
    if (target) target.disabled = !check.checked;
  });

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

  // Runs from the browser on purpose: that is the only way to prove the public
  // address actually reaches SelfPod through the user's proxy and DNS.
  document.addEventListener('click', function (event) {
    var button = event.target.closest('[data-health-test]');
    if (!button) return;
    var url = button.getAttribute('data-url');
    var dot = button.querySelector('.d');
    var action = button.querySelector('.public-url__action');
    if (action) action.textContent = '· testing…';

    var controller = new AbortController();
    var timeout = setTimeout(function () {
      controller.abort();
    }, 8000);

    fetch(url, { signal: controller.signal, cache: 'no-store', mode: 'cors' })
      .then(function (response) {
        return response.json().then(
          function (body) {
            return { ok: response.ok, body: body };
          },
          function () {
            return { ok: response.ok, body: null };
          },
        );
      })
      .then(function (result) {
        clearTimeout(timeout);
        if (result.ok) {
          if (dot) dot.classList.remove('d--warn', 'd--err');
          if (action) action.textContent = '· reachable';
          var version = result.body && result.body.version ? ' (SelfPod ' + result.body.version + ')' : '';
          toast('That address reaches SelfPod' + version + '.');
        } else {
          if (dot) dot.classList.add('d--err');
          if (action) action.textContent = '· failed';
          toast('That address answered, but not with SelfPod’s health check. Check your reverse proxy is pointing at the right container and port.', 'err');
        }
      })
      .catch(function () {
        clearTimeout(timeout);
        if (dot) dot.classList.add('d--err');
        if (action) action.textContent = '· unreachable';
        toast(
          'Your browser could not reach that address. Check DNS, your reverse proxy or tunnel, and that the public base URL matches the hostname you serve SelfPod on.',
          'err',
        );
      });
  });

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

  /* ---------------------------------------------------- dismissible notices */

  document.addEventListener('click', function (event) {
    var button = event.target.closest('[data-dismiss]');
    if (!button) return;
    var key = button.getAttribute('data-dismiss');
    var target = document.querySelector('[data-dismissible="' + key + '"]');
    if (target) target.remove();
    if (window.htmx) {
      window.htmx.ajax('POST', '/ui/settings/dismiss-watcher-notice', { target: 'body', swap: 'none' });
    }
  });

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
