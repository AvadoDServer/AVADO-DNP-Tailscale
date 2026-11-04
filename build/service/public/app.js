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

  function tag(id, done, doneText, todoText) {
    var t = $(id);
    t.textContent = done ? doneText : todoText;
    t.className = done ? "tag ok" : "tag";
  }

  function day(iso) {
    var d = new Date(iso);
    return isNaN(d.getTime()) ? "" : d.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
  }

  function render() {
    if (!s) return;
    $("version").textContent = s.packageVersion ? "Version " + s.packageVersion : "";
    var v = $("verdict");
    var running = s.state === "running";
    var approval = s.state === "needs-approval";
    var needs = s.state === "needs-login" || s.state === "logging-in" || s.state === "stopped";
    var routeTodo = running && s.routeOffered && !s.routeApproved;
    v.setAttribute("data-level", running && !routeTodo ? "ok" : s.state === "error" ? "critical" : "warning");
    $("headline").textContent = running
      ? "Your AVADO is in your Tailscale"
      : approval
        ? "Waiting for your approval in Tailscale"
        : needs
          ? "Not connected to Tailscale yet"
          : s.state === "error"
            ? "Tailscale is not running"
            : "Tailscale is starting…";
    $("subline").textContent = running
      ? routeTodo
        ? "One more step: allow the AVADO network in your Tailscale account (step 1 below)."
        : "You can reach it from your own devices wherever you are, with Tailscale on."
      : approval
        ? "Your Tailscale account asks you to approve new devices. Open Machines in your Tailscale account and approve this AVADO."
        : needs
          ? "Follow the three steps below. It takes a few minutes."
          : s.state === "error"
            ? "It should start again by itself. If this stays, restart the Tailscale app in the Admin."
            : "One moment.";

    $("notice").textContent = s.notice || "";
    show("notice", !!s.notice);

    show("login-card", needs);
    var link = s.authUrl;
    show("login-link", !!link);
    show("key-in-settings", !!s.authKeyInSettings);
    show("logout-key-note", !!s.authKeyInSettings);
    if (link) {
      $("auth-url").href = link;
      if (s.qr) $("qr").src = s.qr;
      $("login-msg").textContent = "";
    } else if (s.state === "logging-in") {
      $("login-msg").textContent = "Asking Tailscale for a login link (this can take half a minute)…";
    }

    show("connected-card", running);
    show("admin-card", running);
    show("mcp-card", running);
    show("exit-card", running);
    show("logout-card", running);
    if (running) {
      $("dns-name").textContent = s.dnsName || "—";
      $("ips").textContent =
        (s.ips || []).filter(function (ip) {
          return ip.indexOf(":") < 0;
        })[0] || "—";
      $("tailnet").textContent = s.tailnet || "—";
      $("route-toggle").checked = !!s.routeOffered;
      show("route-steps", !!s.routeOffered);
      var machine = (s.dnsName || s.hostname || "avado").split(".")[0];
      var names = document.querySelectorAll(".machine-name");
      for (var i = 0; i < names.length; i++) names[i].textContent = machine;
      $("subnet").textContent = s.subnet;
      $("dns-server").textContent = s.dnsServer || "172.33.1.2";
      tag("route-state", s.routeApproved, "Done", "Not done yet");
      tag("expiry-state", !s.keyExpiry, "Done", s.keyExpiry ? "Not done yet: logs out on " + day(s.keyExpiry) : "Not done yet");
      $("clash").textContent = s.routeClash
        ? "Another device in your Tailscale (" +
          s.routeClash +
          ") already offers the same AVADO network, probably a second AVADO. Only one can be opened through Tailscale at a time: switch this off on the one you do not need from afar."
        : "";
      show("clash", !!s.routeClash);

      $("exit-toggle").checked = !!s.exitNodeOffered;
      show("exit-state", !!s.exitNodeOffered);
      tag("exit-state", s.exitNodeApproved, "Allowed", "Not allowed yet");

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

  $("login").addEventListener("click", function () {
    $("login-msg").textContent = "Asking Tailscale for a login link (this can take half a minute)…";
    act("/api/login", {}, $("login"));
  });

  $("login-key").addEventListener("click", function () {
    var key = $("auth-key").value.trim();
    if (!key) {
      $("auth-key").focus();
      return;
    }
    $("login-msg").textContent = "Logging in with the key (this can take half a minute)…";
    act("/api/login", { authKey: key }, $("login-key")).then(function () {
      $("auth-key").value = "";
      $("login-msg").textContent = "";
    });
  });

  $("logout").addEventListener("click", function () {
    if (!confirm("Remove this AVADO from your Tailscale? You can add it again later.")) return;
    act("/api/logout", {}, $("logout"));
  });

  $("route-toggle").addEventListener("change", function (e) {
    var on = e.target.checked;
    if (!on && !confirm("Stop offering the AVADO Admin and apps to your Tailscale devices? You will not be able to open them through Tailscale until you switch this on again.")) {
      e.target.checked = true;
      return;
    }
    act("/api/route", { on: on }, e.target);
  });

  $("exit-toggle").addEventListener("change", function (e) {
    var on = e.target.checked;
    if (on && !confirm("Let your devices send their internet traffic through your AVADO's home connection when you choose it as exit node? Websites will see your home address.")) {
      e.target.checked = false;
      return;
    }
    act("/api/exit-node", { on: on }, e.target);
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
