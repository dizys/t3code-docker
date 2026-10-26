---
name: ssh-ha
description: Use Home Assistant SSH or its REST API when explicitly asked to work on Home Assistant.
---

Use the saved connections; no password or API token belongs in this skill.

```sh
t3-ssh homeassistant-ssh -- 'ha core info'
t3-api homeassistant GET states/light.kitchen
printf '%s' '{"entity_id":"light.kitchen"}' |
  t3-api homeassistant POST services/light/turn_on --stdin
```

`homeassistant-ssh` is the SSH login. `homeassistant` is the API bearer token
and base URL, including `/api/`. The port is part of that saved URL.
Manage both in Setup → Server credentials. Do not read or print credential files
or the helper's child environment. The API helper handles REST requests; it does
not handle Home Assistant's websocket automation traces.
