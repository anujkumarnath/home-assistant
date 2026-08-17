function parseDurationSeconds(str) {
  if (!str) return 0;
  const parts = str.split(":").map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return Number(str) || 0;
}

function formatMMSS(totalSeconds) {
  const s = Math.max(0, Math.round(totalSeconds));
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

function formatPower(watts) {
  if (watts >= 1000) return `${(watts / 1000).toFixed(2)} kW`;
  return `${Math.round(watts)} W`;
}

function formatCurrent(amps) {
  return `${amps.toFixed(1)} A`;
}

const RING_R = 30;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_R;

class AcCycleFlowCard extends HTMLElement {
  setConfig(config) {
    const required = ["phase_entity", "plug1_switch", "plug2_switch"];
    for (const key of required) {
      if (!config[key]) throw new Error(`ac-cycle-flow-card: ${key} is required`);
    }
    this._config = {
      title: "Auto-Cycle Flow",
      plug1_name: "Plug 1",
      plug2_name: "Plug 2",
      plug1_icon: "mdi:air-conditioner",
      plug2_icon: "mdi:air-conditioner",
      ...config,
    };
    this._built = false;
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._built) {
      this._build();
      this._built = true;
    }
    this._update();
  }

  connectedCallback() {
    if (!this._interval) {
      // Timer entities only push state on start/finish, not every second,
      // so we self-tick to animate the countdown ring smoothly.
      this._interval = setInterval(() => {
        if (this._hass) this._update();
      }, 1000);
    }
  }

  disconnectedCallback() {
    if (this._interval) {
      clearInterval(this._interval);
      this._interval = null;
    }
    if (this._onFullscreenChange) {
      document.removeEventListener("fullscreenchange", this._onFullscreenChange);
    }
  }

  getCardSize() {
    return 5;
  }

  _isOffline(switchEntityId) {
    const switchEnt = this._hass.states[switchEntityId];
    return !switchEnt || switchEnt.state === "unavailable";
  }

  _call(domain, service, entityId, extra) {
    if (!entityId || !this._hass) return;
    this._hass.callService(domain, service, { entity_id: entityId, ...extra });
  }

  _styleHtml() {
    return `
      <style>
        .ac-card { padding: 16px 20px 18px; }
        .ac-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 22px; }
        .ac-title { font-size: 1.05em; font-weight: 500; color: var(--primary-text-color); }
        .ac-header-actions { display: flex; align-items: center; gap: 10px; }
        .ac-header-control { display: flex; align-items: center; gap: 8px; }
        .ac-header-label {
          font-size: 0.8em; color: var(--secondary-text-color);
          display: flex; align-items: center; gap: 4px;
        }
        .ac-header-label ha-icon { --mdc-icon-size: 16px; }

        .ac-switch {
          display: inline-flex; align-items: center; gap: 6px;
          border: none; cursor: pointer; border-radius: 999px;
          padding: 5px 10px 5px 8px; font-size: 0.78em; font-weight: 500;
          background: var(--secondary-background-color, rgba(127,127,127,0.15));
          color: var(--secondary-text-color);
          transition: background .2s ease, color .2s ease, transform .15s ease;
          font-family: inherit;
        }
        .ac-switch:active { transform: scale(0.95); }
        .ac-switch-track {
          width: 26px; height: 15px; border-radius: 999px;
          background: var(--disabled-text-color, #666);
          position: relative; transition: background .25s ease; flex-shrink: 0;
        }
        .ac-switch-thumb {
          position: absolute; top: 2px; left: 2px; width: 11px; height: 11px;
          border-radius: 50%; background: white; transition: transform .25s ease;
          box-shadow: 0 1px 2px rgba(0,0,0,0.4);
        }
        .ac-switch.on .ac-switch-thumb { transform: translateX(11px); }

        .ac-switch.away .ac-switch-track { background: var(--disabled-text-color, #666); }
        .ac-switch.away.on .ac-switch-track { background: var(--warning-color, #ff9800); }
        .ac-switch.away.on { color: var(--warning-color, #ff9800); }

        .ac-switch.autocycle.on .ac-switch-track { background: var(--success-color, #4caf50); }
        .ac-switch.autocycle.on { color: var(--success-color, #4caf50); }

        .ac-away-banner {
          display: none; align-items: center; gap: 6px;
          font-size: 0.8em; color: var(--warning-color, #ff9800);
          margin: 2px 0 10px;
        }
        .ac-card.away-active .ac-away-banner { display: flex; }
        .ac-card.away-active .ac-flow-row { filter: grayscale(0.7); opacity: 0.55; }

        .ac-flow-row { display: flex; align-items: center; justify-content: center; gap: 4px; transition: filter .3s ease, opacity .3s ease; }
        .ac-node { display: flex; flex-direction: column; align-items: center; gap: 8px; width: 104px; }
        .ac-node-ring-wrap {
          position: relative; width: 70px; height: 70px;
          display: flex; align-items: center; justify-content: center;
          cursor: pointer; transition: transform .15s ease;
        }
        .ac-node-ring-wrap:active { transform: scale(0.94); }
        .ac-ring-svg { position: absolute; top: 0; left: 0; width: 70px; height: 70px; transform: rotate(-90deg); pointer-events: none; }
        .ac-ring-track { fill: none; stroke: var(--divider-color, #444); stroke-width: 4; }
        .ac-ring-progress {
          fill: none; stroke: var(--disabled-text-color, #888); stroke-width: 4;
          stroke-linecap: round;
          transition: stroke-dashoffset 1s linear, stroke .3s ease;
        }
        .ac-ring-progress.counting { stroke: var(--warning-color, #ff9800); }
        .ac-node-ring-wrap.offline .ac-ring-track,
        .ac-node-ring-wrap.offline .ac-ring-progress {
          stroke: var(--error-color, #f44336) !important;
          stroke-dasharray: 6 5 !important;
          animation: ac-ring-pulse 1.4s ease-in-out infinite;
        }
        @keyframes ac-ring-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
        .ac-node-circle {
          width: 56px; height: 56px; border-radius: 50%; pointer-events: none;
          display: flex; align-items: center; justify-content: center;
          background: var(--disabled-text-color, #888);
          opacity: 0.35;
          transition: background .4s ease, opacity .4s ease;
        }
        .ac-node-circle ha-icon { --mdc-icon-size: 28px; color: white; }
        .ac-node.active .ac-node-circle { opacity: 1; }
        .ac-node.plug1.active .ac-node-circle { background: var(--success-color, #4caf50); }
        .ac-node.plug2.active .ac-node-circle { background: var(--info-color, #2196f3); }
        .ac-node-label { font-size: 0.85em; color: var(--secondary-text-color); text-align: center; }
        .ac-node-time { font-variant-numeric: tabular-nums; margin-left: 4px; color: var(--primary-text-color); }
        .ac-node-power {
          display: none; align-items: center; gap: 3px;
          font-size: 0.68em; font-variant-numeric: tabular-nums;
          color: var(--disabled-text-color, #888);
          margin-top: -4px;
        }
        .ac-node-power.show { display: flex; }
        .ac-node-power ha-icon { --mdc-icon-size: 12px; }
        .ac-node-badge {
          position: absolute; bottom: -2px; right: -2px;
          width: 20px; height: 20px; border-radius: 50%;
          background: var(--error-color, #f44336);
          display: none; align-items: center; justify-content: center;
          border: 2px solid var(--card-background-color, #1c1c1c);
        }
        .ac-node-badge ha-icon { --mdc-icon-size: 12px; color: white; }
        .ac-node-ring-wrap.offline .ac-node-badge { display: flex; }

        .ac-participate {
          display: inline-flex; align-items: center; gap: 5px;
          border: none; cursor: pointer; border-radius: 999px;
          padding: 4px 10px; font-size: 0.72em; font-weight: 500;
          background: transparent; border: 1px solid var(--divider-color, #444);
          color: var(--secondary-text-color);
          transition: all .2s ease;
        }
        .ac-participate:active { transform: scale(0.95); }
        .ac-participate .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--disabled-text-color, #888); transition: background .2s ease; }
        .ac-participate.on { border-color: var(--success-color, #4caf50); color: var(--success-color, #4caf50); }
        .ac-participate.on .dot { background: var(--success-color, #4caf50); }
        .ac-participate.off { border-color: var(--divider-color, #444); color: var(--disabled-text-color, #888); }
        .ac-participate.off .dot { background: var(--disabled-text-color, #888); }

        .ac-arrows { flex: 1; display: flex; flex-direction: column; gap: 8px; padding: 0 2px; max-width: 140px; align-self: flex-start; margin-top: 27px; }
        .ac-arrow-svg { width: 100%; height: 16px; display: block; overflow: visible; }
        .ac-arrow-path {
          fill: none; stroke: var(--disabled-text-color, #888); stroke-width: 2;
          stroke-dasharray: 6 5; opacity: 0.35;
          transition: stroke .3s ease, opacity .3s ease;
        }
        .ac-arrow-path.flowing { stroke: var(--warning-color, #ff9800); opacity: 1; animation: ac-dash 0.6s linear infinite; }
        @keyframes ac-dash { to { stroke-dashoffset: -22; } }

        .ac-phase { margin-top: 16px; margin-bottom: 22px; text-align: center; font-size: 0.95em; color: var(--primary-text-color); }
        .ac-phase .dot2 {
          display: inline-block; width: 8px; height: 8px; border-radius: 50%;
          margin-right: 6px; vertical-align: middle;
          background: var(--disabled-text-color, #888);
          transition: background .3s ease;
        }

        .ac-divider { height: 1px; background: var(--divider-color, #333); margin: 0 0 16px; }

        .ac-footer { display: flex; flex-direction: column; gap: 10px; }
        .ac-footer-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
        .ac-footer-label { font-size: 0.88em; color: var(--primary-text-color); display: flex; align-items: center; gap: 6px; }
        .ac-footer-label ha-icon { --mdc-icon-size: 18px; color: var(--secondary-text-color); }

        .ac-stepper { display: flex; align-items: center; gap: 10px; }
        .ac-stepper-btn {
          width: 26px; height: 26px; border-radius: 50%; border: none;
          background: var(--secondary-background-color, rgba(127,127,127,0.15));
          color: var(--primary-text-color); font-size: 1.1em; line-height: 1;
          cursor: pointer; display: flex; align-items: center; justify-content: center;
          transition: background .2s ease, transform .15s ease;
        }
        .ac-stepper-btn:active { transform: scale(0.9); }
        .ac-stepper-value { font-variant-numeric: tabular-nums; font-size: 0.88em; color: var(--primary-text-color); min-width: 56px; text-align: center; }

        .ac-fullscreen-btn {
          width: 30px; height: 30px; border-radius: 50%; border: none;
          background: var(--secondary-background-color, rgba(127,127,127,0.15));
          color: var(--secondary-text-color); cursor: pointer;
          display: flex; align-items: center; justify-content: center;
          transition: background .2s ease, transform .15s ease;
          flex-shrink: 0;
        }
        .ac-fullscreen-btn:active { transform: scale(0.9); }
        .ac-fullscreen-btn ha-icon { --mdc-icon-size: 18px; }

        .ac-card.fullscreen {
          position: fixed; inset: 0; z-index: 2147483647;
          background: var(--card-background-color, #111);
          display: flex; align-items: center; justify-content: center;
          padding: 0; border-radius: 0;
        }
        .ac-card.fullscreen .ac-card-content {
          transform: scale(2.3);
          width: 320px;
        }
      </style>
    `;
  }

  _contentHtml() {
    const c = this._config;
    return `
      <div class="ac-header">
        <div class="ac-title">${c.title}</div>
        <div class="ac-header-actions">
          ${
            c.away_entity
              ? `<div class="ac-header-control">
                   <span class="ac-header-label"><ha-icon icon="mdi:home-export-outline"></ha-icon>Away Mode</span>
                   <button class="ac-switch away" type="button">
                     <span class="ac-switch-label"></span>
                     <span class="ac-switch-track"><span class="ac-switch-thumb"></span></span>
                   </button>
                 </div>`
              : ""
          }
          <button class="ac-fullscreen-btn" type="button" title="Toggle fullscreen">
            <ha-icon icon="mdi:fullscreen"></ha-icon>
          </button>
        </div>
      </div>
      <div class="ac-away-banner"><ha-icon icon="mdi:airplane"></ha-icon> Away mode - both ACs held off</div>

      <div class="ac-flow-row">
        <div class="ac-node plug1">
          <div class="ac-node-ring-wrap" data-toggle-switch="plug1">
            <svg class="ac-ring-svg" viewBox="0 0 70 70">
              <circle class="ac-ring-track" cx="35" cy="35" r="${RING_R}"></circle>
              <circle class="ac-ring-progress" cx="35" cy="35" r="${RING_R}"></circle>
            </svg>
            <div class="ac-node-circle"><ha-icon icon="${c.plug1_icon}"></ha-icon></div>
            <div class="ac-node-badge"><ha-icon icon="mdi:cloud-off-outline"></ha-icon></div>
          </div>
          <div class="ac-node-label">${c.plug1_name}<span class="ac-node-time"></span></div>
          <div class="ac-node-power"><ha-icon icon="mdi:lightning-bolt"></ha-icon><span></span></div>
          ${c.plug1_participate_entity ? `<button class="ac-participate" data-toggle-participate="plug1" type="button"><span class="dot"></span><span class="txt"></span></button>` : ""}
        </div>
        <div class="ac-arrows">
          <svg class="ac-arrow-svg" viewBox="0 0 100 16" preserveAspectRatio="none">
            <defs>
              <marker id="ac-arrow-fwd" markerWidth="6" markerHeight="6" refX="4" refY="3" orient="auto">
                <path d="M0,0 L6,3 L0,6 Z" class="ac-arrow-marker fwd"></path>
              </marker>
            </defs>
            <path class="ac-arrow-path fwd" d="M2,5 H90" marker-end="url(#ac-arrow-fwd)"></path>
          </svg>
          <svg class="ac-arrow-svg" viewBox="0 0 100 16" preserveAspectRatio="none">
            <defs>
              <marker id="ac-arrow-rev" markerWidth="6" markerHeight="6" refX="4" refY="3" orient="auto">
                <path d="M0,0 L6,3 L0,6 Z" class="ac-arrow-marker rev"></path>
              </marker>
            </defs>
            <path class="ac-arrow-path rev" d="M98,11 H10" marker-end="url(#ac-arrow-rev)"></path>
          </svg>
        </div>
        <div class="ac-node plug2">
          <div class="ac-node-ring-wrap" data-toggle-switch="plug2">
            <svg class="ac-ring-svg" viewBox="0 0 70 70">
              <circle class="ac-ring-track" cx="35" cy="35" r="${RING_R}"></circle>
              <circle class="ac-ring-progress" cx="35" cy="35" r="${RING_R}"></circle>
            </svg>
            <div class="ac-node-circle"><ha-icon icon="${c.plug2_icon}"></ha-icon></div>
            <div class="ac-node-badge"><ha-icon icon="mdi:cloud-off-outline"></ha-icon></div>
          </div>
          <div class="ac-node-label">${c.plug2_name}<span class="ac-node-time"></span></div>
          <div class="ac-node-power"><ha-icon icon="mdi:lightning-bolt"></ha-icon><span></span></div>
          ${c.plug2_participate_entity ? `<button class="ac-participate" data-toggle-participate="plug2" type="button"><span class="dot"></span><span class="txt"></span></button>` : ""}
        </div>
      </div>

      <div class="ac-phase"><span class="dot2"></span><span class="phase-text">—</span></div>

      ${c.auto_cycle_entity || c.max_runtime_entity ? `<div class="ac-divider"></div>` : ""}
      <div class="ac-footer">
        ${
          c.auto_cycle_entity
            ? `<div class="ac-footer-row">
                 <span class="ac-footer-label"><ha-icon icon="mdi:autorenew"></ha-icon>Auto-Cycle</span>
                 <button class="ac-switch autocycle" type="button">
                   <span class="ac-switch-label"></span>
                   <span class="ac-switch-track"><span class="ac-switch-thumb"></span></span>
                 </button>
               </div>`
            : ""
        }
        ${
          c.max_runtime_entity
            ? `<div class="ac-footer-row">
                 <span class="ac-footer-label"><ha-icon icon="mdi:timer-outline"></ha-icon>Max Runtime</span>
                 <div class="ac-stepper">
                   <button class="ac-stepper-btn" data-runtime="minus" type="button">−</button>
                   <span class="ac-stepper-value">—</span>
                   <button class="ac-stepper-btn" data-runtime="plus" type="button">+</button>
                 </div>
               </div>`
            : ""
        }
      </div>
    `;
  }

  _build() {
    this.innerHTML = `
      <ha-card>
        ${this._styleHtml()}
        <div class="ac-card">
          <div class="ac-card-content">
            ${this._contentHtml()}
          </div>
        </div>
      </ha-card>
    `;

    this._els = this._queryEls(this);

    for (const ring of [this._els.ringProgress1, this._els.ringProgress2]) {
      ring.style.strokeDasharray = `${RING_CIRCUMFERENCE} ${RING_CIRCUMFERENCE}`;
    }

    this._onClick = this._onClick.bind(this);
    this.addEventListener("click", this._onClick);

    // Browsers block auto-fullscreen; the button click above is the only
    // entry point. Also sync our state if the user exits via Esc or the
    // browser's own UI, not just via our button.
    this._onFullscreenChange = () => {
      this._setFullscreenState(document.fullscreenElement === document.documentElement);
    };
    document.addEventListener("fullscreenchange", this._onFullscreenChange);
  }

  _queryEls(root) {
    return {
      card: root.querySelector(".ac-card"),
      cardContent: root.querySelector(".ac-card-content"),
      node1: root.querySelector(".ac-node.plug1"),
      node2: root.querySelector(".ac-node.plug2"),
      ringWrap1: root.querySelector(".ac-node.plug1 .ac-node-ring-wrap"),
      ringWrap2: root.querySelector(".ac-node.plug2 .ac-node-ring-wrap"),
      ringProgress1: root.querySelector(".ac-node.plug1 .ac-ring-progress"),
      ringProgress2: root.querySelector(".ac-node.plug2 .ac-ring-progress"),
      time1: root.querySelector(".ac-node.plug1 .ac-node-time"),
      time2: root.querySelector(".ac-node.plug2 .ac-node-time"),
      power1: root.querySelector(".ac-node.plug1 .ac-node-power"),
      power2: root.querySelector(".ac-node.plug2 .ac-node-power"),
      participate1: root.querySelector('[data-toggle-participate="plug1"]'),
      participate2: root.querySelector('[data-toggle-participate="plug2"]'),
      arrowFwd: root.querySelector(".ac-arrow-path.fwd"),
      arrowRev: root.querySelector(".ac-arrow-path.rev"),
      markerFwd: root.querySelector(".ac-arrow-marker.fwd"),
      markerRev: root.querySelector(".ac-arrow-marker.rev"),
      phaseText: root.querySelector(".phase-text"),
      dot2: root.querySelector(".ac-phase .dot2"),
      awaySwitch: root.querySelector(".ac-switch.away"),
      autoCycleSwitch: root.querySelector(".ac-switch.autocycle"),
      runtimeValue: root.querySelector(".ac-stepper-value"),
      fullscreenIcon: root.querySelector(".ac-fullscreen-btn ha-icon"),
    };
  }

  _onClick(e) {
    const switchToggle = e.target.closest("[data-toggle-switch]");
    const participateToggle = e.target.closest("[data-toggle-participate]");
    const runtimeBtn = e.target.closest("[data-runtime]");
    const awayBtn = e.target.closest(".ac-switch.away");
    const autoCycleBtn = e.target.closest(".ac-switch.autocycle");
    const fullscreenBtn = e.target.closest(".ac-fullscreen-btn");

    if (fullscreenBtn) {
      this._toggleFullscreen();
    } else if (switchToggle) {
      const which = switchToggle.getAttribute("data-toggle-switch");
      this._call("switch", "toggle", this._config[`${which}_switch`]);
    } else if (participateToggle) {
      const which = participateToggle.getAttribute("data-toggle-participate");
      this._call("input_boolean", "toggle", this._config[`${which}_participate_entity`]);
    } else if (runtimeBtn && this._config.max_runtime_entity) {
      const ent = this._hass.states[this._config.max_runtime_entity];
      if (ent) {
        const step = Number(ent.attributes.step) || 1;
        const min = Number(ent.attributes.min);
        const max = Number(ent.attributes.max);
        const current = Number(ent.state);
        const delta = runtimeBtn.getAttribute("data-runtime") === "plus" ? step : -step;
        const next = Math.min(max, Math.max(min, current + delta));
        this._call("input_number", "set_value", this._config.max_runtime_entity, { value: next });
      }
    } else if (awayBtn) {
      this._call("input_boolean", "toggle", this._config.away_entity);
    } else if (autoCycleBtn) {
      this._call("input_boolean", "toggle", this._config.auto_cycle_entity);
    }
  }

  _toggleFullscreen() {
    const isFs = document.fullscreenElement === document.documentElement;
    if (!isFs) {
      document.documentElement.requestFullscreen?.().catch(() => {});
      this._setFullscreenState(true);
    } else {
      document.exitFullscreen?.().catch(() => {});
      this._setFullscreenState(false);
    }
  }

  _setFullscreenState(isFs) {
    this._els.card.classList.toggle("fullscreen", isFs);
    this._els.fullscreenIcon.setAttribute("icon", isFs ? "mdi:fullscreen-exit" : "mdi:fullscreen");
  }

  _updateRing(ringProgressEl, timeEl, timerEntityId) {
    const timerEnt = timerEntityId ? this._hass.states[timerEntityId] : null;
    if (timerEnt && timerEnt.state === "active" && timerEnt.attributes.finishes_at) {
      const durationSec = parseDurationSeconds(timerEnt.attributes.duration);
      const finishesAtMs = new Date(timerEnt.attributes.finishes_at).getTime();
      const remainingSec = Math.max(0, (finishesAtMs - Date.now()) / 1000);
      const fraction = durationSec > 0 ? Math.min(1, remainingSec / durationSec) : 0;
      ringProgressEl.style.strokeDashoffset = RING_CIRCUMFERENCE * (1 - fraction);
      ringProgressEl.classList.add("counting");
      timeEl.textContent = ` · ${formatMMSS(remainingSec)}`;
    } else {
      ringProgressEl.style.strokeDashoffset = 0;
      ringProgressEl.classList.remove("counting");
      timeEl.textContent = "";
    }
  }

  _updateSwitchPill(el, isOn, labelOn, labelOff) {
    if (!el) return;
    el.classList.toggle("on", isOn);
    const label = el.querySelector(".ac-switch-label");
    if (label) label.textContent = isOn ? labelOn : labelOff;
  }

  _updateParticipate(el, isOn) {
    if (!el) return;
    el.classList.toggle("on", isOn);
    el.classList.toggle("off", !isOn);
    const txt = el.querySelector(".txt");
    if (txt) txt.textContent = isOn ? "Participating" : "Skipped";
  }

  _updatePower(el, powerEntityId, currentEntityId, isActive) {
    if (!el) return;
    const powerEnt = powerEntityId ? this._hass.states[powerEntityId] : null;
    const currentEnt = currentEntityId ? this._hass.states[currentEntityId] : null;
    const powerVal = powerEnt && !isNaN(Number(powerEnt.state)) ? Number(powerEnt.state) : null;
    const currentVal = currentEnt && !isNaN(Number(currentEnt.state)) ? Number(currentEnt.state) : null;

    if (!isActive || (powerVal === null && currentVal === null)) {
      el.classList.remove("show");
      return;
    }
    const parts = [];
    if (powerVal !== null) parts.push(formatPower(powerVal));
    if (currentVal !== null) parts.push(formatCurrent(currentVal));
    el.querySelector("span").textContent = parts.join(" · ");
    el.classList.add("show");
  }

  _update() {
    this._applyState(this._els);
  }

  _applyState(els) {
    const hass = this._hass;
    const phaseEnt = hass.states[this._config.phase_entity];
    const phase = phaseEnt ? phaseEnt.state : "unknown";

    const plug1Ent = hass.states[this._config.plug1_switch];
    const plug2Ent = hass.states[this._config.plug2_switch];
    const plug1Offline = this._isOffline(this._config.plug1_switch);
    const plug2Offline = this._isOffline(this._config.plug2_switch);
    const plug1On = plug1Ent?.state === "on";
    const plug2On = plug2Ent?.state === "on";

    els.node1.classList.toggle("active", plug1On);
    els.node2.classList.toggle("active", plug2On);
    els.ringWrap1.classList.toggle("offline", plug1Offline);
    els.ringWrap2.classList.toggle("offline", plug2Offline);

    this._updateRing(els.ringProgress1, els.time1, this._config.plug1_timer);
    this._updateRing(els.ringProgress2, els.time2, this._config.plug2_timer);

    this._updatePower(els.power1, this._config.plug1_power_entity, this._config.plug1_current_entity, plug1On);
    this._updatePower(els.power2, this._config.plug2_power_entity, this._config.plug2_current_entity, plug2On);

    if (this._config.plug1_participate_entity) {
      this._updateParticipate(els.participate1, hass.states[this._config.plug1_participate_entity]?.state !== "off");
    }
    if (this._config.plug2_participate_entity) {
      this._updateParticipate(els.participate2, hass.states[this._config.plug2_participate_entity]?.state !== "off");
    }

    const switchingFwd = phase.startsWith("Switching: Plug 1");
    const switchingRev = phase.startsWith("Switching: Plug 2");
    els.arrowFwd.classList.toggle("flowing", switchingFwd);
    els.arrowRev.classList.toggle("flowing", switchingRev);

    const dimColor = getComputedStyle(this).getPropertyValue("--disabled-text-color").trim() || "#888";
    const flowColor = getComputedStyle(this).getPropertyValue("--warning-color").trim() || "#ff9800";
    els.markerFwd.style.fill = switchingFwd ? flowColor : dimColor;
    els.markerRev.style.fill = switchingRev ? flowColor : dimColor;

    const displayPhase = phase
      .replaceAll("Plug 1", this._config.plug1_name)
      .replaceAll("Plug 2", this._config.plug2_name);
    els.phaseText.textContent = displayPhase;

    let phaseColor = "var(--disabled-text-color, #888)";
    if (switchingFwd || switchingRev) phaseColor = "var(--warning-color, #ff9800)";
    else if (plug1On) phaseColor = "var(--success-color, #4caf50)";
    else if (plug2On) phaseColor = "var(--info-color, #2196f3)";
    els.dot2.style.background = phaseColor;

    if (this._config.away_entity) {
      const awayOn = hass.states[this._config.away_entity]?.state === "on";
      this._updateSwitchPill(els.awaySwitch, awayOn, "On", "Off");
      els.card.classList.toggle("away-active", awayOn);
    }
    if (this._config.auto_cycle_entity) {
      const acOn = hass.states[this._config.auto_cycle_entity]?.state === "on";
      this._updateSwitchPill(els.autoCycleSwitch, acOn, "On", "Off");
    }
    if (this._config.max_runtime_entity) {
      const rtEnt = hass.states[this._config.max_runtime_entity];
      if (rtEnt) els.runtimeValue.textContent = `${rtEnt.state} min`;
    }
  }
}

customElements.define("ac-cycle-flow-card", AcCycleFlowCard);
