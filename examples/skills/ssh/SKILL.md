---
name: ssh
description: SSH to HomeServer when explicitly asked to use that server.
---

Use the saved `homeserver` SSH connection:

```sh
t3-ssh homeserver -- '<remote command>'
```

Connection details and the password are managed in Setup → Server credentials.
If the connection is missing or authentication fails, ask the user to check that
page. Do not read or print credential files or the helper's child environment.
