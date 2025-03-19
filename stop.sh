#!/bin/bash
if screen -list | grep -q "refurbminer"; then
    echo "Stopping RefurbMiner..."
    screen -S refurbminer -X quit
    echo "RefurbMiner stopped."
else
    echo "RefurbMiner is not running."
fi
