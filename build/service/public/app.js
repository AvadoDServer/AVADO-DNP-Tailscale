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

  function render() {
    if (!s) return;
    $("version").textContent = s.packageVersion ? "Version " + s.packageVersion : "";
    var v = $("verdict");
    var running = s.state === "running";
    var needs = s.state === "needs-login" || s.state === "logging-in" || s.state === "stopped";
    v.setAttribute("data-level", running ? "ok" : s.state === "error" ? "critical" : "warning");
    $("headline").textContent = running
      ? "Your AVADO is in your Tailscale"
      : needs
        ? "Not connected to Tailscale yet"
        : s.state === "error"
          ? "Tailscale is not running"
          : "Tailscale is starting…";
    $("subline").textContent = running
      ? "You can reach it from your own devices wherever you are, with Tailscale on."
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
    show("logout-card", running);
    if (running) {
      $("dns-name").textContent = s.dnsName || "—";
      $("ips").textContent = (s.ips || []).filter(function (ip) {
        return ip.indexOf(":") < 0;
      })[0] || "—";
      $("tailnet").textContent = s.tailnet || "—";
      $("route-toggle").checked = !!s.routeOffered;
      show("route-steps", !!s.routeOffered);
      $("machine-name").textContent = (s.dnsName || s.hostname || "avado").split(".")[0];
      $("subnet").textContent = s.subnet;
      var rs = $("route-state");
      rs.textContent = s.routeApproved ? "Done" : "Not yet done";
      rs.className = s.routeApproved ? "tag ok" : "tag";
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
    act("/api/login", { offerRoute: $("offer-route").checked }, $("login"));
  });

  $("logout").addEventListener("click", function () {
    if (!confirm("Remove this AVADO from your Tailscale? You can add it again later.")) return;
    act("/api/logout", {}, $("logout"));
  });

  $("route-toggle").addEventListener("change", function (e) {
    act("/api/route", { on: e.target.checked }, e.target);
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
