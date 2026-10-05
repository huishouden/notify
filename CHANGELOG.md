# Changelog

## [0.3.1](https://github.com/huishouden/notify/compare/v0.3.0...v0.3.1) (2026-10-05)

### Bug Fixes

* Rebuild against the re-tagged kit ([b962c6b](https://github.com/huishouden/notify/commit/b962c6b0d8202e15ac03b73058c0aa3364bc1a44))

## [0.3.0](https://github.com/huishouden/notify/compare/v0.2.0...v0.3.0) (2026-10-05)

### Bug Fixes

* **reads:** a malformed FIRESTORE_NOTIFY_READS throws instead of lifting the cap ([23f00de](https://github.com/huishouden/notify/commit/23f00de87de4a45f4d140b4499d1eeed0171024e))

### Performance

* newest-first query only when needed (576 reads a day when quiet, was 864); reads counted per run (`reads`) and household reads capped by FIRESTORE_NOTIFY_READS ([bfb11ad](https://github.com/huishouden/notify/commit/bfb11ad000ffa9fb2f4b8bf0fd4ab409641116af))

## [0.2.0](https://github.com/huishouden/notify/compare/v0.1.0...v0.2.0) (2026-10-05)

### Features

* skip and delete reminders whose source is done (a bill paid, a task ticked) ([9dd1dc5](https://github.com/huishouden/notify/commit/9dd1dc526e3ec97bd0479edd721ed7684fc40db2))

### Bug Fixes

* kit v0.96.0; a Health source counts only on a personal reminder ([822fb0d](https://github.com/huishouden/notify/commit/822fb0d413a097198b23c36d80f483aa19e761bd))
* redact household and document paths from the run's failure log lines ([1f86e86](https://github.com/huishouden/notify/commit/1f86e86c636966a01361561e0295e35864ff8992))

### Other

* kit v0.98.2; sourceAllowed decides the personal-only rule ([dc84f88](https://github.com/huishouden/notify/commit/dc84f8828db6203871e9b334e649282a5f1dece5))
* redact in its own module, used by the run and the heartbeat ([911b9d0](https://github.com/huishouden/notify/commit/911b9d0f85e0e1485397996456623be6806eb702))
* the kit's reminder-source decides; only sources their writer may use count ([b73f6c6](https://github.com/huishouden/notify/commit/b73f6c6bb9454d2445e28264237b9ed8f4eefdd8))
