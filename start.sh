#!/bin/bash
cd \$(dirname "\$0")
if screen -list | grep -q "refurbminer"; then
    echo "RefurbMiner is already running!"
else
    echo "Starting RefurbMiner..."
    screen -dmS refurbminer npm start
    echo "RefurbMiner started in screen session. To view, use: screen -r refurbminer"
fi
