#!/bin/zsh
set -e

cd /Volumes/WorkDrive/andrewhouser/Developer/AgentSpine

echo "Pulling latest from origin..."
git pull origin

echo "Installing dependencies..."
npm install

echo "Building web client..."
npm run web:build

echo "Restarting AgentSpine dashboard service..."
sudo launchctl unload /Library/LaunchDaemons/local.agentspine.dashboard.plist 2>/dev/null || true
sudo launchctl load /Library/LaunchDaemons/local.agentspine.dashboard.plist

echo "Done. Verifying service is running..."
sleep 2
sudo launchctl print system/local.agentspine.dashboard 2>&1 | head -5
