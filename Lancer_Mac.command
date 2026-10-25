#!/bin/bash
cd "$(dirname "$0")"
echo "=== Table JDR - serveur Mac ==="
if ! command -v python3 >/dev/null 2>&1; then
  echo "Python 3 est nécessaire. Installez-le depuis python.org."
  read -r -p "Entrée pour fermer..."
  exit 1
fi
python3 serveur_mac.py
read -r -p "Entrée pour fermer..."
