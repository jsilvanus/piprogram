# systemd user unit

`piprogram.service` runs piprogram as a systemd user service.

Expected layout (relative to the service user's home, `%h`):

- app checkout (built, with `dist/`): `~/apps/piprogram`
- environment file: `~/apps/piprogram.env` (all settings and secrets live here, never in git)
- Node.js: `~/.local/bin/node`

Install:

```sh
mkdir -p ~/.config/systemd/user
cp deploy/piprogram.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now piprogram
loginctl enable-linger "$USER"   # once, so it runs without a login session
```

Status and logs: `systemctl --user status piprogram`, `journalctl --user -u piprogram -f`.
