---
name: server-ssh
description: Use the saved build-server SSH connection when asked to administer that server.
---

Use the saved `build-server` connection for remote commands:

```sh
t3-ssh build-server -- '<remote command>'
```

The host, username, port and password are managed in Setup → Server credentials.
Change the connection ID in this example to match your server. If authentication
fails, check the saved connection. Do not read or print credential files or the
helper's child environment.
