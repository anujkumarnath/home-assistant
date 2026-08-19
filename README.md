# Home Assistant - Tuya plug interlock/scheduler

Dockerized Home Assistant that manages two Wipro (Tuya) smart plugs:

- Only one of the two plugs can ever be on at a time (interlock).
- Whichever plug is on gets turned off automatically after a configurable
  max runtime.
- Optionally, HA can keep alternating between the two plugs forever
  (auto-cycle), driven off the runtime timer itself so it can't drift.
- Works no matter who turns a plug on/off - Alexa, the Tuya/Smart Life app,
  or Home Assistant - because HA reacts to the plug's *state* via Tuya
  cloud, not to who issued the command. **Alexa does not need to know Home
  Assistant exists.**

Trade-off to know up front: this uses Tuya's *cloud* API, so state changes
take ~1-3 seconds to reach Home Assistant. That's the window where both
plugs could briefly show "on" before the interlock corrects it. If that's
ever a problem, migrate to the local Tuya integration (HACS "Tuya Local")
later - the automations below don't need to change, only how the
`switch.plug_1` / `switch.plug_2` entities are provided.

What Alexa **can't** do in this design: change the max-runtime value or
toggle auto-cycle on/off. Those are Home Assistant helpers, not Tuya
devices, so Alexa has no visibility into them. Adjust them from the HA
dashboard/app. (If you want that adjustable by voice later, that needs the
HA-Alexa Smart Home bridge, which we deliberately skipped for now.)

## 1. Tuya IoT Platform account (free)

Your Wipro plugs are already paired to the Tuya Smart or Smart Life app.
Home Assistant's official Tuya integration talks to Tuya's cloud, not
directly to your app account, so you need a small one-time developer setup:

1. Go to https://iot.tuya.com and create a free account.
2. **Cloud > Create Cloud Project.** Pick a name, and for "Industry" /
   "Development Method" choose Smart Home / Smart Home PaaS. Select the
   data center closest to you (e.g. "Central Europe" / "Western America" /
   "India" - match whatever your Tuya Smart/Smart Life app account region
   is; check in the app under Me > Settings > Account and Security).
3. On the new project's **Overview** tab, note the **Access ID/Client ID**
   and **Access Secret/Client Secret** - you'll paste these into Home
   Assistant.
4. Go to the project's **Devices** tab > **Link Tuya App Account**, and
   scan the QR code with the Tuya Smart / Smart Life app (Me > top-right
   scan icon) to link your existing account. Your two plugs should now
   appear in the device list.
5. Also subscribe to the free trial of the "IoT Core" API service if
   prompted (Service API tab) - required for the integration to pull
   devices. Note: Tuya's free trial subscription is time-limited (usually
   ~1 year) and needs periodic renewal (still free, just has to be
   reactivated in the dashboard) - another reason to consider local Tuya
   down the line.

## 2. Start Home Assistant

```bash
cd /home/anuj/home-assistant
docker compose up -d
docker compose logs -f homeassistant   # watch until it says it's ready, then Ctrl+C
```

Open http://localhost:8123 and complete onboarding (create your local admin
account, confirm location/timezone - the compose file sets the container's
`TZ` to `Asia/Kolkata`; edit `docker-compose.yml` if that's wrong for you).

## 3. Add the Tuya integration

Settings > Devices & Services > Add Integration > search "Tuya" > enter the
Access ID and Access Secret from step 1, pick the matching data center.
Your two plugs should be imported as `switch.*` entities.

## 4. Rename the plug entities

The automations in this repo are hardcoded to `switch.plug_1` and
`switch.plug_2` for readability. Easiest fix: rename the entities.

Settings > Devices & Services > Entities > find each plug > gear icon >
Settings tab > Entity ID > set to `switch.plug_1` and `switch.plug_2`.

(Alternative: leave the entity IDs alone and find/replace them in
`config/automations.yaml` and `config/scripts.yaml` instead.)

## 5. Restart and configure

```bash
docker compose restart homeassistant
```

Then in the HA UI:

- **Settings > Devices & Services > Helpers**: confirm "Max Plug Runtime"
  and "Auto Cycle Plugs" exist. Set your desired runtime in minutes.
- Turn **Auto Cycle Plugs** on if you want continuous alternating; leave it
  off if you just want the interlock + runtime cutoff while you drive
  everything manually via Alexa/the Tuya app.
- The default dashboard (defined in `config/ui-lovelace.yaml`) shows both
  switches, their runtime timers, and the two helpers at a glance - this
  replaces HA's auto-generated Overview/areas dashboard.

After editing YAML files directly, you don't need a full restart - use
Developer Tools > YAML > "Reload Automations" / "Reload Scripts". Changes
to `configuration.yaml` itself (helpers, includes) need a restart.

## How it behaves

| Event | Result |
|---|---|
| Plug A turned on (any source) while B is running | B turns off, A gets a fresh full-length runtime timer |
| A plug's runtime timer expires | That plug turns off; if auto-cycle is on, the other plug turns on ~2s later |
| Plug manually turned off before its timer expires | Its timer is cancelled; nothing else turns on (no auto hand-off) |
| Auto-cycle turned on while both plugs are idle | Plug 1 turns on, starting the rotation |
| Both plugs somehow on at once (cloud race) | Watchdog (runs every 5 min) turns both off, notifies you, restarts from plug 1 |
| Home Assistant restarts while a plug is already on | On startup, that plug gets a fresh runtime timer instead of running unmonitored |

## Files

- `docker-compose.yml` - the HA container.
- `config/configuration.yaml` - `default_config`, the three helpers
  (`input_number.max_runtime_minutes`, `input_boolean.auto_cycle_enabled`,
  the two `timer` entities), and the automation/script includes.
- `config/scripts.yaml` - `script.activate_plug`, a small reusable helper
  that turns off the other plug and (re)starts this plug's timer.
- `config/automations.yaml` - the six automations described above.
- `config/ui-lovelace.yaml` - the default dashboard (`lovelace: mode: yaml`
  in `configuration.yaml` points here instead of the auto-generated one).

## Exposing this to the internet (e.g. `tailscale funnel`)

As of HA 2026.7+, the `http:` integration (trusted proxies, etc.) is no
longer read from `configuration.yaml` - it's been migrated to
`config/.storage/http` (a `yaml_still_present_after_migration` repair
warning fires if you still have an `http:` block, and it's silently
ignored). Settings > System > Network doesn't expose these fields in the
UI yet either, so the only way to set them right now is editing the
storage file directly:

```bash
docker compose stop homeassistant
docker compose start homeassistant   # need it briefly running for docker exec
docker exec homeassistant python3 -c "
import json
p = '/config/.storage/http'
d = json.load(open(p))
d['data']['stable']['use_x_forwarded_for'] = True
d['data']['stable']['trusted_proxies'] = ['127.0.0.1', '::1', '<docker-bridge-gateway-ip>']
json.dump(d, open(p, 'w'), indent=4)
"
docker compose restart homeassistant
```

Without this, every proxied request (e.g. via `tailscale funnel --bg 8123`,
which terminates TLS and forwards to `127.0.0.1:8123`) gets rejected with
a bare `400 Bad Request`, logged as `A request from a reverse proxy was
received from <ip>, but your HTTP integration is not set-up for reverse
proxies`.

The `<ip>` in that log line is the address to add to `trusted_proxies` -
it's usually **not** `127.0.0.1`: Docker NATs published-port connections
through the bridge network, so the container sees the request coming from
the bridge gateway (check with `docker inspect homeassistant --format
'{{json .NetworkSettings.Networks}}'`; look for `"Gateway"`). This can
change if the network is ever recreated (e.g. `docker compose down` then
`up`, as opposed to `restart`/`stop`+`start`) - if funnel access breaks
after that, re-check the gateway IP and re-run the steps above.
