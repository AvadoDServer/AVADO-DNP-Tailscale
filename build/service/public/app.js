// AVADO Tailscale page. Plain JS, no dependencies; loaded under a strict CSP (script-src 'self').
(function () {
  "use strict";

  var theme = new URLSearchParams(location.search).get("theme");
  if (theme !== "light" && theme !== "dark") {
    theme = window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  }
  document.documentElement.setAttribute("data-theme", theme);

  var s = null;
  var busy = false;

  function $(id) {
    return document.getElementById(id);
  }

  function api(method, path, body) {
    var opts = { method: method, headers: { Accept: "application/json", "X-Avado-Request": "1" } };
    if (method !== "GET") {
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(body || {});
    }
    return fetch(path, opts).then(function (r) {
      return r.json().then(function (j) {
        if (!r.ok) throw new Error(j && j.error ? j.error : "Something went wrong (" + r.status + ")");
        return j;
      });
    });
  }

  function show(id, on) {
    $(id).hidden = !on;
  }

  /** done: true = ✓, false = still to do (with an optional hint), null = nothing to show */
  function tick(n, done, hint) {
    var t = $("tick-" + n);
    t.textContent = done ? "✓ Done" : hint || "";
    t.className = done ? "tick ok" : "tick";
    $("step-" + n).className = done ? "done" : "";
  }

  function day(iso) {
    var d = new Date(iso);
    return isNaN(d.getTime()) ? "" : d.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
  }

  function render() {
    if (!s) return;
    $("version").textContent = s.packageVersion ? "Version " + s.packageVersion : "";
    var running = s.state === "running";
    var name = (s.dnsName || s.hostname || "avado").split(".")[0];
    var names = document.querySelectorAll(".machine-name");
    for (var i = 0; i < names.length; i++) names[i].textContent = name;

    // the five steps
    tick(1, running, s.state === "needs-approval" ? "Approve " + name + " in Machines" : s.state === "starting" ? "Starting…" : "");
    if (running) $("tick-1").textContent = "✓ " + name;
    show("key-form", !running && s.state !== "needs-approval");

    var routeOk = running && s.routeApproved;
    var exitOk = running && (!s.exitNodeOffered || s.exitNodeApproved);
    tick(2, routeOk && exitOk, running ? (routeOk ? "Use as exit node: not yet" : exitOk ? "Route: not yet" : "Not yet") : "");

    var dnsOk = running && (s.dns === "global" || s.dns === "split");
    tick(3, dnsOk, running && s.dns === "not-override" ? "Turn on Override DNS servers" : running && s.dns === "none" ? "Not yet" : "");

    var deviceOk = running && s.peersOnline > 0;
    tick(4, deviceOk, running ? "Not yet" : "");

    var done = routeOk && exitOk && (dnsOk || s.dns === null) && deviceOk;
    var v = $("verdict");
    v.setAttribute("data-level", done ? "ok" : s.state === "error" ? "critical" : "warning");
    $("headline").textContent = done
      ? "Done — open http://my.ava.do on your phone with Tailscale on."
      : s.state === "error"
        ? "Tailscale is not running"
        : s.state === "starting"
          ? "Tailscale is starting…"
          : "Set up Tailscale";
    $("subline").textContent = done
      ? ""
      : s.state === "error"
        ? "It starts again by itself. If this stays, restart the Tailscale app in the Admin."
        : s.state === "starting"
          ? "One moment."
          : "Follow the steps below. It takes a few minutes.";

    $("notice").textContent = s.notice || "";
    show("notice", !!s.notice);
    $("clash").textContent = s.routeClash
      ? "Another device in your Tailscale (" + s.routeClash + ") already offers the same addresses, probably a second AVADO. Only one works at a time: in Machines, untick the routes of the one you do not need from afar."
      : "";
    show("clash", !!s.routeClash);

    $("expiry-tip").textContent =
      running && s.keyExpiry ? "Tip: in Machines, choose Disable key expiry for " + name + ". Otherwise Tailscale logs it out on " + day(s.keyExpiry) + "." : "";
    show("expiry-tip", !!(running && s.keyExpiry));

    // More options
    var link = !running && s.authUrl;
    show("login-link", !!link);
    $("login").hidden = running || !!link;
    if (link) {
      $("auth-url").href = link;
      if (s.qr) $("qr").src = s.qr;
    }
    show("mcp-card", running);
    show("logout-card", running);
    if (running) {
      $("share-toggle").checked = !!s.mcpShared;
      $("funnel-toggle").checked = !!s.funnel;
      $("funnel-toggle").disabled = !s.mcpShared;
      $("mcp-url").textContent = s.mcpUrl ? "AI Connect address: " + s.mcpUrl + (s.funnel ? " (also on the internet)" : " (only your Tailscale devices)") : "";
      show("mcp-url", !!s.mcpUrl);
    }
  }

  function refresh() {
    if (busy) return Promise.resolve();
    return api("GET", "/api/status")
      .then(function (j) {
        s = j;
        render();
      })
      .catch(function () {});
  }

  function act(path, body, control) {
    busy = true;
    if (control) control.disabled = true;
    return api("POST", path, body)
      .then(function (j) {
        s = Object.assign({}, s, j);
      })
      .catch(function (e) {
        s = Object.assign({}, s, { notice: e.message });
      })
      .then(function () {
        busy = false;
        if (control) control.disabled = false;
        render();
        return refresh();
      });
  }

  // copy a value the owner has to type in Tailscale (works on plain http too)
  function copy(text, button) {
    var done = function () {
      var old = button.getAttribute("data-copy");
      button.textContent = "Copied";
      setTimeout(function () {
        button.textContent = old;
      }, 1500);
    };
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(done, function () {});
      return;
    }
    var t = document.createElement("textarea");
    t.value = text;
    t.setAttribute("readonly", "");
    t.style.position = "fixed";
    t.style.opacity = "0";
    document.body.appendChild(t);
    t.select();
    try {
      if (document.execCommand("copy")) done();
    } catch (e) {
      /* the value is still visible on the button */
    }
    document.body.removeChild(t);
  }
  Array.prototype.forEach.call(document.querySelectorAll(".copy"), function (b) {
    b.addEventListener("click", function () {
      copy(b.getAttribute("data-copy"), b);
    });
  });

  $("password-how").addEventListener("click", function () {
    $("more").open = true;
  });

  $("login").addEventListener("click", function () {
    act("/api/login", {}, $("login"));
  });

  $("login-key").addEventListener("click", function () {
    var key = $("auth-key").value.trim();
    if (!key) {
      $("auth-key").focus();
      return;
    }
    $("login-msg").textContent = "Connecting (this can take half a minute)…";
    act("/api/login", { authKey: key }, $("login-key")).then(function () {
      $("auth-key").value = "";
      $("login-msg").textContent = "";
    });
  });

  $("logout").addEventListener("click", function () {
    if (!confirm("Remove this AVADO from your Tailscale? You can connect it again later.")) return;
    act("/api/logout", {}, $("logout"));
  });

  $("share-toggle").addEventListener("change", function (e) {
    act("/api/share-mcp", { on: e.target.checked }, e.target);
  });

  $("funnel-toggle").addEventListener("change", function (e) {
    var on = e.target.checked;
    if (on) {
      var ok = confirm(
        "Share AI Connect on the internet?\n\nThis gives AI Connect a public address so ChatGPT or Claude on the web can reach it. Only someone with one of your AI Connect keys can use it; nothing else on your AVADO is shared. Switch it off when you do not need it.",
      );
      if (!ok) {
        e.target.checked = false;
        return;
      }
    }
    act("/api/funnel", { on: on, confirm: on ? "share on the internet" : undefined }, e.target);
  });

  refresh();
  setInterval(function () {
    if (!document.hidden) refresh();
  }, 4000);
})();
