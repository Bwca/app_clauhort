#!/usr/bin/env bash
set -e

source ~/.nvm/nvm.sh
nvm use --lts

echo "Starting Clauditteer on http://localhost:3001"
cd server && node index.js
