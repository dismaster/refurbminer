#!/bin/bash
if screen -list | grep -q "refurbminer"; then
    echo "✅ RefurbMiner is running."
    echo "To view the mining console, use: screen -r refurbminer"
    echo "To detach from the console (leave it running), press Ctrl+A, then D."
else
    echo "❌ RefurbMiner is not running."
    echo "Start it with: ./start.sh"
fi
