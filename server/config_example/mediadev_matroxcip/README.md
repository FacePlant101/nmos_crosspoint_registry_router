# Matrox CIP Configuration

This document explains the configuration options for the Matrox Convert IP device integration.

## Configuration File

The configuration is stored in `config/mediadev_matroxcip/matroxcip.json`.

### Basic Authentication Settings

- `user`: Default username for device authentication
- `password`: Default password for device authentication  
- `closeExistingSessions`: Whether to close existing sessions when logging in

### Environment Variable Override

You can override credentials using environment variables:
- `MATROX_CIP_USER`: Overrides the `user` setting
- `MATROX_CIP_PASSWORD`: Overrides the `password` setting

### Auto-Reauthentication Control

**NEW**: `disableAutoReauth` (boolean, default: `false`)

When set to `true`, disables automatic reauthentication when device sessions expire. This is useful when you need to manually access device web interfaces without being logged out by the NMOS system's automatic authentication.

**Use Cases:**
- Manual device configuration via web UI
- Troubleshooting device issues through web interface
- Preventing session conflicts during maintenance

**Important Notes:**
- When disabled, NMOS operations may fail if authentication expires
- The system will log informative messages when skipping reauthentication
- Set back to `false` to restore automatic session management
- Per-device authentication settings in `manualDevices` still respect this global setting

### Example Configuration

```json
{
    "user": "admin1",
    "password": "password",
    "closeExistingSessions": false,
    "disableAutoReauth": true,
    "ignoreHttps": true,
    "manualDevices": [
        {"sn": "abc1234", "auth": {"user": "admin1", "password": "password"}}
    ],
    "autoConfigNmosRegistry": {
        "enabled": false,
        "configureOnDiscovery": true,
        "retryOnFailure": true,
        "retryDelayMs": 30000
    }
}
```

## Usage Instructions

### To Disable Auto-Reauthentication:

1. Edit your `config/mediadev_matroxcip/matroxcip.json` file
2. Set `"disableAutoReauth": true`
3. Restart the NMOS server
4. You can now access device web interfaces without automatic logout

### To Re-enable Auto-Reauthentication:

1. Set `"disableAutoReauth": false` in the config
2. Restart the NMOS server
3. Normal automatic session management resumes

## Monitoring

When auto-reauthentication is disabled, you'll see log messages like:
```
[INFO] MatroxCIP: Auto-reauthentication disabled for device ABC1234, skipping login retry to preserve manual web UI sessions
```

This confirms the feature is working and protecting your manual web sessions.
