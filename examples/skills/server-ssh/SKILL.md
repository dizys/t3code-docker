---
name: server-ssh
description: Use the saved build-server SSH connection when asked to administer that server.
---

Run commands on `build-server` with plain ssh. Its address, user and key are saved
in the Vault:

```sh
ssh build-server '<remote command>'
scp app.tar build-server:/srv/
```

Change the name in this example to match your server. If sign-in fails, run
`t3-vault test build-server` and follow what it says. If the server's key has
changed, stop and show the user what `t3-vault trust build-server` prints. Never
get past it with `StrictHostKeyChecking=no`. Don't read or print credential files.
