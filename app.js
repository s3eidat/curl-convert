/* cURL Convert — parses the command text only. This page has no way to send requests (CSP connect-src 'self'), and never tries. */
(function () {
  "use strict";
  var $ = S3.$, $$ = S3.$$;

  // ================= shell words (POSIX sh quoting, as browsers' "Copy as cURL (bash)" writes it) =================
  var ANSI = { n: "\n", t: "\t", r: "\r", a: "\x07", b: "\b", e: "\x1b", E: "\x1b", f: "\f", v: "\v", "\\": "\\", "'": "'", '"': '"', "?": "?" };
  function shellWords(src) {
    var s = src.replace(/\r\n?/g, "\n"), words = [], cur = null, i = 0, n = s.length, stoppedAt = null;
    function add(t) { cur = (cur || "") + t; }
    function end() { if (cur !== null) { words.push(cur); cur = null; } }
    while (i < n) {
      var c = s[i];
      if (c === "\\" && s[i + 1] === "\n") { i += 2; continue; }                 // bash line continuation
      if ((c === "^" || c === "`") && s[i + 1] === "\n" && cur === null) { i += 2; continue; } // cmd / PowerShell continuation
      if (c === " " || c === "\t" || c === "\n") { end(); i++; continue; }
      if (c === "#" && cur === null) { while (i < n && s[i] !== "\n") i++; continue; }
      if (cur === null && (c === "|" || c === ";" || c === "&" || c === ">" || c === "<")) { stoppedAt = s.slice(i).trim(); break; }
      if (c === "'") {
        var e = s.indexOf("'", i + 1);
        if (e < 0) throw new Error("Unclosed single quote");
        add(s.slice(i + 1, e)); i = e + 1; continue;
      }
      if (c === "$" && s[i + 1] === "'") {
        // $'…' yields bytes: \xNN and octal are raw bytes, \u/\U and plain text are UTF-8. Decode the bytes as UTF-8 at the end.
        var j = i + 2, bytes = [], enc = new TextEncoder();
        var txt = function (t) { enc.encode(t).forEach(function (b) { bytes.push(b); }); };
        for (;;) {
          if (j >= n) throw new Error("Unclosed $'…' quote");
          var ch = s[j];
          if (ch === "'") break;
          if (ch !== "\\") { txt(ch); j++; continue; }
          var x = s[j + 1];
          if (ANSI[x] !== undefined) { txt(ANSI[x]); j += 2; continue; }
          var m;
          if (x === "x" && (m = /^[0-9a-fA-F]{1,2}/.exec(s.slice(j + 2)))) { bytes.push(parseInt(m[0], 16)); j += 2 + m[0].length; continue; }
          if (x === "u" && (m = /^[0-9a-fA-F]{1,4}/.exec(s.slice(j + 2)))) { txt(String.fromCodePoint(parseInt(m[0], 16))); j += 2 + m[0].length; continue; }
          if (x === "U" && (m = /^[0-9a-fA-F]{1,8}/.exec(s.slice(j + 2))) && parseInt(m[0], 16) <= 0x10FFFF) { txt(String.fromCodePoint(parseInt(m[0], 16))); j += 2 + m[0].length; continue; }
          if ((m = /^[0-7]{1,3}/.exec(s.slice(j + 1)))) { bytes.push(parseInt(m[0], 8) & 255); j += 1 + m[0].length; continue; }
          txt("\\" + (x || "")); j += 2;
        }
        add(new TextDecoder("utf-8").decode(new Uint8Array(bytes))); i = j + 1; continue;
      }
      if (c === '"') {
        var k = i + 1, buf = "";
        for (;;) {
          if (k >= n) throw new Error("Unclosed double quote");
          var d = s[k];
          if (d === '"') break;
          if (d === "\\" && /["\\$`\n]/.test(s[k + 1] || "")) { if (s[k + 1] !== "\n") buf += s[k + 1]; k += 2; continue; }
          buf += d; k++;
        }
        add(buf); i = k + 1; continue;
      }
      if (c === "\\") { if (i + 1 < n) add(s[i + 1]); i += 2; continue; }
      add(c); i++;
    }
    end();
    return { words: words, stoppedAt: stoppedAt };
  }

  // ================= curl options =================
  var SHORT_ARG = set("X H d F u b A e o m x T r w c E K D U C P Y y z Q t");
  var SHORT_FLAG = set("s S L k i I v G f O N # n g l j q Z J R 0 1 2 3 4 6 a B M p");
  var LONG_ARG = set("request header data data-raw data-binary data-ascii data-urlencode json form form-string user cookie user-agent " +
    "referer url max-time connect-timeout proxy output cookie-jar cert key cacert capath retry retry-delay retry-max-time write-out " +
    "resolve range upload-file oauth2-bearer aws-sigv4 unix-socket interface limit-rate max-redirs proxy-user dump-header config " +
    "trace trace-ascii stderr ciphers connect-to continue-at expect100-timeout header-file keepalive-time local-port netrc-file " +
    "noproxy pass proto proto-redir proxy-header socks5 socks5-hostname tls-max user-agent variable");
  var IGNORED_NOTE = set("s S v i silent show-error verbose include o output w write-out f fail progress-bar # n O remote-name J remote-header-name " +
    "trace trace-ascii stderr dump-header D c cookie-jar retry retry-delay retry-max-time limit-rate keepalive-time");
  function set(s) { var o = Object.create(null); s.split(/\s+/).forEach(function (w) { if (w) o[w] = true; }); return o; }

  function utf8Base64(s) { var b = new TextEncoder().encode(s), bin = ""; b.forEach(function (x) { bin += String.fromCharCode(x); }); return btoa(bin); }
  // curl --data-urlencode uses RFC 3986 percent-encoding (space → %20), keeping only A-Z a-z 0-9 - . _ ~
  function curlEscape(s) { return encodeURIComponent(s).replace(/[!'()*]/g, function (c) { return "%" + c.charCodeAt(0).toString(16).toUpperCase(); }); }

  function parseCurl(text) {
    var sw = shellWords(text.trim().replace(/^\$\s+/, "")), w = sw.words;
    var r = { url: null, method: null, headers: [], data: [], form: [], user: null, cookie: null, get: false, head: false, upload: null,
      insecure: false, follow: false, compressed: false, timeout: null, connectTimeout: null, proxy: null, json: false,
      ignored: [], warnings: [], urls: [] };
    if (sw.stoppedAt) r.warnings.push("Ignored everything after “" + sw.stoppedAt.slice(0, 30) + "”");
    if (!w.length) throw new Error("Empty command");
    var start = 0;
    if (/^curl(\.exe)?$/i.test(w[0])) start = 1;
    else if (/^https?:/i.test(w[0]) || w[0][0] === "-") start = 0;
    else throw new Error("This doesn't start with curl");
    function opt(name, val) {
      switch (name) {
        case "X": case "request": r.method = val.toUpperCase(); break;
        case "H": case "header":
          var c = val.indexOf(":");
          if (c > 0) {
            var hv = val.slice(c + 1).replace(/^\s+/, "");
            if (hv === "" && val.slice(-1) === ":") r.headers = r.headers.filter(function (h) { return h[0].toLowerCase() !== val.slice(0, c).trim().toLowerCase(); }); // "X-Foo:" removes
            else r.headers.push([val.slice(0, c).trim(), hv]);
          } else if (/;$/.test(val)) r.headers.push([val.slice(0, -1).trim(), ""]);
          else if (val[0] === "@") r.warnings.push("Headers from a file (" + val + ") can't be read here");
          else r.warnings.push("Ignored a header without a colon: " + val);
          break;
        case "d": case "data": case "data-ascii":
          if (val[0] === "@") { r.warnings.push("The body comes from the file " + val.slice(1) + "; the code reads it as a placeholder"); r.data.push({ kind: "file", value: val.slice(1) }); }
          else r.data.push({ kind: "raw", value: val });
          break;
        case "data-raw": r.data.push({ kind: "raw", value: val }); break;
        case "data-binary":
          if (val[0] === "@") { r.warnings.push("The body comes from the file " + val.slice(1) + "; the code reads it as a placeholder"); r.data.push({ kind: "file", value: val.slice(1) }); }
          else r.data.push({ kind: "raw", value: val });
          break;
        case "json":
          r.json = true;
          if (val[0] === "@") { r.warnings.push("The JSON body comes from the file " + val.slice(1)); r.data.push({ kind: "file", value: val.slice(1) }); }
          else r.data.push({ kind: "raw", value: val });
          break;
        case "data-urlencode":
          var eq = val.indexOf("="), at = val.indexOf("@");
          if (at >= 0 && (eq < 0 || at < eq)) { r.warnings.push("--data-urlencode reads " + val.slice(at + 1) + " from a file; left as a placeholder"); r.data.push({ kind: "raw", value: (at > 0 ? val.slice(0, at) + "=" : "") + "<urlencoded contents of " + val.slice(at + 1) + ">" }); }
          else if (eq === 0) r.data.push({ kind: "raw", value: curlEscape(val.slice(1)) });
          else if (eq > 0) r.data.push({ kind: "raw", value: val.slice(0, eq) + "=" + curlEscape(val.slice(eq + 1)) });
          else r.data.push({ kind: "raw", value: curlEscape(val) });
          break;
        case "F": case "form": case "form-string":
          var fe = val.indexOf("=");
          if (fe < 1) { r.warnings.push("Ignored a malformed form field: " + val); break; }
          var fname = val.slice(0, fe), fval = val.slice(fe + 1), item = { name: fname };
          var parts = name === "form-string" ? [fval] : fval.split(";");
          var main = parts[0];
          if (name !== "form-string" && main[0] === "@") { item.file = main.slice(1); }
          else if (name !== "form-string" && main[0] === "<") { item.file = main.slice(1); item.asText = true; }
          else item.value = name === "form-string" ? fval : main;
          parts.slice(1).forEach(function (p) {
            var m = /^\s*(type|filename)=(.*)$/.exec(p);
            if (m) item[m[1]] = m[2].replace(/^"|"$/g, "");
            else if (item.value !== undefined) item.value += ";" + p;
          });
          r.form.push(item);
          break;
        case "u": case "user":
          var uc = val.indexOf(":");
          r.user = uc < 0 ? { user: val, pass: "" } : { user: val.slice(0, uc), pass: val.slice(uc + 1) };
          if (uc < 0) r.warnings.push("No password after -u " + val + ": curl would ask for one; an empty password is used");
          break;
        case "b": case "cookie":
          if (val.indexOf("=") >= 0) r.cookie = r.cookie ? r.cookie + "; " + val : val;
          else r.warnings.push("-b " + val + " reads cookies from a file, which can't be done here");
          break;
        case "A": case "user-agent": r.headers.push(["User-Agent", val]); break;
        case "e": case "referer": r.headers.push(["Referer", val.replace(/;auto$/, "")]); break;
        case "oauth2-bearer": r.headers.push(["Authorization", "Bearer " + val]); break;
        case "url": r.urls.push(val); break;
        case "m": case "max-time": r.timeout = parseFloat(val); break;
        case "connect-timeout": r.connectTimeout = parseFloat(val); break;
        case "x": case "proxy": r.proxy = val; break;
        case "T": case "upload-file": r.upload = val; r.warnings.push("-T uploads the file " + val + "; the code reads it as a placeholder"); break;
        case "G": case "get": r.get = true; break;
        case "I": case "head": r.head = true; break;
        case "k": case "insecure": r.insecure = true; break;
        case "L": case "location": case "location-trusted": r.follow = true; break;
        case "compressed": r.compressed = true; break;
        default:
          r.ignored.push((name.length === 1 ? "-" : "--") + name + (val !== undefined ? " " + val : ""));
      }
    }
    for (var i = start; i < w.length; i++) {
      var a = w[i], m;
      if (a === "--") { r.urls = r.urls.concat(w.slice(i + 1)); break; }
      if ((m = /^--([\w.-]+)(?:=([\s\S]*))?$/.exec(a))) {
        var ln = m[1];
        if (/^no-/.test(ln) && !LONG_ARG[ln]) { r.ignored.push(a); continue; }
        if (LONG_ARG[ln]) {
          var v = m[2] !== undefined ? m[2] : w[++i];
          if (v === undefined) throw new Error(a + " needs a value");
          opt(ln, v);
        } else opt(ln, undefined);
        continue;
      }
      if (a[0] === "-" && a.length > 1) {
        for (var k = 1; k < a.length; k++) {
          var ch = a[k];
          if (SHORT_ARG[ch]) {
            var val = a.slice(k + 1);
            if (!val) { val = w[++i]; if (val === undefined) throw new Error("-" + ch + " needs a value"); }
            opt(ch, val); break;
          }
          opt(ch, undefined);
        }
        continue;
      }
      r.urls.push(a);
    }
    r.ignored = r.ignored.filter(function (x) { return !IGNORED_NOTE[x.replace(/^-+/, "").split(" ")[0]]; }).concat([]);
    if (!r.urls.length) throw new Error("No URL found");
    if (r.urls.length > 1) r.warnings.push("Only the first URL is converted (" + r.urls.length + " given)");
    var url = r.urls[0];
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = "http" + "://" + url;
    if (/[{}\[\]]/.test(url) && !/\/\/\[/.test(url)) r.warnings.push("curl would expand [] and {} in the URL (globbing); they are kept as written");
    try { new URL(url); } catch (e) { throw new Error("Not a valid URL: " + url); }
    // Body, as curl builds it
    var body = null;
    if (r.data.length) body = r.data.map(function (d) { return d.kind === "file" ? "<contents of " + d.value + ">" : d.value; }).join(r.json ? "" : "&");
    if (r.get && body !== null) { url += (url.indexOf("?") >= 0 ? "&" : "?") + body; body = null; }
    r.bodyFile = r.data.length === 1 && r.data[0].kind === "file" ? r.data[0].value : null;
    r.url = url; r.body = body;
    r.method = r.method || (r.head ? "HEAD" : (body !== null || r.form.length) ? "POST" : r.upload ? "PUT" : "GET");
    function has(h) { return r.headers.some(function (x) { return x[0].toLowerCase() === h; }); }
    if (r.json) {
      if (!has("content-type")) r.headers.push(["Content-Type", "application/json"]);
      if (!has("accept")) r.headers.push(["Accept", "application/json"]);
    } else if (body !== null && !has("content-type")) r.headers.push(["Content-Type", "application/x-www-form-urlencoded"]);
    if (r.form.length) {
      var before = r.headers.length;
      r.headers = r.headers.filter(function (h) { return !(h[0].toLowerCase() === "content-type" && /multipart\/form-data/i.test(h[1])); });
      if (before !== r.headers.length) r.warnings.push("Dropped the manual multipart Content-Type: each library adds it with the right boundary");
    }
    if (r.cookie) r.headers.push(["Cookie", r.cookie]);
    if (r.body !== null && r.form.length) r.warnings.push("curl can't combine -d and -F; only the form is used"), r.body = null;
    var ct = (r.headers.filter(function (h) { return h[0].toLowerCase() === "content-type"; })[0] || [])[1] || "";
    r.jsonBody = undefined;
    if (r.body !== null && /json/i.test(ct)) { try { r.jsonBody = JSON.parse(r.body); } catch (e) { /* keep as text */ } }
    return r;
  }

  // ================= code generators =================
  var js = function (s) { return JSON.stringify(s); };
  function pyStr(s) { return JSON.stringify(s); }
  function phpStr(s) { return "'" + s.replace(/\\/g, "\\\\").replace(/'/g, "\\'") + "'"; }
  function goStr(s) { return /["\n\\]/.test(s) && s.indexOf("`") < 0 && s.indexOf("\r") < 0 ? "`" + s + "`" : JSON.stringify(s); }
  function indentLines(s, pad) { return s.split("\n").map(function (l, i) { return i ? pad + l : l; }).join("\n"); }
  function pyLit(v, d) {
    d = d || 0; var pad = "    ".repeat(d + 1), end = "    ".repeat(d);
    if (v === null) return "None";
    if (v === true) return "True";
    if (v === false) return "False";
    if (typeof v === "number" || typeof v === "string") return JSON.stringify(v);
    if (Array.isArray(v)) return v.length ? "[\n" + v.map(function (x) { return pad + pyLit(x, d + 1); }).join(",\n") + ",\n" + end + "]" : "[]";
    var ks = Object.keys(v);
    return ks.length ? "{\n" + ks.map(function (k) { return pad + JSON.stringify(k) + ": " + pyLit(v[k], d + 1); }).join(",\n") + ",\n" + end + "}" : "{}";
  }
  function headerList(r, withAuth) {
    var hs = r.headers.slice();
    if (withAuth && r.user) hs.push(["Authorization", "Basic " + utf8Base64(r.user.user + ":" + r.user.pass)]);
    return hs;
  }
  function fname(p) { return p.split(/[\\/]/).pop(); }

  function genFetch(r) {
    var L = [], hs = headerList(r, true), o = [];
    if (r.insecure) L.push("// curl -k: browsers always verify TLS certificates; this can't be turned off from code.");
    if (r.cookie) L.push("// Browsers don't let scripts set the Cookie header; they send their own cookies (credentials: \"include\").");
    if (r.proxy) L.push("// curl used the proxy " + r.proxy + "; fetch has no proxy option.");
    if (r.form.length) {
      L.push("const form = new FormData();");
      r.form.forEach(function (f) {
        if (f.file) L.push("form.append(" + js(f.name) + ", fileInput.files[0]" + (f.filename || !f.asText ? ", " + js(f.filename || fname(f.file)) : "") + "); // " + (f.asText ? "text of " : "") + f.file + (f.type ? " (" + f.type + ")" : ""));
        else L.push("form.append(" + js(f.name) + ", " + js(f.value) + ");");
      });
      L.push("");
    }
    o.push("  method: " + js(r.method) + ",");
    if (hs.length) o.push("  headers: {\n" + hs.map(function (h) { return "    " + js(h[0]) + ": " + js(h[1]) + ","; }).join("\n") + "\n  },");
    if (r.form.length) o.push("  body: form,");
    else if (r.bodyFile) o.push("  body: fileInput.files[0], // " + r.bodyFile);
    else if (r.upload) o.push("  body: fileInput.files[0], // " + r.upload);
    else if (r.jsonBody !== undefined) o.push("  body: JSON.stringify(" + indentLines(JSON.stringify(r.jsonBody, null, 2), "  ") + "),");
    else if (r.body !== null) o.push("  body: " + js(r.body) + ",");
    if (r.timeout) o.push("  signal: AbortSignal.timeout(" + Math.round(r.timeout * 1000) + "),");
    L.push("const response = await fetch(" + js(r.url) + ", {\n" + o.join("\n") + "\n});");
    L.push("const data = await response.text();", "console.log(response.status, data);");
    return L.join("\n");
  }
  function genAxios(r) {
    var L = ['import axios from "axios";'], hs = headerList(r, false), o = [];
    if (r.insecure) L.push('import https from "node:https";');
    if (r.form.length && r.form.some(function (f) { return f.file; })) L.push('import { openAsBlob } from "node:fs";');
    L.push("");
    if (r.form.length) {
      L.push("const form = new FormData();");
      r.form.forEach(function (f) {
        if (f.file) L.push("form.append(" + js(f.name) + ", await openAsBlob(" + js(f.file) + ")" + (f.asText ? "" : ", " + js(f.filename || fname(f.file))) + ");");
        else L.push("form.append(" + js(f.name) + ", " + js(f.value) + ");");
      });
      L.push("");
    }
    o.push("  method: " + js(r.method.toLowerCase()) + ",", "  url: " + js(r.url) + ",");
    if (hs.length) o.push("  headers: {\n" + hs.map(function (h) { return "    " + js(h[0]) + ": " + js(h[1]) + ","; }).join("\n") + "\n  },");
    if (r.user) o.push("  auth: { username: " + js(r.user.user) + ", password: " + js(r.user.pass) + " },");
    if (r.form.length) o.push("  data: form,");
    else if (r.bodyFile || r.upload) o.push("  data: await openAsBlob(" + js(r.bodyFile || r.upload) + "),"), L.splice(1, 0, 'import { openAsBlob } from "node:fs";');
    else if (r.jsonBody !== undefined) o.push("  data: " + indentLines(JSON.stringify(r.jsonBody, null, 2), "  ") + ",");
    else if (r.body !== null) o.push("  data: " + js(r.body) + ",");
    if (r.timeout) o.push("  timeout: " + Math.round(r.timeout * 1000) + ",");
    if (r.insecure) o.push("  httpsAgent: new https.Agent({ rejectUnauthorized: false }),");
    if (r.proxy) o.push("  // proxy: curl used " + r.proxy + " (see axios' proxy option)");
    o.push("  responseType: \"text\",");
    L.push("const response = await axios({\n" + o.join("\n") + "\n});");
    L.push("console.log(response.status, response.data);");
    return L.join("\n");
  }
  function genPython(r) {
    var L = ["import requests", ""], hs = headerList(r, false), args = ["url"];
    L.push("url = " + pyStr(r.url));
    if (hs.length) { L.push("headers = {\n" + hs.map(function (h) { return "    " + pyStr(h[0]) + ": " + pyStr(h[1]) + ","; }).join("\n") + "\n}"); args.push("headers=headers"); }
    if (r.form.length) {
      L.push("files = {\n" + r.form.map(function (f) {
        return "    " + pyStr(f.name) + ": " + (f.file ? (f.asText ? "(None, open(" + pyStr(f.file) + ").read())" : "(" + pyStr(f.filename || fname(f.file)) + ", open(" + pyStr(f.file) + ", \"rb\")" + (f.type ? ", " + pyStr(f.type) : "") + ")") : "(None, " + pyStr(f.value) + ")") + ",";
      }).join("\n") + "\n}");
      args.push("files=files");
    } else if (r.bodyFile || r.upload) { L.push("data = open(" + pyStr(r.bodyFile || r.upload) + ", \"rb\")"); args.push("data=data"); }
    else if (r.jsonBody !== undefined) { L.push("json_data = " + pyLit(r.jsonBody)); args.push("json=json_data"); }
    else if (r.body !== null) { L.push("data = " + pyStr(r.body)); args.push("data=data"); }
    if (r.user) args.push("auth=(" + pyStr(r.user.user) + ", " + pyStr(r.user.pass) + ")");
    if (r.insecure) args.push("verify=False");
    if (r.timeout || r.connectTimeout) args.push("timeout=" + (r.connectTimeout && r.timeout ? "(" + r.connectTimeout + ", " + r.timeout + ")" : (r.timeout || r.connectTimeout)));
    if (r.proxy) args.push("proxies={\"http\": " + pyStr(r.proxy) + ", \"https\": " + pyStr(r.proxy) + "}");
    if (r.method === "HEAD" && r.follow) args.push("allow_redirects=True");
    var m = r.method.toLowerCase(), call = /^(get|post|put|patch|delete|head|options)$/.test(m) ? "requests." + m + "(" : "requests.request(" + pyStr(r.method) + ", ";
    L.push("", "response = " + call + (args.length > 2 ? "\n    " + args.join(",\n    ") + ",\n)" : args.join(", ") + ")"));
    L.push("print(response.status_code)", "print(response.text)");
    return L.join("\n");
  }
  function genPhp(r) {
    var L = ["<?php", "", "$ch = curl_init();", "curl_setopt($ch, CURLOPT_URL, " + phpStr(r.url) + ");", "curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);"];
    var hs = headerList(r, false).filter(function (h) { return h[0].toLowerCase() !== "cookie"; });
    if (r.method === "HEAD") L.push("curl_setopt($ch, CURLOPT_NOBODY, true);");
    else if (r.method !== "GET" && !(r.method === "POST" && (r.body !== null || r.form.length))) L.push("curl_setopt($ch, CURLOPT_CUSTOMREQUEST, " + phpStr(r.method) + ");");
    if (hs.length) L.push("curl_setopt($ch, CURLOPT_HTTPHEADER, [\n" + hs.map(function (h) { return "    " + phpStr(h[0] + ": " + h[1]) + ","; }).join("\n") + "\n]);");
    if (r.cookie) L.push("curl_setopt($ch, CURLOPT_COOKIE, " + phpStr(r.cookie) + ");");
    if (r.form.length) {
      L.push("curl_setopt($ch, CURLOPT_POSTFIELDS, [\n" + r.form.map(function (f) {
        return "    " + phpStr(f.name) + " => " + (f.file ? (f.asText ? "file_get_contents(" + phpStr(f.file) + ")" : "new CURLFile(" + phpStr(f.file) + (f.type || f.filename ? ", " + phpStr(f.type || "") + ", " + phpStr(f.filename || fname(f.file)) : "") + ")") : phpStr(f.value)) + ",";
      }).join("\n") + "\n]);");
    } else if (r.bodyFile || r.upload) L.push("curl_setopt($ch, CURLOPT_POSTFIELDS, file_get_contents(" + phpStr(r.bodyFile || r.upload) + "));");
    else if (r.body !== null) L.push("curl_setopt($ch, CURLOPT_POSTFIELDS, " + phpStr(r.body) + ");");
    if (r.user) L.push("curl_setopt($ch, CURLOPT_USERPWD, " + phpStr(r.user.user + ":" + r.user.pass) + ");");
    if (r.follow) L.push("curl_setopt($ch, CURLOPT_FOLLOWLOCATION, true);");
    if (r.compressed) L.push("curl_setopt($ch, CURLOPT_ENCODING, '');");
    if (r.insecure) L.push("curl_setopt($ch, CURLOPT_SSL_VERIFYPEER, false);", "curl_setopt($ch, CURLOPT_SSL_VERIFYHOST, 0);");
    if (r.timeout) L.push("curl_setopt($ch, CURLOPT_TIMEOUT, " + r.timeout + ");");
    if (r.connectTimeout) L.push("curl_setopt($ch, CURLOPT_CONNECTTIMEOUT, " + r.connectTimeout + ");");
    if (r.proxy) L.push("curl_setopt($ch, CURLOPT_PROXY, " + phpStr(r.proxy) + ");");
    L.push("", "$response = curl_exec($ch);", "if ($response === false) {", "    echo 'Error: ' . curl_error($ch);", "}", "curl_close($ch);", "", "echo $response;");
    return L.join("\n");
  }
  function genGo(r) {
    var imp = { fmt: 1, io: 1, log: 1, "net/http": 1 }, B = [], hs = headerList(r, false);
    var bodyVar = "nil";
    if (r.form.length) {
      imp.bytes = 1; imp["mime/multipart"] = 1;
      B.push("\tvar buf bytes.Buffer", "\tw := multipart.NewWriter(&buf)");
      r.form.forEach(function (f) {
        if (f.file) {
          imp.os = 1;
          B.push("\tf, err := os.Open(" + goStr(f.file) + ")", "\tif err != nil {", "\t\tlog.Fatal(err)", "\t}",
            "\tpart, err := w.CreateFormFile(" + goStr(f.name) + ", " + goStr(f.filename || fname(f.file)) + ")", "\tif err != nil {", "\t\tlog.Fatal(err)", "\t}",
            "\tif _, err := io.Copy(part, f); err != nil {", "\t\tlog.Fatal(err)", "\t}", "\tf.Close()");
        } else B.push("\tw.WriteField(" + goStr(f.name) + ", " + goStr(f.value) + ")");
      });
      B.push("\tw.Close()", "");
      bodyVar = "&buf";
    } else if (r.bodyFile || r.upload) {
      imp.os = 1;
      B.push("\tbody, err := os.Open(" + goStr(r.bodyFile || r.upload) + ")", "\tif err != nil {", "\t\tlog.Fatal(err)", "\t}", "\tdefer body.Close()", "");
      bodyVar = "body";
    } else if (r.body !== null) {
      imp.strings = 1;
      B.push("\tbody := strings.NewReader(" + goStr(r.body) + ")", "");
      bodyVar = "body";
    }
    B.push("\treq, err := http.NewRequest(" + goStr(r.method) + ", " + goStr(r.url) + ", " + bodyVar + ")", "\tif err != nil {", "\t\tlog.Fatal(err)", "\t}");
    var seen = {};
    hs.forEach(function (h) { var k = h[0].toLowerCase(); B.push("\treq.Header." + (seen[k] ? "Add" : "Set") + "(" + goStr(h[0]) + ", " + goStr(h[1]) + ")"); seen[k] = 1; });
    if (r.form.length) B.push("\treq.Header.Set(\"Content-Type\", w.FormDataContentType())");
    if (r.user) B.push("\treq.SetBasicAuth(" + goStr(r.user.user) + ", " + goStr(r.user.pass) + ")");
    var client = [];
    if (r.insecure || r.proxy) {
      var tr = [];
      if (r.insecure) { imp["crypto/tls"] = 1; tr.push("\t\t\tTLSClientConfig: &tls.Config{InsecureSkipVerify: true},"); }
      if (r.proxy) { imp["net/url"] = 1; B.push("\tproxyURL, _ := url.Parse(" + goStr(/:\/\//.test(r.proxy) ? r.proxy : "http" + "://" + r.proxy) + ")"); tr.push("\t\t\tProxy: http.ProxyURL(proxyURL),"); }
      client.push("\t\tTransport: &http.Transport{\n" + tr.join("\n") + "\n\t\t},");
    }
    if (r.timeout) { imp.time = 1; client.push("\t\tTimeout: " + (r.timeout === Math.round(r.timeout) ? r.timeout + " * time.Second" : Math.round(r.timeout * 1000) + " * time.Millisecond") + ","); }
    if (!r.follow) client.push("\t\t// curl doesn't follow redirects without -L; Go does by default.");
    B.push("", "\tclient := &http.Client{" + (client.length ? "\n" + client.join("\n") + "\n\t" : "") + "}",
      "\tresp, err := client.Do(req)", "\tif err != nil {", "\t\tlog.Fatal(err)", "\t}", "\tdefer resp.Body.Close()", "",
      "\tdata, err := io.ReadAll(resp.Body)", "\tif err != nil {", "\t\tlog.Fatal(err)", "\t}", "\tfmt.Println(resp.Status)", "\tfmt.Printf(\"%s\\n\", data)");
    var imports = Object.keys(imp).sort();
    return "package main\n\nimport (\n" + imports.map(function (x) { return "\t\"" + x + "\""; }).join("\n") + "\n)\n\nfunc main() {\n" + B.join("\n") + "\n}";
  }
  function genNode(r) {
    if (r.form.length) {
      var F = ['import { openAsBlob } from "node:fs";', "", "// Node 18+: multipart is easiest with the built-in fetch and FormData.", "const form = new FormData();"];
      r.form.forEach(function (f) {
        if (f.file) F.push("form.append(" + js(f.name) + ", await openAsBlob(" + js(f.file) + ")" + (f.asText ? "" : ", " + js(f.filename || fname(f.file))) + ");");
        else F.push("form.append(" + js(f.name) + ", " + js(f.value) + ");");
      });
      var hs0 = headerList(r, true);
      F.push("", "const response = await fetch(" + js(r.url) + ", {", "  method: " + js(r.method) + ",");
      if (hs0.length) F.push("  headers: {\n" + hs0.map(function (h) { return "    " + js(h[0]) + ": " + js(h[1]) + ","; }).join("\n") + "\n  },");
      F.push("  body: form,", "});", "console.log(response.status, await response.text());");
      return F.join("\n");
    }
    var mod = /^https:/i.test(r.url) ? "https" : "http", L = ['const ' + mod + ' = require("node:' + mod + '");', ""], hs = headerList(r, true), o = [];
    var hasBody = r.body !== null || r.bodyFile || r.upload;
    if (r.bodyFile || r.upload) L.splice(1, 0, 'const fs = require("node:fs");'), L.push("const body = fs.readFileSync(" + js(r.bodyFile || r.upload) + ");");
    else if (r.jsonBody !== undefined) L.push("const body = JSON.stringify(" + JSON.stringify(r.jsonBody, null, 2) + ");");
    else if (r.body !== null) L.push("const body = " + js(r.body) + ";");
    if (hasBody) L.push("");
    o.push("  method: " + js(r.method) + ",");
    var hl = hs.map(function (h) { return "    " + js(h[0]) + ": " + js(h[1]) + ","; });
    if (hasBody) hl.push('    "Content-Length": Buffer.byteLength(body),');
    if (hl.length) o.push("  headers: {\n" + hl.join("\n") + "\n  },");
    if (r.insecure) o.push("  rejectUnauthorized: false,");
    if (r.timeout) o.push("  timeout: " + Math.round(r.timeout * 1000) + ",");
    L.push("const req = " + mod + ".request(" + js(r.url) + ", {\n" + o.join("\n") + "\n}, (res) => {",
      "  let data = \"\";", "  res.setEncoding(\"utf8\");", "  res.on(\"data\", (chunk) => (data += chunk));", "  res.on(\"end\", () => console.log(res.statusCode, data));", "});");
    if (r.timeout) L.push("req.on(\"timeout\", () => req.destroy(new Error(\"timeout\")));");
    L.push("req.on(\"error\", console.error);");
    if (hasBody) L.push("req.write(body);");
    L.push("req.end();");
    if (r.follow) L.push("// curl -L follows redirects; node:" + mod + " does not, check res.headers.location.");
    if (r.compressed) L.push("// --compressed: if the server compresses the reply, decode it with node:zlib.");
    return L.join("\n");
  }
  var GEN = { fetch: genFetch, axios: genAxios, python: genPython, php: genPhp, go: genGo, node: genNode };
  var EXT = { fetch: [".js", "request.js"], axios: [".js", "request.mjs"], python: [".py", "request.py"], php: [".php", "request.php"], go: [".go", "main.go"], node: [".js", "request.js"] };

  // ================= UI =================
  var input = $("#input"), codeEl = $("#code"), status = $("#status");
  var state = { lang: S3.store("cc.lang") || "fetch", parsed: null, code: "" };
  var SECRET_H = /^(authorization|proxy-authorization|cookie|x-api-key|api-key|apikey|x-auth-token|x-access-token|x-csrf-token|x-xsrf-token)$/i;
  function mask(v) { var m = /^(Basic|Bearer|Token|Digest)\s+/i.exec(v); return (m ? m[0] : "") + "••••••••"; }

  function row(k, v, cls) { var tr = S3.h("tr"); tr.appendChild(S3.h("th", { text: k })); tr.appendChild(S3.h("td", { "class": "mono " + (cls || ""), text: v })); return tr; }
  function renderParts() {
    var box = $("#parts"), notes = $("#notes"), r = state.parsed, rev = $("#reveal").checked;
    box.innerHTML = ""; notes.innerHTML = "";
    if (!r) { box.appendChild(S3.h("div", { "class": "empty" }, [S3.h("b", { text: "Nothing parsed yet" }), "Paste a curl command above."])); return; }
    var tb = S3.h("tbody");
    tb.appendChild(row("Method", r.method, "cc-strong"));
    tb.appendChild(row("URL", r.url));
    try {
      new URL(r.url).searchParams.forEach(function (v, k) { tb.appendChild(row("Query", k + " = " + v)); });
    } catch (e) { /* already validated */ }
    r.headers.forEach(function (h) { tb.appendChild(row("Header", h[0] + ": " + (SECRET_H.test(h[0]) && !rev ? mask(h[1]) : h[1]), SECRET_H.test(h[0]) ? "cc-secret" : "")); });
    if (r.user) tb.appendChild(row("Basic auth", r.user.user + " : " + (rev ? r.user.pass : "••••••••"), "cc-secret"));
    if (r.body !== null) tb.appendChild(row("Body", r.body.length > 2000 ? r.body.slice(0, 2000) + "…" : r.body));
    r.form.forEach(function (f) { tb.appendChild(row("Form field", f.name + " = " + (f.file ? (f.asText ? "<" : "@") + f.file : f.value) + (f.type ? " ; type=" + f.type : ""))); });
    var flags = [];
    if (r.follow) flags.push("follow redirects (-L)");
    if (r.insecure) flags.push("skip TLS verification (-k)");
    if (r.compressed) flags.push("--compressed");
    if (r.timeout) flags.push("max time " + r.timeout + " s");
    if (r.connectTimeout) flags.push("connect timeout " + r.connectTimeout + " s");
    if (r.proxy) flags.push("proxy " + r.proxy);
    if (flags.length) tb.appendChild(row("Options", flags.join(" · ")));
    if (r.ignored.length) tb.appendChild(row("Not converted", r.ignored.join("  "), "cc-faint"));
    var t = S3.h("table", { "class": "tbl" }); t.appendChild(tb); box.appendChild(t);
    r.warnings.forEach(function (w) { notes.appendChild(S3.h("span", { "class": "chip warn", text: w })); });
  }
  function renderCode() {
    $$("#lang button").forEach(function (b) { b.setAttribute("aria-pressed", String(b.dataset.v === state.lang)); });
    $("#ext").textContent = EXT[state.lang][0];
    state.code = state.parsed ? GEN[state.lang](state.parsed) : "";
    codeEl.textContent = state.code;
  }
  function render() {
    var text = input.value;
    state.parsed = null;
    if (!text.trim()) { status.className = "chip"; status.textContent = "Waiting for a curl command"; }
    else {
      try {
        state.parsed = parseCurl(text);
        status.className = "chip ok"; status.textContent = state.parsed.method + " " + new URL(state.parsed.url).host;
      } catch (e) { status.className = "chip bad"; status.textContent = e.message; }
    }
    renderCode(); renderParts();
  }

  var SAMPLE = "curl 'https://s3eidat.github.io/api/v1/orders?status=open&limit=20' \\\n" +
    "  -X POST \\\n" +
    "  -H 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.demo-token.signature' \\\n" +
    "  -H \"Content-Type: application/json\" \\\n" +
    "  -H 'X-Note: it'\\''s \"quoted\"' \\\n" +
    "  -b 'session=abc123; theme=dark' \\\n" +
    "  --data-raw '{\"customer\":\"Omar\",\"items\":[{\"sku\":\"A-1\",\"qty\":2}],\"gift\":true}' \\\n" +
    "  --compressed -L --max-time 30";

  $$("#lang button").forEach(function (b) { b.addEventListener("click", function () { state.lang = b.dataset.v; S3.store("cc.lang", state.lang); renderCode(); }); });
  input.addEventListener("input", S3.debounce(function () { render(); }, 200));
  $("#reveal").addEventListener("change", renderParts);
  $("#sample").addEventListener("click", function () { input.value = SAMPLE; render(); });
  $("#clear").addEventListener("click", function () { input.value = ""; render(); input.focus(); });
  $("#copy").addEventListener("click", function () { if (state.code) { S3.copy(state.code); S3.done(); } else S3.toast("Nothing to copy yet", "error"); });
  $("#save").addEventListener("click", function () { if (state.code) { S3.download(state.code, EXT[state.lang][1], "text/plain"); S3.done(); } });

  window.S3_DEMO = function () { $("#sample").click(); $("#lang button[data-v=python]").click(); };

  // ================= self-test =================
  window.S3_SELFTEST = function () {
    var fails = [];
    function eq(name, a, b) { a = JSON.stringify(a); b = JSON.stringify(b); if (a !== b) fails.push(name + ": got " + a + " want " + b); }
    function hdr(r, n) { var h = r.headers.filter(function (x) { return x[0].toLowerCase() === n.toLowerCase(); })[0]; return h && h[1]; }
    var a = parseCurl("curl 'https://s3eidat.github.io/api?a=1&b=2' -H 'Authorization: Bearer abc' -H \"X-Quote: it's \\\"q\\\"\" --data-raw '{\"name\":\"O'\\''Brien\"}'");
    eq("method from data", a.method, "POST"); eq("url", a.url, "https://s3eidat.github.io/api?a=1&b=2");
    eq("double quotes", hdr(a, "X-Quote"), "it's \"q\""); eq("'\\'' quoting", a.body, "{\"name\":\"O'Brien\"}");
    eq("default content type", hdr(a, "Content-Type"), "application/x-www-form-urlencoded");
    var b = parseCurl("curl -X PUT \\\n  https://s3eidat.github.io/x \\\n  -d a=1 -d 'b=2 3'");
    eq("continuation + PUT", [b.method, b.url, b.body], ["PUT", "https://s3eidat.github.io/x", "a=1&b=2 3"]);
    eq("$'' ansi", parseCurl("curl s3eidat.github.io --data-binary $'line1\\nline2\\x41 \\'q\\' \\u00e9 \\xc3\\xa9'").body, "line1\nline2A 'q' " + String.fromCharCode(233) + " " + String.fromCharCode(233));
    eq("scheme added", parseCurl("curl s3eidat.github.io/p").url, "http" + "://s3eidat.github.io/p");
    eq("basic auth", parseCurl("curl -u 'user:pa:ss' https://s3eidat.github.io").user, { user: "user", pass: "pa:ss" });
    eq("basic header", headerList(parseCurl("curl -u user:pass https://s3eidat.github.io"), true)[0][1], "Basic dXNlcjpwYXNz");
    var j = parseCurl("curl --json '{\"a\":1}' https://s3eidat.github.io");
    eq("--json", [j.method, hdr(j, "content-type"), hdr(j, "accept"), j.jsonBody], ["POST", "application/json", "application/json", { a: 1 }]);
    var f = parseCurl("curl -sSLk -XPOST -H'X-A: 1' --max-time=5 https://s3eidat.github.io");
    eq("combined flags", [f.follow, f.insecure, f.method, hdr(f, "X-A"), f.timeout], [true, true, "POST", "1", 5]);
    eq("data-urlencode", parseCurl("curl --data-urlencode 'q=hello world&x' --data-urlencode '=a/b' https://s3eidat.github.io").body, "q=hello%20world%26x&a%2Fb");
    var g = parseCurl("curl -G -d q=1 -d page=2 https://s3eidat.github.io/s?x=0");
    eq("-G", [g.method, g.url, g.body], ["GET", "https://s3eidat.github.io/s?x=0&q=1&page=2", null]);
    var fm = parseCurl("curl -F 'file=@photo.jpg;type=image/jpeg' -F name=Omar https://s3eidat.github.io/up");
    eq("form", [fm.method, fm.form[0].file, fm.form[0].type, fm.form[1].value], ["POST", "photo.jpg", "image/jpeg", "Omar"]);
    eq("cookie", hdr(parseCurl("curl -b 'a=1; b=2' https://s3eidat.github.io"), "Cookie"), "a=1; b=2");
    eq("head", parseCurl("curl -I https://s3eidat.github.io").method, "HEAD");
    eq("pipe ignored", parseCurl("curl https://s3eidat.github.io | jq .").warnings.length, 1);
    var err = null; try { parseCurl("curl 'https://s3eidat.github.io"); } catch (e) { err = e.message; }
    eq("unclosed quote", err, "Unclosed single quote");
    err = null; try { parseCurl("wget https://s3eidat.github.io"); } catch (e) { err = e.message; }
    eq("not curl", !!err, true);
    var p = parseCurl(SAMPLE);
    eq("sample json body", p.jsonBody.items[0].qty, 2);
    eq("python json", genPython(p).indexOf('"gift": True') >= 0, true);
    eq("php escaping", phpStr("it's a \\ test"), "'it\\'s a \\\\ test'");
    eq("go raw string", goStr("a\"b"), "`a\"b`"); eq("go backtick", goStr("a`b"), "\"a`b\"");
    eq("fetch has body", genFetch(p).indexOf("body: JSON.stringify(") >= 0, true);
    eq("go compiles imports", /"strings"/.test(genGo(p)) && /"net\/http"/.test(genGo(p)), true);
    Object.keys(GEN).forEach(function (k) {
      [SAMPLE, "curl https://s3eidat.github.io", "curl -F a=@x.png -F b=c -u u:p -k https://s3eidat.github.io/up", "curl -T f.bin -x proxy:3128 --connect-timeout 3 -m 9 s3eidat.github.io"].forEach(function (c, i) {
        try { var out = GEN[k](parseCurl(c)); if (!out || out.indexOf("s3eidat.github.io") < 0) fails.push("gen " + k + " " + i + " missing url"); }
        catch (e) { fails.push("gen " + k + " " + i + " threw " + e.message); }
      });
    });
    return fails.length ? fails : true;
  };

  // The command is deliberately not saved: curl commands often contain tokens and cookies.
  render();
})();
