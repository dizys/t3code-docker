---
name: server-ssh
description: Use the saved build-server SSH connection when asked to administer that server.
---

Use the saved `build-server` connection for remote commands:

```sh
t3-ssh build-server -- '<remote command>'
```

The host, username, port and password are managed in Setup → Credentials.
Change the credential name in this example to match your server. If authentication
fails, check the saved login. If the host key is untrusted or changed, stop and
ask the user to verify its fingerprint in Credentials; never bypass host checks. Do not read or print credential files or the
helper's child environment.
