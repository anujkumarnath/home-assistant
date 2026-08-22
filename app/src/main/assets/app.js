(function () {
  "use strict";

  // ---------------------------------------------------------------------
  // Bridge (Kotlin HttpURLConnection calls, so no browser CORS involved)
  // ---------------------------------------------------------------------
  var bridgeSeq = 0;
  var bridgePending = {};

  window.onBridgeResult = function (reqId, json) {
    var resolve = bridgePending[reqId];
    if (!resolve) return;
    delete bridgePending[reqId];
    var data;
    try { data = JSON.parse(json); } catch (e) { data = { _ok: false, _error: "bad json" }; }
    resolve(data);
  };

  function bridgeCall(fn) {
    return new Promise(function (resolve) {
      var reqId = "r" + (++bridgeSeq);
      bridgePending[reqId] = resolve;
      fn(reqId);
    });
  }

  function fetchStates(entityIds) {
    return bridgeCall(function (reqId) {
      window.AndroidBridge.fetchStates(reqId, JSON.stringify(entityIds));
    });
  }

  function callService(domain, service, entityId, extra) {
    return bridgeCall(function (reqId) {
      window.AndroidBridge.callService(reqId, domain, service, entityId || "", JSON.stringify(extra || {}));
    });
  }

  function getSettings() {
    return JSON.parse(window.AndroidBridge.getSettings());
  }
  function saveSettings(obj) {
    window.AndroidBridge.saveSettings(JSON.stringify(obj));
  }
  function fetchHaConfig() {
    return bridgeCall(function (reqId) { window.AndroidBridge.fetchHaConfig(reqId); });
  }
  function fetchOverpassMap(lat, lon, radiusMeters) {
    return bridgeCall(function (reqId) { window.AndroidBridge.fetchOverpassMap(reqId, lat, lon, radiusMeters); });
  }

  // ---------------------------------------------------------------------
  // Formatting helpers
  // ---------------------------------------------------------------------
  function formatMMSS(totalSeconds) {
    var s = Math.max(0, Math.round(totalSeconds));
    var m = Math.floor(s / 60);
    var sec = s % 60;
    return m + ":" + String(sec).padStart(2, "0");
  }
  function formatPower(watts) {
    if (watts >= 1000) return (watts / 1000).toFixed(2) + " kW";
    return Math.round(watts) + " W";
  }
  function formatCurrent(amps) { return amps.toFixed(1) + " A"; }
  function formatEnergy(kwh) { return kwh.toFixed(1) + " kWh"; }
  function fahrenheitToCelsius(f) { return (f - 32) * 5 / 9; }
  function mphToKmh(mph) { return mph * 1.609344; }

  var RING_CIRCUMFERENCE = 2 * Math.PI * 42; // matches r=42 in the 100x100 ring viewBoxes

  function setRingFraction(el, fraction) {
    if (!el) return;
    var f = Math.max(0, Math.min(1, fraction));
    el.style.strokeDashoffset = RING_CIRCUMFERENCE * (1 - f);
  }

  // ---------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------
  var config = null;
  var haStates = {};
  var pollTimer = null;
  var connOk = true;
  var lastSystemInfo = null;

  var el = {};
  function q(id) { return document.getElementById(id); }

  function cacheEls() {
    el.settingsOverlay = q("settings-overlay");
    el.settingsGear = q("settings-gear");
    el.hudOnlineTag = q("hud-online-tag");
    el.ssTime = q("ss-time");
    el.ssAmpm = q("ss-ampm");
    el.ssDate = q("ss-date");

    el.netIp = q("net-ip");
    el.netSsid = q("net-ssid");
    el.netRssi = q("net-rssi");
    el.netSpeed = q("net-speed");
    el.netDot = q("net-dot");
    el.netRingFill = q("net-ring-fill");
    el.netSignalPct = q("net-signal-pct");
    el.hudSync = q("hud-sync");

    el.sysThermal = q("sys-thermal");
    el.sysMem = q("sys-mem");
    el.sysMemPct = q("sys-mem-pct");
    el.sysRingFill = q("sys-ring-fill");
    el.sysUptime = q("sys-uptime");

    el.wxCondition = q("wx-condition");
    el.wxTemp = q("wx-temp");
    el.wxHumidity = q("wx-humidity");
    el.wxWind = q("wx-wind");
    el.envRingFill = q("env-ring-fill");
    el.envParticles = q("env-particles");

    el.plug1Unit = q("climate-plug1");
    el.plug2Unit = q("climate-plug2");
    el.ac1Dot = q("ac1-dot"); el.ac2Dot = q("ac2-dot");
    el.ac1Ring = q("ac1-ring"); el.ac2Ring = q("ac2-ring");
    el.ac1Name = q("ac1-name"); el.ac2Name = q("ac2-name");
    el.ac1State = q("ac1-state"); el.ac2State = q("ac2-state");
    el.ac1Power = q("ac1-power"); el.ac2Power = q("ac2-power");
    el.ac1PowerMo = q("ac1-power-mo"); el.ac2PowerMo = q("ac2-power-mo");
    el.ac1Participate = q("ac1-participate"); el.ac2Participate = q("ac2-participate");
    el.ac1Unused = q("ac1-unused"); el.ac2Unused = q("ac2-unused");
    el.hvacBranch1 = q("hvac-branch-1"); el.hvacBranch2 = q("hvac-branch-2");

    el.awayRow = q("climate-away"); el.awayValue = q("away-value");
    el.autoCycleRow = q("climate-autocycle"); el.autoCycleValue = q("autocycle-value");
    el.runtimeMinus = q("runtime-minus"); el.runtimePlus = q("runtime-plus"); el.runtimeValue = q("runtime-value");

    el.inputBaseUrl = q("input-baseurl"); el.inputToken = q("input-token");
    el.settingsSave = q("settings-save"); el.settingsCancel = q("settings-cancel");

    el.eventStream = q("event-stream");
    el.bootSequence = q("boot-sequence");
  }

  function entityIdList() {
    var e = config.entities;
    var ids = [];
    for (var key in e) {
      if (key === "plug1Name" || key === "plug2Name") continue;
      if (e[key]) ids.push(e[key]);
    }
    return ids.filter(function (v, i, a) { return a.indexOf(v) === i; });
  }

  function st(entityId) {
    var s = haStates[entityId];
    if (!s || s.error) return null;
    return s;
  }
  function isOffline(entityId) {
    var s = haStates[entityId];
    return !s || s.error || s.state === "unavailable";
  }

  function remainingSecondsFor(timerEntityId) {
    var timerEnt = timerEntityId ? st(timerEntityId) : null;
    if (timerEnt && timerEnt.state === "active" && timerEnt.attributes && timerEnt.attributes.finishes_at) {
      var finishesAtMs = new Date(timerEnt.attributes.finishes_at).getTime();
      return Math.max(0, (finishesAtMs - Date.now()) / 1000);
    }
    return null;
  }

  // ---------------------------------------------------------------------
  // Central HUD radial ticks (generated once at init)
  // ---------------------------------------------------------------------
  function buildCoreTicks() {
    var g = q("core-ticks");
    if (!g) return;
    var ns = "http://www.w3.org/2000/svg";
    for (var i = 0; i < 24; i++) {
      var angle = i * 15;
      if (angle % 90 === 0) continue; // cardinal points already have text labels
      var long = angle % 45 === 0;
      var line = document.createElementNS(ns, "line");
      line.setAttribute("x1", "300");
      line.setAttribute("y1", long ? "20" : "26");
      line.setAttribute("x2", "300");
      line.setAttribute("y2", "40");
      line.setAttribute("transform", "rotate(" + angle + " 300 300)");
      g.appendChild(line);
    }
  }

  function buildCoreNodes() {
    var g = q("core-nodes");
    if (!g) return;
    var ns = "http://www.w3.org/2000/svg";
    var angles = [35, 140, 220, 300]; // NETWORK, ENVIRONMENT, HVAC, SYSTEM — roughly toward their screen quadrants
    angles.forEach(function (angle, i) {
      var rad = (angle - 90) * Math.PI / 180;
      var r = 240;
      var cx = 300 + r * Math.cos(rad);
      var cy = 300 + r * Math.sin(rad);
      var c = document.createElementNS(ns, "circle");
      c.setAttribute("cx", cx.toFixed(1));
      c.setAttribute("cy", cy.toFixed(1));
      c.setAttribute("r", "3");
      c.setAttribute("class", "core-node-blip");
      c.style.animationDelay = (i * 0.7) + "s";
      g.appendChild(c);
    });
  }

  // ---------------------------------------------------------------------
  // Live map background — real road/waterway geometry from OpenStreetMap,
  // centered on Home Assistant's configured home location. Fetched once
  // (via the Overpass API) and cached in localStorage, so it never repeats
  // the network round-trip on later launches.
  // ---------------------------------------------------------------------
  var MAP_CACHE_KEY = "liveMapDataV1";
  var MAP_RADIUS_M = 800;

  function projectOverpassData(json, centerLat, centerLon) {
    var metersPerDegLat = 111320;
    var metersPerDegLon = 111320 * Math.cos(centerLat * Math.PI / 180);
    var roadPaths = [];
    var waterPaths = [];
    var elements = (json && json.elements) || [];
    elements.forEach(function (elItem) {
      if (elItem.type !== "way" || !elItem.geometry || elItem.geometry.length < 2) return;
      var d = elItem.geometry.map(function (pt, i) {
        var x = ((pt.lon - centerLon) * metersPerDegLon).toFixed(1);
        var y = (-(pt.lat - centerLat) * metersPerDegLat).toFixed(1);
        return (i === 0 ? "M" : "L") + x + "," + y;
      }).join(" ");
      if (elItem.tags && elItem.tags.waterway) {
        waterPaths.push(d);
      } else {
        roadPaths.push(d);
      }
    });
    return { roadPaths: roadPaths, waterPaths: waterPaths };
  }

  function renderLiveMap(data) {
    var roadsG = q("live-map-roads");
    var waterG = q("live-map-water");
    if (!roadsG || !waterG || !data) return;
    var ns = "http://www.w3.org/2000/svg";
    (data.roadPaths || []).forEach(function (d) {
      var p = document.createElementNS(ns, "path");
      p.setAttribute("d", d);
      p.setAttribute("class", "live-map-road");
      roadsG.appendChild(p);
    });
    (data.waterPaths || []).forEach(function (d) {
      var p = document.createElementNS(ns, "path");
      p.setAttribute("d", d);
      p.setAttribute("class", "live-map-water");
      waterG.appendChild(p);
    });
  }

  function initLiveMap() {
    var cached;
    try { cached = JSON.parse(localStorage.getItem(MAP_CACHE_KEY)); } catch (e) { cached = null; }
    if (cached) {
      renderLiveMap(cached);
      return;
    }
    fetchHaConfig().then(function (cfg) {
      if (!cfg || !cfg._ok || !cfg.latitude || !cfg.longitude) return;
      return fetchOverpassMap(cfg.latitude, cfg.longitude, MAP_RADIUS_M).then(function (res) {
        if (!res || !res._ok) return;
        var data = projectOverpassData(res.data, cfg.latitude, cfg.longitude);
        try { localStorage.setItem(MAP_CACHE_KEY, JSON.stringify(data)); } catch (e) { /* storage full/unavailable, just skip caching */ }
        renderLiveMap(data);
      });
    }).catch(function () { /* no map this session; retried on next launch */ });
  }

  // ---------------------------------------------------------------------
  // Event stream — logs real state transitions only, no filler noise
  // ---------------------------------------------------------------------
  var eventLog = [];
  var MAX_EVENTS = 4;
  function logEvent(tag, text) {
    var now = new Date();
    var hh = String(now.getHours()).padStart(2, "0");
    var mm = String(now.getMinutes()).padStart(2, "0");
    var ss = String(now.getSeconds()).padStart(2, "0");
    eventLog.push({ time: hh + ":" + mm + ":" + ss, tag: tag, text: text });
    if (eventLog.length > MAX_EVENTS) eventLog.shift();
    renderEventStream();
  }
  function renderEventStream() {
    if (!el.eventStream) return;
    el.eventStream.innerHTML = eventLog.map(function (e) {
      return "<div class=\"event-line on\">" + e.time + "<span class=\"event-tag\">" + e.tag + "</span>" + e.text + "</div>";
    }).join("");
  }

  var prevState = { online: null, deviceOnline: null, plug1On: null, plug2On: null, away: null, autoCycle: null, condition: null };

  // ---------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------
  function updateHvacNode(unitEl, dotEl, ringEl, nameEl, stateEl, powerEl, powerMoEl, name, isOn, isOffline_, remaining, powerEntityId, currentEntityId, monthlyEntityId) {
    nameEl.textContent = (name || "PLUG").toUpperCase();
    unitEl.classList.toggle("active", isOn);
    dotEl.classList.toggle("idle", !isOn && !isOffline_);

    if (isOffline_) {
      stateEl.textContent = "OFFLINE";
    } else if (isOn) {
      stateEl.textContent = "RUNNING" + (remaining != null ? " · " + formatMMSS(remaining) : "");
    } else {
      stateEl.textContent = "IDLE";
    }

    var powerEnt = powerEntityId ? st(powerEntityId) : null;
    var currentEnt = currentEntityId ? st(currentEntityId) : null;
    var monthlyEnt = monthlyEntityId ? st(monthlyEntityId) : null;
    var parts = [];
    if (powerEnt && !isNaN(Number(powerEnt.state))) parts.push(formatPower(Number(powerEnt.state)));
    if (currentEnt && !isNaN(Number(currentEnt.state))) parts.push(formatCurrent(Number(currentEnt.state)));
    powerEl.textContent = parts.length ? parts.join(" · ") : "--";
    powerMoEl.textContent = (monthlyEnt && !isNaN(Number(monthlyEnt.state))) ? formatEnergy(Number(monthlyEnt.state)) + "/mo" : "";
  }

  function updateBadge(badgeEl, isOn) {
    badgeEl.classList.toggle("on", isOn);
  }

  function render() {
    var c = config.entities;

    var plug1On = st(c.plug1Switch) && st(c.plug1Switch).state === "on";
    var plug2On = st(c.plug2Switch) && st(c.plug2Switch).state === "on";
    var plug1Offline = isOffline(c.plug1Switch);
    var plug2Offline = isOffline(c.plug2Switch);
    var remaining1 = remainingSecondsFor(c.plug1Timer);
    var remaining2 = remainingSecondsFor(c.plug2Timer);

    updateHvacNode(el.plug1Unit, el.ac1Dot, el.ac1Ring, el.ac1Name, el.ac1State, el.ac1Power, el.ac1PowerMo,
      c.plug1Name, plug1On, plug1Offline, remaining1, c.plug1PowerEntity, c.plug1CurrentEntity, c.plug1MonthlyEnergyEntity);
    updateHvacNode(el.plug2Unit, el.ac2Dot, el.ac2Ring, el.ac2Name, el.ac2State, el.ac2Power, el.ac2PowerMo,
      c.plug2Name, plug2On, plug2Offline, remaining2, c.plug2PowerEntity, c.plug2CurrentEntity, c.plug2MonthlyEnergyEntity);

    el.hvacBranch1.classList.toggle("flowing", plug1On);
    el.hvacBranch2.classList.toggle("flowing", plug2On);

    if (c.plug1ParticipateEntity) updateBadge(el.ac1Participate, !st(c.plug1ParticipateEntity) || st(c.plug1ParticipateEntity).state !== "off");
    if (c.plug2ParticipateEntity) updateBadge(el.ac2Participate, !st(c.plug2ParticipateEntity) || st(c.plug2ParticipateEntity).state !== "off");
    if (c.plug1UseUnusedCycleEntity) updateBadge(el.ac1Unused, !st(c.plug1UseUnusedCycleEntity) || st(c.plug1UseUnusedCycleEntity).state !== "off");
    if (c.plug2UseUnusedCycleEntity) updateBadge(el.ac2Unused, !st(c.plug2UseUnusedCycleEntity) || st(c.plug2UseUnusedCycleEntity).state !== "off");

    var awayOn = c.awayEntity && st(c.awayEntity) && st(c.awayEntity).state === "on";
    el.awayValue.textContent = awayOn ? "ON" : "OFF";
    el.awayValue.classList.toggle("on", !!awayOn);

    var autoCycleOn = c.autoCycleEntity && st(c.autoCycleEntity) && st(c.autoCycleEntity).state === "on";
    el.autoCycleValue.textContent = autoCycleOn ? "ON" : "OFF";
    el.autoCycleValue.classList.toggle("on", !!autoCycleOn);

    if (c.maxRuntimeEntity) {
      var rtEnt = st(c.maxRuntimeEntity);
      if (rtEnt) el.runtimeValue.textContent = rtEnt.state + " min";
    }

    var condition = null;
    if (c.weatherEntity) {
      var wx = st(c.weatherEntity);
      if (wx) {
        condition = wx.state;
        el.wxCondition.textContent = (wx.state || "--").replace(/[-_]/g, " ").toUpperCase();
        var temp = wx.attributes.temperature;
        var tempUnit = (wx.attributes.temperature_unit || "").toUpperCase();
        var tempC = temp != null ? (tempUnit.indexOf("F") !== -1 ? fahrenheitToCelsius(temp) : temp) : null;
        el.wxTemp.textContent = tempC != null ? Math.round(tempC) + "°" : "--";
        setRingFraction(el.envRingFill, tempC != null ? Math.max(0, Math.min(1, tempC / 45)) : 0);
        el.wxHumidity.textContent = wx.attributes.humidity != null ? wx.attributes.humidity + "%" : "--";
        var windSpeed = wx.attributes.wind_speed;
        var windUnit = (wx.attributes.wind_speed_unit || "").toLowerCase();
        var windKmh = windSpeed != null ? (windUnit.indexOf("mph") !== -1 ? mphToKmh(windSpeed) : windSpeed) : null;
        el.wxWind.textContent = windKmh != null ? Math.round(windKmh) + " km/h" : "--";

        var isRainy = /rain|shower|storm|drizzle|snow/i.test(wx.state || "");
        el.envParticles.classList.toggle("show", isRainy);
      }
    }

    // ---- event transitions (real changes only) ----
    if (prevState.plug1On !== null && prevState.plug1On !== plug1On) {
      logEvent("HVAC", (c.plug1Name || "PLUG 1").toUpperCase() + (plug1On ? " COMPRESSOR ACTIVE" : " COMPRESSOR IDLE"));
    }
    if (prevState.plug2On !== null && prevState.plug2On !== plug2On) {
      logEvent("HVAC", (c.plug2Name || "PLUG 2").toUpperCase() + (plug2On ? " COMPRESSOR ACTIVE" : " COMPRESSOR IDLE"));
    }
    if (prevState.away !== null && prevState.away !== awayOn) {
      logEvent("SYS", "AWAY MODE " + (awayOn ? "ENABLED" : "DISABLED"));
    }
    if (prevState.autoCycle !== null && prevState.autoCycle !== autoCycleOn) {
      logEvent("SYS", "AUTO-CYCLE " + (autoCycleOn ? "ENABLED" : "DISABLED"));
    }
    if (condition && prevState.condition !== null && prevState.condition !== condition) {
      logEvent("ENV", "CONDITION " + condition.replace(/[-_]/g, " ").toUpperCase());
    }
    prevState.plug1On = plug1On;
    prevState.plug2On = plug2On;
    prevState.away = awayOn;
    prevState.autoCycle = autoCycleOn;
    if (condition) prevState.condition = condition;

    var wasOk = connOk;
    connOk = true;
    if (!wasOk) logEvent("NET", "UPLINK RESTORED");
    updateHudOnlineTag();
  }

  function updateHudOnlineTag() {
    if (!el.hudOnlineTag) return;
    var ok = connOk && (lastSystemInfo == null || lastSystemInfo.isOnline !== false);
    el.hudOnlineTag.textContent = ok ? "SYSTEM ONLINE" : "CONNECTION LOST";
    el.hudOnlineTag.classList.toggle("offline", !ok);
  }

  // ---------------------------------------------------------------------
  // Polling
  // ---------------------------------------------------------------------
  var pollInFlight = false;
  function poll() {
    if (!config || !config.baseUrl || !config.token) return;
    if (pollInFlight) return;
    pollInFlight = true;
    fetchStates(entityIdList()).then(function (result) {
      pollInFlight = false;
      if (result && result._ok) {
        delete result._ok;
        haStates = result;
        render();
      } else {
        if (connOk) logEvent("NET", "UPLINK LOST");
        connOk = false;
        updateHudOnlineTag();
      }
    }).catch(function () {
      pollInFlight = false;
      if (connOk) logEvent("NET", "UPLINK LOST");
      connOk = false;
      updateHudOnlineTag();
    });
  }

  function startPolling() {
    if (pollTimer) clearInterval(pollTimer);
    poll();
    pollTimer = setInterval(poll, 3000);
  }

  setInterval(function () {
    if (!config || !haStates) return;
    var c = config.entities;
    var plug1On = st(c.plug1Switch) && st(c.plug1Switch).state === "on";
    var plug2On = st(c.plug2Switch) && st(c.plug2Switch).state === "on";
    if (plug1On) {
      var r1 = remainingSecondsFor(c.plug1Timer);
      el.ac1State.textContent = "RUNNING" + (r1 != null ? " · " + formatMMSS(r1) : "");
    }
    if (plug2On) {
      var r2 = remainingSecondsFor(c.plug2Timer);
      el.ac2State.textContent = "RUNNING" + (r2 != null ? " · " + formatMMSS(r2) : "");
    }
  }, 1000);

  // ---------------------------------------------------------------------
  // On-device telemetry
  // ---------------------------------------------------------------------
  function formatUptime(totalSeconds) {
    var s = Math.max(0, Math.floor(totalSeconds));
    var d = Math.floor(s / 86400); s -= d * 86400;
    var h = Math.floor(s / 3600); s -= h * 3600;
    var m = Math.floor(s / 60);
    if (d > 0) return d + "d " + h + "h";
    if (h > 0) return h + "h " + m + "m";
    return m + "m";
  }
  function rssiQuality(rssi) {
    if (rssi == null) return "--";
    if (rssi >= -50) return "EXCELLENT";
    if (rssi >= -60) return "GOOD";
    if (rssi >= -70) return "FAIR";
    return "WEAK";
  }
  function rssiFraction(rssi) {
    if (rssi == null) return 0;
    return Math.max(0, Math.min(1, (rssi + 90) / 60)); // -90dBm..-30dBm -> 0..1
  }

  function pollSystemInfo() {
    if (!window.SystemInfo) return;
    try {
      var info = JSON.parse(window.SystemInfo.getSystemInfo());
      var prevOnline = lastSystemInfo ? lastSystemInfo.isOnline : null;
      lastSystemInfo = info;
      if (prevOnline != null && prevOnline !== info.isOnline) {
        logEvent("NET", info.isOnline === false ? "WIFI LOST" : "WIFI CONNECTED");
      }

      if (el.netIp) el.netIp.textContent = info.localIp || "--";
      if (el.netSsid) {
        var ssid = info.ssid || "";
        el.netSsid.textContent = (ssid && ssid.indexOf("unknown ssid") === -1) ? ssid : "--";
      }
      if (el.netRssi) el.netRssi.textContent = rssiQuality(info.wifiRssi) + (info.wifiRssi != null ? " " + info.wifiRssi + "dBm" : "");
      if (el.netSpeed) el.netSpeed.textContent = info.wifiLinkSpeedMbps != null ? info.wifiLinkSpeedMbps + " Mbps" : "--";
      if (el.netDot) el.netDot.classList.toggle("offline", info.isOnline === false);
      var signalFrac = rssiFraction(info.wifiRssi);
      setRingFraction(el.netRingFill, signalFrac);
      if (el.netSignalPct) el.netSignalPct.textContent = info.wifiRssi != null ? Math.round(signalFrac * 100) + "%" : "--%";

      if (el.sysThermal) {
        var thermal = info.thermalStatus || "--";
        el.sysThermal.textContent = thermal;
        var thermalColor = "#d5f6fc";
        if (thermal === "MODERATE" || thermal === "LIGHT") thermalColor = "#ffd166";
        else if (thermal === "SEVERE" || thermal === "CRITICAL" || thermal === "EMERGENCY" || thermal === "SHUTDOWN") thermalColor = "#ff5252";
        el.sysThermal.style.color = thermalColor;
      }
      if (info.memTotalBytes) {
        var usedFrac = 1 - (info.memAvailBytes / info.memTotalBytes);
        var usedPct = Math.round(usedFrac * 100);
        var totalGb = (info.memTotalBytes / 1073741824).toFixed(1);
        if (el.sysMem) el.sysMem.textContent = usedPct + "% / " + totalGb + " GB";
        if (el.sysMemPct) el.sysMemPct.textContent = usedPct + "%";
        setRingFraction(el.sysRingFill, usedFrac);
      }
      if (el.sysUptime) el.sysUptime.textContent = formatUptime(info.uptimeSeconds);

      updateHudOnlineTag();
    } catch (e) {
      // native bridge hiccup; leave last-known values on screen
    }
  }
  setInterval(pollSystemInfo, 4000);

  // ---------------------------------------------------------------------
  // Clock
  // ---------------------------------------------------------------------
  function tickClock() {
    var now = new Date();
    var h = now.getHours();
    var ampm = h >= 12 ? "PM" : "AM";
    var h12 = h % 12; if (h12 === 0) h12 = 12;
    var mm = String(now.getMinutes()).padStart(2, "0");
    var ss = String(now.getSeconds()).padStart(2, "0");
    if (el.ssTime) el.ssTime.textContent = h12 + ":" + mm + ":" + ss;
    if (el.ssAmpm) el.ssAmpm.textContent = ampm;
    if (el.ssDate) {
      var days = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
      var months = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
      el.ssDate.textContent = days[now.getDay()] + " // " + months[now.getMonth()] + " " + now.getDate();
    }
  }
  setInterval(tickClock, 1000);

  // Slow, bounded synthetic "SYNC" telemetry jitter — decorative, but subtle and
  // believable rather than random noise (moves once every ~25s, stays in a tight band).
  function tickSync() {
    if (!el.hudSync) return;
    var jitter = (99.9 + Math.random() * 0.09).toFixed(2);
    el.hudSync.textContent = "SYNC " + jitter + "%";
  }
  setInterval(tickSync, 25000);

  // ---------------------------------------------------------------------
  // Boot sequence — short, then settles into the main HUD
  // ---------------------------------------------------------------------
  function runBootSequence() {
    if (!el.bootSequence) return;
    var lines = el.bootSequence.querySelectorAll(".boot-line");
    lines[0].classList.add("on");
    var delays = [0, 350, 650, 950, 1250];
    lines.forEach(function (line, i) {
      if (i === 0) return;
      setTimeout(function () { line.classList.add("on"); }, delays[i]);
    });
    setTimeout(function () {
      el.bootSequence.style.opacity = "0";
      setTimeout(function () { el.bootSequence.classList.add("hidden"); }, 550);
    }, 1700);
  }

  // ---------------------------------------------------------------------
  // D-pad focus navigation (WebView has no built-in spatial nav for TV)
  // ---------------------------------------------------------------------
  var NAV = {
    "settings-gear": { down: "climate-plug1" },
    "climate-plug1": { up: "settings-gear", down: "ac1-participate" },
    "ac1-participate": { up: "climate-plug1", right: "ac1-unused", down: "climate-plug2" },
    "ac1-unused": { left: "ac1-participate", up: "climate-plug1", down: "climate-plug2" },
    "climate-plug2": { up: "ac1-participate", down: "ac2-participate" },
    "ac2-participate": { up: "climate-plug2", right: "ac2-unused", down: "climate-away" },
    "ac2-unused": { left: "ac2-participate", up: "climate-plug2", down: "climate-away" },
    "climate-away": { up: "ac2-participate", down: "climate-autocycle" },
    "climate-autocycle": { up: "climate-away", down: "runtime-minus" },
    "runtime-minus": { up: "climate-autocycle", right: "runtime-plus" },
    "runtime-plus": { left: "runtime-minus", up: "climate-autocycle" },
    "input-baseurl": { down: "input-token" },
    "input-token": { up: "input-baseurl", down: "settings-save" },
    "settings-save": { up: "input-token", right: "settings-cancel" },
    "settings-cancel": { up: "input-token", left: "settings-save" }
  };

  function focusId(id) {
    var target = document.getElementById(id);
    if (target) target.focus();
  }

  function handleDirection(dir) {
    var active = document.activeElement;
    var activeId = active && active.id;
    var map = activeId && NAV[activeId];
    var nextId = map && map[dir];
    if (nextId) focusId(nextId);
  }

  window.__nativeNav = function (dir) { handleDirection(dir); };

  document.addEventListener("keydown", function (e) {
    if (e.key === "ArrowLeft") { handleDirection("left"); e.preventDefault(); return; }
    if (e.key === "ArrowRight") { handleDirection("right"); e.preventDefault(); return; }
    if (e.key === "Enter") {
      var active = document.activeElement;
      if (active && typeof active.click === "function") active.click();
      e.preventDefault();
    }
  });

  // ---------------------------------------------------------------------
  // Click handlers
  // ---------------------------------------------------------------------
  function wireClicks() {
    el.plug1Unit.addEventListener("click", function () { callService("switch", "toggle", config.entities.plug1Switch); });
    el.plug2Unit.addEventListener("click", function () { callService("switch", "toggle", config.entities.plug2Switch); });
    el.ac1Participate.addEventListener("click", function (e) { e.stopPropagation(); callService("input_boolean", "toggle", config.entities.plug1ParticipateEntity); });
    el.ac2Participate.addEventListener("click", function (e) { e.stopPropagation(); callService("input_boolean", "toggle", config.entities.plug2ParticipateEntity); });
    el.ac1Unused.addEventListener("click", function (e) { e.stopPropagation(); callService("input_boolean", "toggle", config.entities.plug1UseUnusedCycleEntity); });
    el.ac2Unused.addEventListener("click", function (e) { e.stopPropagation(); callService("input_boolean", "toggle", config.entities.plug2UseUnusedCycleEntity); });
    el.awayRow.addEventListener("click", function () { callService("input_boolean", "toggle", config.entities.awayEntity); });
    el.autoCycleRow.addEventListener("click", function () { callService("input_boolean", "toggle", config.entities.autoCycleEntity); });

    el.runtimeMinus.addEventListener("click", function () { stepRuntime(-1); });
    el.runtimePlus.addEventListener("click", function () { stepRuntime(1); });

    el.settingsGear.addEventListener("click", openSettings);
    el.settingsCancel.addEventListener("click", closeSettings);
    el.settingsSave.addEventListener("click", saveSettingsFromForm);
  }

  function stepRuntime(sign) {
    var ent = st(config.entities.maxRuntimeEntity);
    if (!ent) return;
    var step = Number(ent.attributes.step) || 1;
    var min = Number(ent.attributes.min);
    var max = Number(ent.attributes.max);
    var current = Number(ent.state);
    var next = Math.min(max, Math.max(min, current + sign * step));
    callService("input_number", "set_value", config.entities.maxRuntimeEntity, { value: next }).then(poll);
  }

  function openSettings() {
    el.inputBaseUrl.value = config.baseUrl || "";
    el.inputToken.value = config.token || "";
    el.settingsOverlay.classList.remove("hidden");
    focusId("input-baseurl");
  }
  function closeSettings() {
    el.settingsOverlay.classList.add("hidden");
    focusId("settings-gear");
  }
  function saveSettingsFromForm() {
    config.baseUrl = el.inputBaseUrl.value.trim();
    config.token = el.inputToken.value.trim();
    saveSettings({ baseUrl: config.baseUrl, token: config.token });
    el.settingsOverlay.classList.add("hidden");
    focusId("settings-gear");
    startPolling();
  }

  // ---------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------
  function init() {
    cacheEls();
    buildCoreTicks();
    buildCoreNodes();
    initLiveMap();
    config = getSettings();
    tickClock();
    pollSystemInfo();
    wireClicks();
    runBootSequence();
    focusId("settings-gear");
    if (!config.baseUrl || !config.token) {
      openSettings();
    }
    startPolling();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
