#!/bin/bash
cd $HOME/refurbminer
if screen -list | grep -q "refurbminer"; then
    echo "RefurbMiner is already running!"
else
    echo "Starting RefurbMiner..."

    # Android/Termux: keep a lightweight watchdog loop due to occasional Node/V8 trap exits.
    # Linux hosts: start normally and let the host supervisor (systemd/pm2/etc.) handle restarts.
    if [ "$(uname -o 2>/dev/null)" = "Android" ] || [ -n "$TERMUX_VERSION" ]; then
        screen -dmS refurbminer bash -lc 'while true; do npm start; EXIT_CODE=$?; echo "[watchdog] RefurbMiner exited with code ${EXIT_CODE} at $(date)"; sleep 3; done'
    else
        screen -dmS refurbminer npm start
    fi

    echo "RefurbMiner started in screen session. To view, use: screen -r refurbminer"
fi
